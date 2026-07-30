// Tiny formatting helpers shared across pages.

import type { PermissionEntry } from '@fabrika/iam/admin'

/** A flat scope coordinate (one dimension + opaque value); null = global. */
type Scope = NonNullable<PermissionEntry['scope']>

/** Format a scope coordinate for display: `dimension = value`, or "Global" when null. */
export function fmtScope(scope: Scope | null): string {
	if (scope === null) return 'Global'
	return `${scope.type} = ${scope.value}`
}

/**
 * Format an epoch-**seconds** timestamp as a readable local date-time. The backend
 * stores and returns every timestamp in seconds (SQLite `unixepoch()`), so we scale to
 * millis for `Date`.
 */
export function fmtDate(seconds: number | null | undefined): string {
	if (seconds === null || seconds === undefined) return '—'
	return new Date(seconds * 1000).toLocaleString(undefined, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	})
}

/**
 * Compact "how long ago" for an epoch-**seconds** stamp. A list wants "2h ago"; the exact clock time
 * belongs in the cell's tooltip. Falls back to a date past a week, and to `—` when absent.
 */
export function fmtAgo(seconds: number | null | undefined, nowMs: number = Date.now()): string {
	if (seconds === null || seconds === undefined) return '—'
	const elapsed = Math.max(0, Math.floor(nowMs / 1000) - seconds)
	if (elapsed < 45) return 'just now'
	if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`
	if (elapsed < 86_400) return `${Math.floor(elapsed / 3600)}h ago`
	if (elapsed < 604_800) return `${Math.floor(elapsed / 86_400)}d ago`
	return new Date(seconds * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Format an optional epoch-seconds expiry timestamp; `null` means "never". */
export function fmtExpiry(seconds: number | null | undefined): string {
	if (seconds === null || seconds === undefined) return 'Never'
	return fmtDate(seconds)
}

/** Build a query string from an object, skipping empty / undefined / null values. */
export function qs(params: Record<string, string | number | null | undefined>): string {
	const search = new URLSearchParams()
	for (const [key, value] of Object.entries(params)) {
		if (value === null || value === undefined) continue
		const str = String(value).trim()
		if (str === '') continue
		search.set(key, str)
	}
	const out = search.toString()
	return out ? `?${out}` : ''
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
