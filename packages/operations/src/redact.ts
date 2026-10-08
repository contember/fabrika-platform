// What an ingested event must not keep: a URL fragment (a share link's key travels as `/s/#<key>`), an
// `Authorization` header and anything shaped like a `px_` credential. Applied to the raw payload before it is parsed,
// fingerprinted or stored, so no title, culprit or blob carries one.

const REDACTED = '[redacted]'
/** A fabrika opaque credential: `px_` and its random part (`@fabrika/auth-core`'s `API_KEY_PREFIX`). */
const CREDENTIAL = /px_[A-Za-z0-9_-]+/g
/** A URL's fragment: from `#` to the end of the URL. */
const URL_FRAGMENT = /((?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s#"'<>]*)#[^\s"'<>]*/gi
const AUTHORIZATION = /^(?:proxy-)?authorization$/i

function redactString(value: string): string {
	return value.replace(URL_FRAGMENT, `$1#${REDACTED}`).replace(CREDENTIAL, `px_${REDACTED}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A Sentry header list may be `[name, value]` pairs instead of an object. */
function isAuthorizationPair(value: readonly unknown[]): boolean {
	const [name] = value
	return value.length === 2 && typeof name === 'string' && AUTHORIZATION.test(name)
}

function redactValue(value: unknown): unknown {
	if (typeof value === 'string') {
		return redactString(value)
	}
	if (Array.isArray(value)) {
		return isAuthorizationPair(value) ? [value[0], REDACTED] : value.map(redactValue)
	}
	if (isRecord(value)) {
		return redactRecord(value)
	}
	return value
}

function redactRecord(record: Record<string, unknown>): Record<string, unknown> {
	// `fromEntries` defines own properties, so a `__proto__` key of the parsed JSON stays a key.
	return Object.fromEntries(Object.entries(record).map(([key, value]) => [redactString(key), AUTHORIZATION.test(key) ? REDACTED : redactValue(value)]))
}

/** A copy of an event payload with every fragment, `Authorization` header and `px_` credential replaced. */
export function redactEventPayload(payload: Record<string, unknown>): Record<string, unknown> {
	return redactRecord(payload)
}
