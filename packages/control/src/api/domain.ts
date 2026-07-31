import { json } from '../http'

export class ControlApiError extends Error {
	readonly httpStatus: number
	readonly type: string

	constructor(httpStatus: number, message: string) {
		super(message)
		this.name = 'ControlApiError'
		this.httpStatus = httpStatus
		this.type = errorType(httpStatus)
	}
}

export function fail(httpStatus: number, message: string): never {
	throw new ControlApiError(httpStatus, message)
}

export async function jsonAdapter<T>(run: () => Promise<T>, init?: ResponseInit): Promise<Response> {
	try {
		return json(await run(), init)
	} catch (cause) {
		if (cause instanceof ControlApiError) {
			return json({ error: cause.message }, { status: cause.httpStatus })
		}
		throw cause
	}
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
