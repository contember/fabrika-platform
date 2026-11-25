// The framework's side of `fabrika_push_subscriptions` (`@fabrika/db/migrations`, ADR-0088): a browser's Web Push
// subscription, bound to the principal who recorded it. Only `@fabrika/app`'s dispatcher reaches it, through
// `frameworkTablesOf`, in the invocation's own transaction. The principal always comes from the verified token, never
// from a request body; the caller hands it in.
//
// - A subscription is recorded only under its own principal: an endpoint whose row (or unexpired tombstone) names
//   another principal is `taken`, never rebound.
// - A replacement (a key rotation, a `pushsubscriptionchange`) names the old endpoint, and is accepted only when the
//   old endpoint's row or tombstone names the caller; the old row goes, its cursor moves to the new one.
// - A push service's 404 or 410 turns the row into a tombstone (`retire`): the principal and the endpoint only, kept
//   `tombstoneRetentionMs`, which answers nothing but a replacement's question.
// - A principal holds at most `perPrincipal` live subscriptions: a record past it drops the oldest.
//
// On Postgres every write first takes the principal's transaction lock, so two records of one person never both see
// room under the bound; the endpoint's uniqueness decides between two people. Times are epoch milliseconds the caller
// passes, as the receipts take theirs.

import { runFixedStatement, type Session } from './database'
import { QueryRefusedError } from './errors'
import type { DialectTexts } from './job-leases'
import { PUSH_SUBSCRIPTIONS_TABLE } from './migrations'

export const PUSH_SUBSCRIPTION_LIMITS = Object.freeze({
	/** Live subscriptions one principal holds; the next record drops the oldest. */
	perPrincipal: 10,
	/** How long a tombstone answers a replacement: 30 days. */
	tombstoneRetentionMs: 30 * 24 * 60 * 60 * 1_000,
})

/** A subscription as the page hands it over, with the VAPID public key it was made with. */
export interface PushSubscriptionKeys {
	readonly endpoint: string
	/** The browser's P-256 key, base64url. */
	readonly p256dh: string
	/** The browser's authentication secret, base64url. */
	readonly auth: string
	/** The VAPID public key the browser subscribed with, base64url. */
	readonly vapidKey: string
}

/** Whose a browser's endpoint is, as the caller may learn it: its own live row, another principal's, or none (a tombstone included). */
export type PushBinding = 'mine' | 'other' | 'unknown'

/** `recorded`, or why not: the endpoint is bound to another principal, or the replaced endpoint is not the caller's. */
export type PushRecordOutcome = 'recorded' | 'taken' | 'not_replaceable'

export interface PushSubscriptions {
	/** Whose `endpoint` is, for `principal`. */
	binding(session: Session, principal: string, endpoint: string): Promise<PushBinding>
	/**
	 * Records `subscription` for `principal` under `id` (a new row's key; an existing row of the caller keeps its own),
	 * replacing the endpoint `replace` when it names one, at `now`. Prunes a batch of expired tombstones first, and
	 * drops the principal's oldest live rows past the bound after. An outcome but `recorded` changes no subscription: the
	 * old row is removed only after the new one was written.
	 */
	record(
		session: Session,
		principal: string,
		id: string,
		subscription: PushSubscriptionKeys,
		replace: string | null,
		now: number,
	): Promise<PushRecordOutcome>
	/** Removes `principal`'s own row (or tombstone) of `endpoint`; `false` when it has none. */
	remove(session: Session, principal: string, endpoint: string): Promise<boolean>
	/** The push service called `endpoint` gone: its live row becomes a tombstone at `now`. `false` when it had none. */
	retire(session: Session, endpoint: string, now: number): Promise<boolean>
}

const T = PUSH_SUBSCRIPTIONS_TABLE

/** Tombstones one write prunes at most; every record prunes, so expired ones never outgrow the live ones. */
const PRUNE_BATCH = 32

// Held until the transaction ends; two principals whose hashes collide only wait for each other.
const SQL_LOCK = `select 1 as locked from pg_advisory_xact_lock(hashtextextended('fabrika_push' || chr(10) || $1, 0))`

const SQL_PRUNE: DialectTexts = {
	postgres: `delete from ${T} where id in (
	select id from ${T} where gone_at < $1::bigint limit ${PRUNE_BATCH} for update skip locked
)`,
	sqlite: `delete from ${T} where id in (select id from ${T} where gone_at < ?1 limit ${PRUNE_BATCH})`,
}

// The old row is replaceable only when it, or its tombstone within the retention, is the caller's; its cursor moves on.
// Locked until the transaction ends, so the sender cannot retire it between this read and its delete.
const SQL_REPLACED: DialectTexts = {
	postgres: `select cursor from ${T} where endpoint = $1 and principal = $2 and (gone_at is null or gone_at >= $3::bigint) for update`,
	sqlite: `select cursor from ${T} where endpoint = ?1 and principal = ?2 and (gone_at is null or gone_at >= ?3)`,
}

// After the new row is written: the old one, read and locked above, goes.
const SQL_DROP_REPLACED: DialectTexts = {
	postgres: `delete from ${T} where endpoint = $1 and principal = $2`,
	sqlite: `delete from ${T} where endpoint = ?1 and principal = ?2`,
}

// One statement decides between two principals: a row of another principal is overwritten only when it is a tombstone
// past the retention. A row of the caller keeps its id and its cursor, and is live again with the new keys.
const SQL_UPSERT: DialectTexts = {
	postgres: `insert into ${T} (id, principal, endpoint, p256dh, auth, vapid_key, cursor, recorded_at)
values ($1, $2, $3, $4, $5, $6, $7, $8::bigint)
on conflict (endpoint) do update set
	principal = excluded.principal,
	p256dh = excluded.p256dh,
	auth = excluded.auth,
	vapid_key = excluded.vapid_key,
	cursor = case when ${T}.principal = excluded.principal then coalesce(${T}.cursor, excluded.cursor) else excluded.cursor end,
	next_attempt_at = null,
	recorded_at = excluded.recorded_at,
	gone_at = null
where ${T}.principal = excluded.principal or ${T}.gone_at < $9::bigint
returning endpoint`,
	sqlite: `insert into ${T} (id, principal, endpoint, p256dh, auth, vapid_key, cursor, recorded_at)
values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
on conflict (endpoint) do update set
	principal = excluded.principal,
	p256dh = excluded.p256dh,
	auth = excluded.auth,
	vapid_key = excluded.vapid_key,
	cursor = case when ${T}.principal = excluded.principal then coalesce(${T}.cursor, excluded.cursor) else excluded.cursor end,
	next_attempt_at = null,
	recorded_at = excluded.recorded_at,
	gone_at = null
where ${T}.principal = excluded.principal or ${T}.gone_at < ?9
returning endpoint`,
}

const SQL_TRIM: DialectTexts = {
	postgres: `delete from ${T} where id in (
	select id from ${T} where principal = $1 and gone_at is null order by recorded_at desc, id desc offset ${PUSH_SUBSCRIPTION_LIMITS.perPrincipal}
)`,
	sqlite: `delete from ${T} where id in (
	select id from ${T} where principal = ?1 and gone_at is null order by recorded_at desc, id desc limit -1 offset ${PUSH_SUBSCRIPTION_LIMITS.perPrincipal}
)`,
}

const SQL_BINDING: DialectTexts = {
	postgres: `select principal from ${T} where endpoint = $1 and gone_at is null`,
	sqlite: `select principal from ${T} where endpoint = ?1 and gone_at is null`,
}

const SQL_REMOVE: DialectTexts = {
	postgres: `delete from ${T} where endpoint = $1 and principal = $2 returning endpoint`,
	sqlite: `delete from ${T} where endpoint = ?1 and principal = ?2 returning endpoint`,
}

const SQL_RETIRE: DialectTexts = {
	postgres: `update ${T} set gone_at = $2::bigint, p256dh = null, auth = null, vapid_key = null, next_attempt_at = null
where endpoint = $1 and gone_at is null returning endpoint`,
	sqlite: `update ${T} set gone_at = ?2, p256dh = null, auth = null, vapid_key = null, next_attempt_at = null
where endpoint = ?1 and gone_at is null returning endpoint`,
}

function isRow(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null
}

/** The text in `column` of the row, or `null`; any other value is a row this module did not write. */
function nullableText(row: unknown, column: string): string | null {
	if (!isRow(row)) {
		throw new QueryRefusedError('unexpected_row', `${T} answered a row that is not an object`)
	}
	const value = row[column]
	if (value === null || typeof value === 'string') {
		return value
	}
	throw new QueryRefusedError('unexpected_row', `${T}.${column} came back as ${typeof value}`)
}

function epochMs(value: number, what: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new QueryRefusedError('invalid_argument', `${what} must be epoch milliseconds`)
	}
	return value
}

export function pushSubscriptions(): PushSubscriptions {
	return Object.freeze({
		async binding(session: Session, principal: string, endpoint: string): Promise<PushBinding> {
			const [row] = await runFixedStatement(session, SQL_BINDING[session.dialect], [endpoint])
			if (row === undefined) {
				return 'unknown'
			}
			return nullableText(row, 'principal') === principal ? 'mine' : 'other'
		},

		record(
			session: Session,
			principal: string,
			id: string,
			subscription: PushSubscriptionKeys,
			replace: string | null,
			now: number,
		): Promise<PushRecordOutcome> {
			const cutoff = epochMs(now, 'now') - PUSH_SUBSCRIPTION_LIMITS.tombstoneRetentionMs
			return session.transaction(async (transaction) => {
				const dialect = transaction.dialect
				if (dialect === 'postgres') {
					await runFixedStatement(transaction, SQL_LOCK, [principal])
				}
				await runFixedStatement(transaction, SQL_PRUNE[dialect], [cutoff])
				// Nothing but the prune is written before both checks pass, so no outcome but `recorded` changes a row.
				let cursor: string | null = null
				const replacing = replace !== null && replace !== subscription.endpoint ? replace : null
				if (replacing !== null) {
					const [replaced] = await runFixedStatement(transaction, SQL_REPLACED[dialect], [replacing, principal, cutoff])
					if (replaced === undefined) {
						return 'not_replaceable'
					}
					cursor = nullableText(replaced, 'cursor')
				}
				const written = await runFixedStatement(transaction, SQL_UPSERT[dialect], [
					id,
					principal,
					subscription.endpoint,
					subscription.p256dh,
					subscription.auth,
					subscription.vapidKey,
					cursor,
					now,
					cutoff,
				])
				if (written.length === 0) {
					return 'taken'
				}
				if (replacing !== null) {
					await runFixedStatement(transaction, SQL_DROP_REPLACED[dialect], [replacing, principal])
				}
				await runFixedStatement(transaction, SQL_TRIM[dialect], [principal])
				return 'recorded'
			})
		},

		async remove(session: Session, principal: string, endpoint: string): Promise<boolean> {
			return (await runFixedStatement(session, SQL_REMOVE[session.dialect], [endpoint, principal])).length > 0
		},

		async retire(session: Session, endpoint: string, now: number): Promise<boolean> {
			return (await runFixedStatement(session, SQL_RETIRE[session.dialect], [endpoint, epochMs(now, 'now')])).length > 0
		},
	})
}
