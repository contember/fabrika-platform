// What an ingested event must not keep: a URL fragment (a share link's key travels as `/s/#<key>`), an
// `Authorization` header and anything shaped like a `px_` credential. Applied to the raw payload before it is parsed,
// fingerprinted or stored, so no title, culprit or blob carries one.

const REDACTED = '[redacted]'
/** A fabrika opaque credential: `px_` and its random part (`@fabrika/auth-core`'s `API_KEY_PREFIX`). */
const CREDENTIAL = /px_[A-Za-z0-9_-]+/g
/** What ends a URL: whitespace, a quote or an angle bracket. Captured, so splitting on it keeps the delimiters. */
const URL_DELIMITER = /([\s"'<>])/
const AUTHORIZATION = /^(?:proxy-)?authorization$/i

/** A URL's fragment: from the first `#` after a token's first `/` to the end of the token. */
function redactUrlFragments(value: string): string {
	// One split and one indexOf pair per token keep this linear; a regex over the same rule backtracks quadratically.
	if (!value.includes('#')) {
		return value
	}
	return value.split(URL_DELIMITER).map(redactTokenFragment).join('')
}

function redactTokenFragment(token: string): string {
	// A scheme's `://` holds a `/`, so the first `/` covers absolute URLs and paths alike.
	const slash = token.indexOf('/')
	if (slash < 0) {
		return token
	}
	const hash = token.indexOf('#', slash)
	return hash < 0 ? token : `${token.slice(0, hash)}#${REDACTED}`
}

function redactString(value: string): string {
	return redactUrlFragments(value).replace(CREDENTIAL, `px_${REDACTED}`)
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
