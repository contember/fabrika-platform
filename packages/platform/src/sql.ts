// The SQL port — the ONE database seam every service sits on.
//
// Shape is deliberately D1's: a real `D1Database` satisfies `SqlDatabase` STRUCTURALLY, with no
// adapter and no rewriting of the ~90 statements the services already carry. The Postgres driver
// reimplements this same surface (see @fabrika/platform-node), so the SQL bodies stay in ONE place
// instead of being duplicated per backend.
//
// The cost of that choice lands on the SQL, not on the code: every statement must stay inside the
// SQLite ∩ Postgres common subset. In practice that is cheap — both dialects support `ON CONFLICT`
// and `RETURNING`, and this codebase already generates ids and timestamps caller-side (never
// `strftime`/`unixepoch`/`AUTOINCREMENT` in a query). Placeholder syntax is the one real divergence
// and the Postgres driver rewrites `?` → `$n` mechanically. DDL is NOT covered here — migrations are
// per-dialect and are the genuinely expensive part of the port.

/**
 * A prepared statement. `bind()` returns a NEW statement; it never mutates the receiver (D1
 * semantics) — call sites build a base statement and bind it repeatedly, so a mutating `bind()`
 * corrupts them silently.
 *
 * Two further contracts every driver must honour, both relied on by existing call sites:
 *  - **`bind()` is optional.** A statement with no placeholders is executed directly, and `bind()`
 *    may legally be called with zero arguments.
 *  - **SQL NULL maps to JS `null`, never `undefined`.** Row shapes are checked with `=== null`.
 */
export interface SqlStatement {
	/** Bind positional parameters, left to right, for this statement's `?` placeholders. */
	bind(...values: unknown[]): SqlStatement
	/** First row, or `null` when the query matched nothing. */
	first<T = Record<string, unknown>>(): Promise<T | null>
	/** All matching rows. */
	all<T = Record<string, unknown>>(): Promise<SqlQueryResult<T>>
	/** Execute a write. Read `meta.changes` to learn whether it affected anything. */
	run(): Promise<SqlRunResult>
}

/** The result of `all()` — wrapped in `{ results }` to match D1 so no call site changes. */
export interface SqlQueryResult<T> {
	results: T[]
}

/**
 * The result of `run()`. `changes` is how the guarded-UPDATE idioms across this codebase detect a
 * no-op, so it is REQUIRED: a driver that left it undefined would turn every successful guarded
 * write into a silent "not found". `D1Meta.changes` is likewise non-optional, so D1 still satisfies
 * this structurally.
 *
 * It counts rows AFFECTED BY A WRITE. A `SELECT` reports `0` — drivers whose underlying client
 * returns a row count for reads must map that to `0` rather than passing it through.
 */
export interface SqlRunResult {
	meta: {
		/** Rows actually affected. `0` means the guard did not match — never treat it as success. */
		changes: number
	}
}

/** A database handle. `batch()` executes its statements atomically, in order. */
export interface SqlDatabase {
	prepare(sql: string): SqlStatement
	batch<T = Record<string, unknown>>(statements: SqlStatement[]): Promise<SqlQueryResult<T>[]>
}
