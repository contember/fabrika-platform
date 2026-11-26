// An agent's device grant at an application environment (ADR-0090): the client, the caller its exchanged token
// presents, the scope it approved and the narrowing of the person's permissions to one scope value.

import type { CredentialedEndpointKind } from './contract'
import { isScopeParameterText } from './oauth'
import { narrowPermissions, uniquePermissions } from './permissions'
import { DIMENSION_NAME, parseRelationInside, type PermissionEntry, type Scope } from './types'

export { AGENT_CLIENT_ID } from './oauth'

/** The caller a person's application token presents when the proxy exchanged an agent's grant for it. */
export const AGENT_CALLER = 'agent'

export const AGENT_SCOPE_MODES = ['read', 'write'] as const
export type AgentScopeMode = (typeof AGENT_SCOPE_MODES)[number]

/** The mode a grant gets when the client asks for no scope. */
export const DEFAULT_AGENT_SCOPE_MODE: AgentScopeMode = 'read'

/** The endpoint kinds each mode admits. Neither admits an SPA: an agent calls procedures. */
export const AGENT_SCOPE_KINDS: Readonly<Record<AgentScopeMode, readonly CredentialedEndpointKind[]>> = Object.freeze({
	read: Object.freeze(['query', 'download'] as const),
	write: Object.freeze(['query', 'mutation', 'upload', 'download'] as const),
})

/** The scope one grant holds: its mode, and the one scope value it is narrowed to, or null for none. */
export interface AgentScope {
	readonly mode: AgentScopeMode
	readonly within: Scope | null
}

/**
 * Read one scope token: `read`, `write`, or either narrowed to one value of a dimension, `read:<dimension>=<value>`.
 * The dimension is a contract's dimension name; the value is opaque text of a parameterized scope
 * (`isScopeParameterText`). Anything else is null.
 */
export function parseAgentScope(token: string): AgentScope | null {
	const colon = token.indexOf(':')
	const mode = colon === -1 ? token : token.slice(0, colon)
	if (!isAgentScopeMode(mode)) return null
	if (colon === -1) return { mode, within: null }
	const rest = token.slice(colon + 1)
	const equals = rest.indexOf('=')
	if (equals === -1) return null
	const type = rest.slice(0, equals)
	const value = rest.slice(equals + 1)
	if (!DIMENSION_NAME.test(type) || !isScopeParameterText(type) || !isScopeParameterText(value)) return null
	return { mode, within: { type, value } }
}

/** The scope token of `scope`; `parseAgentScope` reads it back to the same scope. */
export function agentScopeToken(scope: AgentScope): string {
	return scope.within === null ? scope.mode : `${scope.mode}:${scope.within.type}=${scope.within.value}`
}

export function isAgentScopeMode(value: string): value is AgentScopeMode {
	return value === 'read' || value === 'write'
}

/** Whether a grant of `mode` reaches an endpoint of `kind`. */
export function agentScopeAdmits(mode: AgentScopeMode, kind: string): boolean {
	return AGENT_SCOPE_KINDS[mode].some((admitted) => admitted === kind)
}

/**
 * The person's entries narrowed to the one scope value `within` (ADR-0090 §3): `narrowPermissions` under `*` at `within`
 * (a global entry becomes the same action there, an entry at `within` stays, every other scope is dropped), plus the
 * relations the person holds inside `within`. A relation held anywhere (`~rel`) is dropped: an access view bound to
 * its member reaches rows for a node that a hold anywhere does not reach (ADR-0076), so moving it inside `within` would
 * widen it. Never adds an action or a reach the person does not hold.
 */
export function narrowToValue(entries: readonly PermissionEntry[], within: Scope): PermissionEntry[] {
	if (!DIMENSION_NAME.test(within.type)) throw new Error('a grant is narrowed to a value of a dimension')
	const scope = { type: within.type, value: within.value }
	const inside = entries.filter((entry) => entry.scope !== null && relationInside(entry.scope, within))
	return uniquePermissions([...narrowPermissions(entries, [{ action: '*', scope }]), ...inside])
}

/** Whether every entry lies within `within`, as `narrowToValue` leaves them: a check a token's reader repeats. */
export function liesWithinValue(entries: readonly PermissionEntry[], within: Scope): boolean {
	return entries.every((entry) =>
		entry.scope !== null && ((entry.scope.type === within.type && entry.scope.value === within.value) || relationInside(entry.scope, within))
	)
}

function relationInside(scope: Scope, within: Scope): boolean {
	const inside = parseRelationInside(scope)
	return inside !== null && inside.dimension === within.type && inside.node === within.value
}
