// An application environment as an OAuth resource of the agent client, and the one scope token an agent grant holds
// (ADR-0090 §1–§2). Kept apart from `oauth.ts` so the device start, the device page, the grant's ceiling and the
// exchange read the same rules from one place.

import { type AgentScope, type AgentScopeMode, DEFAULT_AGENT_SCOPE_MODE, isOAuthResourceUri, parseAgentScope } from '@fabrika/auth-core'
import type { AgentWriteGate } from '@fabrika/iam-contract'
import { normalizeOrigin } from './origin'
import { reachesCrossAppAuthority } from './resolve'
import type { Services } from './services'

/** An application environment an agent grant names: its `<app>@<env>` id and its origin, the resource. */
export interface ApplicationResource {
	readonly app: string
	readonly resource: string
}

/**
 * The application environment whose origin `uri` is, or null. The resource is an origin with no path, registered as a
 * return origin by exactly one id, whose reconciled schema admits the caller `agent`. A platform audience is never
 * one: its tokens carry cross-app authority.
 */
export async function applicationResource(services: Services, uri: string): Promise<ApplicationResource | null> {
	if (!isOAuthResourceUri(uri) || normalizeOrigin(uri) !== uri) return null
	const apps = await services.repositories.handoff.appsForReturnOrigin(uri)
	const [app] = apps
	if (app === undefined || apps.length !== 1 || reachesCrossAppAuthority(services.config, app)) return null
	return await services.repositories.appSchema.admitsAgent(app) ? { app, resource: uri } : null
}

/** The scope a device start asks for: none is the default `read`, one token is parsed, more is null. */
export function requestedAgentScope(tokens: readonly string[]): AgentScope | null {
	if (tokens.length === 0) return { mode: DEFAULT_AGENT_SCOPE_MODE, within: null }
	return storedAgentScope(tokens)
}

/** The scope of a stored agent grant or attempt: exactly one token, or null. */
export function storedAgentScope(tokens: readonly string[]): AgentScope | null {
	const [token] = tokens
	return tokens.length === 1 && token !== undefined ? parseAgentScope(token) : null
}

/** Whether the environment's schema declares the dimension a narrowed scope names; an unnarrowed scope names none. */
export async function agentScopeDeclared(services: Services, app: string, scope: AgentScope): Promise<boolean> {
	return scope.within === null || await services.repositories.appSchema.getScope(app, scope.within.type) !== null
}

/** The environment's mirrored `agent-write` gate (ADR-0090 §5): `refuse` until Control has written one. */
export function agentWriteGate(services: Services, app: string): Promise<AgentWriteGate> {
	return services.repositories.grantRequests.agentWriteGate(app)
}

/**
 * Whether an environment whose `agent-write` gate is `gate` serves an agent grant of `mode` (ADR-0090 §5). `read` is
 * served everywhere; `write` only where the gate is `open`. A `passkey` gate refuses it too until the device page asks
 * that passkey, so a protected environment fails closed. Read at the approval and at every exchange, so a gate that
 * tightens ends a `write` grant at its next exchange.
 */
export function agentModeServed(mode: AgentScopeMode, gate: AgentWriteGate): boolean {
	return mode === 'read' || gate === 'open'
}

/**
 * The scopes a person may approve for `requested`, widest first: the request, or `read` for `write`, with the same
 * narrowing, and only modes the environment serves. Never wider than the request, and the narrowing never changes.
 */
export function approvableAgentScopes(requested: AgentScope, gate: AgentWriteGate): AgentScope[] {
	const modes: AgentScopeMode[] = requested.mode === 'write' ? ['write', 'read'] : ['read']
	return modes.filter((mode) => agentModeServed(mode, gate)).map((mode) => ({ mode, within: requested.within }))
}
