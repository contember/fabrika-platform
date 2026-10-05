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
