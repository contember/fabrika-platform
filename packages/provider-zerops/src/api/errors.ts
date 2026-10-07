import { z } from 'zod'

const errorDetailShape = {
	code: z.string().optional().catch(undefined),
	message: z.string().optional().catch(undefined),
	// An element that is not an object still counts: `isAppVersionNotFoundResponse` requires exactly one.
	meta: z.array(z.object({ code: z.string().optional().catch(undefined) }).catch({})).catch([]),
}
const errorDetailSchema = z.object(errorDetailShape).catch({ meta: [] })
const errorEnvelopeSchema = z.object({ ...errorDetailShape, error: errorDetailSchema }).catch({ meta: [], error: { meta: [] } })

export const isAppVersionNotFoundResponse = (value: unknown): boolean => {
	const { error: inner, ...outer } = errorEnvelopeSchema.parse(value)
	const metadata = [...outer.meta, ...inner.meta]
	return inner.code === 'appVersionNotFound' || outer.code === 'appVersionNotFound'
		|| (metadata.length === 1 && metadata[0]?.code === 'appVersionNotFound')
}

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
	const { error: inner, ...outer } = errorEnvelopeSchema.parse(body)
	const code = inner.code ?? outer.code ?? ''
	const message = redactDetail ? '' : (inner.message ?? outer.message ?? '')
	const detail = [code, message].filter((part) => part !== '').join(': ')
	return new ZeropsApiError(`zerops: ${label} failed (${status})${detail === '' ? '' : ` — ${detail.slice(0, 300)}`}`, status, code)
}
