/**
 * Tiny structural readers for untrusted JSON (request bodies, webhook payloads, external API
 * responses). They narrow `unknown` at the deserialization boundary without `as` casts: read a
 * field, check its runtime type, proceed. Mirrors propustka's `src/json.ts`.
 */

/** Read a property off an unknown value (undefined when absent / not an object). */
export function prop(value: unknown, key: string): unknown {
	if (typeof value !== 'object' || value === null) {
		return undefined
	}
	return Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined
}

export function stringField(value: unknown, key: string): string | undefined {
	const v = prop(value, key)
	return typeof v === 'string' ? v : undefined
}

export function numberField(value: unknown, key: string): number | undefined {
	const v = prop(value, key)
	return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
