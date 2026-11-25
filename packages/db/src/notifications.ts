// The framework's side of `fabrika_notifications` (`@fabrika/db/migrations`, ADR-0088 §6): a notification written for
// one principal, with what the recipient must hold to read it. Only `@fabrika/app` reaches it, through
// `frameworkTablesOf`, in the invocation's own transaction. The inbox reads a principal's rows after a subscription's
// cursor, oldest first; whether the caller may read each one is the framework's check, not this module's. A row lives
// `retentionMs`: a read never answers an older one, and every write prunes a batch of them.

import { runFixedStatement, type Session } from './database'
import { QueryRefusedError } from './errors'
import type { DialectTexts } from './job-leases'
import { NOTIFICATIONS_TABLE } from './migrations'

export const NOTIFICATION_LIMITS = Object.freeze({
	/** How long a notification is kept and answered: seven days. */
	retentionMs: 7 * 24 * 60 * 60 * 1_000,
})

/** What the recipient must hold to read a notification: an action on one object, or the action as a global grant. */
export type NotificationAbout =
	| { readonly action: string; readonly dimension: string; readonly value: string }
	| { readonly action: string; readonly dimension: null; readonly value: null }

export interface StoredNotification {
	/** A UUIDv7: its order is the order written. */
	readonly id: string
	readonly title: string
	readonly body: string
	readonly path: string
	readonly about: NotificationAbout
}

export interface NewNotification extends StoredNotification {
	readonly principal: string
	/** Epoch milliseconds. */
	readonly createdAt: number
}

export interface Notifications {
	/** Writes `notification`, after pruning a batch of rows past the retention. */
	record(session: Session, notification: NewNotification): Promise<void>
	/** `principal`'s rows written after the notification `after` (all of them for `null`), within the retention at `now`, oldest first, at most `limit`. */
	unseen(session: Session, principal: string, after: string | null, now: number, limit: number): Promise<readonly StoredNotification[]>
	/** How many of `principal`'s rows within the retention at `now` were written after `after`. */
	countAfter(session: Session, principal: string, after: string | null, now: number): Promise<number>
}

const N = NOTIFICATIONS_TABLE

/** Rows one write prunes at most. */
const PRUNE_BATCH = 32

const SQL_PRUNE: DialectTexts = {
	postgres: `delete from ${N} where id in (select id from ${N} where created_at < $1::bigint limit ${PRUNE_BATCH} for update skip locked)`,
	sqlite: `delete from ${N} where id in (select id from ${N} where created_at < ?1 limit ${PRUNE_BATCH})`,
}

const SQL_INSERT: DialectTexts = {
	postgres: `insert into ${N} (id, principal, title, body, path, action, dimension, scope_value, created_at)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9::bigint)`,
	sqlite: `insert into ${N} (id, principal, title, body, path, action, dimension, scope_value, created_at)
values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
}

const SQL_UNSEEN: DialectTexts = {
	postgres: `select id::text as id, title, body, path, action, dimension, scope_value from ${N}
where principal = $1 and ($2::uuid is null or id > $2::uuid) and created_at >= $3::bigint order by id limit $4::int`,
	sqlite: `select id, title, body, path, action, dimension, scope_value from ${N}
where principal = ?1 and (?2 is null or id > ?2) and created_at >= ?3 order by id limit ?4`,
}

const SQL_COUNT: DialectTexts = {
	postgres: `select count(*)::int as unseen from ${N} where principal = $1 and ($2::uuid is null or id > $2::uuid) and created_at >= $3::bigint`,
	sqlite: `select count(*) as unseen from ${N} where principal = ?1 and (?2 is null or id > ?2) and created_at >= ?3`,
}

function isRow(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null
}

function text(row: Readonly<Record<string, unknown>>, column: string): string {
	const value = row[column]
	if (typeof value !== 'string') {
		throw new QueryRefusedError('unexpected_row', `${N}.${column} came back as ${typeof value}`)
	}
	return value
}

function storedOf(row: unknown): StoredNotification {
	if (!isRow(row)) {
		throw new QueryRefusedError('unexpected_row', `${N} answered a row that is not an object`)
	}
	const dimension = row['dimension']
	const value = row['scope_value']
	const action = text(row, 'action')
	const about: NotificationAbout | null = dimension === null && value === null
		? { action, dimension: null, value: null }
		: typeof dimension === 'string' && typeof value === 'string'
		? { action, dimension, value }
		: null
	if (about === null) {
		throw new QueryRefusedError('unexpected_row', `${N} answered a row whose object is half named`)
	}
	return { id: text(row, 'id'), title: text(row, 'title'), body: text(row, 'body'), path: text(row, 'path'), about }
}

function epochMs(value: number, what: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new QueryRefusedError('invalid_argument', `${what} must be epoch milliseconds`)
	}
	return value
}

export function notifications(): Notifications {
	return Object.freeze({
		record(session: Session, notification: NewNotification): Promise<void> {
			const createdAt = epochMs(notification.createdAt, 'createdAt')
			return session.transaction(async (transaction) => {
				await runFixedStatement(transaction, SQL_PRUNE[transaction.dialect], [createdAt - NOTIFICATION_LIMITS.retentionMs])
				const { about } = notification
				await runFixedStatement(transaction, SQL_INSERT[transaction.dialect], [
					notification.id,
					notification.principal,
					notification.title,
					notification.body,
					notification.path,
					about.action,
					about.dimension,
					about.value,
					createdAt,
				])
			})
		},

		async unseen(session: Session, principal: string, after: string | null, now: number, limit: number): Promise<readonly StoredNotification[]> {
			if (!Number.isSafeInteger(limit) || limit < 1) {
				throw new QueryRefusedError('invalid_argument', 'a limit must be a whole number of at least 1')
			}
			const since = epochMs(now, 'now') - NOTIFICATION_LIMITS.retentionMs
			const rows = await runFixedStatement(session, SQL_UNSEEN[session.dialect], [principal, after, since, limit])
			return rows.map(storedOf)
		},

		async countAfter(session: Session, principal: string, after: string | null, now: number): Promise<number> {
			const since = epochMs(now, 'now') - NOTIFICATION_LIMITS.retentionMs
			const [row] = await runFixedStatement(session, SQL_COUNT[session.dialect], [principal, after, since])
			const counted = isRow(row) ? row['unseen'] : undefined
			if (typeof counted !== 'number') {
				throw new QueryRefusedError('unexpected_row', `${N} answered a count that is no number`)
			}
			return counted
		},
	})
}
