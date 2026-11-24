/** A value that can cross the provider persistence boundary without provider-specific types. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/**
 * The most a run's provider state may take as JSON text, in UTF-8 bytes: an external id's state and every checkpoint.
 * Control refuses a larger one, so a provider whose state outgrows it fails its first real run.
 */
export const MAX_PROVIDER_STATE_BYTES = 16 * 1024

/** Persisted provider data. The provider owns the payload schema and its version. */
export interface ProviderEnvelope {
	readonly provider: string
	readonly version: number
	readonly payload: JsonValue
}

/** Converts one provider-owned value to and from its versioned JSON payload. */
export interface ProviderCodec<T> {
	readonly version: number
	encode(value: T): JsonValue
	decode(payload: JsonValue): T
}

export const decodeEnvelope = <T>(kind: string, provider: string, envelope: ProviderEnvelope, codec: ProviderCodec<T>): T => {
	if (envelope.provider !== provider) {
		throw new Error(`${kind} belongs to provider "${envelope.provider}", expected "${provider}"`)
	}
	if (envelope.version !== codec.version) {
		throw new Error(`${kind} schema version ${envelope.version} is not supported by provider "${provider}"`)
	}
	return codec.decode(envelope.payload)
}
