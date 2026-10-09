/** A capability of the wrong kind, dimension or action, or one the framework did not mint for this request. */
export class CapabilityError extends Error {
	override name = 'CapabilityError'
}

/** A query description or an operation tree outside what the layer allows. */
export class QueryRefusedError extends Error {
	override name = 'QueryRefusedError'
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
