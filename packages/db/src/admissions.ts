// The framework's side of `fabrika_form_admissions`, `fabrika_form_challenges` and `fabrika_form_bytes`
// (`@fabrika/db/migrations`): the per-minute buckets a procedure's admission takes from, shared by every instance of the
// application, the digests of the challenge tokens it accepted, and its hourly byte budget (`bytesPerHour`). Each is
// keyed by the endpoint id; the tables keep the names and the `form` column they were created with. Only `@fabrika/app`'s
// dispatcher reaches them, through `frameworkTablesOf`. Each operation is one statement, so two instances never read a
// counter and then write it, and each prunes a bounded batch of expired rows of its own table, so no table grows past
// what the last minutes or hours hold.

import { runFixedStatement, sessionOf } from './database'
import { QueryRefusedError } from './errors'
import { FORM_ADMISSIONS_TABLE, FORM_BYTES_TABLE, FORM_CHALLENGES_TABLE } from './migrations'
import type { DataLayerRuntime } from './store'

export interface Admissions {
	/**
	 * Takes one from `bucket` of `endpoint` in the database's current minute; `false` when `limit` were already taken
	 * there. The counter and the check are one statement.
	 */
	take(endpoint: string, bucket: string, limit: number): Promise<boolean>
	/**
	 * Records the digest of a challenge token `endpoint` accepted, kept for `retainMs`; `false` when it was already
	 * recorded and has not expired, which makes the token's second use a replay.
	 */
	recordChallenge(endpoint: string, tokenDigest: string, retainMs: number): Promise<boolean>
	/**
	 * Reserves `bytes` of `endpoint`'s hourly byte budget `limit`, in the database's current hour; `false`, with nothing
	 * taken, when they no longer fit. The check and the counter are one statement.
	 */
	reserveBytes(endpoint: string, bytes: number, limit: number): Promise<boolean>
	/** Gives back `bytes` of a reservation of the current hour that the request did not need. */
	releaseBytes(endpoint: string, bytes: number): Promise<void>
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

export function admissions(runtime: () => DataLayerRuntime): Admissions {
	const session = () => sessionOf(runtime())
	return Object.freeze({
		async take(endpoint: string, bucket: string, limit: number): Promise<boolean> {
			const rows = await runFixedStatement(session(), SQL_TAKE, [endpoint, bucket, positiveInteger(limit, 'a bucket limit')])
			return rows.length > 0
		},

		async recordChallenge(endpoint: string, tokenDigest: string, retainMs: number): Promise<boolean> {
			const rows = await runFixedStatement(session(), SQL_RECORD_CHALLENGE, [endpoint, tokenDigest, positiveInteger(retainMs, 'a retention')])
			return rows.length > 0
		},

		async reserveBytes(endpoint: string, bytes: number, limit: number): Promise<boolean> {
			const rows = await runFixedStatement(session(), SQL_RESERVE_BYTES, [
				endpoint,
				positiveInteger(bytes, 'a reservation'),
				positiveInteger(limit, 'a byte budget'),
			])
			return rows.length > 0
		},

		async releaseBytes(endpoint: string, bytes: number): Promise<void> {
			if (bytes > 0) {
				await runFixedStatement(session(), SQL_RELEASE_BYTES, [endpoint, positiveInteger(bytes, 'a release')])
			}
		},
	})
}
