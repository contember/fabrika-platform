import type { JsonValue } from './api'

// Keep opaque JSON intact: schema object/record parsing would drop extension keys such as __proto__.
export function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true
	if (Array.isArray(value)) return value.every(isJsonValue)
	if (typeof value !== 'object') return false
	return Object.values(value).every((entry) => entry !== undefined && isJsonValue(entry))
}
