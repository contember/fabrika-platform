/** A capability of the wrong kind, dimension or action, or one the framework did not mint for this request. */
export class CapabilityError extends Error {
	override name = 'CapabilityError'
}

/**
 * Why the layer refused, as a closed catalog: a server log names the reason and its fixed text, never the message,
 * which can quote a value the request sent.
 */
export const QUERY_REFUSALS = {
	invalid_argument: 'a data-layer call took an argument of another shape than its type declares',
	invalid_value: 'a value cannot be bound: an invalid or out-of-range date, or a non-finite number',
	invalid_name: 'a configured name (application, schema, file collection or owner column) breaks its naming rule',
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
	sql_scope: 'ctx.sql.scope(…) stands alone, joined by AND, in a WHERE or JOIN … ON clause of its own invocation',
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
