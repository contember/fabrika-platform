// Reading a `px_` credential off a request: the bearer header and the session cookie.

/** Read the token out of an `Authorization: Bearer <token>` header. Null when absent/non-bearer. */
export function readBearer(header: string | null): string | null {
	if (header === null) {
		return null
	}
	const match = /^Bearer\s+(.+)$/i.exec(header.trim())
	return match ? (match[1]?.trim() ?? null) : null
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
