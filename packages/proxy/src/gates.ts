/**
 * Gate matching — the ordered, first-match-wins per-path rule evaluation, relocated out of the app's
 * process ([ADR-0007](../../../docs/decisions/0007-proxy-based-auth-enforcement.md)).
 *
 * The semantics are `AppGates`', verbatim (see `@fabrika/auth-core`'s `types.ts`):
 *   - array order IS the precedence;
 *   - a matching rule whose credential is ABSENT falls through to the next matching rule;
 *   - a matching rule whose credential is PRESENT is terminal (valid → allow, invalid → deny);
 *   - a request matching NO rule is denied.
 *
 * DUPLICATION WARNING: `pathMatches` and the credential readers below are byte-for-byte the private
 * helpers in `@fabrika/auth/src/session.ts`. Two implementations of an authorization check is exactly
 * what [ADR-0008](../../../docs/decisions/0008-caddy-forward-auth-proxy.md) rejects — they are copied
 * here only because this package may not modify `@fabrika/auth-core`. Hoisting them into
 * `@fabrika/auth-core` is a required follow-up; until then, any change here MUST be mirrored there.
 */

import type { AppGates, CredentialLocation, GateRule } from '@fabrika/auth-core'

/** A gate rule with its path glob precompiled — the matcher runs on every request, so compile once. */
export interface CompiledGate {
	readonly rule: GateRule
	matches(pathname: string): boolean
}

/** Precompile an app's gate rules, PRESERVING array order (order is the precedence). */
export function compileGates(gates: AppGates): CompiledGate[] {
	return gates.rules.map((rule) => {
		const regex = globToRegExp(rule.path)
		return { rule, matches: (pathname: string) => regex.test(pathname) }
	})
}

/** The rules whose path matches, in declaration order. */
export function applicableGates(compiled: readonly CompiledGate[], pathname: string): CompiledGate[] {
	return compiled.filter((gate) => gate.matches(pathname))
}

/** Glob where `*` matches any run of characters; the rest is literal. Anchored, CASE-SENSITIVE. */
function globToRegExp(pattern: string): RegExp {
	return new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`)
}

function escapeRegExp(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

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
