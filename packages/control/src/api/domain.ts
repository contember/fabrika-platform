import type { JsonValue } from '@fabrika/provider-contract'

export class ControlApiError extends Error {
	readonly httpStatus: number
	readonly type: string
	/** What the caller acts on beside the message; the RPC envelope carries it as `data`. */
	readonly data?: JsonValue

	constructor(httpStatus: number, message: string, options?: { readonly type: string; readonly data: JsonValue }) {
		super(message)
		this.name = 'ControlApiError'
		this.httpStatus = httpStatus
		this.type = options?.type ?? errorType(httpStatus)
		if (options !== undefined) this.data = options.data
	}
}

export function fail(httpStatus: number, message: string): never {
	throw new ControlApiError(httpStatus, message)
}

function errorType(status: number): string {
	if (status === 400) return 'bad_request'
	if (status === 401) return 'auth'
	if (status === 403) return 'forbidden'
	if (status === 404) return 'not_found'
	if (status === 405) return 'method_not_allowed'
	if (status === 409) return 'conflict'
	return status >= 500 ? 'internal' : 'error'
}
