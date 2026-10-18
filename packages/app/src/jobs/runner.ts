// The job runner (`fabrika job run <name>`): one run of one `c.cron` job. A run takes the job's lease or does not
// start; each attempt holds one generation of it with a deadline the database enforces, so a write of an attempt
// that timed out, failed or lost the lease never commits (`@fabrika/db`'s fence). A form's `then` kicks a run in the
// background without waiting for any lock; a kick that finds the lease held leaves the shared pending flag, and the run
// holding it runs once more after it succeeded. Failures, crashed runs and a job that stopped succeeding are reported
// to Operations, each under a fixed failure code.

import type { IamMembership } from '@fabrika/auth'
import { type ContractArtifact, JOB_SITE_PREFIX, type JobArtifact, type JobMailer, type PermissionEntry, permits } from '@fabrika/auth-core'
import type { CapabilityAuthority } from '@fabrika/db/capability'
import { type DataAccess, type FrameworkTables, type JobLeases, type LeaseFence, LeaseLostError, type Session } from '@fabrika/db/framework'
import { EmailDeliveryError, type EmailSenderCapabilities, mayRetryDelivery } from '@fabrika/email'
import { NotFoundError } from '../errors'
import type { FileCollections } from '../files/collections'
import { type CapabilityMint, CapabilityRefusedError, type Ref, RequestFrame, runInRequest, type Within } from '../implement/capability'
import { failureCode, type FailureReason, failureReason } from '../implement/failures'
import { ServerFault } from '../implement/faults'
import type { ContractDatabase } from '../implement/implement'
import {
	approvedDeclaration,
	approvedReach,
	boundTo,
	isSiteHandler,
	jobHandles,
	jobSql,
	jobSqlOutsideTransaction,
	noFileCollections,
	siteData,
	type SiteDeclaration,
	undeclaredSql,
} from '../implement/invocation'
import { jobLinkIssuing, type JobLinkMount } from '../implement/membership'
import type { WorkloadCredential } from '../implement/workload'
import { jobMail, type MailTransports } from './mail'
import type { OperationsReporter } from './report'
import { type CronSchedule, parseCron, periodAt } from './schedule'
import type { AppMail, JobContext, JobPrincipal } from './types'

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
 * ever logged or returned. Only the report to Operations carries them, scrubbed (ADR-0059).
 */
export type JobFailureCode =
	| 'timeout'
	| 'lease_lost'
	| 'handler_failed'
	/** The data layer refused a statement or an operation tree (`QueryRefusedError`): its reason names why. */
	| 'query_refused'
	/** A capability or a handle was refused: forged, ended, of other work, or of another kind than the call takes. */
	| 'capability_refused'
	| 'driver_failed'
	| 'crashed'
	/** IAM refused the job's key: the attempt mints no capability. */
	| 'unauthorized'
	/** IAM could not be asked for the job's token. */
	| 'iam_unavailable'
	/** The process stopped a kicked run while shutting down; the schedule runs the job again. */
	| 'stopped'
	/** The transport refused a message the handler did not catch; `reason` is the `EmailDeliveryError` code. */
	| 'mail_failed'

export type JobRunResult =
	| { readonly status: 'succeeded'; readonly attempts: number }
	/** `reason` is a framework refusal's catalog key (`query_refused`, `capability_refused`), present only for one. */
	| { readonly status: 'failed'; readonly attempts: number; readonly code: JobFailureCode; readonly reason?: string }
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
			// The listener goes with the wait: a long-lived signal (a process's stop) would otherwise collect one per wait.
			const done = new AbortController()
			const timer = setTimeout(() => {
				done.abort()
				resolve()
			}, ms)
			signal.addEventListener('abort', () => {
				clearTimeout(timer)
				resolve()
			}, { once: true, signal: done.signal })
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
	/** The link mount the approved artifact says the job `issues`: its `ctx.links`. */
	readonly links: JobLinkMount | null
	/** The mail transport the approved artifact says the job reaches: its `ctx.mail`. */
	readonly mailer: JobMailer | null
}

interface RunnerContext {
	readonly artifact: ContractArtifact
	readonly database: ContractDatabase | null
	readonly ownedDimensions: ReadonlySet<string>
	readonly leases: JobLeases
	readonly reporter: OperationsReporter
	readonly mint: CapabilityMint
	readonly data: DataAccess | null
	readonly files: FileCollections | null
	readonly membership: IamMembership | null
	readonly capabilities: CapabilityAuthority
	readonly containers: ReadonlyMap<string, readonly string[]>
	readonly revealHandlerErrors: HandlerErrorSink | null
	readonly mail: MailTransports
}

/** Where `fabrika app dev` shows what a handler threw, on the developer's own machine; nothing else sets one. */
export type HandlerErrorSink = (where: string, error: unknown) => void

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
	/** The contract's file collections, behind a staged-kit job's `ctx.files` and `tx.files`; `null` without any. */
	readonly files?: FileCollections | null
	/** The framework's own jobs this contract needs: the scan of its `scan: true` file collections. */
	readonly frameworkJobs?: readonly FrameworkJob[]
	/** IAM's membership operations, which a job that `issues` links asks; `null` when the adapter supplies none. */
	readonly membership: IamMembership | null
	/** The runtime's authority, which a `Ref` passed to IAM must resolve with. */
	readonly capabilities: CapabilityAuthority
	/** Each dimension's containers, nearest first: a link's chain. */
	readonly containers: ReadonlyMap<string, readonly string[]>
	/** What a job's handler threw, for `fabrika app dev`; without it the error is only its fixed code. */
	readonly revealHandlerErrors?: HandlerErrorSink
	/** The transports of the jobs that declare `mailer`, which `boot` resolved. */
	readonly mail: MailTransports
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
	/**
	 * Kicks the contract job `name`, as a form's `then` does after its row committed: a run under the job's own key
	 * now, or the shared pending flag for the run holding the lease, which then runs once more after it succeeded. It
	 * waits for no lock, settles when that work has ended and never rejects; the schedule stays the recovery path.
	 */
	readonly kick: (name: string) => Promise<void>
	/**
	 * Aborts every kicked run in flight; a later kick starts none and only sets the pending flag, for a process that is
	 * not stopping; the schedule recovers their work.
	 */
	readonly stopKicks: () => void
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
		const links = jobLinks(where, `${JOB_SITE_PREFIX}${name}`, site, input, problems)
		const mailer = input.artifact.declared?.[`${JOB_SITE_PREFIX}${name}`]?.mailer ?? null
		if (typeof handler !== 'function') {
			problems.push(`${where} has no handler; add it to handlers.jobs`)
		} else if (site !== null && input.data === null) {
			problems.push(`${where} reaches data through ctx.db, which runs on @fabrika/db: pass serve(contract, { database: scoped(tables) })`)
		} else if (schedule !== null && timeoutMs !== null && credential !== undefined) {
			bound.set(name, {
				name,
				artifact,
				schedule,
				timeoutMs,
				handler: (args) => Reflect.apply(handler, undefined, [args]),
				credential,
				site,
				links,
				mailer,
			})
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
		files: input.files ?? null,
		membership: input.membership,
		capabilities: input.capabilities,
		containers: input.containers,
		revealHandlerErrors: input.revealHandlerErrors ?? null,
		mail: input.mail,
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
			return runJob(job, contextFor(framework.jobs, options.reporter), options.clock ?? systemClock, 'wait').then((result) => {
				if (result.status === 'skipped') {
					console.error(`fabrika: a previous run of job '${name}' still holds its lease; this run does not start`)
				}
				return result
			})
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
	const stopping = new AbortController()
	const kick = async (name: string): Promise<void> => {
		const job = bound.get(name)
		if (job !== undefined && framework !== null) {
			await kickOnce(job, contextFor(framework.jobs, undefined), stopping.signal)
		}
	}
	return { jobs, declared, kick, stopKicks: () => stopping.abort() }
}

/**
 * One kick: a run while the lease is free, else the shared pending flag. Neither waits for a lock, so a kick never
 * holds a connection requests share while a run writes. After a failed run the flag stays for the schedule.
 */
async function kickOnce(job: BoundJob, context: RunnerContext, stop: AbortSignal): Promise<void> {
	if (stop.aborted) {
		// The flag waits for no lock, and another process that is not stopping runs the job.
		await markPending(job, context)
		return
	}
	if ((await runJob(job, context, systemClock, 'try', stop)).status === 'skipped') {
		await handOver(job, context, systemClock, stop)
	}
}

/**
 * Leaves the flag to the run holding the lease, which takes it after it succeeded. That run may have finished before
 * the flag was set, so the lease is tried once more; `null` when another run still holds it.
 */
async function handOver(job: BoundJob, context: RunnerContext, clock: JobClock, stop?: AbortSignal): Promise<JobRunResult | null> {
	if (!(await markPending(job, context))) {
		return null
	}
	const result = await runJob(job, context, clock, 'try', stop)
	return result.status === 'skipped' ? null : result
}

async function markPending(job: BoundJob, context: RunnerContext): Promise<boolean> {
	try {
		await context.leases.markPending(job.name)
		return true
	} catch {
		// A driver error may quote the database URL; the schedule picks the submission up.
		console.error(`fabrika: the kick of job '${job.name}' failed: driver_failed`)
		return false
	}
}

/**
 * The link mount a job issues, by the approved artifact's declaration of its site whatever its leaf; a job that issues
 * without an IAM membership transport does not boot.
 */
function jobLinks(where: string, site: string, declaration: SiteDeclaration | null, input: JobBindingInput, problems: string[]): JobLinkMount | null {
	const reach = declaration ?? (input.artifact.declared === undefined ? null : approvedReach(site, input.artifact))
	const name = reach?.issues ?? null
	if (name === null) {
		return null
	}
	const mount = Object.hasOwn(input.artifact.mounts, name) ? input.artifact.mounts[name] : undefined
	if (mount?.kind !== 'link') {
		problems.push(`${where} issues '${name}', which is not a link mount of the contract`)
		return null
	}
	if (input.membership === null) {
		problems.push(
			`${where} issues links of '${name}', and the runtime adapter supplies no IAM membership transport (the IAM binding on Cloudflare; FABRIKA_IAM_RPC_URL and FABRIKA_IAM_RPC_KEY on Bun)`,
		)
		return null
	}
	return { name, prefix: mount.prefix, dimension: mount.dimension, issuedBy: mount.issuedBy }
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

/**
 * How a run takes the lease: `wait` is `fabrika job run`'s, in a process of its own; `try` is a kick's and a follow-up
 * run's, which never wait for a lock.
 */
type Acquisition = 'wait' | 'try'

/**
 * A run of the job, then one more while a kick arrived after the last one started and it succeeded. Once `stop`
 * aborted, no follow-up run starts: the pending flag stays for the schedule.
 */
async function runJob(job: BoundJob, context: RunnerContext, clock: JobClock, acquisition: Acquisition, stop?: AbortSignal): Promise<JobRunResult> {
	let result = await runOnce(job, context, clock, acquisition, stop)
	while (result.status === 'succeeded' && stop?.aborted !== true && (await pendingTaken(job, context))) {
		const next = await runOnce(job, context, clock, 'try', stop)
		if (next.status !== 'skipped') {
			result = next
			continue
		}
		// A newer run holds the lease and may have read before the kick's row: the flag goes back to it.
		const handed = await handOver(job, context, clock, stop)
		return handed ?? result
	}
	return result
}

async function pendingTaken(job: BoundJob, context: RunnerContext): Promise<boolean> {
	try {
		return await context.leases.takePending(job.name)
	} catch {
		// A driver error may quote the database URL; the flag stays for the next run.
		console.error(`fabrika: the pending run of job '${job.name}' could not be read: driver_failed`)
		return false
	}
}

async function runOnce(job: BoundJob, context: RunnerContext, clock: JobClock, acquisition: Acquisition, stop?: AbortSignal): Promise<JobRunResult> {
	const progress: Progress = { attempts: 0 }
	try {
		return await runLeased(job, context, clock, progress, acquisition, stop)
	} catch {
		// Only the lease store throws here: the handler's errors stay inside its attempt. Its message may quote the URL.
		return failed(job, progress.attempts, failure('driver_failed'), context.reporter)
	}
}

async function runLeased(
	job: BoundJob,
	context: RunnerContext,
	clock: JobClock,
	progress: Progress,
	acquisition: Acquisition,
	stop?: AbortSignal,
): Promise<JobRunResult> {
	const { leases } = context
	await leases.register(job.name)
	const leaseMs = job.timeoutMs + LEASE_GRACE_MS
	if (stop?.aborted === true) {
		return { status: 'skipped' }
	}
	let fence: LeaseFence | null
	if (acquisition === 'wait') {
		await surveil(job, context)
		fence = await leases.acquire(job.name, attemptId(), job.timeoutMs, leaseMs)
	} else {
		fence = await leases.tryAcquire(job.name, attemptId(), job.timeoutMs, leaseMs)
	}
	if (fence === null) {
		return { status: 'skipped' }
	}
	// This run covers every kick before it: their rows committed before it reads.
	await pendingTaken(job, context)
	const attempts = job.artifact.retries + 1
	progress.attempts = 1
	let outcome = await attemptOnce(job, fence, progress.attempts, clock, context, stop)
	while (outcome !== null && outcome.code !== 'stopped' && !outcome.final && progress.attempts < attempts) {
		console.error(`fabrika: job '${job.name}' attempt ${progress.attempts} of ${attempts} failed: ${describeFailure(outcome)}`)
		const delay = backoffMs(progress.attempts, clock.random())
		// A new generation at once: nothing the failed attempt still has in flight commits from here on.
		const next = await leases.renew(fence, attemptId(), delay + job.timeoutMs, delay + leaseMs)
		if (next === null) {
			return failed(job, progress.attempts, failure('lease_lost'), context.reporter)
		}
		fence = next
		await clock.wait(delay, stop ?? new AbortController().signal)
		progress.attempts++
		outcome = await attemptOnce(job, fence, progress.attempts, clock, context, stop)
	}
	if (outcome === null) {
		if (await leases.finish(fence, 'succeeded')) {
			return { status: 'succeeded', attempts: progress.attempts }
		}
		return failed(job, progress.attempts, failure('lease_lost'), context.reporter)
	}
	await leases.finish(fence, 'failed')
	if (outcome.code === 'stopped') {
		// Not a failure of the job: the schedule runs it again, so Operations hears nothing.
		console.error(`fabrika: job '${job.name}' stopped: the process is shutting down; its schedule runs it again`)
		return { status: 'failed', attempts: progress.attempts, code: 'stopped' }
	}
	return failed(job, progress.attempts, outcome, context.reporter)
}

/** Why an attempt or a run failed: its code and, for a framework refusal, its reason and the reason's catalog text. */
interface JobFailure {
	readonly code: JobFailureCode
	readonly why: FailureReason | null
	/** What the attempt threw, which only the report carries, scrubbed (ADR-0059); never a log line or the result. */
	readonly thrown?: unknown
	/** Another attempt must not run: it could send a message the transport may already have taken. */
	readonly final: boolean
}

const failure = (code: JobFailureCode): JobFailure => ({ code, why: null, final: false })

/** The code, then a refusal's reason and its fixed text: the same words a request's log line uses. */
const describeFailure = ({ code, why }: JobFailure): string => (why === null ? code : `${code}: ${why.reason}: ${why.text}`)

async function failed(job: { readonly name: string }, attempts: number, outcome: JobFailure, reporter: OperationsReporter): Promise<JobRunResult> {
	const { code, why } = outcome
	const message = `job '${job.name}' failed after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${code}`
	console.error(`fabrika: job '${job.name}' failed after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${describeFailure(outcome)}`)
	const tags: Record<string, string> = { job: job.name, code }
	if (why !== null) {
		tags['reason'] = why.reason
	}
	await reporter.report({
		fingerprint: ['fabrika-job-failed', job.name],
		type: 'JobFailed',
		message,
		tags,
		...('thrown' in outcome ? { error: outcome.thrown } : {}),
	})
	return why === null ? { status: 'failed', attempts, code } : { status: 'failed', attempts, code, reason: why.reason }
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
		return failed(bound, 0, failure('driver_failed'), context.reporter)
	}
	if (fence === null) {
		console.error(`fabrika: a previous run of job '${bound.name}' still holds its lease; this run does not start`)
		return { status: 'skipped' }
	}
	const frame = new RequestFrame(fence.holder, { fence })
	const cancel = new AbortController()
	const timer = new AbortController()
	let outcome: JobFailure | null
	try {
		const ran = runInRequest(frame, () => bound.job.run(context.reporter, cancel.signal)).then(() => null, (error: unknown) => failureOf(error, null))
		const timeout = clock.wait(bound.job.timeoutMs, timer.signal).then((): typeof TIMED_OUT => TIMED_OUT)
		const result = await Promise.race([ran, timeout])
		outcome = result === TIMED_OUT ? failure('timeout') : result
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
		const finished = await leases.finish(fence, outcome === null ? 'succeeded' : 'failed')
		if (outcome === null) {
			return finished ? { status: 'succeeded', attempts: 1 } : failed(bound, 1, failure('lease_lost'), context.reporter)
		}
	} catch {
		return failed(bound, 1, failure('driver_failed'), context.reporter)
	}
	return failed(bound, 1, outcome, context.reporter)
}

/** Read afresh at each call: the signal may abort while the caller awaits. */
const isStopped = (stop: AbortSignal | undefined): boolean => stop?.aborted === true

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
	stop?: AbortSignal,
): Promise<JobFailure | null> {
	if (isStopped(stop)) {
		return failure('stopped')
	}
	// The job's authority is what IAM signs for its key at the start of the attempt; a revoked key stops the next one.
	const authority = await job.credential.authority()
	if (isStopped(stop)) {
		return failure('stopped')
	}
	if (!authority.ok) {
		return failure(authority.reason === 'unavailable' ? 'iam_unavailable' : 'unauthorized')
	}
	const frame = new RequestFrame(fence.holder, { fence })
	const cancel = new AbortController()
	const timer = new AbortController()
	const signal = stop === undefined ? cancel.signal : AbortSignal.any([cancel.signal, stop])
	const ctx = jobContext(job, frame, attempt, signal, context, authority.perms)
	try {
		const ran = runInRequest(frame, async () => {
			await job.handler({ ctx })
		}).then(() => null, (error: unknown) => {
			const failed = failureOf(error, job.mailer === null ? null : (context.mail[job.mailer]?.sender.capabilities ?? null))
			if (failed.code === 'handler_failed') context.revealHandlerErrors?.(`job '${job.name}' attempt ${attempt}`, error)
			return failed
		})
		const timeout = clock.wait(job.timeoutMs, timer.signal).then((): typeof TIMED_OUT => TIMED_OUT)
		const stopped = new Promise<JobFailure>((resolve) => {
			if (stop?.aborted === true) {
				resolve(failure('stopped'))
			}
			stop?.addEventListener('abort', () => resolve(failure('stopped')), { once: true, signal: timer.signal })
		})
		const result = await Promise.race([ran, timeout, stopped])
		return result === TIMED_OUT ? failure('timeout') : result
	} finally {
		frame.end()
		cancel.abort()
		timer.abort()
		await context.leases.cancelInFlight(fence)
	}
}

/** What a job without a declared transport sends through, if it sends at all: nothing it promises, so nothing is resent. */
const UNKNOWN_TRANSPORT: EmailSenderCapabilities = Object.freeze({ idempotent: false, confirmation: 'queued', maxBatch: 1 })

/**
 * By class, never by name: an application error can call itself anything. A refusal is classified as a request's is
 * (`failureCode`), so both name it alike; every other thrown value is `handler_failed`.
 */
function failureOf(error: unknown, transport: EmailSenderCapabilities | null): JobFailure {
	if (error instanceof LeaseLostError) {
		return failure('lease_lost')
	}
	if (error instanceof EmailDeliveryError) {
		const text = error.outcome === 'unknown' ? 'the transport may have accepted the message' : 'the transport did not send the message'
		// ADR-0019's one retry rule: a repeat over a non-idempotent transport may deliver the message twice.
		return { code: 'mail_failed', why: { reason: error.code, text }, final: !mayRetryDelivery(error, transport ?? UNKNOWN_TRANSPORT) }
	}
	const code = failureCode(error)
	return code === 'query_refused' || code === 'capability_refused'
		? { code, why: failureReason(error), thrown: error, final: false }
		: { code: 'handler_failed', why: null, thrown: error, final: false }
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
	/** A located `Ref`, read in `using` (a job's transaction, which sees what it wrote) or a statement of its own. */
	const ref = async <const Act extends string, const Dim extends string>(
		action: Act,
		dimension: Dim,
		id: string,
		using?: Session,
	): Promise<Ref<Dim, Act>> => {
		check(action, dimension)
		if (typeof id !== 'string' || id === '') {
			throw new CapabilityRefusedError('missing_id', `job '${job.name}' named an object without an id`)
		}
		const database = context.database
		const chain = database === null || !context.ownedDimensions.has(dimension) ? new Map<string, string>() : await database.locate(dimension, id, using)
		if (chain === null) {
			throw new NotFoundError('Not found')
		}
		return context.mint.ref(frame, dimension, action, principal.id, id, chain)
	}
	return Object.freeze({
		principal,
		runId: frame.id,
		attempt,
		signal,
		...(job.site === null || context.data === null ? {} : kitJobContext(frame, context.data, context.files, job.name, job.site, principal.id, ref)),
		...(job.links === null || context.membership === null ? {} : { links: jobLinksOf(job, job.links, context.membership, frame, context) }),
		...(job.mailer === null ? {} : { mail: jobMailOf(job, job.mailer, frame, signal, context) }),
		within<const Act extends string, const Dim extends string>(action: Act, dimension: Dim): Within<Dim, Act> {
			check(action, dimension)
			return context.mint.within(frame, dimension, action, principal.id, 'all')
		},
		ref<const Act extends string, const Dim extends string>(action: Act, dimension: Dim, id: string): Promise<Ref<Dim, Act>> {
			return ref(action, dimension, id)
		},
	})
}

/** `ctx.links` of a job that issues: IAM is asked with the job's current token, under the attempt's id. */
function jobLinksOf(job: BoundJob, mount: JobLinkMount, iam: IamMembership, frame: RequestFrame, context: RunnerContext): object {
	// An attempt that timed out or lost its lease asks IAM nothing: its replacement may already have acted.
	const assertLive = (): void => {
		if (frame.ended) {
			throw new CapabilityRefusedError('ended', `attempt ${frame.id} of job '${job.name}' has ended; it asks IAM for no link`)
		}
	}
	return jobLinkIssuing({
		iam,
		job: job.name,
		mount,
		containers: context.containers.get(mount.dimension) ?? [],
		capabilities: context.capabilities,
		assertLive,
		async caller() {
			assertLive()
			const authority = await job.credential.authority()
			if (!authority.ok) {
				throw new ServerFault(
					authority.reason === 'unavailable' ? 'iam_unavailable' : 'workload_unauthorized',
					`IAM signs no token for the key of job '${job.name}'`,
					503,
				)
			}
			return { credential: authority.token, requestId: frame.id }
		},
	})
}

/** `ctx.mail` of a job that declares `mailer`: the transport `boot` resolved for it, until the attempt ends. */
function jobMailOf(job: BoundJob, mailer: JobMailer, frame: RequestFrame, signal: AbortSignal, context: RunnerContext): AppMail {
	const transport = context.mail[mailer]
	if (transport === null) {
		throw new ServerFault('facility_unbound', `job '${job.name}' declares mailer: '${mailer}', and boot resolved no transport for it`)
	}
	return jobMail({
		transport,
		keyPrefix: context.mail.keyPrefix,
		signal,
		assertLive: () => {
			if (frame.ended) {
				throw new CapabilityRefusedError('ended', `attempt ${frame.id} of job '${job.name}' has ended; it sends no mail`)
			}
		},
	})
}

/**
 * What a staged-kit job adds: `ctx.db`, whose reads run each on its own, and `ctx.transaction(work)`, the one place it
 * writes and runs `tx.sql` — fenced by the attempt's lease, so an attempt that timed out or lost it commits nothing.
 */
function kitJobContext(
	frame: RequestFrame,
	data: DataAccess,
	files: FileCollections | null,
	name: string,
	site: SiteDeclaration,
	principal: string,
	ref: (action: string, dimension: string, id: string, using: Session) => Promise<Ref<string, string>>,
): Readonly<Record<string, unknown>> {
	const reads = jobHandles(frame, data, site, principal, 'job', async () => data.direct(), () => false)
	const job = `job '${name}'`
	return {
		db: siteData(reads),
		sql: site.sql === null ? undeclaredSql(job, 'job') : jobSqlOutsideTransaction(job),
		files: files === null ? noFileCollections(job) : files.site({
			where: job,
			frame,
			check: boundTo(frame, () => false, 'ctx.files'),
			session: async () => data.direct(),
			readOnly: 'a job removes files inside ctx.transaction((tx) => …), as tx.files',
			attaches: false,
		}),
		transaction: async <R>(work: (tx: object) => Promise<R>): Promise<R> => {
			// Outside its attempt there is no lease to fence the transaction with, so it never opens.
			boundTo(frame, () => false)()
			return data.transaction(async (session) => {
				let open = true
				const writes = jobHandles(frame, data, site, principal, 'mutation', async () => session, () => !open)
				try {
					const sql = site.sql === null ? undeclaredSql(job, 'job', 'tx.sql') : jobSql(frame, data, site.sql, session, () => !open)
					const removing = files === null
						? noFileCollections(job)
						: files.site({
							where: job,
							frame,
							check: boundTo(frame, () => !open, 'tx.files'),
							session: async () => session,
							readOnly: null,
							attaches: true,
						})
					// Located in this transaction, so an object it wrote is found before the commit.
					const located = (action: string, dimension: string, id: string) => {
						boundTo(frame, () => !open, 'tx.ref')()
						return ref(action, dimension, id, session)
					}
					return await work(Object.freeze({ db: siteData(writes), sql, files: removing, ref: located }))
				} finally {
					open = false
				}
			})
		},
	}
}
