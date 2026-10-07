/** A value that can cross the provider persistence boundary without provider-specific types. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

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
