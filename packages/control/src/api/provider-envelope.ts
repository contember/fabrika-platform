import type { JsonValue, ProviderEnvelope } from '@fabrika/provider-contract'
import { error } from '../http'
import { numberField, prop, stringField } from '../json'

export const isJsonValue = (value: unknown): value is JsonValue => {
	if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
		return true
	}
	if (Array.isArray(value)) {
		return value.every(isJsonValue)
	}
	return typeof value === 'object' && Object.values(value).every(isJsonValue)
}

export function readProviderEnvelope(value: unknown): ProviderEnvelope | null {
	const provider = stringField(value, 'provider')
	const version = numberField(value, 'version')
	const payload = prop(value, 'payload')
	if (
		provider === undefined
		|| version === undefined
		|| !Number.isInteger(version)
		|| version < 1
		|| payload === undefined
		|| !isJsonValue(payload)
	) {
		return null
	}
	return { provider, version, payload }
}

export function envelopeField(body: unknown, name: string): ProviderEnvelope | Response {
	const envelope = readProviderEnvelope(prop(body, name))
	return envelope ?? error(400, `${name} must be a versioned provider envelope`)
}

export function parseStoredEnvelope(value: string, label: string): ProviderEnvelope {
	const parsed: unknown = JSON.parse(value)
	const envelope = readProviderEnvelope(parsed)
	if (envelope === null) {
		throw new Error(`${label} is not a versioned provider envelope`)
	}
	return envelope
}
