import type { AuthContext } from '@fabrika/auth'
import { type PermissionEntry, permits, type Scope, scopedValues } from '@fabrika/auth-core'

/**
 * Build the `AuthContext` a handler sees, from permission entries.
 *
 * `can`/`scopedTo` run core's real `permits`/`scopedValues` matchers — the same ones the
 * token-backed context uses — so a test exercises the production authorization semantics without
 * signing a token. This is a TEST double for one resolved caller and nothing more: it cannot
 * authenticate a request, and nothing in `src/` may import it.
 */
function context(input: { id: string; label: string; permissions: readonly { action: string; scope: Scope | null }[] }): AuthContext {
	const entries: PermissionEntry[] = input.permissions.map((grant) => ({ action: grant.action, scope: grant.scope, source: 'grant' }))
	return {
		ok: true,
		principal: { id: input.id, type: 'user', label: input.label },
		can: (action, scope) => permits(entries, action, scope),
		scopedTo: (action, dimension) => scopedValues(entries, action, dimension),
		audit: () => Promise.resolve(),
	}
}

/** A resolved context that authorizes every action. */
export function allowAllAuth(): AuthContext {
	return context({ id: 'mem-admin', label: 'admin@test', permissions: [{ action: '*', scope: null }] })
}

/** A resolved context holding the supplied global actions. */
export function authWithActions(actions: readonly string[], label = 'operator@test'): AuthContext {
	return context({ id: `p-${label}`, label, permissions: actions.map((action) => ({ action, scope: null })) })
}

/** A resolved context with exact scoped permission entries. */
export function authWithPermissions(permissions: readonly { action: string; scope: Scope | null }[], label = 'scoped@test'): AuthContext {
	return context({ id: `p-${label}`, label, permissions })
}
