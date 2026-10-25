// The framework's side of `fabrika_wakes` (`@fabrika/db/migrations`): a job's durable pending work, one row per due
// unit (its next scheduled run, a kick, a claim's re-arm, a durable retry), and the scheduler's next wake over it and the
// leases. Only `@fabrika/app` reaches it, through `frameworkTablesOf`. A wake changes with its run's lease only in the
// transaction of that run's fenced finish (`leaseProjection`), so a crash at any point leaves either the wake or a held
// lease whose expiry is due. Every change runs the runtime's `projectWakes` in its own transaction.

import { uuidv7 } from '@fabrika/platform'
import { freeze } from './builtins'
import { type FixedParameter, runFixedStatement, type Session, sessionOf } from './database'
import { QueryRefusedError } from './errors'
import type { DialectTexts, JobOutcome, LeaseChange, LeaseProjection } from './job-leases'
import { JOB_LEASES_TABLE, JOB_WAKES_TABLE } from './migrations'
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
}

/**
 * What a run's finish does with the wakes it owned (those due at or before its start), applied in the finish's
 * transaction and only when the finish still held the lease. Without one, a success is `completed` and a failure
 * leaves the wakes as they are.
 */
export type FinishWakes =
	/** The run is done with them: they are consumed, then the job's next cron run is scheduled (`cron:<job>:<expression>`). */
	| { readonly kind: 'completed'; readonly nextCron?: { readonly expression: string; readonly dueAt: Date } }
	/** The run failed and runs again: they move to `at`, and their attempt counts up. Only with a failed outcome. */
	| { readonly kind: 'retry'; readonly at: Date }

export interface JobWakes {
	/**
	 * Records a pending wake, in `using` when given (the transaction of the write it belongs to). A key already pending
	 * keeps one row at the earlier due time: a later wake never postpones an earlier one. Answers the row that holds it;
	 * a key another job holds is refused.
	 */
	schedule(wake: NewWake, using?: Session): Promise<Wake>
	/** The pending wakes of `job`, earliest first. */
	pending(job: string): Promise<readonly Wake[]>
	/**
	 * When the scheduler wakes next: the earliest due wake of a job whose lease is free or expired, or the expiry of a
	 * held lease (its deadman), whichever is earlier; `null` when neither exists. It may be past. Read in `using` when given.
	 */
	next(using?: Session): Promise<Date | null>
	/**
	 * Deletes the wakes of every job not in `declared`, the jobs the contract declares with their cron expressions, and
	 * each declared job's cron wake whose key names another expression; answers how many it deleted.
	 */
	reconcile(declared: readonly DeclaredJob[]): Promise<number>
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

/** A job the contract declares, and the cron expression its schedule is: its cron wake's key is `cron:<job>:<expression>`. */
export interface DeclaredJob {
	readonly job: string
	readonly expression: string
}

const W = JOB_WAKES_TABLE
const L = JOB_LEASES_TABLE
const COLUMNS = 'job, due_at, reason, attempt, dedupe'
const SQLITE_NOW = `strftime('${SQLITE_NOW_FORMAT}', 'now')`

/** A stored timestamp as epoch milliseconds, in each dialect. */
const PG_EPOCH_MS = (column: string): string => `floor(extract(epoch from ${column}) * 1000)::bigint`
const SQLITE_EPOCH_MS = (column: string): string => `cast(round((julianday(${column}) - 2440587.5) * 86400000) as integer)`

/** The start of the job's current run, in epoch milliseconds: the cut between the wakes it owns and later ones. */
const PG_RUN_START = `(select ${PG_EPOCH_MS('last_started_at')} from ${L} where job = $1)`
const SQLITE_RUN_START = `(select ${SQLITE_EPOCH_MS('last_started_at')} from ${L} where job = ?1)`

const SQL_SCHEDULE: DialectTexts = {
	// The update applies only to the same job's row, so a key another job holds answers no row.
	postgres: `insert into ${W} (id, ${COLUMNS}) values ($1::uuid, $2, $3::bigint, $4, 0, $5)
	on conflict (dedupe) where dedupe is not null do update set due_at = least(${W}.due_at, excluded.due_at) where ${W}.job = excluded.job
	returning id::text as id, ${COLUMNS}`,
	sqlite: `insert into ${W} (id, ${COLUMNS}) values (?1, ?2, cast(?3 as integer), ?4, 0, ?5)
	on conflict (dedupe) where dedupe is not null do update set due_at = min(${W}.due_at, excluded.due_at) where ${W}.job = excluded.job
	returning id, ${COLUMNS}`,
}

const SQL_PENDING: DialectTexts = {
	postgres: `select id::text as id, ${COLUMNS} from ${W} where job = $1 order by due_at, id`,
	sqlite: `select id, ${COLUMNS} from ${W} where job = ?1 order by due_at, id`,
}

// Two candidates, each one index-ordered or per-job lookup: the earliest wake of a free or expired job walks the due index
// and stops at the first, and the earliest held expiry reads the lease rows, one per job. Postgres compares by the
// statement's clock, not the transaction's: `using` may be a transaction that began before a lease expired.
const SQL_NEXT: DialectTexts = {
	postgres: `select
		(select w.due_at from ${W} w left join ${L} l on l.job = w.job
			where l.holder is null or l.expires_at <= clock_timestamp() order by w.due_at limit 1) as wake,
		(select ${PG_EPOCH_MS('min(expires_at)')} from ${L} where holder is not null) as held`,
	sqlite: `select
		(select w.due_at from ${W} w left join ${L} l on l.job = w.job
			where l.holder is null or l.expires_at <= ${SQLITE_NOW} order by w.due_at limit 1) as wake,
		(select ${SQLITE_EPOCH_MS('min(expires_at)')} from ${L} where holder is not null) as held`,
}

const SQL_EXPIRED_HOLDERS: DialectTexts = {
	postgres: `select job from ${L} where holder is not null and expires_at <= clock_timestamp() order by job`,
	sqlite: `select job from ${L} where holder is not null and expires_at <= ${SQLITE_NOW} order by job`,
}

const SQL_CONSUME: DialectTexts = {
	postgres: `delete from ${W} where job = $1 and due_at <= ${PG_RUN_START}`,
	sqlite: `delete from ${W} where job = ?1 and due_at <= ${SQLITE_RUN_START}`,
}

const SQL_RETRY: DialectTexts = {
	postgres: `update ${W} set due_at = $2::bigint, attempt = attempt + 1 where job = $1 and due_at <= ${PG_RUN_START}`,
	sqlite: `update ${W} set due_at = cast(?2 as integer), attempt = attempt + 1 where job = ?1 and due_at <= ${SQLITE_RUN_START}`,
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

function wakeOf(row: Readonly<Record<string, unknown>>): Wake {
	const { id, job, reason, due_at: dueAt, attempt, dedupe } = row
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
	return freeze({ kind: 'completed', nextCron: freeze({ expression: wakes.nextCron.expression, dueAt: wakes.nextCron.dueAt }) })
}

/** The runtime's projection of a change, in its transaction; nothing without one. */
function projectionOf(runtime: () => DataLayerRuntime): (transaction: Session) => Promise<void> {
	return async (transaction) => {
		await runtime().projectWakes?.(transaction)
	}
}

/**
 * The lease store's projection: a fenced finish applies its wake instruction, and every lease change then runs the
 * runtime's projection, all in the lease statement's transaction.
 */
export function leaseProjection(runtime: () => DataLayerRuntime): LeaseProjection {
	const project = projectionOf(runtime)
	return async (transaction: Session, job: string, change: LeaseChange): Promise<void> => {
		if (change.kind === 'finished' && change.wakes !== null) {
			if (change.wakes.kind === 'retry') {
				await rows(transaction, SQL_RETRY, [job, String(change.wakes.at.getTime())])
			} else {
				await rows(transaction, SQL_CONSUME, [job])
				const next = change.wakes.nextCron
				if (next !== undefined) {
					await insert(transaction, newWake({ job, reason: 'cron', dueAt: next.dueAt, dedupe: `cron:${job}:${next.expression}` }), job)
				}
			}
		}
		await project(transaction)
	}
}

/** A job's one claim wake: each claim's computation replaces it. */
const claimKey = (job: string): string => `claim:${job}`

/**
 * Replaces `job`'s claim wake with one due at `dueAt`, or removes it for `null`, in `transaction`: the claim's fenced
 * transaction, so the re-arm commits with the rows it leased. Only the latest claim's computation stands.
 */
export async function rearmClaim(runtime: DataLayerRuntime, transaction: Session, job: string, dueAt: Date | null): Promise<void> {
	const parameters = dueAt === null ? null : newWake({ job, reason: 'claim', dueAt, dedupe: claimKey(job) })
	await rows(transaction, SQL_DROP_CLAIM, [job, claimKey(job)])
	if (parameters !== null) {
		await insert(transaction, parameters, job)
	}
	await runtime.projectWakes?.(transaction)
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

		async next(using?: Session): Promise<Date | null> {
			const [{ wake = null, held = null } = {}] = await rows(using ?? session(), SQL_NEXT, [])
			const candidates = [wake, held].filter((value) => value !== null).map((value) => wholeNumber(value, 'the next wake'))
			return candidates.length === 0 ? null : new Date(Math.min(...candidates))
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

		async reconcile(declared: readonly DeclaredJob[]): Promise<number> {
			if (!Array.isArray(declared)) {
				throw new QueryRefusedError('invalid_argument', 'the declared jobs are a list of jobs with their expressions')
			}
			const jobs = declared.map((entry: unknown) => {
				const job: unknown = typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'job') : undefined
				const expression: unknown = typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'expression') : undefined
				return { job: nonEmpty(job, 'a declared job'), expression: nonEmpty(expression, "a declared job's expression") }
			})
			return await session().transaction(async (transaction) => {
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
