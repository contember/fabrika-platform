import { prop, str } from './readers'

/**
 * A non-2xx answer from the Zerops API. `code` is the platform's own error identifier, so a caller can
 * branch on `userDataDuplicateKey` rather than matching a prose message.
 */
export class ZeropsApiError extends Error {
	constructor(message: string, readonly status: number, readonly code: string) {
		super(message)
		this.name = 'ZeropsApiError'
	}
}

/**
 * The platform's code for "this service publishes no HTTP port", the answer `enableSubdomainAccess` gives
 * before a service's first deploy. Exported so a caller can say what is missing instead of relaying prose.
 */
export const ZEROPS_SERVICE_NOT_HTTP = 'serviceStackIsNotHttp'

/**
 * Turn a non-2xx response into a `ZeropsApiError`. Zerops answers with `{ error: { code, message, meta } }`
 * (the envelope observed live; the OpenAPI `Error` schema shows the inner `{ code, message }`).
 *
 * `redactDetail` drops the server's MESSAGE, which a validation error can fill with the value it
 * rejected. The CODE is a fixed identifier and is kept either way — without it nothing downstream can
 * tell a duplicate key from a missing service.
 */
export const apiError = (label: string, status: number, body: unknown, redactDetail: boolean): ZeropsApiError => {
	const code = str(prop(body, 'error'), 'code') ?? str(body, 'code') ?? ''
	const message = redactDetail ? '' : (str(prop(body, 'error'), 'message') ?? str(body, 'message') ?? '')
	const detail = [code, message].filter((part) => part !== '').join(': ')
	return new ZeropsApiError(`zerops: ${label} failed (${status})${detail === '' ? '' : ` — ${detail.slice(0, 300)}`}`, status, code)
}
