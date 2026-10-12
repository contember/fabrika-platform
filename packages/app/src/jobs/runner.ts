// The job runner (`fabrika job run <name>`): one run of one `c.cron` job. A run takes the job's lease or does not
// start; each attempt holds one generation of it with a deadline the database enforces, so a write of an attempt
// that timed out, failed or lost the lease never commits (`@fabrika/db`'s fence). Failures, crashed runs and a job
// that stopped succeeding are reported to Operations, each under a fixed failure code.

import { type ContractArtifact, JOB_SITE_PREFIX, type JobArtifact, type PermissionEntry, permits } from '@fabrika/auth-core'
import { type DataAccess, type FrameworkTables, type JobLeases, type LeaseFence, LeaseLostError } from '@fabrika/db/framework'
import { NotFoundError } from '../errors'
import { type CapabilityMint, CapabilityRefusedError, type Ref, RequestFrame, runInRequest, type Within } from '../implement/capability'
import type { ContractDatabase } from '../implement/implement'
import { approvedDeclaration, boundTo, isSiteHandler, jobHandles, jobSql, siteData, type SiteDeclaration } from '../implement/invocation'
import type { WorkloadCredential } from '../implement/workload'
import type { OperationsReporter } from './report'
import { type CronSchedule, parseCron, periodAt } from './schedule'
import type { JobContext, JobPrincipal } from './types'

/** An attempt of a job without a `timeout` is cancelled after this long. */
export const DEFAULT_JOB_TIMEOUT_MS = 15 * 60_000
/**
 * The lease outlives an attempt's deadline by this much: the runner renews or finishes a timed-out attempt's lease,
 * and no other run takes it over meanwhile. The attempt's writes stop at its deadline regardless.
 */
export const LEASE_GRACE_MS = 60_000
/** How often the serving process checks every job for a crashed run and for a schedule that stopped. */
export const JOB_CHECK_INTERVAL_MS = 60_000
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 5 * 60_000
const DURATION = /^([1-9][0-9]*)([smh])$/
const UNIT_MS: Readonly<Record<string, number>> = { s: 1_000, m: 60_000, h: 3_600_000 }

/**
 * Why a run failed. Fixed codes only: an application error's name and message may carry a secret, so neither is
 * ever logged, returned or reported.
 */
export type JobFailureCode =
	| 'timeout'
	| 'lease_lost'
	| 'handler_failed'
	| 'driver_failed'
	| 'crashed'
	/** IAM refused the job's key: the attempt mints no capability. */
	| 'unauthorized'
	/** IAM could not be asked for the job's token. */
	| 'iam_unavailable'

export type JobRunResult =
	| { readonly status: 'succeeded'; readonly attempts: number }
	| { readonly status: 'failed'; readonly attempts: number; readonly code: JobFailureCode }
	/** Another run holds the lease: an overlapping run does not start. */
	| { readonly status: 'skipped' }

/** The runner's waits; the lease's times are always the database's. */
export interface JobClock {
	/** Resolves after `ms`, or as soon as `signal` aborts. */
	wait(ms: number, signal: AbortSignal): Promise<void>
	/** In [0, 1): the jitter of a retry's backoff. */
	random(): number
}

export interface JobRunOptions {
	readonly clock?: JobClock
	/** Where failures and missed runs go; by default the one `boot` built from `FABRIKA_OPERATIONS_DSN`. */
	readonly reporter?: OperationsReporter
}

/**
 * A job the framework runs itself under a reserved name (`FILE_SCAN_JOB`): no handler, no key, no capability, one
 * attempt. It holds its lease like an application job, and every write of its run is fenced by it.
 */
export interface FrameworkJob {
	readonly name: string
	readonly schedule: string
	readonly timeoutMs: number
	/** One run; `signal` aborts when the attempt's deadline passes. A throw fails the run. */
	run(reporter: OperationsReporter, signal: AbortSignal): Promise<void>
}

/** The contract's jobs, bound to their handlers by `boot`, and the framework's own. */
export interface ContractJobs {
	/** The contract's `c.cron` jobs; `run` also takes the name of a framework job the contract needs. */
	readonly names: readonly string[]
	run(name: string, options?: JobRunOptions): Promise<JobRunResult>
	/**
	 * Registers every job (its first-seen time), reports a run that crashed and a job that has not succeeded within
	 * twice its period. The serving process calls it every `JOB_CHECK_INTERVAL_MS`; it never throws.
	 */
	check(options?: Pick<JobRunOptions, 'reporter'>): Promise<void>
}

/** A run that cannot start: an unknown job. Its message is framework-authored. */
export class JobError extends Error {
	override readonly name = 'JobError'
}

export const systemClock: JobClock = Object.freeze({
	wait: (ms: number, signal: AbortSignal) =>
		new Promise<void>((resolve) => {
			if (signal.aborted) {
				resolve()
				return
			}
			const timer = setTimeout(resolve, ms)
			signal.addEventListener('abort', () => {
				clearTimeout(timer)
				resolve()
			}, { once: true })
		}),
	random: () => Math.random(),
})

interface BoundJob {
	readonly name: string
	readonly artifact: JobArtifact
	readonly schedule: CronSchedule
	readonly timeoutMs: number
	readonly handler: (args: { readonly ctx: object }) => unknown
	readonly credential: WorkloadCredential
	/** A staged-kit job's declaration: it reads through `ctx.db` and writes only in `ctx.transaction`. */
	readonly site: SiteDeclaration | null
}

interface RunnerContext {
	readonly artifact: ContractArtifact
	readonly database: ContractDatabase | null
	readonly ownedDimensions: ReadonlySet<string>
	readonly leases: JobLeases
	readonly reporter: OperationsReporter
	readonly mint: CapabilityMint
	readonly data: DataAccess | null
}

export interface JobBindingInput {
	readonly artifact: ContractArtifact
	/** The handler tree `boot` binds; a job's handler is `handlers.jobs.<name>`. */
	readonly handlers: unknown
	readonly database: ContractDatabase | null
	/** The framework side of `@fabrika/db`, bound by `boot`; `null` when the application has no such layer. */
	readonly framework: FrameworkTables | null
	readonly ownedDimensions: ReadonlySet<string>
	/** Where failures and missed runs go: Operations, or the server log without a DSN. */
	readonly reporter: OperationsReporter
	/** `job:<name>` → the job's key; `boot` refuses a job without one. */
	readonly credentials: ReadonlyMap<string, WorkloadCredential>
	/** The runtime's capability mint, which `boot` alone holds. */
	readonly mint: CapabilityMint
	/** The mini-ORM of the bound `scoped(tables)` layer, behind a staged-kit job's `ctx.db`. */
	readonly data: DataAccess | null
	/** The framework's own jobs this contract needs: the scan of its `scan: true` file collections. */
	readonly frameworkJobs?: readonly FrameworkJob[]
}

interface BoundFrameworkJob {
	readonly job: FrameworkJob
	readonly name: string
	readonly schedule: CronSchedule
}

export interface BoundJobs {
	readonly jobs: ContractJobs
	/** The handler ids the jobs took (`jobs.<name>`), so `boot` finds no undeclared handler among them. */
	readonly declared: readonly string[]
}

function ownChild(node: unknown, key: string): unknown {
	return typeof node === 'object' && node !== null && Object.hasOwn(node, key) ? Reflect.get(node, key) : undefined
}

function durationMs(timeout: string | null): number | null {
	if (timeout === null) {
		return DEFAULT_JOB_TIMEOUT_MS
	}
	const match = DURATION.exec(timeout)
	const unit = match?.[2] === undefined ? undefined : UNIT_MS[match[2]]
	return match?.[1] === undefined || unit === undefined ? null : Number.parseInt(match[1], 10) * unit
}

/** Binds every declared job to its handler, or adds why it cannot run to `problems`. */
export function bindJobs(input: JobBindingInput, problems: string[]): BoundJobs {
	const entries = Object.entries(input.artifact.jobs)
	const bound = new Map<string, BoundJob>()
	const declared: string[] = []
	const tree = ownChild(input.handlers, 'jobs')
	for (const [name, artifact] of entries) {
		declared.push(`jobs.${name}`)
		const where = `job '${name}'`
		if (artifact.scope.kind !== 'app') {
			problems.push(`${where} is scoped to '${artifact.scope.dimension}'; this version runs jobs with scope: 'app' only`)
		}
		if (input.framework === null) {
			problems.push(`${where} needs @fabrika/db on Postgres, which holds its lease and fences its writes: serve(contract, { database: scoped(tables) })`)
		}
		const schedule = parseCron(artifact.schedule)
		if (schedule === null) {
			problems.push(`${where} has the schedule '${artifact.schedule}', which is not a cron expression (allowed: '0 3 * * *', '*/15 * * * *')`)
		}
		const timeoutMs = durationMs(artifact.timeout)
		if (timeoutMs === null) {
			problems.push(`${where} has the timeout '${artifact.timeout}', which is not a duration (allowed: '30s', '10m', '1h')`)
		}
		const node = ownChild(tree, name)
		const handler = isSiteHandler(node) ? node.handler : node
		const site = isSiteHandler(node) ? approvedDeclaration(where, `${JOB_SITE_PREFIX}${name}`, node.declared, 'job', input.artifact, problems) : null
		const credential = input.credentials.get(`job:${name}`)
		if (typeof handler !== 'function') {
			problems.push(`${where} has no handler; add it to handlers.jobs`)
		} else if (site !== null && input.data === null) {
			problems.push(`${where} reaches data through ctx.db, which runs on @fabrika/db: pass serve(contract, { database: scoped(tables) })`)
		} else if (schedule !== null && timeoutMs !== null && credential !== undefined) {
			bound.set(name, { name, artifact, schedule, timeoutMs, handler: (args) => Reflect.apply(handler, undefined, [args]), credential, site })
		}
	}
	const frameworkJobs = new Map<string, BoundFrameworkJob>()
	for (const job of input.frameworkJobs ?? []) {
		const schedule = parseCron(job.schedule)
		if (input.framework === null) {
			problems.push(`the framework job '${job.name}' needs @fabrika/db on Postgres, which holds its lease and fences its writes`)
		} else if (schedule !== null) {
			frameworkJobs.set(job.name, { job, name: job.name, schedule })
		}
	}
	const names = Object.freeze(entries.map(([name]) => name))
	const framework = input.framework
	const contextFor = (leases: JobLeases, chosen: OperationsReporter | undefined): RunnerContext => ({
		artifact: input.artifact,
		database: input.database,
		ownedDimensions: input.ownedDimensions,
		leases,
		reporter: chosen ?? input.reporter,
		mint: input.mint,
		data: input.data,
	})
	const jobs: ContractJobs = Object.freeze({
		names,
		run(name: string, options: JobRunOptions = {}): Promise<JobRunResult> {
			const own = frameworkJobs.get(name)
			if (own !== undefined && framework !== null) {
				return runFrameworkJob(own, contextFor(framework.jobs, options.reporter), options.clock ?? systemClock)
			}
			const job = bound.get(name)
			if (job === undefined || framework === null) {
				throw new JobError(`no job '${name}' in the contract (jobs: ${names.length === 0 ? 'none' : names.join(', ')})`)
			}
			return runJob(job, contextFor(framework.jobs, options.reporter), options.clock ?? systemClock)
		},
		async check(options: Pick<JobRunOptions, 'reporter'> = {}): Promise<void> {
			if (framework === null) {
				return
			}
			const context = contextFor(framework.jobs, options.reporter)
			for (const job of [...bound.values(), ...frameworkJobs.values()]) {
				try {
					await context.leases.register(job.name)
					await surveil(job, context)
				} catch {
					// A driver error may quote the database URL.
					console.error(`fabrika: the check of job '${job.name}' failed: driver_failed`)
				}
			}
		},
	})
	return { jobs, declared }
}

const attemptId = (): string => Bun.randomUUIDv7()

/** Exponential from one second, capped at five minutes, with half of it jittered. */
function backoffMs(attempt: number, random: number): number {
	const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1))
	return Math.round(ceiling / 2 + (ceiling / 2) * random)
}

/** A crashed run (its lease expired before it finished) and a job overdue by twice its period: one report each. */
async function surveil(job: { readonly name: string; readonly schedule: CronSchedule }, context: RunnerContext): Promise<void> {
	const tags = { job: job.name }
	if (await context.leases.reapCrashed(job.name)) {
		const message = `job '${job.name}' failed: crashed (its run's lease expired before the run finished)`
		console.error(`fabrika: ${message}`)
		await context.reporter.report({ fingerprint: ['fabrika-job-failed', job.name], type: 'JobFailed', message, tags: { ...tags, code: 'crashed' } })
	}
	const period = periodAt(job.schedule, await context.leases.now())
	const claim = period === null ? null : await context.leases.claimOverdue(job.name, period)
	if (claim === null || period === null) {
		return
	}
	const last = claim.lastSucceededAt === null
		? `has never succeeded since it was first seen at ${claim.firstSeenAt.toISOString()}`
		: `last succeeded at ${claim.lastSucceededAt.toISOString()}`
	await context.reporter.report({
		fingerprint: ['fabrika-job-missed', job.name],
		type: 'JobMissed',
		message: `job '${job.name}' ${last}; it is due every ${Math.round(period / 60_000)} min and has missed twice that`,
		tags,
	})
}

interface Progress {
	attempts: number
}

async function runJob(job: BoundJob, context: RunnerContext, clock: JobClock): Promise<JobRunResult> {
	const progress: Progress = { attempts: 0 }
	try {
		return await runLeased(job, context, clock, progress)
	} catch {
		// Only the lease store throws here: the handler's errors stay inside its attempt. Its message may quote the URL.
		return failed(job, progress.attempts, 'driver_failed', context.reporter)
	}
}

async function runLeased(job: BoundJob, context: RunnerContext, clock: JobClock, progress: Progress): Promise<JobRunResult> {
	const { leases } = context
	await leases.register(job.name)
	await surveil(job, context)
	const leaseMs = job.timeoutMs + LEASE_GRACE_MS
	let fence = await leases.acquire(job.name, attemptId(), job.timeoutMs, leaseMs)
	if (fence === null) {
		console.error(`fabrika: a previous run of job '${job.name}' still holds its lease; this run does not start`)
		return { status: 'skipped' }
	}
	const attempts = job.artifact.retries + 1
	progress.attempts = 1
	let code = await attemptOnce(job, fence, progress.attempts, clock, context)
	while (code !== null && progress.attempts < attempts) {
		console.error(`fabrika: job '${job.name}' attempt ${progress.attempts} of ${attempts} failed: ${code}`)
		const delay = backoffMs(progress.attempts, clock.random())
		// A new generation at once: nothing the failed attempt still has in flight commits from here on.
		const next = await leases.renew(fence, attemptId(), delay + job.timeoutMs, delay + leaseMs)
		if (next === null) {
			return failed(job, progress.attempts, 'lease_lost', context.reporter)
		}
		fence = next
		await clock.wait(delay, new AbortController().signal)
		progress.attempts++
		code = await attemptOnce(job, fence, progress.attempts, clock, context)
	}
	if (code === null) {
		if (await leases.finish(fence, 'succeeded')) {
			return { status: 'succeeded', attempts: progress.attempts }
		}
		return failed(job, progress.attempts, 'lease_lost', context.reporter)
	}
	await leases.finish(fence, 'failed')
	return failed(job, progress.attempts, code, context.reporter)
}

async function failed(job: { readonly name: string }, attempts: number, code: JobFailureCode, reporter: OperationsReporter): Promise<JobRunResult> {
	const message = `job '${job.name}' failed after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${code}`
	console.error(`fabrika: ${message}`)
	await reporter.report({ fingerprint: ['fabrika-job-failed', job.name], type: 'JobFailed', message, tags: { job: job.name, code } })
	return { status: 'failed', attempts, code }
}

const TIMED_OUT: unique symbol = Symbol('fabrika.job.timedOut')

/** One run of a framework job: its lease, one attempt in a frame fenced by it, and the outcome reported like a job's. */
async function runFrameworkJob(bound: BoundFrameworkJob, context: RunnerContext, clock: JobClock): Promise<JobRunResult> {
	const { leases } = context
	let fence: LeaseFence | null
	try {
		await leases.register(bound.name)
		await surveil(bound, context)
		fence = await leases.acquire(bound.name, attemptId(), bound.job.timeoutMs, bound.job.timeoutMs + LEASE_GRACE_MS)
	} catch {
		return failed(bound, 0, 'driver_failed', context.reporter)
	}
	if (fence === null) {
		console.error(`fabrika: a previous run of job '${bound.name}' still holds its lease; this run does not start`)
		return { status: 'skipped' }
	}
	const frame = new RequestFrame(fence.holder, { fence })
	const cancel = new AbortController()
	const timer = new AbortController()
	let code: JobFailureCode | null
	try {
		const ran = runInRequest(frame, () => bound.job.run(context.reporter, cancel.signal)).then(() => null, failureOf)
		const timeout = clock.wait(bound.job.timeoutMs, timer.signal).then((): typeof TIMED_OUT => TIMED_OUT)
		const result = await Promise.race([ran, timeout])
		code = result === TIMED_OUT ? 'timeout' : result
	} finally {
		frame.end()
		timer.abort()
	}
	try {
		// Writes are refused before the run hears it was stopped: a scanner that answers on abort commits nothing.
		try {
			await leases.cancelInFlight(fence)
		} finally {
			cancel.abort()
		}
		const finished = await leases.finish(fence, code === null ? 'succeeded' : 'failed')
		if (code === null) {
			return finished ? { status: 'succeeded', attempts: 1 } : failed(bound, 1, 'lease_lost', context.reporter)
		}
	} catch {
		return failed(bound, 1, 'driver_failed', context.reporter)
	}
	return failed(bound, 1, code, context.reporter)
}

/**
 * `null` when the handler finished, else the attempt's failure code. Either way the attempt's frame ends and the
 * statements it still has running are cancelled before the runner touches the lease again.
 */
async function attemptOnce(
	job: BoundJob,
	fence: LeaseFence,
	attempt: number,
	clock: JobClock,
	context: RunnerContext,
): Promise<JobFailureCode | null> {
	// The job's authority is what IAM signs for its key at the start of the attempt; a revoked key stops the next one.
	const authority = await job.credential.authority()
	if (!authority.ok) {
		return authority.reason === 'unavailable' ? 'iam_unavailable' : 'unauthorized'
	}
	const frame = new RequestFrame(fence.holder, { fence })
	const cancel = new AbortController()
	const timer = new AbortController()
	const ctx = jobContext(job, frame, attempt, cancel.signal, context, authority.perms)
	try {
		const ran = runInRequest(frame, async () => {
			await job.handler({ ctx })
		}).then(() => null, failureOf)
		const timeout = clock.wait(job.timeoutMs, timer.signal).then((): typeof TIMED_OUT => TIMED_OUT)
		const result = await Promise.race([ran, timeout])
		return result === TIMED_OUT ? 'timeout' : result
	} finally {
		frame.end()
		cancel.abort()
		timer.abort()
		await context.leases.cancelInFlight(fence)
	}
}

/** By class, never by name: an application error can call itself anything. */
function failureOf(error: unknown): JobFailureCode {
	return error instanceof LeaseLostError ? 'lease_lost' : 'handler_failed'
}

function jobContext(
	job: BoundJob,
	frame: RequestFrame,
	attempt: number,
	signal: AbortSignal,
	context: RunnerContext,
	perms: readonly PermissionEntry[],
): JobContext<string, string> {
	const principal: JobPrincipal = Object.freeze({ kind: 'job', id: `job:${job.name}`, job: job.name })
	const check = (action: string, dimension: string): void => {
		if (frame.ended) {
			throw new CapabilityRefusedError('ended', `attempt ${frame.id} of job '${job.name}' has ended; it mints no capability`)
		}
		if (!job.artifact.actions.includes(action)) {
			throw new CapabilityRefusedError(
				'undeclared_action',
				`job '${job.name}' does not declare this action (actions: ${job.artifact.actions.join(', ')})`,
			)
		}
		if (!permits([...perms], action)) {
			throw new CapabilityRefusedError('undeclared_action', `the token IAM signed for the key of job '${job.name}' does not carry this action`)
		}
		if (!Object.hasOwn(context.artifact.dimensions, dimension)) {
			throw new CapabilityRefusedError('undeclared_dimension', `job '${job.name}' named a dimension the contract does not declare`)
		}
	}
	return Object.freeze({
		principal,
		runId: frame.id,
		attempt,
		signal,
		...(job.site === null || context.data === null ? {} : kitJobContext(frame, context.data, job.site, principal.id)),
		within<const Act extends string, const Dim extends string>(action: Act, dimension: Dim): Within<Dim, Act> {
			check(action, dimension)
			return context.mint.within(frame, dimension, action, principal.id, 'all')
		},
		async ref<const Act extends string, const Dim extends string>(action: Act, dimension: Dim, id: string): Promise<Ref<Dim, Act>> {
			check(action, dimension)
			if (typeof id !== 'string' || id === '') {
				throw new CapabilityRefusedError('missing_id', `job '${job.name}' named an object without an id`)
			}
			const database = context.database
			const chain = database === null || !context.ownedDimensions.has(dimension) ? new Map<string, string>() : await database.locate(dimension, id)
			if (chain === null) {
				throw new NotFoundError('Not found')
			}
			return context.mint.ref(frame, dimension, action, principal.id, id, chain)
		},
	})
}

/**
 * What a staged-kit job adds: `ctx.db`, whose reads run each on its own, and `ctx.transaction(work)`, the one place it
 * writes and runs `tx.sql` — fenced by the attempt's lease, so an attempt that timed out or lost it commits nothing.
 */
function kitJobContext(frame: RequestFrame, data: DataAccess, site: SiteDeclaration, principal: string): Readonly<Record<string, unknown>> {
	const reads = jobHandles(frame, data, site, principal, 'job', async () => data.direct(), () => false)
	return {
		db: siteData(reads),
		transaction: async <R>(work: (tx: object) => Promise<R>): Promise<R> => {
			// Outside its attempt there is no lease to fence the transaction with, so it never opens.
			boundTo(frame, () => false)()
			return data.transaction(async (session) => {
				let open = true
				const writes = jobHandles(frame, data, site, principal, 'mutation', async () => session, () => !open)
				try {
					const sql = site.sql === null ? {} : { sql: jobSql(frame, data, site.sql, session, () => !open) }
					return await work(Object.freeze({ db: siteData(writes), ...sql }))
				} finally {
					open = false
				}
			})
		},
	}
}
