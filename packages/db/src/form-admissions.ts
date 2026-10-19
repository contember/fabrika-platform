// The framework's side of `fabrika_form_admissions` and `fabrika_form_challenges` (`@fabrika/db/migrations`): the
// per-minute counters a form's admission takes from, shared by every instance of the application, and the digests of
// the challenge tokens a form accepted. Only `@fabrika/app`'s form dispatcher reaches them, through
// `frameworkTablesOf`. Each operation is one statement, so two instances never read a counter and then write it, and
// each prunes a bounded batch of expired rows of its own table, so neither table grows past what the last minutes hold.

import { runFixedStatement, type Session, sessionOf } from './database'
import { QueryRefusedError } from './errors'
import { FORM_ADMISSIONS_TABLE, FORM_BYTES_TABLE, FORM_CHALLENGES_TABLE } from './migrations'
import type { DataLayerRuntime } from './store'

/** The bucket of `fabrika_form_admissions` an inbox append takes from, in the append's own transaction. */
export interface InboxQuota {
	readonly bucket: string
	readonly limit: number
}

export interface FormAdmissions {
	/**
	 * Takes one from `bucket` of `form` in the database's current minute; `false` when `limit` were already taken
	 * there. The counter and the check are one statement.
	 */
	take(form: string, bucket: string, limit: number): Promise<boolean>
	/**
	 * Records the digest of a challenge token `form` accepted, kept for `retainMs`; `false` when it was already
	 * recorded and has not expired, which makes the token's second use a replay.
	 */
	recordChallenge(form: string, tokenDigest: string, retainMs: number): Promise<boolean>
	/**
	 * Reserves `bytes` of `form`'s hourly byte budget `limit`, in the database's current hour; `false`, with nothing
	 * taken, when they no longer fit. The check and the counter are one statement. `form` is a form's name, or the
	 * endpoint id of a procedure whose `bytesPerHour` is charged its declared body length.
	 */
	reserveBytes(form: string, bytes: number, limit: number): Promise<boolean>
	/** Gives back `bytes` of a reservation of the current hour that a written file did not need. */
	releaseBytes(form: string, bytes: number): Promise<void>
}

const A = FORM_ADMISSIONS_TABLE
const C = FORM_CHALLENGES_TABLE

/** Rows one statement prunes at most; every statement prunes, so expired rows never outgrow the live ones. */
const PRUNE_BATCH = 32

// `skip locked`: a prune never waits on a row another statement holds, so two admissions never deadlock. A prune never
// touches the row its own statement writes: the take's is the current minute's, and a record's is excluded by key.
const SQL_TAKE = `with pruned as (
	delete from ${A} where (form, bucket, window_start) in (
		select form, bucket, window_start from ${A} where window_start < date_trunc('minute', now())
		limit ${PRUNE_BATCH} for update skip locked
	)
)
insert into ${A} (form, bucket, window_start, count) values ($1, $2, date_trunc('minute', now()), 1)
on conflict (form, bucket, window_start) do update set count = ${A}.count + 1 where ${A}.count < $3::int
returning count`

const B = FORM_BYTES_TABLE

const SQL_RESERVE_BYTES = `with pruned as (
	delete from ${B} where (form, window_start) in (
		select form, window_start from ${B} where window_start < date_trunc('hour', now())
		limit ${PRUNE_BATCH} for update skip locked
	)
)
insert into ${B} (form, window_start, bytes) select $1, date_trunc('hour', now()), $2::bigint where $2::bigint <= $3::bigint
on conflict (form, window_start) do update set bytes = ${B}.bytes + excluded.bytes where ${B}.bytes + excluded.bytes <= $3::bigint
returning bytes`

const SQL_RELEASE_BYTES = `update ${B} set bytes = greatest(bytes - $2::bigint, 0)
where form = $1 and window_start = date_trunc('hour', now()) returning bytes`

const SQL_RECORD_CHALLENGE = `with pruned as (
	delete from ${C} where (form, token_digest) in (
		select form, token_digest from ${C} where expires_at <= now() and (form, token_digest) <> ($1, $2)
		limit ${PRUNE_BATCH} for update skip locked
	)
)
insert into ${C} (form, token_digest, expires_at) values ($1, $2, now() + $3::bigint * interval '1 millisecond')
on conflict (form, token_digest) do update set expires_at = excluded.expires_at where ${C}.expires_at <= now()
returning form`

function positiveInteger(value: number, what: string): number {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new QueryRefusedError('invalid_argument', `${what} must be a whole number of at least 1`)
	}
	return value
}

/** One take of `bucket` in `session`, which may be a transaction: rolled back with it, the take is given back. */
export async function takeFromBucket(session: Session, form: string, bucket: string, limit: number): Promise<boolean> {
	const rows = await runFixedStatement(session, SQL_TAKE, [form, bucket, positiveInteger(limit, 'a form limit')])
	return rows.length > 0
}

export function formAdmissions(runtime: () => DataLayerRuntime): FormAdmissions {
	const session = () => sessionOf(runtime())
	return Object.freeze({
		take: (form: string, bucket: string, limit: number): Promise<boolean> => takeFromBucket(session(), form, bucket, limit),

		async recordChallenge(form: string, tokenDigest: string, retainMs: number): Promise<boolean> {
			const rows = await runFixedStatement(session(), SQL_RECORD_CHALLENGE, [form, tokenDigest, positiveInteger(retainMs, 'a retention')])
			return rows.length > 0
		},

		async reserveBytes(form: string, bytes: number, limit: number): Promise<boolean> {
			const rows = await runFixedStatement(session(), SQL_RESERVE_BYTES, [
				form,
				positiveInteger(bytes, 'a reservation'),
				positiveInteger(limit, 'a byte budget'),
			])
			return rows.length > 0
		},

		async releaseBytes(form: string, bytes: number): Promise<void> {
			if (bytes > 0) {
				await runFixedStatement(session(), SQL_RELEASE_BYTES, [form, positiveInteger(bytes, 'a release')])
			}
		},
	})
}
