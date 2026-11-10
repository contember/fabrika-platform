import { parseJsonStringArray } from '@fabrika/auth-core'

/** A role's stored `via`: relation → actions. A malformed row contributes nothing, as an unparseable grant does. */
export function parseStoredVia(json: string | null): Record<string, string[]> {
	if (json === null) return {}
	let value: unknown
	try {
		value = JSON.parse(json)
	} catch {
		return {}
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
	const via: Record<string, string[]> = {}
	for (const [relation, actions] of Object.entries(value)) {
		const parsed = parseJsonStringArray(JSON.stringify(actions))
		if (relation.length > 0 && parsed.length > 0) via[relation] = parsed
	}
	return via
}

/** Legacy rows retain valid patterns even when other entries are malformed. */
export function parseStoredPermissions(json: string): string[] {
	return parseJsonStringArray(json)
}

/**
 * Every action a grant of a role carries: its own, and each one it holds through a relation (`via`). Whoever gives the
 * role must hold each of them, by a grant of the action itself: a relation it holds them through does not count.
 */
export function delegatedActions(role: { readonly permissions: string; readonly via: string | null }): string[] {
	const actions = parseStoredPermissions(role.permissions)
	for (const held of Object.values(parseStoredVia(role.via))) actions.push(...held)
	return actions
}
