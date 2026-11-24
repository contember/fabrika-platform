// The framework's side of `fabrika_wakes` (`@fabrika/db/migrations`): a job's durable pending work, one row per due
// unit (its next scheduled run, a kick, a claim's re-arm, a durable retry), and the scheduler's next wake over it and the
// leases. Only `@fabrika/app` reaches it, through `frameworkTablesOf`. A run owns the wakes due when it took its lease,
// marked in that transaction (`owned`); a wake written or merged into afterwards is not its. Only the transaction of that
// run's fenced finish consumes or retries what it owns (`leaseProjection`), so a crash at any point leaves either the wake
// or a held lease whose expiry is due. Every change runs the runtime's `projectWakes` in its own transaction. Where no
// crontab runs, `fabrika_job_schedule` keeps the generation of the deploy whose serving processes keep the cron wakes
// (ADR-0080).

import { uuidv7 } from '@fabrika/platform'
import { freeze } from './builtins'
import type { LeaseFence } from './capability'
import { type FixedParameter, runFixedStatement, type Session, sessionOf } from './database'
import { QueryRefusedError } from './errors'
import type { DialectTexts, JobOutcome, LeaseChange, LeaseProjection } from './job-leases'
import { JOB_LEASES_TABLE, JOB_SCHEDULE_TABLE, JOB_WAKES_TABLE } from './migrations'
import { SQLITE_NOW_FORMAT } from './migrations-sqlite'
import { refuseInProduction } from './production'
import type { DataLayerRuntime } from './store'

export const WAKE_REASONS = ['cron', 'kick', 'claim', 'retry'] as const

export type WakeReason = (typeof WAKE_REASONS)[number]

export interface NewWake {
	readonly job: string
	readonly reason: WakeReason
	readonly dueAt: Date
	/** Wakes under one key are one row: `cron:<job>:<expr>`, `claim:<job>`, `kick:<job>:<due second>`. */
	readonly dedupe?: string
}

export interface Wake {
	readonly id: string
	readonly job: string
	readonly reason: WakeReason
	readonly dueAt: Date
	/** How many failed runs moved this wake (`retry`). */
	readonly attempt: number
	readonly dedupe: string | null
	/** Taken by the run that holds its job's lease, when that run took it: that run's finish consumes or retries it. */
	readonly owned: boolean
}

/**
 * What a run's finish does with the wakes it owned (those due when it took the lease), applied in the finish's
 * transaction and only when the finish still held the lease. Without one, a success is `completed` and a failure
 * leaves the wakes as they are.
 */
export type FinishWakes =
	/** The run is done with them: they are consumed, then the job's next cron run is scheduled (`cron:<job>:<expression>`). */
	| {
		readonly kind: 'completed'
		/**
		 * With `scheduled`, the next fire is written only when the stored schedule (`keepSchedule`) declares its key, read
		 * in the finish's transaction: under a process schedule, a run of an older deploy writes no removed job's or
		 * changed expression's fire (ADR-0080).
		 */
		readonly nextCron?: { readonly expression: string; readonly dueAt: Date; readonly scheduled?: boolean }
	}
	/** The run failed and runs again: they move to `at`, and their attempt counts up. Only with a failed outcome. */
	| { readonly kind: 'retry'; readonly at: Date }

export interface JobWakes {
	/**
	 * Records a pending wake, in `using` when given (the transaction of the write it belongs to). A key already pending
	 * keeps one row at the earlier due time: a later wake never postpones an earlier one. A merge takes the row from the
	 * run that owns it, except a cron wake's, whose next fire that run's finish schedules. Answers the row that holds it;
	 * a key another job holds is refused.
	 */
	schedule(wake: NewWake, using?: Session): Promise<Wake>
	/** The pending wakes of `job`, earliest first. */
	pending(job: string): Promise<readonly Wake[]>
	/**
	 * When the scheduler wakes next: the earliest due wake of a job whose lease is free or expired, or the expiry of a
	 * held lease (its deadman), whichever is earlier; `null` when neither exists. It may be past. Read in `using` when given;
	 * with `jobs`, of those jobs only, so a wake of a job this process does not run never holds its timer.
	 */
	next(using?: Session, jobs?: readonly string[]): Promise<Date | null>
	/** How many milliseconds from the database's now `next` is (0 or less when due), read in `using` when given. */
	untilNext(using?: Session, jobs?: readonly string[]): Promise<number | null>
	/**
	 * Where no crontab runs (ADR-0080), in one transaction: raises the stored schedule generation to `generation` when that
	 * one is higher in byte order, with the cron keys `fires` declare, and when `generation` is then the stored one,
	 * reconciles the wakes against `fires` (as `reconcile`) and adds each fire's wake under its job's cron key where none
	 * is pending (an existing one, overdue or not, is left as it is and not locked, so a lease taken meanwhile still owns
	 * it). Answers whether `generation` is the stored one; a process of an older one writes nothing. The generation's row stays
	 * locked until the transaction commits, so on Postgres a newer generation waits for an older one's seed and reconciles
	 * after it, and an older one queued behind a newer one reads the newer and writes nothing. A UUIDv7, lowercase: a
	 * later deploy's sorts later.
	 */
	keepSchedule(generation: string, fires: readonly ScheduledFire[]): Promise<boolean>
	/** The database's clock, read in `using` when given: a wake due now is due by it. */
	now(using?: Session): Promise<Date>
	/**
	 * Deletes the wakes of every job not in `declared`, the jobs the contract declares with their cron expressions, and
	 * each declared job's cron wake whose key names another expression; answers how many it deleted. In `using` when
	 * given.
	 */
	reconcile(declared: readonly DeclaredJob[], using?: Session): Promise<number>
	/**
	 * The test kit's: moves each wake `ids` names that is not yet due to the database's now, so the scheduler takes it
	 * now; an overdue one stays. Answers how many it moved. Refused in a process that serves an application.
	 */
	hasten(ids: readonly string[]): Promise<number>
	/**
	 * The jobs whose lease a run holds past its expiry, declared or not: a removed job's crashed holder still arms the
	 * alarm through `next` until someone reaps it.
	 */
	expiredHolders(): Promise<readonly string[]>
}

/** A declared job and its next fire, which `keepSchedule` seeds; `null` when its expression has none in the window. */
export interface ScheduledFire extends DeclaredJob {
	readonly dueAt: Date | null
}

/** A job the contract declares, and the cron expression its schedule is: its cron wake's key is `cron:<job>:<expression>`. */
export interface DeclaredJob {
	readonly job: string
	readonly expression: string
}

const W = JOB_WAKES_TABLE
const L = JOB_LEASES_TABLE
const S = JOB_SCHEDULE_TABLE
const COLUMNS = 'job, due_at, reason, attempt, dedupe'
const SELECTED = `${COLUMNS}, owned`
const SQLITE_NOW = `strftime('${SQLITE_NOW_FORMAT}', 'now')`

/** A stored timestamp as epoch milliseconds, in each dialect. */
const PG_EPOCH_MS = (column: string): string => `floor(extract(epoch from ${column}) * 1000)::bigint`
const SQLITE_EPOCH_MS = (column: string): string => `cast(round((julianday(${column}) - 2440587.5) * 86400000) as integer)`

/** The start of the job's current run, in epoch milliseconds: the wakes due by then are the ones it takes. */
const PG_RUN_START = `(select ${PG_EPOCH_MS('last_started_at')} from ${L} where job = $1)`
const SQLITE_RUN_START = `(select ${SQLITE_EPOCH_MS('last_started_at')} from ${L} where job = ?1)`

const SQL_SCHEDULE: DialectTexts = {
	// The update applies only to the same job's row, so a key another job holds answers no row.
	postgres: `insert into ${W} (id, ${COLUMNS}) values ($1::uuid, $2, $3::bigint, $4, 0, $5)
	on conflict (dedupe) where dedupe is not null do update set due_at = least(${W}.due_at, excluded.due_at),
		owned = ${W}.owned and excluded.reason = 'cron' where ${W}.job = excluded.job
	returning id::text as id, ${SELECTED}`,
	sqlite: `insert into ${W} (id, ${COLUMNS}) values (?1, ?2, cast(?3 as integer), ?4, 0, ?5)
	on conflict (dedupe) where dedupe is not null do update set due_at = min(${W}.due_at, excluded.due_at),
		owned = ${W}.owned and excluded.reason = 'cron' where ${W}.job = excluded.job
	returning id, ${SELECTED}`,
}

const SQL_PENDING: DialectTexts = {
	postgres: `select id::text as id, ${SELECTED} from ${W} where job = $1 order by due_at, id`,
	sqlite: `select id, ${SELECTED} from ${W} where job = ?1 order by due_at, id`,
}

// A taking run marks every wake of its job, due by its start or not. A row a write still holds (`skip locked`) is being
// written, and that write leaves it unowned: the lease is taken without waiting for it.
const SQL_OWN: DialectTexts = {
	postgres: `update ${W} set owned = coalesce(${W}.due_at <= ${PG_RUN_START}, false)
		where id in (select id from ${W} where job = $1 for update skip locked)`,
	sqlite: `update ${W} set owned = coalesce(due_at <= ${SQLITE_RUN_START}, 0) where job = ?1`,
}

const SQL_DISOWN: DialectTexts = {
	postgres: `update ${W} set owned = false where id in (select id from ${W} where job = $1 and owned for update skip locked)`,
	sqlite: `update ${W} set owned = 0 where job = ?1 and owned = 1`,
}

// Two candidates, each one index-ordered or per-job lookup: the earliest wake of a free or expired job walks the due index
// and stops at the first, and the earliest held expiry reads the lease rows, one per job. Postgres compares by the
// statement's clock, not the transaction's: `using` may be a transaction that began before a lease expired. The one
// parameter is the JSON list of jobs to look at, or null for every job.
const SQL_NEXT: DialectTexts = {
	postgres: `select
		(select w.due_at from ${W} w left join ${L} l on l.job = w.job
			where (l.holder is null or l.expires_at <= clock_timestamp())
				and ($1::jsonb is null or w.job in (select jsonb_array_elements_text($1::jsonb))) order by w.due_at limit 1) as wake,
		(select ${PG_EPOCH_MS('min(expires_at)')} from ${L}
			where holder is not null and ($1::jsonb is null or job in (select jsonb_array_elements_text($1::jsonb)))) as held,
		${PG_EPOCH_MS('clock_timestamp()')} as now`,
	sqlite: `select
		(select w.due_at from ${W} w left join ${L} l on l.job = w.job
			where (l.holder is null or l.expires_at <= ${SQLITE_NOW})
				and (?1 is null or w.job in (select value from json_each(?1))) order by w.due_at limit 1) as wake,
		(select ${SQLITE_EPOCH_MS('min(expires_at)')} from ${L}
			where holder is not null and (?1 is null or job in (select value from json_each(?1)))) as held,
		${SQLITE_EPOCH_MS(SQLITE_NOW)} as now`,
}

// One row; a lower generation leaves it as it is, keys included, and the row answers what is stored after the write.
const SQL_HOLD_SCHEDULE: DialectTexts = {
	postgres: `insert into ${S} (id, generation, declared) values (1, $1, $2)
		on conflict (id) do update set generation = greatest(${S}.generation, excluded.generation),
			declared = case when excluded.generation >= ${S}.generation then excluded.declared else ${S}.declared end
		returning generation`,
	sqlite: `insert into ${S} (id, generation, declared) values (1, ?1, ?2)
		on conflict (id) do update set generation = max(${S}.generation, excluded.generation),
			declared = case when excluded.generation >= ${S}.generation then excluded.declared else ${S}.declared end
		returning generation`,
}

// A seed only adds a missing wake. `do nothing` takes no lock on a row that exists, so a replica's lease, taken while
// a seed is open, still marks that row owned (`SQL_OWN` skips a locked row).
const SQL_SEED: DialectTexts = {
	postgres: `insert into ${W} (id, ${COLUMNS}) values ($1::uuid, $2, $3::bigint, $4, 0, $5) on conflict (dedupe) where dedupe is not null do nothing`,
	sqlite: `insert into ${W} (id, ${COLUMNS}) values (?1, ?2, cast(?3 as integer), ?4, 0, ?5) on conflict (dedupe) where dedupe is not null do nothing`,
}

// The keys the stored generation declares, read by a finish in its transaction; `for share` waits for a seed under way.
const SQL_SCHEDULE_DECLARED: DialectTexts = {
	postgres: `select declared from ${S} where id = 1 for share`,
	sqlite: `select declared from ${S} where id = 1`,
}

/** Whether the stored schedule declares `key`: its row's keys, read in `transaction`. No row declares nothing. */
async function scheduleDeclares(transaction: Session, key: string): Promise<boolean> {
	const [row] = await rows(transaction, SQL_SCHEDULE_DECLARED, [])
	if (row === undefined) {
		return false
	}
	const declared: unknown = typeof row['declared'] === 'string' ? JSON.parse(row['declared']) : undefined
	if (!Array.isArray(declared)) {
		throw new QueryRefusedError('unexpected_row', `${S}.declared is not a list of keys`)
	}
	return declared.includes(key)
}

/**
 * A schedule generation: a lowercase UUIDv7 (version 7, the RFC variant), whose text order is its time order. Any other
 * UUID would order deploys at random, and a later deploy that sorted lower would never take the schedule.
 */
const SCHEDULE_GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** The declared jobs `reconcile` keeps, checked: a list of jobs with their expressions. */
function declaredJobs(declared: readonly DeclaredJob[]): DeclaredJob[] {
	if (!Array.isArray(declared)) {
		throw new QueryRefusedError('invalid_argument', 'the declared jobs are a list of jobs with their expressions')
	}
	return declared.map((entry: unknown) => {
		const job: unknown = typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'job') : undefined
		const expression: unknown = typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'expression') : undefined
		return { job: nonEmpty(job, 'a declared job'), expression: nonEmpty(expression, "a declared job's expression") }
	})
}

/** Each fire `keepSchedule` seeds, checked before its transaction: the declared job and the cron wake of its next fire. */
function scheduledFires(fires: readonly ScheduledFire[]): {
	readonly declared: DeclaredJob[]
	readonly wakes: { readonly job: string; readonly parameters: readonly FixedParameter[] }[]
} {
	const declared = declaredJobs(fires)
	const wakes = fires.flatMap((fire, index) => {
		const dueAt: unknown = Reflect.get(fire, 'dueAt')
		const job = declared[index]
		if (dueAt === null || job === undefined) {
			return []
		}
		if (!(dueAt instanceof Date)) {
			throw new QueryRefusedError('invalid_argument', "a fire's due time is a valid time or null")
		}
		return [{ job: job.job, parameters: newWake({ job: job.job, reason: 'cron', dueAt, dedupe: `cron:${job.job}:${job.expression}` }) }]
	})
	return { declared, wakes }
}

const SQL_CLOCK: DialectTexts = {
	postgres: `select ${PG_EPOCH_MS('clock_timestamp()')} as now`,
	sqlite: `select ${SQLITE_EPOCH_MS(SQLITE_NOW)} as now`,
}

const SQL_EXPIRED_HOLDERS: DialectTexts = {
	postgres: `select job from ${L} where holder is not null and expires_at <= clock_timestamp() order by job`,
	sqlite: `select job from ${L} where holder is not null and expires_at <= ${SQLITE_NOW} order by job`,
}

const SQL_CONSUME: DialectTexts = {
	postgres: `delete from ${W} where job = $1 and owned`,
	sqlite: `delete from ${W} where job = ?1 and owned = 1`,
}

const SQL_RETRY: DialectTexts = {
	postgres: `update ${W} set due_at = $2::bigint, attempt = attempt + 1, owned = false where job = $1 and owned`,
	sqlite: `update ${W} set due_at = cast(?2 as integer), attempt = attempt + 1, owned = 0 where job = ?1 and owned = 1`,
}

const SQL_DROP_CLAIM: DialectTexts = {
	postgres: `delete from ${W} where job = $1 and dedupe = $2`,
	sqlite: `delete from ${W} where job = ?1 and dedupe = ?2`,
}

// A wake is kept when its job is declared and it is no cron wake, or is the cron wake of the declared expression.
const SQL_RECONCILE: DialectTexts = {
	postgres: `delete from ${W} where not exists (select 1 from jsonb_to_recordset($1::jsonb) as d(job text, expression text)
		where d.job = ${W}.job and (${W}.reason <> 'cron' or ${W}.dedupe = 'cron:' || d.job || ':' || d.expression)) returning id`,
	sqlite: `delete from ${W} where not exists (select 1 from json_each(?1) d
		where json_extract(d.value, '$.job') = ${W}.job
			and (${W}.reason <> 'cron' or ${W}.dedupe = 'cron:' || json_extract(d.value, '$.job') || ':' || json_extract(d.value, '$.expression'))) returning id`,
}

// Only a wake still ahead moves: moving an overdue one to now would postpone it.
const SQL_HASTEN: DialectTexts = {
	postgres: `update ${W} set due_at = ${PG_EPOCH_MS('now()')}
		where id::text in (select jsonb_array_elements_text($1::jsonb)) and due_at > ${PG_EPOCH_MS('now()')} returning id::text as id`,
	sqlite: `update ${W} set due_at = ${SQLITE_EPOCH_MS(SQLITE_NOW)}
		where id in (select value from json_each(?1)) and due_at > ${SQLITE_EPOCH_MS(SQLITE_NOW)} returning id`,
}

function record(row: unknown): Readonly<Record<string, unknown>> {
	if (typeof row !== 'object' || row === null) {
		throw new QueryRefusedError('unexpected_row', `${W} answered a row that is not an object`)
	}
	return Object.fromEntries(Object.entries(row))
}

async function rows(session: Session, texts: DialectTexts, parameters: readonly FixedParameter[]): Promise<Readonly<Record<string, unknown>>[]> {
	return (await runFixedStatement(session, texts[session.dialect], parameters)).map(record)
}

/** BIGINT comes back from Postgres as a string, INTEGER from SQLite as a number. */
function wholeNumber(value: unknown, what: string): number {
	const parsed = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value
	if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed)) {
		throw new QueryRefusedError('unexpected_row', `${what} is not a whole number`)
	}
	return parsed
}

/** BOOLEAN comes back from Postgres as a boolean, an INTEGER flag from SQLite as 0 or 1. */
function flag(value: unknown, what: string): boolean {
	if (value === true || value === 1) {
		return true
	}
	if (value === false || value === 0) {
		return false
	}
	throw new QueryRefusedError('unexpected_row', `${what} is not a flag`)
}

function wakeOf(row: Readonly<Record<string, unknown>>): Wake {
	const { id, job, reason, due_at: dueAt, attempt, dedupe, owned } = row
	if (typeof id !== 'string' || typeof job !== 'string' || (dedupe !== null && typeof dedupe !== 'string')) {
		throw new QueryRefusedError('unexpected_row', `${W} came back in another shape than its migration declares`)
	}
	const known = WAKE_REASONS.find((candidate) => candidate === reason)
	if (known === undefined) {
		throw new QueryRefusedError('unexpected_row', `${W}.reason is not a wake reason`)
	}
	return freeze({
		id,
		job,
		reason: known,
		dueAt: new Date(wholeNumber(dueAt, `${W}.due_at`)),
		attempt: wholeNumber(attempt, `${W}.attempt`),
		dedupe,
		owned: flag(owned, `${W}.owned`),
	})
}

function epochOf(value: unknown, what: string): number {
	const time = value instanceof Date ? value.getTime() : Number.NaN
	if (!Number.isSafeInteger(time)) {
		throw new QueryRefusedError('invalid_argument', `${what} is a valid time`)
	}
	return time
}

function nonEmpty(value: unknown, what: string): string {
	if (typeof value !== 'string' || value === '') {
		throw new QueryRefusedError('invalid_argument', `${what} is a non-empty string`)
	}
	return value
}

function newWake(wake: NewWake): readonly FixedParameter[] {
	const job = nonEmpty(wake.job, "a wake's job")
	if (!WAKE_REASONS.some((reason) => reason === wake.reason)) {
		throw new QueryRefusedError('invalid_argument', `a wake's reason is one of ${WAKE_REASONS.join(', ')}`)
	}
	const due = epochOf(wake.dueAt, "a wake's due time")
	const dedupe = wake.dedupe === undefined ? null : nonEmpty(wake.dedupe, "a wake's dedupe key")
	return [uuidv7(), job, String(due), wake.reason, dedupe]
}

/** Inserts the wake `newWake` checked, in `transaction`; refuses a key another job holds, which rolls it back. */
async function insert(transaction: Session, parameters: readonly FixedParameter[], job: string): Promise<Wake> {
	const [row] = await rows(transaction, SQL_SCHEDULE, parameters)
	if (row === undefined) {
		throw new QueryRefusedError('invalid_argument', `the dedupe key of this wake of '${job}' is held by another job's wake`)
	}
	return wakeOf(row)
}

/**
 * A finish's instruction checked before its statement runs, with the default filled in: `null` leaves the wakes. The
 * lease store calls it, so a malformed instruction refuses the finish and leaves the lease held.
 */
export function finishWakes(outcome: JobOutcome, wakes: FinishWakes | undefined): FinishWakes | null {
	if (wakes === undefined) {
		return outcome === 'succeeded' ? freeze({ kind: 'completed' }) : null
	}
	if (wakes.kind === 'retry') {
		if (outcome !== 'failed') {
			throw new QueryRefusedError('invalid_argument', 'only a failed run retries its wakes')
		}
		epochOf(wakes.at, 'a retry')
		return freeze({ kind: 'retry', at: wakes.at })
	}
	if (wakes.kind !== 'completed') {
		throw new QueryRefusedError('invalid_argument', "a finish's wakes are completed or retried")
	}
	if (wakes.nextCron === undefined) {
		return freeze({ kind: 'completed' })
	}
	nonEmpty(wakes.nextCron.expression, "a cron wake's expression")
	epochOf(wakes.nextCron.dueAt, "a cron wake's due time")
	const { expression, dueAt, scheduled } = wakes.nextCron
	if (scheduled !== undefined && typeof scheduled !== 'boolean') {
		throw new QueryRefusedError('invalid_argument', "a cron wake's schedule guard is a boolean")
	}
	return freeze({ kind: 'completed', nextCron: freeze(scheduled === true ? { expression, dueAt, scheduled } : { expression, dueAt }) })
}

/** The runtime's projection of a change, in its transaction; nothing without one. */
function projectionOf(runtime: () => DataLayerRuntime): (transaction: Session) => Promise<void> {
	return async (transaction) => {
		await runtime().projectWakes?.(transaction)
	}
}

/**
 * The lease store's projection, all in the lease statement's transaction: a taken lease marks the wakes its run owns, a
 * fenced finish applies its wake instruction to them, a finish or a reap leaves none owned, and every lease change then
 * runs the runtime's projection.
 */
export function leaseProjection(runtime: () => DataLayerRuntime): LeaseProjection {
	const project = projectionOf(runtime)
	return async (transaction: Session, job: string, change: LeaseChange): Promise<void> => {
		if (change.kind === 'acquired') {
			await rows(transaction, SQL_OWN, [job])
		}
		if (change.kind === 'finished' && change.wakes !== null) {
			if (change.wakes.kind === 'retry') {
				await rows(transaction, SQL_RETRY, [job, String(change.wakes.at.getTime())])
			} else {
				await rows(transaction, SQL_CONSUME, [job])
				const next = change.wakes.nextCron
				const key = next === undefined ? null : `cron:${job}:${next.expression}`
				if (next !== undefined && key !== null && (next.scheduled !== true || (await scheduleDeclares(transaction, key)))) {
					await insert(transaction, newWake({ job, reason: 'cron', dueAt: next.dueAt, dedupe: key }), job)
				}
			}
		}
		if (change.kind === 'finished' || change.kind === 'reaped') {
			await rows(transaction, SQL_DISOWN, [job])
		}
		await project(transaction)
	}
}

/** A job's one claim wake: each attempt's first claim replaces it. */
const claimKey = (job: string): string => `claim:${job}`

/**
 * Each attempt's earliest claim re-arm so far (`null`: none), by its fence: a later claim of the attempt, over another
 * queue or `where`, never postpones it. A claim whose transaction rolled back may leave it early, which costs one run.
 */
const attemptRearms = new WeakMap<LeaseFence, number | null>()

/**
 * Sets the claim wake of `fence`'s job to `dueAt`, or removes it for `null`, in `transaction`: the claim's fenced
 * transaction, so the re-arm commits with the rows it leased. The attempt's first claim replaces what an earlier run
 * left; each later claim keeps the earliest re-arm of the attempt.
 */
export async function rearmClaim(runtime: DataLayerRuntime, transaction: Session, fence: LeaseFence, dueAt: Date | null): Promise<void> {
	const candidate = dueAt === null ? null : epochOf(dueAt, 'a claim re-arm')
	const earlier = attemptRearms.get(fence) ?? null
	const due = earlier === null ? candidate : candidate === null ? earlier : Math.min(earlier, candidate)
	attemptRearms.set(fence, due)
	await rows(transaction, SQL_DROP_CLAIM, [fence.job, claimKey(fence.job)])
	if (due !== null) {
		await insert(transaction, newWake({ job: fence.job, reason: 'claim', dueAt: new Date(due), dedupe: claimKey(fence.job) }), fence.job)
	}
	await runtime.projectWakes?.(transaction)
}

/** The jobs `next` looks at, as its JSON parameter: `null` for every job. */
function jobsFilter(jobs: readonly string[] | undefined): FixedParameter {
	if (jobs === undefined) {
		return null
	}
	if (!Array.isArray(jobs)) {
		throw new QueryRefusedError('invalid_argument', 'the jobs the next wake is read for are a list of job names')
	}
	return JSON.stringify(jobs.map((job: unknown) => nonEmpty(job, 'a job the next wake is read for')))
}

/** The next wake, in epoch milliseconds, and the database's now as the same statement read it. */
async function nextAndNow(
	session: Session,
	jobs: readonly string[] | undefined,
): Promise<{ readonly next: number | null; readonly now: () => number }> {
	const [{ wake = null, held = null, now = null } = {}] = await rows(session, SQL_NEXT, [jobsFilter(jobs)])
	const candidates = [wake, held].filter((value) => value !== null).map((value) => wholeNumber(value, 'the next wake'))
	return { next: candidates.length === 0 ? null : Math.min(...candidates), now: () => wholeNumber(now, "the database's now") }
}

export function jobWakes(runtime: () => DataLayerRuntime): JobWakes {
	const session = () => sessionOf(runtime())
	const project = projectionOf(runtime)
	return freeze({
		async schedule(wake: NewWake, using?: Session): Promise<Wake> {
			const parameters = newWake(wake)
			return await (using ?? session()).transaction(async (transaction) => {
				const scheduled = await insert(transaction, parameters, wake.job)
				await project(transaction)
				return scheduled
			})
		},

		async pending(job: string): Promise<readonly Wake[]> {
			return freeze((await rows(session(), SQL_PENDING, [job])).map(wakeOf))
		},

		async next(using?: Session, jobs?: readonly string[]): Promise<Date | null> {
			const { next } = await nextAndNow(using ?? session(), jobs)
			return next === null ? null : new Date(next)
		},

		async untilNext(using?: Session, jobs?: readonly string[]): Promise<number | null> {
			const { next, now } = await nextAndNow(using ?? session(), jobs)
			return next === null ? null : next - now()
		},

		async keepSchedule(generation: string, fires: readonly ScheduledFire[]): Promise<boolean> {
			if (typeof generation !== 'string' || !SCHEDULE_GENERATION.test(generation)) {
				throw new QueryRefusedError('invalid_argument', 'a schedule generation is a lowercase UUIDv7')
			}
			const { declared, wakes } = scheduledFires(fires)
			const keys = JSON.stringify(declared.map(({ job, expression }) => `cron:${job}:${expression}`))
			return await session().transaction(async (transaction) => {
				// The upsert locks the row until this transaction commits: the reconcile and the seed below happen under it,
				// and a finish that reads the declared keys waits for them.
				const [{ generation: stored } = {}] = await rows(transaction, SQL_HOLD_SCHEDULE, [generation, keys])
				if (typeof stored !== 'string') {
					throw new QueryRefusedError('unexpected_row', `${S} came back in another shape than its migration declares`)
				}
				if (stored !== generation) {
					return false
				}
				await rows(transaction, SQL_RECONCILE, [JSON.stringify(declared)])
				for (const wake of wakes) {
					await rows(transaction, SQL_SEED, wake.parameters)
				}
				await project(transaction)
				return true
			})
		},

		async now(using?: Session): Promise<Date> {
			const [{ now = null } = {}] = await rows(using ?? session(), SQL_CLOCK, [])
			return new Date(wholeNumber(now, "the database's now"))
		},

		async expiredHolders(): Promise<readonly string[]> {
			return freeze(
				(await rows(session(), SQL_EXPIRED_HOLDERS, [])).map(({ job }) => {
					if (typeof job !== 'string') {
						throw new QueryRefusedError('unexpected_row', `${L} came back in another shape than its migration declares`)
					}
					return job
				}),
			)
		},

		async reconcile(declared: readonly DeclaredJob[], using?: Session): Promise<number> {
			const jobs = declaredJobs(declared)
			return await (using ?? session()).transaction(async (transaction) => {
				const removed = await rows(transaction, SQL_RECONCILE, [JSON.stringify(jobs)])
				await project(transaction)
				return removed.length
			})
		},

		async hasten(ids: readonly string[]): Promise<number> {
			refuseInProduction("the wakes store's hasten")
			if (!Array.isArray(ids)) {
				throw new QueryRefusedError('invalid_argument', 'the wakes to hasten are a list of wake ids')
			}
			const named = ids.map((id: unknown) => nonEmpty(id, 'a wake id'))
			return await session().transaction(async (transaction) => {
				const moved = await rows(transaction, SQL_HASTEN, [JSON.stringify(named)])
				await project(transaction)
				return moved.length
			})
		},
	})
}
