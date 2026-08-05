/**
 * Cookie (de)serialization for the auth flow. Minimal — only what login/callback/logout need:
 * a `Set-Cookie` builder and a single-cookie reader off the `Cookie` header.
 */

/**
 * There is deliberately **no `domain` option**. Every cookie this service writes is host-only: the
 * login cookie belongs to IAM's host and an app's session is written on the app's own host by its
 * proxy ([ADR-0023](../../../../docs/decisions/0023-one-session-per-host.md)). `SESSION_COOKIE` also
 * carries the `__Host-` prefix, which makes a browser refuse any cookie of that name that names a
 * `Domain` — so the option could not do anything but break the cookie it was applied to.
 */
export interface CookieOptions {
	/** Lifetime in seconds. Omit for a session cookie; 0 to expire immediately. */
	maxAge?: number
	httpOnly?: boolean
	secure?: boolean
	sameSite?: 'Lax' | 'Strict' | 'None'
	path?: string
}

/** Build a `Set-Cookie` value. */
export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
	const parts = [`${name}=${value}`, `Path=${opts.path ?? '/'}`]
	if (opts.maxAge !== undefined) {
		parts.push(`Max-Age=${opts.maxAge}`)
	}
	if (opts.httpOnly) {
		parts.push('HttpOnly')
	}
	if (opts.secure) {
		parts.push('Secure')
	}
	if (opts.sameSite) {
		parts.push(`SameSite=${opts.sameSite}`)
	}
	return parts.join('; ')
}

/**
 * A `Set-Cookie` that immediately expires `name` (logout / one-shot cookie cleanup). `Secure` is
 * unconditional for the same reason it is on the way in: a deletion must satisfy the same attribute
 * rules as the cookie it replaces, or the browser keeps the original.
 */
export function clearCookie(name: string, opts: Pick<CookieOptions, 'path'> = {}): string {
	return serializeCookie(name, '', { ...opts, maxAge: 0, httpOnly: true, secure: true, sameSite: 'Lax' })
}

/** Read a single cookie value out of a raw `Cookie` header. Returns null when absent. */
export function readCookie(header: string | null, name: string): string | null {
	if (!header) {
		return null
	}
	for (const part of header.split(';')) {
		const eq = part.indexOf('=')
		if (eq === -1) {
			continue
		}
		if (part.slice(0, eq).trim() === name) {
			return part.slice(eq + 1).trim()
		}
	}
	return null
}
