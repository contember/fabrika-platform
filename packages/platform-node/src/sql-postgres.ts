// `SqlDatabase` over Postgres, using Bun's BUILT-IN SQL client (`Bun.SQL`).
//
// No driver dependency: `postgres`/`pg` would add a package, a second connection pool implementation
// and a second set of type-coercion rules for nothing — `Bun.SQL` already gives a pooled client,
// `unsafe(text, values)` for pre-built parameterised statements (which is exactly what a D1-shaped
// port needs — `prepare()` then `bind()`, not a tagged template) and `begin()` for real transactions.
// The runtime is Bun (ADR-0003: the control plane itself executes deploys on Zerops), so the built-in
// is available by construction.
//
// WHERE POSTGRES DIVERGES FROM D1 — the port hides the API, not the engine. Read this before moving
// an existing service onto this driver:
//
//  * `meta.changes` — Bun reports `count` on the result. For a SELECT that is the ROW COUNT, which D1
//    reports as 0, so `run()` maps `count` to `changes` only for INSERT/UPDATE/DELETE/MERGE and
//    reports 0 otherwise. The guarded-UPDATE idiom (`changes === 0` means the guard did not match) is
//    therefore accurate on both, including for `… RETURNING`, where `count` is the affected-row count.
//  * BIGINT / NUMERIC COLUMNS COME BACK AS STRINGS. Bun decodes by column type, not by value: `int8`
//    and `numeric` are `string` (or `bigint` with `{ bigint: true }`), never `number`, even for a
//    value of 5. SQLite/D1 hand back a `number`. Any column a row shape types as `number` must be
//    `INTEGER` (int4) in the Postgres migration, or the caller must coerce. int4 tops out at
//    2147483647 — fine for the unix-SECONDS timestamps this codebase uses, NOT for unix millis.
//  * PARAMETER TYPES ARE CHECKED. `WHERE text_col = $1` bound with a number fails with
//    `operator does not exist: text = integer`; SQLite would have compared them happily (and returned
//    no rows). This surfaces latent bind-type bugs as loud errors rather than silent empty results.
//  * `undefined` binds as NULL (D1 throws). Kept deliberately: both existing bun:sqlite test harnesses
//    already coerce `undefined` → null, so this matches what the services are tested against.
//  * SQLite-only SQL still fails, obviously: `unixepoch()` does not exist in Postgres. Several
//    statements in `@fabrika/control` and `@fabrika/iam` use it today.
//  * Prepared statements are cached per connection by default. Behind a transaction-mode pooler
//    (pgbouncer) construct the client with `{ prepare: false }`.

import type { SqlDatabase, SqlQueryResult, SqlRunResult, SqlStatement } from '@fabrika/platform'
import { rewritePlaceholders, type RewrittenSql } from './placeholders'

/** Command tags whose row count IS an affected-row count. Anything else reports `changes: 0`, as D1 does. */
const MUTATING_COMMANDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE'])

/** What a bound value may be. Anything else is a programming error and throws at bind time, as D1 does. */
export type SqlBindValue = string | number | bigint | boolean | Date | Uint8Array | null

/**
 * One prepared statement. IMMUTABLE: `bind()` returns a NEW statement carrying the values and leaves
 * the receiver untouched, which is D1's contract and what call sites rely on when they prepare once
 * and bind in a loop.
 */
export class PostgresStatement implements SqlStatement {
	constructor(
		private readonly sql: Bun.SQL,
		private readonly text: string,
		private readonly placeholders: number,
		private readonly values: readonly SqlBindValue[],
	) {}

	bind(...values: unknown[]): SqlStatement {
		return new PostgresStatement(this.sql, this.text, this.placeholders, values.map(toBindValue))
	}

	async first<T = Record<string, unknown>>(): Promise<T | null> {
		const statement = this.bound()
		const rows = await onReservedConnection(this.sql, (connection) => statement.rows<T>(connection))
		return rows[0] ?? null
	}

	async all<T = Record<string, unknown>>(): Promise<SqlQueryResult<T>> {
		const statement = this.bound()
		return { results: await onReservedConnection(this.sql, (connection) => statement.rows<T>(connection)) }
	}

	async run(): Promise<SqlRunResult> {
		const statement = this.bound()
		const result: unknown = await onReservedConnection(this.sql, (connection) => statement.rows<Record<string, unknown>>(connection))
		return { meta: { changes: changesOf(result) } }
	}

	/** This statement, once every placeholder has its value: a wrong count fails before any connection is taken. */
	bound(): PostgresStatement {
		if (this.values.length !== this.placeholders) {
			throw new Error(`statement expects ${this.placeholders} bound value(s), got ${this.values.length}`)
		}
		return this
	}

	/**
	 * Run this statement on a specific handle — a reserved connection of the pool, or the one `batch()` holds its
	 * transaction on. Internal to the package; the port only ever sees `first`/`all`/`run`.
	 */
	rows<T>(handle: Bun.SQL): Promise<T[]> {
		return handle.unsafe<T[]>(this.text, [...this.values])
	}
}

/**
 * A Postgres-backed `SqlDatabase`. Rewritten statement text is memoised per SQL string, so the
 * prepare-once/bind-many idiom tokenises each statement exactly once.
 */
export class PostgresDatabase implements SqlDatabase {
	private readonly rewrites = new Map<string, RewrittenSql>()

	constructor(private readonly sql: Bun.SQL) {}

	/**
	 * Open a pooled client. The URL is a CREDENTIAL — it is never logged, and never included in an
	 * error message raised here.
	 */
	static connect(url: string, options: Omit<Bun.SQL.PostgresOrMySQLOptions, 'url' | 'adapter'> = {}): PostgresDatabase {
		return new PostgresDatabase(new Bun.SQL({ ...options, url, adapter: 'postgres' }))
	}

	prepare(sql: string): SqlStatement {
		let rewritten = this.rewrites.get(sql)
		if (rewritten === undefined) {
			rewritten = rewritePlaceholders(sql)
			this.rewrites.set(sql, rewritten)
		}
		return new PostgresStatement(this.sql, rewritten.text, rewritten.count, [])
	}

	/**
	 * Run every statement in ONE transaction, in order. A throw rolls the whole batch back. The transaction is sent by
	 * hand on the reserved connection: Bun 1.3.14's `begin()` on a reserved connection rejects a failed statement twice,
	 * once unhandled.
	 */
	async batch<T = Record<string, unknown>>(statements: SqlStatement[]): Promise<SqlQueryResult<T>[]> {
		const own = statements.map((statement) => {
			if (!(statement instanceof PostgresStatement)) {
				throw new Error('batch() accepts only statements created by this database')
			}
			return statement.bound()
		})
		return onReservedConnection(this.sql, async (connection) => {
			await connection.unsafe('BEGIN')
			try {
				const out: SqlQueryResult<T>[] = []
				for (const statement of own) {
					out.push({ results: await statement.rows<T>(connection) })
				}
				await connection.unsafe('COMMIT')
				return out
			} catch (error) {
				// ROLLBACK fails only on a connection that is gone; the statement's own error is the one to report.
				await connection.unsafe('ROLLBACK').catch(() => undefined)
				throw error
			}
		})
	}

	/** Close the pool. Waits for in-flight queries unless a timeout is given. */
	async close(options?: { timeout?: number }): Promise<void> {
		await this.sql.close(options)
	}
}

/**
 * Runs `work` on a connection reserved from `pool` and releases it afterwards; every statement and every batch goes
 * through here. Bun 1.3.14's pool sends an unreserved query onto a connection that holds another caller's
 * transaction, where it waits for that transaction or runs inside it, and a burst of batches larger than the pool
 * hangs. Once every use is reserved, the pool has no unreserved query to send.
 */
async function onReservedConnection<T>(pool: Bun.SQL, work: (connection: Bun.SQL) => Promise<T>): Promise<T> {
	const connection = await pool.reserve()
	try {
		return await work(connection)
	} finally {
		// Typed `void`, `release()` answers a promise that rejects once the pool has closed the connection.
		Promise.resolve(connection.release()).catch(() => undefined)
	}
}

/** The rows-affected count D1 would report, or 0 for a statement that changes nothing. */
function changesOf(result: unknown): number {
	const command: unknown = readProperty(result, 'command')
	if (typeof command === 'string' && !MUTATING_COMMANDS.has(command)) {
		return 0
	}
	const count: unknown = readProperty(result, 'count')
	return typeof count === 'number' ? count : 0
}

function readProperty(value: unknown, key: string): unknown {
	if (typeof value !== 'object' || value === null) {
		return undefined
	}
	return Reflect.get(value, key)
}

/**
 * Narrow a bound value to something the driver can send. `undefined` becomes NULL (see the divergence
 * note at the top); anything else non-scalar is a bug in the call site and throws immediately, rather
 * than being silently JSON-ified into a column.
 */
function toBindValue(value: unknown): SqlBindValue {
	if (value === undefined) {
		return null
	}
	if (
		value === null
		|| typeof value === 'string'
		|| typeof value === 'number'
		|| typeof value === 'bigint'
		|| typeof value === 'boolean'
		|| value instanceof Date
		|| value instanceof Uint8Array
	) {
		return value
	}
	if (value instanceof ArrayBuffer) {
		return new Uint8Array(value)
	}
	throw new Error(`unsupported bind value of type ${typeof value}`)
}
