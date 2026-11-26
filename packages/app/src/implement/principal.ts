// Who called: the caller kind a verified token presents, and the principal a handler sees for it.

import {
	type AccessTokenClaims,
	AGENT_CALLER,
	type AgentScope,
	APP_CALLER_PREFIX,
	type Caller,
	callerOf,
	matchAction,
	OAUTH_CALLER,
	type PermissionEntry,
	permits,
	type TerminalTokenClaims,
} from '@fabrika/auth-core'
import type { PageCaller } from '../client/caller'

/** A person: the IAM session, or a `px_` key bound to a user principal. */
export interface UserPrincipal {
	readonly kind: 'user'
	readonly id: string
	/** What IAM shows for the person: the address as it was spelled. Display it; never mail it. */
	readonly label: string
	/** The mailbox IAM recorded for the person, lower-cased: the one to mail, not proof of possession. Only a person has one. */
	readonly email: string
	/**
	 * The enrolled terminal the person signed in on, when an application asserted them there (ADR-0067); absent for every
	 * other sign-in. Information for the handler: what the session may do is in its permissions already.
	 */
	readonly terminal?: TerminalTokenClaims
}

/** A machine: a `px_` key bound to a service principal. */
export interface ServicePrincipal {
	readonly kind: 'service'
	readonly id: string
	readonly label: string
}

/** The anonymous holder of a share link; the id is the link's credential, not a person. */
export interface LinkHolder {
	readonly kind: 'link'
	readonly credentialId: string
}

/** Another application, through its connector key. */
export interface AppPrincipal<Id extends string = string> {
	readonly kind: 'app'
	readonly app: Id
	readonly id: string
}

export type Principal = UserPrincipal | ServicePrincipal | LinkHolder | AppPrincipal

/** Whoever called a public procedure: nobody the platform knows. The handler runs as the endpoint's own workload. */
export interface PublicPrincipal {
	readonly kind: 'public'
	/** The endpoint id, which is the workload's name: `<mount>.<group>.<procedure>`. */
	readonly endpoint: string
}

export type PrincipalOf<C> = C extends 'human' | 'agent' ? UserPrincipal
	: C extends 'machine' ? ServicePrincipal
	: C extends 'link' ? LinkHolder
	: C extends `app:${infer Id}` ? AppPrincipal<Id>
	: never

export interface Presented {
	readonly caller: Caller
	readonly principal: Principal
	/** The agent the person's token acts for, when the proxy exchanged an agent's grant for it (ADR-0090); else `null`. */
	readonly agent: AgentGrant | null
}

/**
 * `ctx.agent`: the agent a person's token acts for — the grant the person approved, the name the agent gave itself and
 * the grant's scope. `ctx.principal` is the person, with the person's permissions as the grant's scope narrowed them.
 */
export interface AgentGrant {
	readonly grant: string
	readonly label: string | null
	readonly scope: AgentScope
}

/**
 * Why a verified token presents no principal: it is no caller of an application (`no_caller`), or a person's token
 * from an IAM that does not mint the mailbox (`no_mailbox`), which a handler could not read.
 */
export type Unpresented = 'no_caller' | 'no_mailbox'

/** The caller a verified application token presents, by `callerOf` (the proxy reads the same), and its principal. */
export function presentedBy(claims: AccessTokenClaims): Presented | Unpresented {
	const caller = callerOf(claims)
	switch (caller) {
		case 'human':
		case AGENT_CALLER: {
			if (claims.email === undefined) return 'no_mailbox'
			// `callerOf` presents `agent` exactly when the token carries `act`.
			const act = claims.act
			return {
				caller,
				principal: {
					kind: 'user',
					id: claims.sub,
					label: claims.label ?? claims.sub,
					email: claims.email,
					...(claims.terminal === undefined ? {} : { terminal: Object.freeze({ id: claims.terminal.id, label: claims.terminal.label }) }),
				},
				agent: act === undefined ? null : Object.freeze({ grant: act.grant, label: act.label ?? null, scope: act.scope }),
			}
		}
		case 'machine':
			return { caller, principal: { kind: 'service', id: claims.sub, label: claims.label ?? claims.sub }, agent: null }
		case 'link':
			return { caller, principal: { kind: 'link', credentialId: claims.sub }, agent: null }
		// An OAuth token reaches only an installation entry, which no application serves.
		case OAUTH_CALLER:
		case null:
			return 'no_caller'
		default:
			return { caller, principal: { kind: 'app', app: caller.slice(APP_CALLER_PREFIX.length), id: claims.sub }, agent: null }
	}
}

/**
 * The caller document of an SPA mount: the person and the contract's actions each of the token's entries covers, a
 * pattern listed as those actions, global entries apart from each scope value's. Built from the token alone.
 */
export function pageCallerOf(principal: UserPrincipal, perms: readonly PermissionEntry[], actions: readonly string[]): PageCaller {
	const covered = (pattern: string) => actions.filter((action) => matchAction(pattern, action))
	const app = new Set<string>()
	const scoped = new Map<string, { readonly type: string; readonly value: string; readonly actions: Set<string> }>()
	for (const entry of perms) {
		const held = covered(entry.action)
		if (held.length === 0) continue
		if (entry.scope === null) {
			for (const action of held) app.add(action)
			continue
		}
		const key = JSON.stringify([entry.scope.type, entry.scope.value])
		const value = scoped.get(key) ?? { type: entry.scope.type, value: entry.scope.value, actions: new Set<string>() }
		for (const action of held) value.actions.add(action)
		scoped.set(key, value)
	}
	const scopes = [...scoped.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([, value]) => ({ type: value.type, value: value.value, actions: [...value.actions].sort() }))
	return { label: principal.label, email: principal.email, actions: { app: [...app].sort(), scopes } }
}

/**
 * `ctx.holds(action)` of a group procedure: whether the verified token holds `action`, an action of the contract, as a
 * global grant, the `app` form's rule. Information for the handler's own authorization: it grants no reach, builds no
 * `ctx.db` and asks IAM nothing.
 */
export function globalHolds(perms: readonly PermissionEntry[], actions: readonly string[]): (action: string) => boolean {
	return Object.freeze((action: string) => actions.includes(action) && perms.some((entry) => permits([entry], action)))
}
