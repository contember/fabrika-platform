/**
 * Tiny structural readers for untrusted JSON (request bodies, external API
 * responses). They let us narrow `unknown` at the deserialization boundary without
 * `as` casts: read a field, check its runtime type, proceed.
 */

/** `JSON.parse` typed to return `unknown` (the built-in returns `any`). */
export function parseJson(text: string): unknown {
	return JSON.parse(text)
}

/**
 * `parseJson` that yields `null` instead of throwing on malformed text.
 *
 * The JSON-bearing TEXT columns (`audit_events.diff`/`metadata`, `roles.permissions`,
 * `grants.permissions`) used to carry a `CHECK (json_valid(...))`, which let read paths parse
 * without a guard. That check is SQLite-only (Postgres has no equivalent inside the common
 * subset), so it is gone from the migrations and the guarantee now lives at the two ends: the
 * only writer JSON-encodes, and every reader goes through here. A hand-written or out-of-band
 * row can therefore no longer 500 the admin API or break an authenticate().
 */
export function parseJsonOrNull(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return null
	}
}

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

/** A nullable string field: distinguishes explicit `null` from absent (undefined). */
export function nullableStringField(value: unknown, key: string): string | null | undefined {
	const v = prop(value, key)
	if (v === null) {
		return null
	}
	return typeof v === 'string' ? v : undefined
}

/**
 * Read a field that must be an array of strings. Returns undefined when the field is
 * absent or not an array; a non-string element makes the whole field undefined (the
 * caller then rejects). An empty array is a valid result (length-0 array of strings).
 */
export function arrayField(value: unknown, key: string): string[] | undefined {
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
