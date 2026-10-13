import { RpcError } from '../client/transport'

/** The status the application refused a call with; a failure that is not its answer (no status) is rethrown. */
export function refusalStatus(error: unknown): number {
	if (error instanceof RpcError && error.httpStatus !== undefined) {
		return error.httpStatus
	}
	throw error
}

/** A call's status: 200 when it resolves, the status the application refused it with otherwise. */
export async function statusOf(call: Promise<unknown>): Promise<number> {
	try {
		await call
		return 200
	} catch (error) {
		return refusalStatus(error)
	}
}
