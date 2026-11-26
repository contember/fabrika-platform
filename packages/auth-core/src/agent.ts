// An agent's device grant at an application environment (ADR-0090): the client, the caller its exchanged token
// presents, the scope it approved and the narrowing of the person's permissions to one scope value.

import type { CredentialedEndpointKind } from './contract'
import { MAX_MEMBERSHIP_SCOPE_PART_LENGTH } from './membership'
import { uniquePermissions } from './permissions'
import { isReservedScopeType, parseRelationInside, type PermissionEntry, RELATION_SCOPE_TYPE, relationInsideScope, type Scope } from './types'

/** The public device client an agent obtains an application grant with. It is never served Control's resources. */
export const AGENT_CLIENT_ID = 'agent-cli'

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

/** A dimension name as a contract declares one. */
const DIMENSION = /^[a-z][A-Za-z0-9_]*$/

/** RFC 6749 scope-token characters. */
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/

/**
 * Read one scope token: `read`, `write`, or either narrowed to one value of a dimension, `read:<dimension>=<value>`.
 * The dimension is a contract's dimension name, never a reserved one; the value is 1 to
 * `MAX_MEMBERSHIP_SCOPE_PART_LENGTH` scope-token characters, opaque. Anything else is null.
 */
export function parseAgentScope(token: string): AgentScope | null {
	if (!SCOPE_TOKEN.test(token)) return null
	const colon = token.indexOf(':')
	const mode = colon === -1 ? token : token.slice(0, colon)
	if (!isAgentScopeMode(mode)) return null
	if (colon === -1) return { mode, within: null }
	const rest = token.slice(colon + 1)
	const equals = rest.indexOf('=')
	if (equals === -1) return null
	const type = rest.slice(0, equals)
	const value = rest.slice(equals + 1)
	if (!DIMENSION.test(type) || type.length > MAX_MEMBERSHIP_SCOPE_PART_LENGTH || isReservedScopeType(type)) return null
	if (value === '' || value.length > MAX_MEMBERSHIP_SCOPE_PART_LENGTH) return null
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
 * The person's entries narrowed to the one scope value `within` (ADR-0090 §3). A global entry becomes the same action at
 * `within`; a relation held anywhere becomes the same relation held inside `within`; an entry at `within`, or a
 * relation held inside it, stays. Every other entry is dropped: one at another value, at another dimension, or at a
 * container of `within` or inside it, because which value lies in which is application data. Never adds an action.
 */
export function narrowToValue(entries: readonly PermissionEntry[], within: Scope): PermissionEntry[] {
	if (!DIMENSION.test(within.type)) throw new Error('a grant is narrowed to a value of a dimension')
	const narrowed: PermissionEntry[] = []
	for (const entry of entries) {
		const scope = narrowedScope(entry.scope, within)
		if (scope !== null) narrowed.push({ action: entry.action, scope, source: entry.source })
	}
	return uniquePermissions(narrowed)
}

/** Whether every entry lies within `within`, as `narrowToValue` leaves them: a check a token's reader repeats. */
export function liesWithinValue(entries: readonly PermissionEntry[], within: Scope): boolean {
	return entries.every((entry) => entry.scope !== null && insideValue(entry.scope, within))
}

function narrowedScope(scope: Scope | null, within: Scope): Scope | null {
	if (scope === null) return { type: within.type, value: within.value }
	if (scope.type === RELATION_SCOPE_TYPE) {
		// IAM derives no relation entry whose name holds `:`, which a `~relin` value could not name.
		return scope.value === '' || scope.value.includes(':')
			? null
			: relationInsideScope({ relation: scope.value, dimension: within.type, node: within.value })
	}
	return insideValue(scope, within) ? { type: scope.type, value: scope.value } : null
}

function insideValue(scope: Scope, within: Scope): boolean {
	if (scope.type === within.type) return scope.value === within.value
	const inside = parseRelationInside(scope)
	return inside !== null && inside.dimension === within.type && inside.node === within.value
}
