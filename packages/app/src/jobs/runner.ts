// The job runner (`fabrika job run <name>`): one run of one `c.cron` job. A run takes the job's lease or does not
// start; each attempt holds one generation of it with a deadline the database enforces, so a write of an attempt
// that timed out, failed or lost the lease never commits (`@fabrika/db`'s fence). A site's `ctx.kick` sends a run in
// the background after its commit, without waiting for any lock; a kick that finds the lease held leaves the shared pending flag, and the run
// holding it runs once more after it succeeded. Failures, crashed runs and a job that stopped succeeding are reported
// to Operations, each under a fixed failure code. On Cloudflare the object's alarm drives the jobs through `scheduler`:
// a run it starts owns the job's due wakes, and when it fails they move to a durable retry instead of an inline one.

import type { IamMembership } from '@fabrika/auth'
import { type ContractArtifact, JOB_SITE_PREFIX, type JobArtifact, type JobMailer, type PermissionEntry, permits } from '@fabrika/auth-core'
import type { CapabilityAuthority } from '@fabrika/db/capability'
import {
	type DataAccess,
	type FinishWakes,
	type FrameworkTables,
	type JobLeases,
	type JobWakes,
	type LeaseFence,
	LeaseLostError,
	type Session,
	type Wake,
} from '@fabrika/db/framework'
import { EmailDeliveryError, type EmailSenderCapabilities, mayRetryDelivery } from '@fabrika/email'
import { uuidv7 } from '@fabrika/platform'
import { NotFoundError } from '../errors'
import { FileWork, type StoredFileKinds, storedFilesHandle } from '../files/kinds'
import {
	type AppCapability,
	type CapabilityMint,
	CapabilityRefusedError,
	type Ref,
	RequestFrame,
	runInRequest,
	type Within,
} from '../implement/capability'
import { admitInvocation, type InvocationAdmission } from '../implement/dispatch'
import { runAsSite } from '../implement/egress'
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
	type KickRecorder,
	kickRecorder,
	siteData,
	type SiteDeclaration,
	undeclaredSql,
} from '../implement/invocation'
import { jobLinkIssuing, type JobLinkMount } from '../implement/membership'
import type { SignedTokens } from '../implement/tokens'
import { type AppUrl, appUrl } from '../implement/urls'
import { type WorkloadAuthority, type WorkloadCredential, workloadSite } from '../implement/workload'
import { jobMail, type MailTransports } from './mail'
import type { OperationsReporter } from './report'
import { type CronSchedule, isDueAt, parseCron, periodAt } from './schedule'
import type { AppMail, JobContext, JobPrincipal } from './types'

/**
 * The lease outlives an attempt's deadline by this much: the runner renews or finishes a timed-out attempt's lease,
 * and no other run takes it over meanwhile. The attempt's writes stop at its deadline regardless.
 */
export const LEASE_GRACE_MS = 60_000
/** How often the serving process checks every job for a crashed run and for a schedule that stopped. */
export const JOB_CHECK_INTERVAL_MS = 60_000
/**
 * A run the Cloudflare alarm started has one segment (`CLOUDFLARE_MAX_JOB_SEGMENT_MS`): its attempt ends this much
 * before the segment, at most a tenth of it, so the finish runs inside the segment too.
 */
export const SEGMENT_FINISH_RESERVE_MS = 30_000
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 5 * 60_000

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
	/** The process stopped a kicked run while shutting down, or the object's maintenance stopped a run; the schedule runs it again. */
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
	/** Epoch milliseconds: what an attempt's deadline is measured on; `Date.now()` when absent. */
	now?(): number
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
	/** Every job bound to run, the framework's included, with its schedule: what a minute tick runs when due. */
	readonly scheduled: readonly { readonly name: string; readonly schedule: CronSchedule }[]
	run(name: string, options?: JobRunOptions): Promise<JobRunResult>
	/**
	 * Registers every job (its first-seen time), reports a run that crashed and a job that has not succeeded within
	 * twice its period. The serving process calls it every `JOB_CHECK_INTERVAL_MS`; it never throws.
	 */
	check(options?: Pick<JobRunOptions, 'reporter'>): Promise<void>
	/**
	 * The serving process's wake timer on Bun, where crontab runs the schedule: reaps a crashed holder of every job and
	 * kicks each contract job with a due wake through the kick path, handing each kick to `track` until it ended. Answers
	 * how long until a wake is due next on the database's clock (0 while one still is), `null` when none is pending. The
	 * first call deletes the wakes of jobs the contract no longer declares.
	 */
	wake(track: (kick: Promise<void>) => void): Promise<number | null>
	/** What the Cloudflare object's alarm drives the jobs through; `null` without `@fabrika/db`. */
	readonly scheduler: JobScheduler | null
}

/** What the scheduler's `take` did for one job in the alarm's transaction. */
export interface TakenLease {
	/** The lease a run of the job now holds, for `run`; `null` when nothing was due or another run holds it. */
	readonly fence: LeaseFence | null
	/** Whether a crashed holder's lease was freed: `crashed` reports it once the transaction committed. */
	readonly reaped: boolean
}

/**
 * The jobs as the Cloudflare object's alarm drives them (ADR-0065 §5): over the wakes and leases of the object's
 * storage, every time on the database's clock. The object holds the transactions and arms the alarm.
 */
export interface JobScheduler {
	/** Every job bound to run, the framework's included. */
	readonly jobs: readonly string[]
	/**
	 * Startup repair: reaps and reports every crashed run, of a job the contract no longer declares too; registers every
	 * job and surveils it (as `check`), deletes the wakes of jobs the contract no longer declares and the cron wakes of a
	 * changed expression, and keeps one cron wake per job at its next fire; an overdue one stays, so missed runs coalesce
	 * into one. `false` when the object's barrier admits no job.
	 */
	repair(options?: Pick<JobRunOptions, 'reporter'>): Promise<boolean>
	/** The jobs the contract no longer declares whose lease a crashed run still holds: `take` reaps them. */
	orphans(): Promise<readonly string[]>
	/** How long until every wake due within `withinMs` of the database's clock is due; 0 when none is early. */
	earlyBy(withinMs: number): Promise<number>
	/**
	 * Reaps a crashed holder of `job`'s lease, then, when one of its wakes is due, takes the lease, or sets the pending
	 * flag for the run holding it; of a job no longer declared (an orphan), only reaps. Statements only, for the caller's
	 * one transaction.
	 */
	take(job: string): Promise<TakenLease>
	/** Runs `job` under the lease `take` took. A failed run retries the wakes it owns durably. */
	run(job: string, fence: LeaseFence, options?: JobRunOptions): Promise<JobRunResult>
	/** Reports the crashed run `take` reaped. */
	crashed(job: string, options?: Pick<JobRunOptions, 'reporter'>): Promise<void>
	/** When the scheduler wakes next: `JobWakes.next`, read in `using` when given. */
	next(using?: Session): Promise<Date | null>
	/** Reports a failure of the scheduler itself: the alarm's or the repair's. Never rejects. */
	failed(step: 'alarm' | 'repair', error: unknown): Promise<void>
}

/** A run that cannot start: an unknown job. Its message is framework-authored. */
export class JobError extends Error {
	override readonly name = 'JobError'
}

export const systemClock: JobClock = Object.freeze({
	now: () => Date.now(),
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
	/** The jobs' pending wakes, which a run's finish consumes, retries or schedules. */
	readonly wakes: JobWakes
	readonly reporter: OperationsReporter
	readonly mint: CapabilityMint
	readonly data: DataAccess | null
	readonly fileKinds: StoredFileKinds | null
	readonly membership: IamMembership | null
	readonly capabilities: CapabilityAuthority
	readonly containers: ReadonlyMap<string, readonly string[]>
	readonly revealHandlerErrors: HandlerErrorSink | null
	readonly mail: MailTransports
	/** Kicks a contract job in the background: what a job's own `ctx.kick` sends once its run succeeded. */
	readonly kick: (name: string) => Promise<void>
	/** The environment's signed tokens: `ctx.tokens` of a job that declares `signs`. */
	readonly tokens: SignedTokens | null
	readonly url: AppUrl
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
	/** The contract's file kinds, behind a staged-kit job's `ctx.files.put` and `.open`; `null` without any. */
	readonly fileKinds?: StoredFileKinds | null
	/** The framework's own jobs this contract needs: the scan of its `scan: true` file kinds, and the file sweep. */
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
	/** The environment's signed tokens, which a job that declares `signs` signs with. */
	readonly tokens?: SignedTokens
	/** `ctx.url`: absolute links to the application's own procedures; without it every link is refused. */
	readonly url?: AppUrl
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
	 * Kicks the contract job `name`, as a site's `ctx.kick` does after its commit: a run under the job's own key
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
		const node = ownChild(tree, name)
		const handler = isSiteHandler(node) ? node.handler : node
		const site = isSiteHandler(node) ? approvedDeclaration(where, `${JOB_SITE_PREFIX}${name}`, node.declared, 'job', input.artifact, problems) : null
		const credential = input.credentials.get(workloadSite('job', name))
		const links = jobLinks(where, `${JOB_SITE_PREFIX}${name}`, site, input, problems)
		const mailer = input.artifact.declared?.[`${JOB_SITE_PREFIX}${name}`]?.mailer ?? null
		if (typeof handler !== 'function') {
			problems.push(`${where} has no handler; add it to handlers.jobs`)
		} else if (site !== null && input.data === null) {
			problems.push(`${where} reaches data through ctx.db, which runs on @fabrika/db: pass serve(contract, { database: scoped(tables) })`)
		} else if (schedule !== null && credential !== undefined) {
			bound.set(name, {
				name,
				artifact,
				schedule,
				timeoutMs: artifact.timeoutMs,
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
	const declaredJobs: readonly (Scheduled & { readonly timeoutMs: number })[] = [
		...[...bound.values()].map((job) => ({ name: job.name, expression: job.artifact.schedule, schedule: job.schedule, timeoutMs: job.timeoutMs })),
		...[...frameworkJobs.values()].map((own) => ({
			name: own.name,
			expression: own.job.schedule,
			schedule: own.schedule,
			timeoutMs: own.job.timeoutMs,
		})),
	]
	let reconciled = false
	const contextFor = (tables: FrameworkTables, chosen: OperationsReporter | undefined): RunnerContext => ({
		artifact: input.artifact,
		database: input.database,
		ownedDimensions: input.ownedDimensions,
		leases: tables.jobs,
		wakes: tables.wakes,
		reporter: chosen ?? input.reporter,
		mint: input.mint,
		data: input.data,
		fileKinds: input.fileKinds ?? null,
		membership: input.membership,
		capabilities: input.capabilities,
		containers: input.containers,
		revealHandlerErrors: input.revealHandlerErrors ?? null,
		mail: input.mail,
		tokens: input.tokens ?? null,
		url: input.url ?? appUrl(input.artifact, null),
		// A job's kicks run only after the job is bound, so `kick` below is defined by then.
		kick: (name: string) => kick(name),
	})
	const jobs: ContractJobs = Object.freeze({
		names,
		scheduled: Object.freeze([...bound.values(), ...frameworkJobs.values()].map(({ name, schedule }) => ({ name, schedule }))),
		run(name: string, options: JobRunOptions = {}): Promise<JobRunResult> {
			const own = frameworkJobs.get(name)
			if (own !== undefined && framework !== null) {
				return admitted(
					'framework-job',
					name,
					(control) => runFrameworkJob(own, contextFor(framework, options.reporter), options.clock ?? systemClock, control, null),
				)
			}
			const job = bound.get(name)
			if (job === undefined || framework === null) {
				throw new JobError(`no job '${name}' in the contract (jobs: ${names.length === 0 ? 'none' : names.join(', ')})`)
			}
			return admitted(
				'job',
				name,
				(control) => runJob(job, contextFor(framework, options.reporter), options.clock ?? systemClock, 'wait', control, 'inline'),
			)
				.then((result) => {
					if (result.status === 'skipped') {
						console.error(`fabrika: a previous run of job '${name}' still holds its lease; this run does not start`)
					}
					return result
				})
		},
		async check(options: Pick<JobRunOptions, 'reporter'> = {}): Promise<void> {
			const admission = framework === null ? null : admitInvocation('framework-job')
			if (framework === null || admission === null) {
				return
			}
			try {
				const context = contextFor(framework, options.reporter)
				for (const job of [...bound.values(), ...frameworkJobs.values()]) {
					try {
						await context.leases.register(job.name)
						await surveil(job, context)
					} catch {
						// A driver error may quote the database URL.
						console.error(`fabrika: the check of job '${job.name}' failed: driver_failed`)
					}
				}
			} finally {
				admission.release()
			}
		},
		async wake(track: (kick: Promise<void>) => void): Promise<number | null> {
			if (framework === null) {
				return null
			}
			if (!reconciled) {
				await framework.wakes.reconcile(declaredJobs.map((job) => ({ job: job.name, expression: job.expression })))
				reconciled = true
			}
			// A crashed holder's expiry is a wake too, and a kick never takes a lease over.
			for (const job of declaredJobs) {
				if (await framework.jobs.reapCrashed(job.name)) {
					await reportCrashed(job.name, input.reporter)
				}
			}
			const now = (await framework.jobs.now()).getTime()
			for (const job of bound.values()) {
				const due = (await framework.wakes.pending(job.name)).filter((wake) => wake.dueAt.getTime() <= now)
				if (due.length > 0 && !(await ownedByHolder(job.name, due, framework.jobs))) {
					track(kick(job.name))
				}
			}
			const next = await framework.wakes.next()
			return next === null ? null : Math.max(0, next.getTime() - now)
		},
		scheduler: framework === null ? null : jobScheduler({
			framework,
			declared: declaredJobs,
			contextFor: (reporter) => contextFor(framework, reporter),
			run(name: string, fence: LeaseFence, options: JobRunOptions): Promise<JobRunResult> {
				const clock = options.clock ?? systemClock
				const context = contextFor(framework, options.reporter)
				const own = frameworkJobs.get(name)
				if (own !== undefined) {
					return admitted('framework-job', name, (control) => runFrameworkJob(own, context, clock, control, fence))
				}
				const job = bound.get(name)
				if (job === undefined) {
					throw new JobError(`no job '${name}' in the contract (jobs: ${names.length === 0 ? 'none' : names.join(', ')})`)
				}
				return admitted('job', name, (control) => runJob(job, context, clock, { fence }, control, 'durable'))
			},
		}),
	})
	const stopping = new AbortController()
	const kick = async (name: string): Promise<void> => {
		const job = bound.get(name)
		if (job === undefined || framework === null) {
			return
		}
		const admission = admitInvocation('kick')
		if (admission === null) {
			// A kick hurries a run; the schedule still runs the job once the object opens.
			console.error(`fabrika: job '${name}' was not kicked: the object is in maintenance`)
			return
		}
		try {
			await kickOnce(job, contextFor(framework, undefined), {
				signal: AbortSignal.any([admission.signal, stopping.signal]),
				track: admission.track,
			})
		} finally {
			admission.release()
		}
	}
	return { jobs, declared, kick, stopKicks: () => stopping.abort() }
}

/**
 * What stops one run, and where the handler work that outlives its attempt is counted: the run's admission at the
 * object's barrier, which a drain aborts, and for a kick also the process's stop.
 */
type RunControl = Pick<InvocationAdmission, 'signal' | 'track'>

/** A run admitted at the current event's gate, released once it ended; a refused one is `stopped` and starts nothing. */
async function admitted(kind: 'job' | 'framework-job', name: string, run: (control: RunControl) => Promise<JobRunResult>): Promise<JobRunResult> {
	const admission = admitInvocation(kind)
	if (admission === null) {
		console.error(`fabrika: job '${name}' did not start: the object is in maintenance; its schedule runs it again`)
		return { status: 'failed', attempts: 0, code: 'stopped' }
	}
	try {
		return await run(admission)
	} finally {
		admission.release()
	}
}

/**
 * One kick: a run while the lease is free, else the shared pending flag. Neither waits for a lock, so a kick never
 * holds a connection requests share while a run writes. After a failed run the flag stays for the schedule.
 */
async function kickOnce(job: BoundJob, context: RunnerContext, control: RunControl): Promise<void> {
	if (control.signal.aborted) {
		// The flag waits for no lock, and another process that is not stopping runs the job.
		await markPending(job, context)
		return
	}
	if ((await runJob(job, context, systemClock, 'try', control, 'inline')).status === 'skipped') {
		await handOver(job, context, systemClock, control, 'inline')
	}
}

/**
 * Leaves the flag to the run holding the lease, which takes it after it succeeded. That run may have finished before
 * the flag was set, so the lease is tried once more; `null` when another run still holds it.
 */
async function handOver(job: BoundJob, context: RunnerContext, clock: JobClock, control: RunControl, retries: Retries): Promise<JobRunResult | null> {
	if (!(await markPending(job, context))) {
		return null
	}
	const result = await runJob(job, context, clock, 'try', control, retries)
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

const attemptId = (): string => uuidv7()

/** Exponential from one second, capped at five minutes, with half of it jittered. */
function backoffMs(attempt: number, random: number): number {
	const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1))
	return Math.round(ceiling / 2 + (ceiling / 2) * random)
}

const nowOf = (clock: JobClock): number => clock.now?.() ?? Date.now()

/** How much of a segment that ends at `deadline` is left, never below zero. */
const remainingMs = (clock: JobClock, deadline: number): number => Math.max(0, deadline - nowOf(clock))

const finishReserveMs = (timeoutMs: number): number => Math.min(SEGMENT_FINISH_RESERVE_MS, Math.floor(timeoutMs / 10))

const OUT_OF_SEGMENT: unique symbol = Symbol('fabrika.job.outOfSegment')

/**
 * `step` while the segment that ends at `end` lasts (always, without one). Past its end the run stops waiting for it;
 * only a step that is safe to abandon goes here: a read, or the refusal of the attempt's writes, never a finish.
 */
async function withinSegment<T>(clock: JobClock, end: number | null, step: Promise<T>): Promise<T | typeof OUT_OF_SEGMENT> {
	if (end === null) {
		return await step
	}
	const timer = new AbortController()
	// Abandoned past the segment, its rejection is nobody's: the race below still answers it while it is awaited.
	step.catch(() => undefined)
	try {
		return await Promise.race([step, clock.wait(remainingMs(clock, end), timer.signal).then((): typeof OUT_OF_SEGMENT => OUT_OF_SEGMENT)])
	} finally {
		timer.abort()
	}
}

/** A run whose segment ended before its finish started: its lease expires, the reap reports the crash, and the alarm runs it again. */
function outOfSegment(job: { readonly name: string }, attempts: number): JobRunResult {
	console.error(`fabrika: job '${job.name}' reached the end of its segment before its finish; its lease expires and the alarm runs it again`)
	return { status: 'failed', attempts, code: 'timeout' }
}

const MINUTE_MS = 60_000
/** How far ahead a next fire is looked for, as far as `previousDue` looks back. */
const NEXT_FIRE_DAYS = 366 * 5

/** The first due minute of `schedule` after `after`, or `null` when none falls in the window. */
function nextFire(schedule: CronSchedule, after: Date): Date | null {
	const hours = [...schedule.hours].sort((left, right) => left - right)
	const minutes = [...schedule.minutes].sort((left, right) => left - right)
	const [firstHour, firstMinute] = [hours[0], minutes[0]]
	if (firstHour === undefined || firstMinute === undefined) {
		return null
	}
	const today = Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate())
	for (let ahead = 0; ahead <= NEXT_FIRE_DAYS; ahead++) {
		const day = today + ahead * 24 * 60 * MINUTE_MS
		// The day's first scheduled minute is due exactly when the day matches.
		if (!isDueAt(schedule, new Date(day + (firstHour * 60 + firstMinute) * MINUTE_MS))) {
			continue
		}
		for (const hour of hours) {
			for (const minute of minutes) {
				const time = day + (hour * 60 + minute) * MINUTE_MS
				if (time > after.getTime()) {
					return new Date(time)
				}
			}
		}
	}
	return null
}

/** A cron wake's dedupe key: one pending wake per job and expression. */
const cronKey = (job: string, expression: string): string => `cron:${job}:${expression}`

/** A job's schedule as the scheduler and a finish read it. */
interface Scheduled {
	readonly name: string
	/** The cron expression as declared: its wake's key. */
	readonly expression: string
	readonly schedule: CronSchedule
}

/**
 * Whether a run holds `job`'s lease and owns every wake of `due`, each due at or before its start: its finish consumes
 * them, so a kick or a pending run for them would only repeat that run. A post-commit kick's run usually owns its wake.
 */
async function ownedByHolder(job: string, due: readonly Wake[], leases: JobLeases): Promise<boolean> {
	const state = await leases.state(job)
	const started = state === null || state.holder === null ? null : state.lastStartedAt
	return started !== null && due.every((wake) => wake.dueAt.getTime() <= started.getTime())
}

/** The wakes the run holding `job`'s lease owns: those due at or before its start, on the database's clock. */
async function ownedWakes(job: string, context: RunnerContext): Promise<readonly Wake[]> {
	const started = (await context.leases.state(job))?.lastStartedAt ?? null
	return started === null ? [] : (await context.wakes.pending(job)).filter((wake) => wake.dueAt.getTime() <= started.getTime())
}

/**
 * What a finish does with the owned wakes when the run is done with them, succeeded or failed past its retries: they
 * are consumed, and when the job keeps a cron wake (always, for a run the alarm started) its next fire is scheduled
 * under its key. On Bun, where crontab runs the schedule, a job keeps none.
 */
async function completion(job: Scheduled, context: RunnerContext, durable: boolean): Promise<FinishWakes> {
	if (!durable && !(await context.wakes.pending(job.name)).some((wake) => wake.reason === 'cron')) {
		return { kind: 'completed' }
	}
	const dueAt = nextFire(job.schedule, await context.leases.now())
	return dueAt === null ? { kind: 'completed' } : { kind: 'completed', nextCron: { expression: job.expression, dueAt } }
}

/** A crashed run (its lease expired before it finished): one report. */
async function reportCrashed(job: string, reporter: OperationsReporter): Promise<void> {
	const message = `job '${job}' failed: crashed (its run's lease expired before the run finished)`
	console.error(`fabrika: ${message}`)
	await reporter.report({ fingerprint: ['fabrika-job-failed', job], type: 'JobFailed', message, tags: { job, code: 'crashed' } })
}

/** A crashed run (its lease expired before it finished) and a job overdue by twice its period: one report each. */
async function surveil(job: { readonly name: string; readonly schedule: CronSchedule }, context: RunnerContext): Promise<void> {
	const tags = { job: job.name }
	if (await context.leases.reapCrashed(job.name)) {
		await reportCrashed(job.name, context.reporter)
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

interface SchedulerInput {
	readonly framework: FrameworkTables
	/** Every job bound to run, with the attempt time its lease is taken for. */
	readonly declared: readonly (Scheduled & { readonly timeoutMs: number })[]
	readonly contextFor: (reporter: OperationsReporter | undefined) => RunnerContext
	readonly run: (job: string, fence: LeaseFence, options: JobRunOptions) => Promise<JobRunResult>
}

function jobScheduler(input: SchedulerInput): JobScheduler {
	const { framework, declared } = input
	const byName = new Map(declared.map((job) => [job.name, job]))
	return Object.freeze({
		jobs: Object.freeze(declared.map((job) => job.name)),
		async repair(options: Pick<JobRunOptions, 'reporter'> = {}): Promise<boolean> {
			const admission = admitInvocation('framework-job')
			if (admission === null) {
				return false
			}
			try {
				const context = input.contextFor(options.reporter)
				for (const job of await framework.wakes.expiredHolders()) {
					if (await context.leases.reapCrashed(job)) {
						await reportCrashed(job, context.reporter)
					}
				}
				for (const job of declared) {
					await context.leases.register(job.name)
					await surveil(job, context)
				}
				await framework.wakes.reconcile(declared.map((job) => ({ job: job.name, expression: job.expression })))
				const now = await context.leases.now()
				for (const job of declared) {
					const dueAt = nextFire(job.schedule, now)
					if (dueAt !== null) {
						await framework.wakes.schedule({ job: job.name, reason: 'cron', dueAt, dedupe: cronKey(job.name, job.expression) })
					}
				}
				return true
			} finally {
				admission.release()
			}
		},
		async orphans(): Promise<readonly string[]> {
			return (await framework.wakes.expiredHolders()).filter((job) => !byName.has(job))
		},
		async earlyBy(withinMs: number): Promise<number> {
			const now = (await framework.jobs.now()).getTime()
			let early = 0
			for (const job of declared) {
				for (const wake of await framework.wakes.pending(job.name)) {
					const ahead = wake.dueAt.getTime() - now
					if (ahead <= withinMs) {
						early = Math.max(early, ahead)
					}
				}
			}
			return early
		},
		async take(name: string): Promise<TakenLease> {
			const job = byName.get(name)
			const leases = framework.jobs
			if (job === undefined) {
				// A removed job runs no more; only a crashed run's lease is freed, so it stops arming the alarm.
				return { fence: null, reaped: await leases.reapCrashed(name) }
			}
			await leases.register(name)
			const reaped = await leases.reapCrashed(name)
			const now = (await leases.now()).getTime()
			const due = (await framework.wakes.pending(name)).filter((wake) => wake.dueAt.getTime() <= now)
			if (due.length === 0) {
				return { fence: null, reaped }
			}
			const fence = await leases.tryAcquire(name, attemptId(), job.timeoutMs, job.timeoutMs + LEASE_GRACE_MS)
			if (fence === null && !(await ownedByHolder(name, due, leases))) {
				// The run holding the lease runs once more after it succeeded; a wake it did not own stays pending.
				await leases.markPending(name)
			}
			return { fence, reaped }
		},
		run(job: string, fence: LeaseFence, options: JobRunOptions = {}): Promise<JobRunResult> {
			return input.run(job, fence, options)
		},
		async crashed(job: string, options: Pick<JobRunOptions, 'reporter'> = {}): Promise<void> {
			await reportCrashed(job, input.contextFor(options.reporter).reporter)
		},
		next(using?: Session): Promise<Date | null> {
			return framework.wakes.next(using)
		},
		async failed(step: 'alarm' | 'repair', error: unknown): Promise<void> {
			try {
				await input.contextFor(undefined).reporter.report({
					fingerprint: ['fabrika-alarm-failed', step],
					type: 'AlarmFailed',
					message: `the job scheduler's ${step} failed`,
					tags: { step },
					error,
				})
			} catch {
				console.error(`fabrika: the failure of the job scheduler's ${step} could not be reported`)
			}
		},
	})
}

interface Progress {
	attempts: number
}

/** What the attempt that succeeded kicked: `null` until a handler returned. */
interface Kicked {
	recorder: KickRecorder | null
}

/**
 * How a run takes the lease: `wait` is `fabrika job run`'s, in a process of its own; `try` is a kick's and a follow-up
 * run's, which never wait for a lock; a fence is one the alarm's scheduler already took.
 */
type Acquisition = 'wait' | 'try' | { readonly fence: LeaseFence }

/**
 * How a failed attempt is retried: `inline` in the same run, after a backoff, under a renewed lease; `durable` (a run the
 * Cloudflare alarm started) by moving the wakes it owns to a later due time, so the alarm runs it again. A durable run
 * that owns no wake retries inline: there is nothing to move.
 */
type Retries = 'inline' | 'durable'

/**
 * A run of the job, then one more while a kick arrived after the last one started and it succeeded. Once the run's
 * control aborted, no follow-up run starts: the pending flag stays for the schedule.
 */
async function runJob(
	job: BoundJob,
	context: RunnerContext,
	clock: JobClock,
	acquisition: Acquisition,
	control: RunControl,
	retries: Retries,
): Promise<JobRunResult> {
	let result = await runOnce(job, context, clock, acquisition, control, retries)
	while (result.status === 'succeeded' && !control.signal.aborted && (await pendingTaken(job, context))) {
		const next = await runOnce(job, context, clock, 'try', control, retries)
		if (next.status !== 'skipped') {
			result = next
			continue
		}
		// A newer run holds the lease and may have read before the kick's row: the flag goes back to it.
		const handed = await handOver(job, context, clock, control, retries)
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

async function runOnce(
	job: BoundJob,
	context: RunnerContext,
	clock: JobClock,
	acquisition: Acquisition,
	control: RunControl,
	retries: Retries,
): Promise<JobRunResult> {
	const progress: Progress = { attempts: 0 }
	try {
		return await runLeased(job, context, clock, progress, acquisition, control, retries)
	} catch {
		if (control.signal.aborted) {
			// A stopped run's lease write is refused by the object's write fence; the lease expires and the schedule runs it.
			console.error(`fabrika: job '${job.name}' stopped before it released its lease; its schedule runs it again`)
			return { status: 'failed', attempts: progress.attempts, code: 'stopped' }
		}
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
	control: RunControl,
	retries: Retries,
): Promise<JobRunResult> {
	const { leases } = context
	const leaseMs = job.timeoutMs + LEASE_GRACE_MS
	let fence: LeaseFence | null
	if (typeof acquisition === 'object') {
		fence = acquisition.fence
	} else {
		await leases.register(job.name)
		if (control.signal.aborted) {
			return { status: 'skipped' }
		}
		if (acquisition === 'wait') {
			await surveil(job, context)
			fence = await leases.acquire(job.name, attemptId(), job.timeoutMs, leaseMs)
		} else {
			fence = await leases.tryAcquire(job.name, attemptId(), job.timeoutMs, leaseMs)
		}
	}
	if (fence === null) {
		return { status: 'skipped' }
	}
	// The segment is measured from the lease, as the database's attempt deadline is. A run the alarm started has one
	// segment: its attempts end before it by the finish's reserve, and no finish starts past it.
	const segmentEnd = retries === 'durable' ? nowOf(clock) + job.timeoutMs : null
	const attemptEnd = (
		start: number,
	): number => (segmentEnd === null ? start + job.timeoutMs : Math.min(start + job.timeoutMs, segmentEnd - finishReserveMs(job.timeoutMs)))
	let deadline = attemptEnd(nowOf(clock))
	// This run covers every kick before it: their rows committed before it reads.
	await pendingTaken(job, context)
	const owned = retries === 'durable' ? await ownedWakes(job.name, context) : []
	const durable = owned.length > 0
	const scheduled: Scheduled = { name: job.name, expression: job.artifact.schedule, schedule: job.schedule }
	const attempts = job.artifact.retries + 1
	progress.attempts = durable ? Math.max(...owned.map((wake) => wake.attempt)) + 1 : 1
	// The kicks of the succeeding attempt; a failed attempt's kicks are dropped with its writes.
	const kicked: Kicked = { recorder: null }
	let outcome = await attemptOnce(job, fence, progress.attempts, deadline, segmentEnd, clock, context, kicked, control)
	while (!durable && outcome !== null && outcome.code !== 'stopped' && !outcome.final && progress.attempts < attempts) {
		console.error(`fabrika: job '${job.name}' attempt ${progress.attempts} of ${attempts} failed: ${describeFailure(outcome)}`)
		const delay = backoffMs(progress.attempts, clock.random())
		// A new generation at once: nothing the failed attempt still has in flight commits from here on.
		const next = await leases.renew(fence, attemptId(), delay + job.timeoutMs, delay + leaseMs)
		if (next === null) {
			return failed(job, progress.attempts, failure('lease_lost'), context.reporter)
		}
		fence = next
		deadline = attemptEnd(nowOf(clock) + delay)
		await clock.wait(delay, control.signal)
		progress.attempts++
		outcome = await attemptOnce(job, fence, progress.attempts, deadline, segmentEnd, clock, context, kicked, control)
	}
	const held = fence
	// The finish, unless the segment ended first; a finish once started is awaited, as it may be committing.
	const finish = async (status: 'succeeded' | 'failed', wakes: Promise<FinishWakes | undefined>): Promise<boolean | typeof OUT_OF_SEGMENT> => {
		const applied = await withinSegment(clock, segmentEnd, wakes)
		if (applied === OUT_OF_SEGMENT || (segmentEnd !== null && remainingMs(clock, segmentEnd) === 0)) {
			return OUT_OF_SEGMENT
		}
		return await leases.finish(held, status, applied)
	}
	if (outcome === null) {
		// Before the finish, so a crash between it and a kick's start leaves the kick's wake to the scheduler.
		const kicks = kicked.recorder
		for (const wake of kicks?.wakes(await leases.now()) ?? []) {
			await context.wakes.schedule(wake)
		}
		const finished = await finish('succeeded', completion(scheduled, context, durable))
		if (finished === OUT_OF_SEGMENT) {
			return outOfSegment(job, progress.attempts)
		}
		if (finished) {
			// After the lease is released, so a job that kicks another never waits on its own lease; a kick never rejects.
			await Promise.all((kicks?.kicked() ?? []).map((name) => context.kick(name)))
			return { status: 'succeeded', attempts: progress.attempts }
		}
		return failed(job, progress.attempts, failure('lease_lost'), context.reporter)
	}
	if (outcome.code === 'stopped') {
		// Its wakes stay, so the alarm or the schedule runs it again. Not a failure of the job: Operations hears nothing.
		await leases.finish(fence, 'failed')
		console.error(`fabrika: job '${job.name}' stopped: the process is shutting down; its schedule runs it again`)
		return { status: 'failed', attempts: progress.attempts, code: 'stopped' }
	}
	if (durable && !outcome.final && progress.attempts < attempts) {
		const at = new Date(nowOf(clock) + backoffMs(progress.attempts, clock.random()))
		console.error(
			`fabrika: job '${job.name}' attempt ${progress.attempts} of ${attempts} failed: ${describeFailure(outcome)}; it runs again at ${at.toISOString()}`,
		)
		const finished = await finish('failed', Promise.resolve({ kind: 'retry', at }))
		if (finished === OUT_OF_SEGMENT) {
			return outOfSegment(job, progress.attempts)
		}
		if (!finished) {
			return failed(job, progress.attempts, failure('lease_lost'), context.reporter)
		}
		return outcome.why === null
			? { status: 'failed', attempts: progress.attempts, code: outcome.code }
			: { status: 'failed', attempts: progress.attempts, code: outcome.code, reason: outcome.why.reason }
	}
	// Past its retries a run is done with its wakes: the next cron fire is scheduled, a kick's wake removed.
	if ((await finish('failed', completion(scheduled, context, durable))) === OUT_OF_SEGMENT) {
		return outOfSegment(job, progress.attempts)
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

/**
 * One run of a framework job: its lease, one attempt in a frame fenced by it, and the outcome reported like a job's.
 * A run its control stopped is not a failure: the schedule runs it again. `acquired` is the lease the alarm's scheduler
 * took: such a run is done with the wakes it owns whether it succeeded or failed, as a framework job has no retries.
 */
async function runFrameworkJob(
	bound: BoundFrameworkJob,
	context: RunnerContext,
	clock: JobClock,
	control: RunControl,
	acquired: LeaseFence | null,
): Promise<JobRunResult> {
	const { leases } = context
	const scheduled: Scheduled = { name: bound.name, expression: bound.job.schedule, schedule: bound.schedule }
	let fence: LeaseFence | null = acquired
	try {
		if (fence === null) {
			await leases.register(bound.name)
			await surveil(bound, context)
			fence = await leases.acquire(bound.name, attemptId(), bound.job.timeoutMs, bound.job.timeoutMs + LEASE_GRACE_MS)
		}
	} catch {
		return failed(bound, 0, failure('driver_failed'), context.reporter)
	}
	if (fence === null) {
		console.error(`fabrika: a previous run of job '${bound.name}' still holds its lease; this run does not start`)
		return { status: 'skipped' }
	}
	// A run the alarm took the lease for has one segment, whose end is kept for the finish, as a contract job's.
	const segmentEnd = acquired === null ? null : nowOf(clock) + bound.job.timeoutMs
	const frame = new RequestFrame(fence.holder, { fence })
	const cancel = new AbortController()
	const timer = new AbortController()
	let outcome: JobFailure | null
	try {
		const ran = runInRequest(frame, () => bound.job.run(context.reporter, cancel.signal)).then(() => null, (error: unknown) => failureOf(error, null))
		control.track(ran)
		const budget = segmentEnd === null ? bound.job.timeoutMs : bound.job.timeoutMs - finishReserveMs(bound.job.timeoutMs)
		const timeout = clock.wait(budget, timer.signal).then((): typeof TIMED_OUT => TIMED_OUT)
		const result = await Promise.race([ran, timeout, stoppedBy(control, timer.signal)])
		outcome = result === TIMED_OUT ? failure('timeout') : result
	} finally {
		frame.end()
		timer.abort()
	}
	try {
		// Writes are refused before the run hears it was stopped: a scanner that answers on abort commits nothing.
		try {
			await withinSegment(clock, segmentEnd, leases.cancelInFlight(fence))
		} finally {
			cancel.abort()
		}
		// A stopped run keeps its wakes, so the alarm runs it again once the object opens.
		const done = outcome === null || (acquired !== null && outcome.code !== 'stopped')
		const wakes = await withinSegment(clock, segmentEnd, done ? completion(scheduled, context, acquired !== null) : Promise.resolve(undefined))
		if (wakes === OUT_OF_SEGMENT || (segmentEnd !== null && remainingMs(clock, segmentEnd) === 0)) {
			return outOfSegment(bound, 1)
		}
		// Awaited once started: a finish may be committing.
		const finished = await leases.finish(fence, outcome === null ? 'succeeded' : 'failed', wakes)
		if (outcome === null) {
			return finished ? { status: 'succeeded', attempts: 1 } : failed(bound, 1, failure('lease_lost'), context.reporter)
		}
	} catch {
		// A stopped run's lease write is refused by the object's write fence; the lease expires and the schedule runs it.
		if (!control.signal.aborted) {
			return failed(bound, 1, failure('driver_failed'), context.reporter)
		}
	}
	// Here a run without a failure of its own is one whose stop refused its lease write.
	if (outcome === null || outcome.code === 'stopped' || control.signal.aborted) {
		console.error(`fabrika: job '${bound.name}' stopped: the object entered maintenance; its schedule runs it again`)
		return { status: 'failed', attempts: 1, code: 'stopped' }
	}
	return failed(bound, 1, outcome, context.reporter)
}

/** Read afresh at each call: the signal may abort while the caller awaits. */
const isStopped = (control: RunControl): boolean => control.signal.aborted

/** Resolves `stopped` once the run's control aborts; the listener goes when `done` aborts. */
function stoppedBy(control: RunControl, done: AbortSignal): Promise<JobFailure> {
	return new Promise<JobFailure>((resolve) => {
		if (control.signal.aborted) {
			resolve(failure('stopped'))
		}
		control.signal.addEventListener('abort', () => resolve(failure('stopped')), { once: true, signal: done })
	})
}

/**
 * `null` when the handler finished, else the attempt's failure code. One deadline bounds the attempt: IAM's answer for
 * the job's key, then the handler with only what is left of it. Either way the attempt's frame ends and the statements
 * it still has running are cancelled before the runner touches the lease again, waited for only while the segment lasts.
 */
async function attemptOnce(
	job: BoundJob,
	fence: LeaseFence,
	attempt: number,
	deadline: number,
	segmentEnd: number | null,
	clock: JobClock,
	context: RunnerContext,
	kicked: Kicked,
	control: RunControl,
): Promise<JobFailure | null> {
	kicked.recorder = null
	if (isStopped(control)) {
		return failure('stopped')
	}
	// The job's authority is what IAM signs for its key at the start of the attempt; a revoked key stops the next one.
	const setup = new AbortController()
	const exchange = job.credential.authority()
	// Its settlement, not only the attempt's: a drain waits for an exchange the attempt stopped waiting for.
	control.track(exchange)
	let authority: WorkloadAuthority
	try {
		const answered = await Promise.race([
			exchange,
			clock.wait(remainingMs(clock, deadline), setup.signal).then((): typeof TIMED_OUT => TIMED_OUT),
			stoppedBy(control, setup.signal),
		])
		if (answered === TIMED_OUT || 'code' in answered) {
			// The next attempt asks IAM afresh rather than wait on an exchange that outlived this one.
			job.credential.abandon(exchange)
			return answered === TIMED_OUT ? failure('timeout') : answered
		}
		authority = answered
	} finally {
		setup.abort()
	}
	if (isStopped(control)) {
		return failure('stopped')
	}
	if (!authority.ok) {
		return failure(authority.reason === 'unavailable' ? 'iam_unavailable' : 'unauthorized')
	}
	const budget = remainingMs(clock, deadline)
	if (budget === 0) {
		return failure('timeout')
	}
	const frame = new RequestFrame(fence.holder, { fence })
	const cancel = new AbortController()
	const timer = new AbortController()
	const signal = AbortSignal.any([cancel.signal, control.signal])
	const kicks = kickRecorder(`job '${job.name}'`, job.site?.kicks ?? [])
	const ctx = { ...jobContext(job, frame, attempt, signal, context, authority.perms), kick: kicks.kick }
	try {
		const ran = runInRequest(frame, async () => {
			const site = job.site
			if (site === null) {
				await job.handler({ ctx })
			} else {
				await runAsSite(`job '${job.name}'`, site.egress, async () => await job.handler({ ctx }))
			}
			kicked.recorder = kicks
		}).then(() => null, (error: unknown) => {
			const failed = failureOf(error, job.mailer === null ? null : (context.mail[job.mailer]?.sender.capabilities ?? null))
			if (failed.code === 'handler_failed') context.revealHandlerErrors?.(`job '${job.name}' attempt ${attempt}`, error)
			return failed
		})
		// Its settlement, not only the end of its frame: a drain waits for a handler that outlived the attempt.
		control.track(ran)
		const timeout = clock.wait(budget, timer.signal).then((): typeof TIMED_OUT => TIMED_OUT)
		const result = await Promise.race([ran, timeout, stoppedBy(control, timer.signal)])
		return result === TIMED_OUT ? failure('timeout') : result
	} finally {
		frame.end()
		cancel.abort()
		timer.abort()
		await withinSegment(clock, segmentEnd, context.leases.cancelInFlight(fence))
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
	const checkAction = (action: string): void => {
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
	}
	const check = (action: string, dimension: string): void => {
		checkAction(action)
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
	const app = <const Act extends string>(action: Act): AppCapability<Act> => {
		checkAction(action)
		return context.mint.app(frame, action, principal.id)
	}
	return Object.freeze({
		principal,
		runId: frame.id,
		attempt,
		signal,
		url: context.url,
		...(job.site === null || context.data === null
			? {}
			: kitJobContext(
				frame,
				context.data,
				context.fileKinds,
				job.name,
				job.site,
				principal.id,
				ref,
				app,
				periodAt(job.schedule, new Date()) ?? undefined,
			)),
		...(job.links === null || context.membership === null ? {} : { links: jobLinksOf(job, job.links, context.membership, frame, context) }),
		...(job.mailer === null ? {} : { mail: jobMailOf(job, job.mailer, frame, signal, context) }),
		...(job.site === null || job.site.signs.length === 0 || context.tokens === null
			? {}
			: { tokens: context.tokens.context(`job '${job.name}'`, job.site.signs) }),
		within<const Act extends string, const Dim extends string>(action: Act, dimension: Dim): Within<Dim, Act> {
			check(action, dimension)
			return context.mint.within(frame, dimension, action, principal.id, 'all')
		},
		ref<const Act extends string, const Dim extends string>(action: Act, dimension: Dim, id: string): Promise<Ref<Dim, Act>> {
			return ref(action, dimension, id)
		},
		app,
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
	const assertLive = (): void => {
		if (frame.ended) {
			throw new CapabilityRefusedError('ended', `attempt ${frame.id} of job '${job.name}' has ended; it sends no mail`)
		}
	}
	// The attempt's holdings belong to its frame, so this work opens what `ctx.files.open` of the attempt opens.
	const files = storedFilesHandle(context.fileKinds, new FileWork(frame, frame.id), { where: `job '${job.name}'`, check: assertLive, writes: false })
	return jobMail({ transport, keyPrefix: context.mail.keyPrefix, signal, assertLive, open: files.open })
}

/**
 * What a staged-kit job adds: `ctx.db`, whose reads run each on its own, and `ctx.transaction(work)`, the one place it
 * writes and runs `tx.sql` — fenced by the attempt's lease, so an attempt that timed out or lost it commits nothing.
 */
function kitJobContext(
	frame: RequestFrame,
	data: DataAccess,
	kinds: StoredFileKinds | null,
	name: string,
	site: SiteDeclaration,
	principal: string,
	ref: (action: string, dimension: string, id: string, using: Session) => Promise<Ref<string, string>>,
	app: (action: string) => AppCapability<string>,
	tickMs: number | undefined,
): Readonly<Record<string, unknown>> {
	// One attempt's files: what it reads, puts and writes, inside its transactions and outside them, belongs to it.
	const work = new FileWork(frame, frame.id)
	const binding = kinds?.binding(work)
	const reads = jobHandles(frame, data, site, principal, 'job', async () => data.direct(), () => false, tickMs, binding)
	const job = `job '${name}'`
	const putAndOpen = (check: () => void) => storedFilesHandle(kinds, work, { where: job, check, writes: true })
	return {
		db: siteData(reads, (action) => reads.app(app(action))),
		sql: site.sql === null ? undeclaredSql(job, 'job') : jobSqlOutsideTransaction(job),
		files: putAndOpen(boundTo(frame, () => false, 'ctx.files')),
		transaction: async <R>(body: (tx: object) => Promise<R>): Promise<R> => {
			// Outside its attempt there is no lease to fence the transaction with, so it never opens.
			boundTo(frame, () => false)()
			// Its own files: a rollback releases only what this transaction staged, never a file of a concurrent one.
			const own = new FileWork(frame, frame.id)
			let rolledBack = false
			try {
				return await data.transaction(async (session) => {
					let open = true
					const writes = jobHandles(frame, data, site, principal, 'mutation', async () => session, () => !open, undefined, binding)
					try {
						const sql = site.sql === null ? undeclaredSql(job, 'job', 'tx.sql') : jobSql(frame, data, site.sql, session, () => !open)
						// Located in this transaction, so an object it wrote is found before the commit.
						const located = (action: string, dimension: string, id: string) => {
							boundTo(frame, () => !open, 'tx.ref')()
							return ref(action, dimension, id, session)
						}
						const files = storedFilesHandle(kinds, own, { where: job, check: boundTo(frame, () => !open, 'tx.files'), writes: true })
						return await body(Object.freeze({ db: siteData(writes, (action) => writes.app(app(action))), sql, files, ref: located }))
					} catch (error) {
						rolledBack = true
						throw error
					} finally {
						open = false
					}
				})
			} catch (error) {
				// A transaction the work threw out of is a known rollback; a failed commit is not, and the sweep decides.
				if (rolledBack) await kinds?.release(own)
				throw error
			}
		},
	}
}
