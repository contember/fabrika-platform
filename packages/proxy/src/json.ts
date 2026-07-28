/**
 * Tiny structural readers for untrusted JSON (the deployed manifest, an IAM HTTP response body).
 * They let the parsers narrow without `as` casts: read a field, check its runtime type, proceed.
 * Mirrors `@fabrika/auth-core`'s internal `json.ts`, which is not exported from its entry point.
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

/** An array of strings, or undefined when the field is absent or any element is not a string. */
export function stringArrayField(value: unknown, key: string): string[] | undefined {
	const v = prop(value, key)
	if (!Array.isArray(v)) {
		return undefined
	}
	const out: string[] = []
	for (const item of v) {
		if (typeof item !== 'string') {
			return undefined
		}
		out.push(item)
	}
	return out
}
