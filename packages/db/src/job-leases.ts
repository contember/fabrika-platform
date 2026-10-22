// The framework's side of `fabrika_job_leases` (`@fabrika/db/migrations`): the lease a job run takes, the generation
// and deadline that fence every write of the attempt holding it, and the state of the job's last run; and
// `fabrika_job_kicks`, a kick's pending run. Only
// `@fabrika/app`'s job runner reaches it, through `frameworkTablesOf`. Every time is the database's own clock: two
// containers whose clocks disagree still agree on who holds a lease and when it expires.

import type { LeaseFence } from './capability'
import { runFixedStatement, type Session, sessionOf, type SqlDialect } from './database'
import { DatabaseError, LeaseLostError, QueryRefusedError } from './errors'
import { JOB_KICKS_TABLE, JOB_LEASES_TABLE } from './migrations'
import { SQLITE_NOW_FORMAT } from './migrations-sqlite'
import type { DataLayerRuntime } from './store'

export type JobOutcome = 'succeeded' | 'failed'

export interface JobLeaseState {
	readonly generation: number
	/** The attempt holding the lease, or `null` when it is free. */
	readonly holder: string | null
	readonly expiresAt: Date
	/** The holding attempt's deadline: no write of it commits after this. */
	readonly attemptDeadline: Date
	/** When the job was first seen in this schema: the baseline of a job that never succeeded. */
	readonly firstSeenAt: Date
	readonly lastStartedAt: Date | null
	readonly lastFinishedAt: Date | null
	readonly lastStatus: JobOutcome | null
	readonly lastSucceededAt: Date | null
	readonly lastDurationMs: number | null
	readonly lastMissedReportedAt: Date | null
}

/** A job overdue by twice its period, claimed for one report. */
export interface OverdueClaim {
	readonly lastSucceededAt: Date | null
	readonly firstSeenAt: Date
}

export interface JobLeases {
	/** The database's clock. */
	now(): Promise<Date>
	/** Records that the job exists (its first-seen time), once; later calls change nothing. */
	register(job: string): Promise<void>
	/**
	 * Frees a lease whose holder never finished before it expired (the run crashed) and records the run as failed.
	 * `true` for the one caller that freed it.
	 */
	reapCrashed(job: string): Promise<boolean>
	/**
	 * A free lease for `holder`, under a new generation, for `leaseMs`; its attempt may write for `attemptMs`. `null`
	 * while another run holds it.
	 */
	acquire(job: string, holder: string, attemptMs: number, leaseMs: number): Promise<LeaseFence | null>
	/**
	 * `acquire` of a registered job that never waits for a lock: `null` at once while another run holds the lease or an
	 * attempt's transaction holds its row. A kick takes the lease only this way, on a connection requests share.
	 */
	tryAcquire(job: string, holder: string, attemptMs: number, leaseMs: number): Promise<LeaseFence | null>
	/**
	 * Hands a live lease to the next attempt under a new generation, so no write of the previous attempt commits from
	 * now on. `null` when `fence` no longer holds it.
	 */
	renew(fence: LeaseFence, holder: string, attemptMs: number, leaseMs: number): Promise<LeaseFence | null>
	/** Frees the lease and records the run's outcome and duration; `false` when `fence` no longer held it. */
	finish(fence: LeaseFence, outcome: JobOutcome): Promise<boolean>
	/** Records that a kick arrived: the run that started before it runs the job once more. Never waits on the lease. */
	markPending(job: string): Promise<void>
	/**
	 * Clears the flag `markPending` set; `true` for the one caller that cleared it. A run clears it when it starts (it
	 * covers every kick before it) and again after it succeeded, when `true` means one more run.
	 */
	takePending(job: string): Promise<boolean>
	/**
	 * Claims one report of a job that has not succeeded within twice `periodMs`, at most once per period: only the
	 * caller that gets the claim reports.
	 */
	claimOverdue(job: string, periodMs: number): Promise<OverdueClaim | null>
	/**
	 * Refuses every further write of the attempt `fence` names and cancels the statements it still has running; the
	 * runner calls it when the attempt ends.
	 */
	cancelInFlight(fence: LeaseFence): Promise<void>
	state(job: string): Promise<JobLeaseState | null>
}

/** One framework statement in each dialect's text; a session runs the text of its own. */
export type DialectTexts = Readonly<Record<SqlDialect, string>>

/** SQLite's clock, as a stored timestamp: ISO text, so a comparison of two is a text comparison. */
export const SQLITE_NOW = `strftime('${SQLITE_NOW_FORMAT}', 'now')`

/** SQLite's clock moved by `ms`, an SQL expression of milliseconds (negative is earlier). */
export function sqliteNowPlus(ms: string): string {
	return `strftime('${SQLITE_NOW_FORMAT}', 'now', printf('%+.3f seconds', (${ms}) / 1000.0))`
}

const T = JOB_LEASES_TABLE
const MS = `* interval '1 millisecond'`
const N = SQLITE_NOW
const SQLITE_RUN_MS = `cast(round((julianday('now') - julianday(last_started_at)) * 86400000) as integer)`
const QUERY_CANCELED = '57014'
const IDLE_TIMEOUT = '25P03'

const STATE_COLUMNS =
	'generation, holder, expires_at, attempt_deadline, first_seen_at, last_started_at, last_finished_at, last_status, last_succeeded_at, last_duration_ms, last_missed_reported_at'

const SQL_NOW: DialectTexts = {
	postgres: 'select now() as now',
	sqlite: `select ${N} as now`,
}

const SQL_REGISTER: DialectTexts = {
	postgres: `insert into ${T} (job, generation, holder, expires_at, attempt_deadline, first_seen_at)
	values ($1, 0, null, now(), now(), now()) on conflict (job) do nothing`,
	sqlite: `insert into ${T} (job, generation, holder, expires_at, attempt_deadline, first_seen_at)
	values (?1, 0, null, ${N}, ${N}, ${N}) on conflict (job) do nothing`,
}

const SQL_REAP: DialectTexts = {
	postgres: `update ${T} set holder = null, last_status = 'failed', last_finished_at = now(),
	last_duration_ms = (extract(epoch from now() - last_started_at) * 1000)::int
	where job = $1 and holder is not null and expires_at <= now() returning job`,
	sqlite: `update ${T} set holder = null, last_status = 'failed', last_finished_at = ${N},
	last_duration_ms = ${SQLITE_RUN_MS}
	where job = ?1 and holder is not null and expires_at <= ${N} returning job`,
}

const SQL_ACQUIRE: DialectTexts = {
	postgres: `insert into ${T} (job, generation, holder, expires_at, attempt_deadline, first_seen_at, last_started_at)
	values ($1, 1, $2, now() + $3::bigint ${MS}, now() + $4::bigint ${MS}, now(), now())
	on conflict (job) do update set generation = ${T}.generation + 1, holder = excluded.holder, expires_at = excluded.expires_at,
		attempt_deadline = excluded.attempt_deadline, last_started_at = excluded.last_started_at
	where ${T}.holder is null returning generation`,
	sqlite: `insert into ${T} (job, generation, holder, expires_at, attempt_deadline, first_seen_at, last_started_at)
	values (?1, 1, ?2, ${sqliteNowPlus('?3')}, ${sqliteNowPlus('?4')}, ${N}, ${N})
	on conflict (job) do update set generation = ${T}.generation + 1, holder = excluded.holder, expires_at = excluded.expires_at,
		attempt_deadline = excluded.attempt_deadline, last_started_at = excluded.last_started_at
	where ${T}.holder is null returning generation`,
}

const SQL_RENEW: DialectTexts = {
	postgres: `update ${T} set generation = generation + 1, holder = $4, expires_at = now() + $5::bigint ${MS},
	attempt_deadline = now() + $6::bigint ${MS}
	where job = $1 and generation = $2 and holder = $3 and expires_at > now() returning generation`,
	sqlite: `update ${T} set generation = generation + 1, holder = ?4, expires_at = ${sqliteNowPlus('?5')},
	attempt_deadline = ${sqliteNowPlus('?6')}
	where job = ?1 and generation = ?2 and holder = ?3 and expires_at > ${N} returning generation`,
}

const SQL_FINISH: DialectTexts = {
	postgres: `update ${T} set holder = null, last_finished_at = now(), last_status = $4,
	last_duration_ms = (extract(epoch from now() - last_started_at) * 1000)::int,
	last_succeeded_at = case when $4 = 'succeeded' then now() else last_succeeded_at end
	where job = $1 and generation = $2 and holder = $3 returning job`,
	sqlite: `update ${T} set holder = null, last_finished_at = ${N}, last_status = ?4,
	last_duration_ms = ${SQLITE_RUN_MS},
	last_succeeded_at = case when ?4 = 'succeeded' then ${N} else last_succeeded_at end
	where job = ?1 and generation = ?2 and holder = ?3 returning job`,
}

const SQL_TRY_ACQUIRE: DialectTexts = {
	// A free lease whose row no transaction holds (`skip locked`): an attempt's fence holds it `for share` while it writes.
	postgres: `with free as (select job from ${T} where job = $1 and holder is null for update skip locked)
	update ${T} set generation = ${T}.generation + 1, holder = $2, expires_at = now() + $3::bigint ${MS},
		attempt_deadline = now() + $4::bigint ${MS}, last_started_at = now()
	from free where ${T}.job = free.job returning ${T}.generation`,
	// No lock to skip: while an attempt's fenced transaction is open, the Durable Object serves no kick.
	sqlite: `update ${T} set generation = generation + 1, holder = ?2, expires_at = ${sqliteNowPlus('?3')},
		attempt_deadline = ${sqliteNowPlus('?4')}, last_started_at = ${N}
	where job = ?1 and holder is null returning generation`,
}

const K = JOB_KICKS_TABLE

const SQL_MARK_PENDING: DialectTexts = {
	postgres: `insert into ${K} (job, pending) values ($1, true) on conflict (job) do update set pending = true where ${K}.pending = false`,
	sqlite: `insert into ${K} (job, pending) values (?1, 1) on conflict (job) do update set pending = 1 where ${K}.pending = 0`,
}

const SQL_TAKE_PENDING: DialectTexts = {
	postgres: `update ${K} set pending = false where job = $1 and pending returning job`,
	sqlite: `update ${K} set pending = 0 where job = ?1 and pending = 1 returning job`,
}

const SQL_CLAIM_OVERDUE: DialectTexts = {
	postgres: `update ${T} set last_missed_reported_at = now()
	where job = $1 and coalesce(last_succeeded_at, first_seen_at) < now() - 2 * $2::bigint ${MS}
		and (last_missed_reported_at is null or last_missed_reported_at <= now() - $2::bigint ${MS})
	returning last_succeeded_at, first_seen_at`,
	sqlite: `update ${T} set last_missed_reported_at = ${N}
	where job = ?1 and coalesce(last_succeeded_at, first_seen_at) < ${sqliteNowPlus('-2 * ?2')}
		and (last_missed_reported_at is null or last_missed_reported_at <= ${sqliteNowPlus('-?2')})
	returning last_succeeded_at, first_seen_at`,
}

const SQL_STILL_HELD: DialectTexts = {
	postgres: `select job from ${T} where job = $1 and generation = $2 and holder = $3 and attempt_deadline > clock_timestamp()`,
	sqlite: `select job from ${T} where job = ?1 and generation = ?2 and holder = ?3 and attempt_deadline > ${N}`,
}

const SQL_FENCE: DialectTexts = {
	// Inside a mutation's transaction, so `clock_timestamp()`: `now()` is when the transaction began.
	postgres: `select pg_backend_pid() as pid, transaction_timestamp()::text as began,
	greatest(1, ceil(extract(epoch from attempt_deadline - clock_timestamp()) * 1000))::int as remaining_ms
	from ${T} where job = $1 and generation = $2 and holder = $3 and attempt_deadline > clock_timestamp() for share`,
	// No lock: while the transaction is open the Durable Object serves no other event, so no takeover runs before it ends.
	sqlite: SQL_STILL_HELD.sqlite,
}

// Postgres only. The attempt's remaining time bounds a statement and an idle wait alike: either past the deadline ends it.
const SQL_TIMEOUTS = `select set_config('statement_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $1, true)`

// Postgres only. Only the backend still in the transaction the fence opened: a pid the pool reused is left alone.
const SQL_CANCEL = `select pg_cancel_backend(pid) from pg_stat_activity where pid = $1 and xact_start = $2::timestamptz`

const SQL_STATE: DialectTexts = {
	postgres: `select now() as now, ${STATE_COLUMNS} from ${T} where job = $1`,
	sqlite: `select ${N} as now, ${STATE_COLUMNS} from ${T} where job = ?1`,
}

/** The columns that hold a time; SQLite answers each as ISO text, which the row's entry reads as a `Date`. */
const TIMESTAMP_COLUMNS: ReadonlySet<string> = new Set([
	'now',
	'expires_at',
	'attempt_deadline',
	'first_seen_at',
	'last_started_at',
	'last_finished_at',
	'last_succeeded_at',
	'last_missed_reported_at',
])

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/** A stored SQLite timestamp (`SQLITE_NOW_FORMAT`) as a `Date`, or `null`; anything else is refused. */
export function sqliteTimestamp(value: unknown, what: string): Date | null {
	if (value === null) {
		return null
	}
	const parsed = typeof value === 'string' && ISO_TIMESTAMP.test(value) ? new Date(value) : undefined
	if (parsed === undefined || Number.isNaN(parsed.getTime())) {
		throw new QueryRefusedError('unexpected_row', `${what} is not a stored timestamp`)
	}
	return parsed
}

function record(row: unknown): Readonly<Record<string, unknown>> {
	if (typeof row !== 'object' || row === null) {
		throw new QueryRefusedError('unexpected_row', `${T} answered a row that is not an object`)
	}
	return Object.fromEntries(Object.entries(row))
}

async function rows(
	session: Session,
	texts: DialectTexts,
	parameters: readonly (string | number | null)[],
): Promise<Readonly<Record<string, unknown>>[]> {
	const found = (await runFixedStatement(session, texts[session.dialect], parameters)).map(record)
	return session.dialect === 'sqlite' ? found.map(sqliteRow) : found
}

function sqliteRow(row: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
	return Object.fromEntries(
		Object.entries(row).map(([name, value]) => [name, TIMESTAMP_COLUMNS.has(name) ? sqliteTimestamp(value, `${T}.${name}`) : value]),
	)
}

function integer(row: Readonly<Record<string, unknown>>, name: string): number {
	const value = row[name]
	if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
		throw new QueryRefusedError('unexpected_row', `${T}.${name} came back as ${typeof value}`)
	}
	return value
}

function text(row: Readonly<Record<string, unknown>>, name: string): string {
	const value = row[name]
	if (typeof value !== 'string') {
		throw new QueryRefusedError('unexpected_row', `${T}.${name} came back as ${typeof value}`)
	}
	return value
}

function date(row: Readonly<Record<string, unknown>>, name: string): Date | null {
	const value = row[name]
	if (value === null) {
		return null
	}
	if (!(value instanceof Date)) {
		throw new QueryRefusedError('unexpected_row', `${T}.${name} came back as ${typeof value}`)
	}
	return value
}

function requiredDate(row: Readonly<Record<string, unknown>>, name: string): Date {
	const value = date(row, name)
	if (value === null) {
		throw new QueryRefusedError('unexpected_row', `${T}.${name} came back as null`)
	}
	return value
}

function stateOf(row: Readonly<Record<string, unknown>>): JobLeaseState {
	const { holder, last_status: status, last_duration_ms: duration } = row
	if ((holder !== null && typeof holder !== 'string') || (duration !== null && typeof duration !== 'number')) {
		throw new QueryRefusedError('unexpected_row', `${T} came back in another shape than its migration declares`)
	}
	if (status !== null && status !== 'succeeded' && status !== 'failed') {
		throw new QueryRefusedError('unexpected_row', `${T}.last_status is not succeeded or failed`)
	}
	return Object.freeze({
		generation: integer(row, 'generation'),
		holder,
		expiresAt: requiredDate(row, 'expires_at'),
		attemptDeadline: requiredDate(row, 'attempt_deadline'),
		firstSeenAt: requiredDate(row, 'first_seen_at'),
		lastStartedAt: date(row, 'last_started_at'),
		lastFinishedAt: date(row, 'last_finished_at'),
		lastStatus: status,
		lastSucceededAt: date(row, 'last_succeeded_at'),
		lastDurationMs: duration,
		lastMissedReportedAt: date(row, 'last_missed_reported_at'),
	})
}

function milliseconds(value: number, what: string): number {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new QueryRefusedError('invalid_argument', `${what} must be a whole number of milliseconds of at least 1`)
	}
	return value
}

function fenceOf(job: string, holder: string, row: Readonly<Record<string, unknown>> | undefined): LeaseFence | null {
	return row === undefined ? null : Object.freeze({ job, holder, generation: integer(row, 'generation') })
}

/** A backend in one fenced transaction: its pid, and when that transaction began. */
interface Backend {
	readonly pid: number
	readonly began: string
}

// Which transactions each attempt has open, how to end them, and which attempts have ended. Keyed by the fence the
// runner holds.
const inFlight = new WeakMap<LeaseFence, Set<Backend>>()
const stops = new WeakMap<LeaseFence, AbortController>()
const ended = new WeakSet<LeaseFence>()

function stopOf(fence: LeaseFence): AbortController {
	const known = stops.get(fence)
	if (known !== undefined) {
		return known
	}
	const stop = new AbortController()
	stops.set(fence, stop)
	return stop
}

function refuseEnded(fence: LeaseFence): void {
	if (ended.has(fence)) {
		throw new LeaseLostError(`attempt ${fence.holder} of job '${fence.job}' has ended; it writes nothing more`)
	}
}

const SQL_CLOCK: DialectTexts = {
	postgres: 'select clock_timestamp() as now',
	sqlite: `select ${N} as now`,
}

/**
 * The database's clock inside `session`'s transaction: a queue claim compares and moves `due` by it, so no process
 * clock decides when a row is due.
 */
export async function databaseNow(session: Session): Promise<Date> {
	const [row] = await rows(session, SQL_CLOCK, [])
	return requiredDate(row ?? {}, 'now')
}

const lost = (fence: LeaseFence): LeaseLostError =>
	new LeaseLostError(`job '${fence.job}' lost its lease or its attempt's deadline (generation ${fence.generation}); nothing was written`)

const params = (fence: LeaseFence): (string | number)[] => [fence.job, fence.generation, fence.holder]

/**
 * Runs `work` in a mutation's transaction under `fence`. Before it: the attempt still holds its lease, the lease row
 * stays locked `for share` until the commit (a takeover or a renewal waits), and every statement is bounded by the
 * attempt's remaining time. After it, just before the commit: the attempt still holds the lease within its deadline.
 * Otherwise the transaction rolls back with `LeaseLostError`; so does a statement the deadline or the runner cancelled.
 * On SQLite only the two checks run: no other event reaches the Durable Object while the transaction is open.
 */
export async function fencedTransaction<T>(session: Session, fence: LeaseFence, work: (transaction: Session) => Promise<T>): Promise<T> {
	refuseEnded(fence)
	let backend: Backend | undefined
	try {
		return await session.transaction(async (transaction) => {
			const [held] = await rows(transaction, SQL_FENCE, params(fence))
			if (held === undefined) {
				throw lost(fence)
			}
			// SQLite has no backend to cancel and no statement timeout: the check before the commit refuses a late attempt,
			// and a Durable Object resets a transaction that runs past its own limit.
			const postgres = transaction.dialect === 'postgres'
			if (postgres) {
				backend = { pid: integer(held, 'pid'), began: text(held, 'began') }
				const running = inFlight.get(fence) ?? new Set<Backend>()
				running.add(backend)
				inFlight.set(fence, running)
			}
			refuseEnded(fence)
			if (postgres) {
				await runFixedStatement(transaction, SQL_TIMEOUTS, [String(integer(held, 'remaining_ms'))])
			}
			const result = await work(transaction)
			refuseEnded(fence)
			if ((await rows(transaction, SQL_STILL_HELD, params(fence))).length === 0) {
				throw lost(fence)
			}
			return result
		}, stopOf(fence).signal)
	} catch (error) {
		if (ended.has(fence) || (error instanceof DatabaseError && (error.sqlState === QUERY_CANCELED || error.sqlState === IDLE_TIMEOUT))) {
			throw lost(fence)
		}
		throw error
	} finally {
		if (backend !== undefined) {
			inFlight.get(fence)?.delete(backend)
		}
	}
}

export function jobLeases(runtime: () => DataLayerRuntime): JobLeases {
	const session = () => sessionOf(runtime())
	return Object.freeze({
		async now(): Promise<Date> {
			const [row] = await rows(session(), SQL_NOW, [])
			return requiredDate(row ?? {}, 'now')
		},

		async register(job: string): Promise<void> {
			await rows(session(), SQL_REGISTER, [job])
		},

		async reapCrashed(job: string): Promise<boolean> {
			return (await rows(session(), SQL_REAP, [job])).length > 0
		},

		async acquire(job: string, holder: string, attemptMs: number, leaseMs: number): Promise<LeaseFence | null> {
			const [row] = await rows(session(), SQL_ACQUIRE, [job, holder, milliseconds(leaseMs, 'a lease'), milliseconds(attemptMs, 'an attempt')])
			return fenceOf(job, holder, row)
		},

		async renew(fence: LeaseFence, holder: string, attemptMs: number, leaseMs: number): Promise<LeaseFence | null> {
			const [row] = await rows(session(), SQL_RENEW, [
				...params(fence),
				holder,
				milliseconds(leaseMs, 'a lease'),
				milliseconds(attemptMs, 'an attempt'),
			])
			return fenceOf(fence.job, holder, row)
		},

		async finish(fence: LeaseFence, outcome: JobOutcome): Promise<boolean> {
			return (await rows(session(), SQL_FINISH, [...params(fence), outcome])).length > 0
		},

		async tryAcquire(job: string, holder: string, attemptMs: number, leaseMs: number): Promise<LeaseFence | null> {
			const [row] = await rows(session(), SQL_TRY_ACQUIRE, [job, holder, milliseconds(leaseMs, 'a lease'), milliseconds(attemptMs, 'an attempt')])
			return fenceOf(job, holder, row)
		},

		async markPending(job: string): Promise<void> {
			await rows(session(), SQL_MARK_PENDING, [job])
		},

		async takePending(job: string): Promise<boolean> {
			return (await rows(session(), SQL_TAKE_PENDING, [job])).length > 0
		},

		async claimOverdue(job: string, periodMs: number): Promise<OverdueClaim | null> {
			const [row] = await rows(session(), SQL_CLAIM_OVERDUE, [job, milliseconds(periodMs, 'a period')])
			return row === undefined
				? null
				: Object.freeze({ lastSucceededAt: date(row, 'last_succeeded_at'), firstSeenAt: requiredDate(row, 'first_seen_at') })
		},

		async cancelInFlight(fence: LeaseFence): Promise<void> {
			ended.add(fence)
			// The transaction rolls back and gives its connection back now, even while its work waits on something else;
			// a statement still running is cancelled, so the ROLLBACK queued behind it runs. SQLite records no backend.
			stopOf(fence).abort(lost(fence))
			const running = [...(inFlight.get(fence) ?? [])]
			for (const backend of running) {
				await runFixedStatement(session(), SQL_CANCEL, [backend.pid, backend.began])
			}
		},

		async state(job: string): Promise<JobLeaseState | null> {
			const [row] = await rows(session(), SQL_STATE, [job])
			return row === undefined ? null : stateOf(row)
		},
	})
}
