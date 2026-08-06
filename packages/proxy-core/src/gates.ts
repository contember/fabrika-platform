/**
 * Credential extraction for the gate evaluator relocated out of the app's process
 * ([ADR-0007](../../../docs/decisions/0007-proxy-based-auth-enforcement.md)).
 *
 * The semantics are `AppGates`', verbatim (see `@fabrika/auth-core`'s `types.ts`):
 *   - array order IS the precedence;
 *   - a matching rule whose credential is ABSENT falls through to the next matching rule;
 *   - a matching rule whose credential is PRESENT is terminal (valid → allow, invalid → deny);
 *   - a request matching NO rule is denied.
 *
 * The canonical matcher and its ordered compiled representation live in `@fabrika/auth-core` so the
 * gate declaration and its evaluator cannot drift. Credential extraction remains proxy-owned.
 */

import type { CredentialLocation } from '@fabrika/auth-core'

export { applicableGates, compileGates } from '@fabrika/auth-core'
export type { CompiledGate } from '@fabrika/auth-core'

// ── Credential extraction ──────────────────────────────────────────────────────

/** The raw `service`-rule credential: the declared location, else `Authorization: Bearer`. Null if absent. */
export function readServiceCredential(headers: Headers, url: URL, location: CredentialLocation | undefined): string | null {
	if (location !== undefined) {
		const raw = extractCredential(headers, url, location)
		return raw === null || raw === '' ? null : raw
	}
	return readBearer(headers.get('Authorization'))
}

/** Pull the raw credential from a declared location. A header value may be bare or `Bearer <token>`. */
function extractCredential(headers: Headers, url: URL, source: CredentialLocation): string | null {
	if (source.in === 'header') {
		const value = headers.get(source.name)
		return value === null ? null : (readBearer(value) ?? value.trim())
	}
	if (source.in === 'query') {
		return url.searchParams.get(source.name)
	}
	return readCookie(headers.get('Cookie'), source.name)
}

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
