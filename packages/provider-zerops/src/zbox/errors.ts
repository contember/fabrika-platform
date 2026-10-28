import { z } from 'zod'

/** A Box error code is a fixed identifier; anything else in that slot is body text and must not reach a message. */
const BOX_CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/

const codeSchema = z.string().regex(BOX_CODE).optional().catch(undefined)
// Live answers wrap the error (`{ error: { code } }`); the OpenAPI `Error` schema is the bare `{ code }`.
const errorBodySchema = z
	.object({ code: codeSchema, error: z.object({ code: codeSchema }).optional().catch(undefined) })
	.catch({ code: undefined, error: undefined })

/**
 * A failed Box Workspace API call. `code` is Box's `error.code` when the body was Box's error JSON, `http_<status>`
 * when it was not, or one of the client's own: `unreadable` (a success body that does not parse), `timeout`,
 * `unreachable` (status 0 for the last two). The message names the operation and nothing the server sent beyond
 * the code: Box echoes request env and launch env in its bodies.
 */
export class ZboxApiError extends Error {
	constructor(readonly operation: string, readonly status: number, readonly code: string) {
		super(`zbox: ${operation} failed (${status === 0 ? code : `${status} ${code}`})`)
		this.name = 'ZboxApiError'
	}
}

/** An asynchronous Box operation that ended FAILED. `code` is Box's error only when it is an identifier. */
export class ZboxOperationFailed extends Error {
	constructor(readonly kind: string, readonly operationId: string, readonly code: string | null) {
		super(`zbox: ${kind} operation ${operationId} failed${code === null ? '' : ` (${code})`}`)
		this.name = 'ZboxOperationFailed'
	}
}

export const zboxErrorCode = (status: number, body: unknown): string => {
	const parsed = errorBodySchema.parse(body)
	return parsed.error?.code ?? parsed.code ?? `http_${status}`
}

export const zboxOperationErrorCode = (error: string | null): string | null => error !== null && BOX_CODE.test(error) ? error : null

export const isZboxNotFound = (error: unknown): error is ZboxApiError => error instanceof ZboxApiError && error.status === 404

export const isZboxWorkspaceFull = (error: unknown): error is ZboxApiError => error instanceof ZboxApiError && error.code === 'workspaceFull'

/** An upload over the workspace's body limit; nginx answers it with an HTML page, so only the status identifies it. */
export const isZboxTooLarge = (error: unknown): error is ZboxApiError => error instanceof ZboxApiError && error.status === 413
