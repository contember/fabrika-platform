// The framework's side of `fabrika_wakes` (`@fabrika/db/migrations`): a job's durable pending work, one row per due
// unit (its next scheduled run, a kick, a claim's re-arm, a durable retry), and the projection of the scheduler's next
// wake over it and the leases. Only `@fabrika/app` reaches it, through `frameworkTablesOf`. A wake leaves the table
// only in the transaction of the fenced, successful finish of a run that started at or after it (`follow`, the lease
// store's projection), so a crash at any point leaves either the wake or a held lease whose expiry is due.

import { uuidv7 } from '@fabrika/platform'
import { freeze } from './builtins'
import { type FixedParameter, runFixedStatement, type Session, sessionOf } from './database'
import { QueryRefusedError } from './errors'
import { type DialectTexts, type LeaseChange, type LeaseProjection, SQLITE_NOW } from './job-leases'
import { JOB_LEASES_TABLE, JOB_WAKES_TABLE } from './migrations'
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
	readonly attempt: number
	readonly dedupe: string | null
}

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
	/** The lease store's projection: a successful finish consumes the wakes due at or before its run's start. */
	readonly follow: LeaseProjection
}

const W = JOB_WAKES_TABLE
const L = JOB_LEASES_TABLE
const COLUMNS = 'job, due_at, reason, attempt, dedupe'

/** A stored timestamp as epoch milliseconds, in each dialect. */
const PG_EPOCH_MS = (column: string): string => `floor(extract(epoch from ${column}) * 1000)::bigint`
const SQLITE_EPOCH_MS = (column: string): string => `cast(round((julianday(${column}) - 2440587.5) * 86400000) as integer)`

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

const SQL_NEXT: DialectTexts = {
	postgres: `select min(at) as next from (
		select w.due_at as at from ${W} w left join ${L} l on l.job = w.job where l.holder is null or l.expires_at <= now()
		union all
		select ${PG_EPOCH_MS('expires_at')} from ${L} where holder is not null
	) pending`,
	sqlite: `select min(at) as next from (
		select w.due_at as at from ${W} w left join ${L} l on l.job = w.job
		where l.holder is null or l.expires_at <= ${SQLITE_NOW}
		union all
		select ${SQLITE_EPOCH_MS('expires_at')} from ${L} where holder is not null
	)`,
}

const SQL_CONSUME: DialectTexts = {
	postgres: `delete from ${W} w using ${L} l where w.job = $1 and l.job = $1 and w.due_at <= ${PG_EPOCH_MS('l.last_started_at')}`,
	sqlite: `delete from ${W} where job = ?1 and due_at <= (select ${SQLITE_EPOCH_MS('last_started_at')} from ${L} where job = ?1)`,
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

function newWake(wake: NewWake): readonly FixedParameter[] {
	if (typeof wake.job !== 'string' || wake.job === '') {
		throw new QueryRefusedError('invalid_argument', 'a wake names the job it wakes')
	}
	if (!WAKE_REASONS.some((reason) => reason === wake.reason)) {
		throw new QueryRefusedError('invalid_argument', `a wake's reason is one of ${WAKE_REASONS.join(', ')}`)
	}
	const due = wake.dueAt instanceof Date ? wake.dueAt.getTime() : Number.NaN
	if (!Number.isSafeInteger(due)) {
		throw new QueryRefusedError('invalid_argument', 'a wake is due at a valid time')
	}
	if (wake.dedupe !== undefined && (typeof wake.dedupe !== 'string' || wake.dedupe === '')) {
		throw new QueryRefusedError('invalid_argument', "a wake's dedupe key is a non-empty string")
	}
	return [uuidv7(), wake.job, String(due), wake.reason, wake.dedupe ?? null]
}

export function jobWakes(runtime: () => DataLayerRuntime): JobWakes {
	const session = () => sessionOf(runtime())
	return freeze({
		async schedule(wake: NewWake, using?: Session): Promise<Wake> {
			const [row] = await rows(using ?? session(), SQL_SCHEDULE, newWake(wake))
			if (row === undefined) {
				throw new QueryRefusedError('invalid_argument', `the dedupe key of this wake of '${wake.job}' is held by another job's wake`)
			}
			return wakeOf(row)
		},

		async pending(job: string): Promise<readonly Wake[]> {
			return freeze((await rows(session(), SQL_PENDING, [job])).map(wakeOf))
		},

		async next(using?: Session): Promise<Date | null> {
			const [{ next = null } = {}] = await rows(using ?? session(), SQL_NEXT, [])
			return next === null ? null : new Date(wholeNumber(next, 'the next wake'))
		},

		async follow(transaction: Session, job: string, change: LeaseChange): Promise<void> {
			if (change === 'succeeded') {
				await rows(transaction, SQL_CONSUME, [job])
			}
		},
	})
}
