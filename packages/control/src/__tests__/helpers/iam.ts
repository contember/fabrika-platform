import { type AuthContext, makeDevContext, type PersonaSpec } from '@fabrika/auth'

/** A resolved dev context that authorizes every action. */
export function allowAllAuth(): AuthContext {
	return makeDevContext({
		id: 'mem-admin',
		label: 'admin@test',
		type: 'user',
		permissions: [{ action: '*', scope: null }],
	})
}

/** A resolved dev context holding the supplied global actions. */
export function authWithActions(actions: readonly string[], label = 'operator@test'): AuthContext {
	return makeDevContext({
		id: `p-${label}`,
		label,
		type: 'user',
		permissions: actions.map((action) => ({ action, scope: null })),
	})
}

/** A resolved context with exact scoped permission entries. */
export function authWithPermissions(permissions: PersonaSpec['permissions'], label = 'scoped@test'): AuthContext {
	return makeDevContext({ id: `p-${label}`, label, type: 'user', permissions })
}
