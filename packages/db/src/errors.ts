/**
 * Why the layer refused a capability, as a closed catalog: a server log names the reason and its fixed text, never the
 * message, which can name a table, a dimension or a value.
 */
export const CAPABILITY_ERRORS = Object.freeze({
	wrong_capability: 'the operation takes another capability than it was given: another kind (a Ref, a Within or an app capability) or dimension',
	wrong_action: 'the capability holds another action than the table names for the operation',
	out_of_reach: "the table does not lie in the capability's dimension, or the capability does not reach it",
	unenforceable: "the table carries no column for a dimension of the capability's chain, so the layer cannot enforce it",
	undeclared_operation: "the table's policy declares no action for the operation, or handlers do not write the table",
	table_kind: 'the operation needs another kind of table (a dimension, a child or an application table)',
	within_size: 'a Within carries more scope values than one statement binds',
	layer_unbound: 'the data layer was used before the framework connected it at boot, or connected a second time',
})

export type CapabilityErrorReason = keyof typeof CAPABILITY_ERRORS

/** A capability of the wrong kind, dimension or action for the operation, or the layer used outside its binding. */
export class CapabilityError extends Error {
	override name = 'CapabilityError'
	/** What a log may say; the message is for the author's own run. */
	readonly reason: CapabilityErrorReason

	constructor(reason: CapabilityErrorReason, message: string) {
		super(message)
		this.reason = reason
	}
}

/**
 * Why the layer refused, as a closed catalog: a server log names the reason and its fixed text, never the message,
 * which can quote a value the request sent.
 */
export const QUERY_REFUSALS = {
	invalid_argument: 'a data-layer call took an argument of another shape than its type declares',
	invalid_value: 'a value cannot be bound: an invalid or out-of-range date, or a non-finite number',
	invalid_name: 'a configured name (application, schema, table or file column) breaks its naming rule',
	unknown_column: 'a column the table does not declare, or one this operation may not set',
	unknown_table: 'a table src/db/tables.ts does not declare, or one no store, join or locator reaches',
	framework_table: "a framework table or a catalog name: application data reaches only the application's own tables",
	row_address: 'a row is addressed otherwise than its table declares (its Ref, its parent Ref and key, or its key)',
	version_required: 'the table has a version column, so update and remove take expectVersion',
	read_only: 'a read-only request, query or table was asked to write or lock a row',
	ended: 'the transaction, invocation or handle has ended or belongs to other work',
	statement_failed: 'a statement of this transaction failed, so nothing it wrote commits',
	unexpected_row: 'the database answered a row in another shape than its migration declares',
	statement_shape: 'the compiled statement has a form the guard does not admit',
	scope_predicate: 'the scope predicate is missing or is not a top-level conjunct',
	list_page: 'a list limit, cursor or order outside what a page admits',
	undeclared_reach: 'the site reaches data it did not declare (sql or unscoped, or their mode)',
	sql_template: 'ctx.sql was not called as one tagged template whose values are interpolated whole',
	sql_statement: 'ctx.sql runs one statement of an admitted kind, and none inside another',
	sql_read_only: "sql: 'read' runs queries only; declare sql: 'write' on a mutation, a job or a webhook",
	sql_name: 'ctx.sql names a framework, catalog or foreign-schema object, or writes a name in U& form',
	sql_function: 'ctx.sql calls a function that is not a reviewed built-in',
	sql_outside_transaction: 'a job runs ctx.sql only inside ctx.transaction((tx) => …), as tx.sql',
	sql_scope: 'ctx.sql.scope(…) stands alone, joined by AND, in a WHERE or JOIN … ON clause of its own invocation',
	sql_dialect: 'ctx.sql runs only on Postgres; an application on SQLite (Cloudflare) reads and writes through ctx.db',
	file_scan: "a scan verdict outside the scan job's lease",
	claim_site: 'claim leases rows in a transaction of its own: a job calls it on ctx.db, never inside ctx.transaction or a request',
	on_conflict: "an insert's onConflict names no column of the table, a column the insert leaves empty, or another action",
	public_reach: "a public procedure updates, removes, locks or claims no row, and an insert's conflict writes nothing",
	file_value:
		"a file column takes a file reference this request holds and may read (an incoming file, a put, or a read under the table's read action) of the column's kind, or null",
	file_scope: 'a file is referenced from another top-level scope than the one its first reference set',
} as const

export type QueryRefusal = keyof typeof QUERY_REFUSALS

/** A query description or an operation tree outside what the layer allows. */
export class QueryRefusedError extends Error {
	override name = 'QueryRefusedError'
	/** What a log may say; the message is for the author's own run and may quote a value. */
	readonly reason: QueryRefusal

	constructor(reason: QueryRefusal, message: string) {
		super(message)
		this.reason = reason
	}
}

/** A `ctx.sql` row its row schema refuses: the handler's bug. The message names the column, never its value. */
export class SqlRowError extends Error {
	override name = 'SqlRowError'
}

/** A table policy that cannot be enforced as written. */
export class PolicyError extends Error {
	override name = 'PolicyError'
}

/** The addressed object does not exist in the capability's scope (HTTP 404). */
export class NotFoundError extends Error {
	override name = 'NotFoundError'
}

/** The object exists, but its version is not the one the caller expected (HTTP 409). */
export class ConflictError extends Error {
	override name = 'ConflictError'
}

/** A job attempt wrote after it lost its lease (timed out, taken over or expired); nothing was written. */
export class LeaseLostError extends Error {
	override name = 'LeaseLostError'
}

const SQLSTATE = /^[0-9A-Z]{5}$/

/**
 * A statement the database refused or could not run, as the layer reports it: its SQLSTATE only. The driver's message,
 * detail and hint can quote the whole failing row, columns the capability may not read included, so none is kept.
 */
export class DatabaseError extends Error {
	override name = 'DatabaseError'
	/** The five-character SQLSTATE, or `null` when the statement never reached the database (a lost connection). */
	readonly sqlState: string | null

	constructor(sqlState: string | null) {
		super(sqlState === null ? 'the database could not run the statement' : `the database refused the statement (SQLSTATE ${sqlState})`)
		this.sqlState = sqlState
	}
}

/** The driver's failure as a `DatabaseError`; the driver's error object goes no further. */
export function databaseError(error: unknown): DatabaseError {
	if (error instanceof DatabaseError) {
		return error
	}
	const state: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'errno') : undefined
	return new DatabaseError(typeof state === 'string' && SQLSTATE.test(state) ? state : null)
}
