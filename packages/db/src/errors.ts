/** A capability of the wrong kind, dimension or action, or one the framework did not mint for this request. */
export class CapabilityError extends Error {
	override name = 'CapabilityError'
}

/** A query description or an operation tree outside what the layer allows. */
export class QueryRefusedError extends Error {
	override name = 'QueryRefusedError'
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
