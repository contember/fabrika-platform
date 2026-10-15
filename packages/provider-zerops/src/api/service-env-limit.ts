/**
 * The largest service variable value fabrika writes, in UTF-8 bytes. Measured live on 2026-10-15 (issue #3): a value
 * of 32,000 bytes is created, one of 32,768 bytes or more answers a bare `500` with no error code. The bytes between
 * were not probed, so the bound is the largest size that was seen to work.
 */
export const ZEROPS_SERVICE_ENV_VALUE_MAX_BYTES = 32_000

/** The provider's code for a value over the bound; the platform has none of its own, only the 500. */
export const ZEROPS_SERVICE_ENV_VALUE_TOO_LARGE = 'serviceEnvValueTooLarge'

/** A write refused before it was sent. The message names the variable and the sizes, never the value. */
export class ZeropsServiceEnvValueTooLargeError extends Error {
	readonly code = ZEROPS_SERVICE_ENV_VALUE_TOO_LARGE

	constructor(readonly key: string, readonly bytes: number) {
		super(
			`zerops: service variable \`${key}\` is ${bytes} bytes (UTF-8), over the ${ZEROPS_SERVICE_ENV_VALUE_MAX_BYTES}-byte limit of a Zerops service variable`,
		)
		this.name = 'ZeropsServiceEnvValueTooLargeError'
	}
}

/** Refuse a value Zerops would answer with a bare 500, which reads as an outage and is retried for ever. */
export const assertServiceEnvValueFits = (key: string, value: string): void => {
	const bytes = new TextEncoder().encode(value).byteLength
	if (bytes > ZEROPS_SERVICE_ENV_VALUE_MAX_BYTES) {
		throw new ZeropsServiceEnvValueTooLargeError(key, bytes)
	}
}
