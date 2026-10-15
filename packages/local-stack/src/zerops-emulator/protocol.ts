/**
 * A refusal the platform states with its own error code. `route`'s catch-all answers `400 BAD_REQUEST`,
 * which is honest for a malformed request and useless for a fact a client branches on.
 */
export class PlatformRefusal extends Error {
	constructor(readonly status: number, readonly code: string, message: string) {
		super(message)
		this.name = 'PlatformRefusal'
	}
}

export const parseJsonBody = async (request: Request): Promise<unknown> => {
	try {
		return await request.json()
	} catch {
		throw new Error('request body must be JSON')
	}
}

export const json = (value: unknown, status = 200): Response => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })

export const error = (status: number, code: string, message: string): Response => json({ error: { code, message } }, status)

/** The one answer the whole service-stack family gives for "absent", whatever the reason. */
export const serviceStackNotFound = (): Response => error(400, 'serviceStackNotFound', 'Service stack not found.')

/** The refusal every user-data write gets without `sensitive`, create and update alike. */
export const sensitiveIsRequired = (): Response => error(400, 'invalidUserInput', 'sensitive: field is required')

/**
 * The smallest value size, in bytes, the platform was measured to refuse (issue #3: 32,000 created, 32,768 refused).
 * It answers a bare 500 without an error code, create and update alike.
 */
export const USER_DATA_REFUSED_CONTENT_BYTES = 32_768

export const userDataContentTooLarge = (content: string): boolean => new TextEncoder().encode(content).byteLength >= USER_DATA_REFUSED_CONTENT_BYTES

export const bareInternalServerError = (): Response => new Response(null, { status: 500 })

/** Zerops owns this key prefix and refuses a custom variable that uses it. */
export const RESERVED_KEY_PREFIX = 'ZEROPS_'

export const id = (prefix: string, sequence: number): string => `${prefix}-${sequence.toString().padStart(6, '0')}`

/**
 * The value served as a minted token's `token`. It is a LABEL, not a credential: no bearer check anywhere
 * accepts it, and it is derived from the record id so the state file never holds anything secret-shaped.
 */
export const fakeIntegrationTokenValue = (tokenId: string): string => `not-a-real-zerops-${tokenId}`
