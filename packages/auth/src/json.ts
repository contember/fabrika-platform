/**
 * Tiny structural readers for untrusted JSON — here, an IAM HTTP response body. They let the decoders
 * in `rpc-http.ts` narrow without `as` casts: read a field, check its runtime type, proceed.
 *
 * Mirrors `@fabrika/auth-core`'s internal `json.ts` (not exported from its entry point) and
 * `@fabrika/proxy`'s copy. Three tiny functions duplicated three times is cheaper than widening a
 * published package's public API to share them.
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

export function booleanField(value: unknown, key: string): boolean | undefined {
	const v = prop(value, key)
	return typeof v === 'boolean' ? v : undefined
}
