// Access-only formatting helpers; the console-wide ones live in `lib/format.ts`.

import type { GrantDto, PermissionEntry, ShareLinkListItem } from '@fabrika/iam-contract'
import { fmtDate } from '../../lib/format'

/** A flat scope coordinate (one dimension + opaque value); null = global. */
type Scope = NonNullable<PermissionEntry['scope']>

/** Format a scope coordinate for display: `dimension = value`, or "Global" when null. */
export function fmtScope(scope: Scope | null): string {
	if (scope === null) return 'Global'
	return `${scope.type} = ${scope.value}`
}

/** Format a grant's scope: `Global`, or its dimension and every value it holds (ADR-0085). */
export function fmtGrantScope(grant: Pick<GrantDto, 'scopeType' | 'scopeValue' | 'scopeValues'>): string {
	if (grant.scopeType === null) return 'Global'
	const values = grant.scopeValues ?? (grant.scopeValue === null ? [] : [grant.scopeValue])
	return `${grant.scopeType} = ${values.join(', ')}`
}

/** Format an optional epoch-seconds expiry timestamp; `null` means "never". */
export function fmtExpiry(seconds: number | null | undefined): string {
	if (seconds === null || seconds === undefined) return 'Never'
	return fmtDate(seconds)
}

/** A share link's derived lifecycle. Revoked wins over expired; the row itself stores neither. */
export type ShareLinkState = 'active' | 'expired' | 'revoked'

export function shareLinkState(link: ShareLinkListItem, nowMs: number = Date.now()): ShareLinkState {
	if (link.revokedAt !== null) return 'revoked'
	// expiresAt is epoch-seconds (backend `unixepoch()`), so compare in seconds.
	if (link.expiresAt !== null && link.expiresAt <= nowMs / 1000) return 'expired'
	return 'active'
}

/** Trim a URL filter value and omit it when it contains only whitespace. */
export function trimmedQueryValue(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim()
	return trimmed === '' ? undefined : trimmed
}

/**
 * Parse a `<datetime-local>` input value into epoch **seconds** (the unit the backend
 * stores and compares against `unixepoch()`), or null when empty (= no expiry).
 */
export function parseDateTimeLocal(value: string): number | null {
	const trimmed = value.trim()
	if (trimmed === '') return null
	const ms = new Date(trimmed).getTime()
	return Number.isNaN(ms) ? null : Math.floor(ms / 1000)
}

/** Format epoch seconds as a `<datetime-local>` value in the browser's time zone, the inverse of `parseDateTimeLocal`. */
export function toDateTimeLocal(seconds: number): string {
	const date = new Date(seconds * 1000)
	return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

/** The expiry a grant form submits: an untouched field keeps the stored seconds, because the field shows only minutes. */
export function submittedExpiry(value: string, stored: number | null | undefined): number | null {
	if (stored != null && value === toDateTimeLocal(stored)) return stored
	return parseDateTimeLocal(value)
}
