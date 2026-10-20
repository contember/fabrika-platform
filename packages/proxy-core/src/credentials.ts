// Reading a `px_` credential off a request: the bearer header and the session cookie.

/** Read the token out of an `Authorization: Bearer <token>` header. Null when absent/non-bearer. */
export function readBearer(header: string | null): string | null {
	if (header === null) {
		return null
	}
	const match = /^Bearer\s+(.+)$/i.exec(header.trim())
	return match ? (match[1]?.trim() ?? null) : null
}

/**
 * Whether an `Authorization` value carries a platform key anywhere: the header itself, or the user or password of Basic
 * credentials. Such a value is never forwarded to an application, whatever its row says: a key sent to a webhook URL
 * by mistake must not reach application code.
 */
export function carriesPlatformKey(header: string, keyPrefix: string): boolean {
	if (header.includes(keyPrefix)) {
		return true
	}
	const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header.trim())
	if (basic?.[1] === undefined) {
		return false
	}
	try {
		return atob(basic[1]).includes(keyPrefix)
	} catch {
		// Not base64: the application refuses it as a verifier would, and it holds no readable key.
		return false
	}
}

/** Read a single cookie value out of a raw `Cookie` header. Null when absent or malformed. */
export function readCookie(header: string | null, name: string): string | null {
	if (!header) {
		return null
	}
	for (const part of header.split(';')) {
		const eq = part.indexOf('=')
		if (eq !== -1 && part.slice(0, eq).trim() === name) {
			const value = part.slice(eq + 1).trim()
			return value === '' ? null : value
		}
	}
	return null
}
