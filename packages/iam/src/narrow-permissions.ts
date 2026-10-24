import { type KeyGrant, matchAction, type PermissionEntry, type Scope } from '@fabrika/auth-core'

/**
 * Intersect live permissions with a ceiling: an OAuth scope's grants, or a terminal's patterns for an application. The
 * ceiling never adds anything: each result is the narrower action and the narrower scope of one held entry and one
 * ceiling entry that overlap, so a held `*` under a ceiling `a.read` yields `a.read`.
 */
export function narrowPermissions(live: readonly PermissionEntry[], ceiling: readonly KeyGrant[]): PermissionEntry[] {
	const result: PermissionEntry[] = []
	const seen = new Set<string>()
	for (const held of live) {
		for (const limit of ceiling) {
			const action = matchAction(limit.action, held.action) ? held.action : matchAction(held.action, limit.action) ? limit.action : null
			const scope = narrowerScope(held.scope, limit.scope ?? null)
			if (action === null || scope === undefined) continue
			const key = `${action} ${scope === null ? '' : `${scope.type}:${scope.value}`} ${held.source}`
			if (seen.has(key)) continue
			seen.add(key)
			result.push({ action, scope, source: held.source })
		}
	}
	return result
}

/** `null` is global; `undefined` means the two scopes do not overlap. */
function narrowerScope(held: Scope | null, limit: Scope | null): Scope | null | undefined {
	if (held === null) return limit
	if (limit === null) return held
	return held.type === limit.type && held.value === limit.value ? held : undefined
}
