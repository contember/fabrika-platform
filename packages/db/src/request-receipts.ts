// The framework's side of `fabrika_request_receipts` (`@fabrika/db/migrations`, ADR-0078): the answer of a mutation
// whose request carried a key, kept so a repeat of that request is answered without running it again. Keyed by the
// principal and the key; only `@fabrika/app`'s dispatcher reaches it, through `frameworkTablesOf`, and always in the
// invocation's own transaction, so a receipt commits with the write it answers. Each write prunes a bounded batch of
// receipts past the retention, so the table holds about one retention of keyed writes.

import { runFixedStatement, type Session } from './database'
import { QueryRefusedError } from './errors'
import type { DialectTexts } from './job-leases'
import { REQUEST_RECEIPTS_TABLE } from './migrations'

/** What a receipt records of the request it answers: its operation, the digest of its input, and the output's JSON. */
export interface RequestReceipt {
	readonly operation: string
	readonly identity: string
	readonly output: string
}

export interface RequestReceipts {
	/**
	 * The receipt of `principal`'s `key`, read in `session`; `null` when there is none. On Postgres it first takes the
	 * key's transaction lock, so a concurrent copy of the request waits for this transaction and then reads its receipt
	 * instead of running too; SQLite's one writer already serializes them.
	 */
	find(session: Session, principal: string, key: string): Promise<RequestReceipt | null>
	/**
	 * Records `receipt` under `principal`'s `key` in `session`, created at `now` (epoch ms), after pruning a batch of
	 * receipts created before `retainedSince`. `false` when the key already has a receipt: another copy of the request
	 * recorded it meanwhile, and this one's transaction must not commit.
	 */
	record(session: Session, principal: string, key: string, receipt: RequestReceipt, now: number, retainedSince: number): Promise<boolean>
}

const R = REQUEST_RECEIPTS_TABLE

/** Receipts one write prunes at most; every write prunes, so expired receipts never outgrow the live ones. */
const PRUNE_BATCH = 32

// Held until the transaction ends; two keys whose hashes collide only wait for each other.
const SQL_LOCK = `select 1 as locked from pg_advisory_xact_lock(hashtextextended($1 || chr(10) || $2, 0))`

const SQL_FIND: DialectTexts = {
	postgres: `select operation, identity, output from ${R} where principal = $1 and request_key = $2`,
	sqlite: `select operation, identity, output from ${R} where principal = ?1 and request_key = ?2`,
}

// `skip locked`: a prune never waits on a receipt another transaction holds. It never touches the key it writes.
const SQL_RECORD_POSTGRES = `with pruned as (
	delete from ${R} where (principal, request_key) in (
		select principal, request_key from ${R}
		where created_at < $7::bigint and not (principal = $1 and request_key = $2)
		limit ${PRUNE_BATCH} for update skip locked
	)
)
insert into ${R} (principal, request_key, operation, identity, output, created_at) values ($1, $2, $3, $4, $5, $6::bigint)
on conflict (principal, request_key) do nothing
returning request_key`

// SQLite has no data-modifying CTE, so the prune is a statement of its own before the insert, in the same transaction.
const SQLITE_PRUNE = `delete from ${R} where (principal, request_key) in (
	select principal, request_key from ${R}
	where created_at < ?3 and not (principal = ?1 and request_key = ?2)
	limit ${PRUNE_BATCH}
)`

const SQLITE_RECORD = `insert into ${R} (principal, request_key, operation, identity, output, created_at) values (?1, ?2, ?3, ?4, ?5, ?6)
on conflict (principal, request_key) do nothing
returning request_key`

function text(row: Readonly<Record<string, unknown>>, column: string): string {
	const value = row[column]
	if (typeof value !== 'string') {
		throw new QueryRefusedError('unexpected_row', `${R}.${column} came back as ${typeof value}`)
	}
	return value
}

function isRow(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null
}

export function requestReceipts(): RequestReceipts {
	return Object.freeze({
		async find(session: Session, principal: string, key: string): Promise<RequestReceipt | null> {
			if (session.dialect === 'postgres') {
				await runFixedStatement(session, SQL_LOCK, [principal, key])
			}
			const rows = await runFixedStatement(session, SQL_FIND[session.dialect], [principal, key])
			const row = rows[0]
			if (row === undefined) {
				return null
			}
			if (!isRow(row)) {
				throw new QueryRefusedError('unexpected_row', `${R} answered a row that is not an object`)
			}
			return { operation: text(row, 'operation'), identity: text(row, 'identity'), output: text(row, 'output') }
		},
		async record(session: Session, principal: string, key: string, receipt: RequestReceipt, now: number, retainedSince: number): Promise<boolean> {
			const values = [principal, key, receipt.operation, receipt.identity, receipt.output, now]
			if (session.dialect === 'sqlite') {
				await runFixedStatement(session, SQLITE_PRUNE, [principal, key, retainedSince])
				return (await runFixedStatement(session, SQLITE_RECORD, values)).length === 1
			}
			return (await runFixedStatement(session, SQL_RECORD_POSTGRES, [...values, retainedSince])).length === 1
		},
	})
}
