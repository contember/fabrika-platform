// Who called: the caller kind a verified token presents, and the principal a handler sees for it.

import { type AccessTokenClaims, APP_CALLER_PREFIX, type Caller, callerOf } from '@fabrika/auth-core'

/** A person: the IAM session, or a `px_` key bound to a user principal. */
export interface UserPrincipal {
	readonly kind: 'user'
	readonly id: string
	readonly label: string
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

export type PrincipalOf<C> = C extends 'human' ? UserPrincipal
	: C extends 'machine' ? ServicePrincipal
	: C extends 'link' ? LinkHolder
	: C extends `app:${infer Id}` ? AppPrincipal<Id>
	: never

export interface Presented {
	readonly caller: Caller
	readonly principal: Principal
}

/** The caller a verified application token presents, by `callerOf` (the proxy reads the same), and its principal. */
export function presentedBy(claims: AccessTokenClaims): Presented | null {
	const caller = callerOf(claims)
	switch (caller) {
		case 'human':
			return { caller, principal: { kind: 'user', id: claims.sub, label: claims.label ?? claims.sub } }
		case 'machine':
			return { caller, principal: { kind: 'service', id: claims.sub, label: claims.label ?? claims.sub } }
		case 'link':
			return { caller, principal: { kind: 'link', credentialId: claims.sub } }
		case null:
			return null
		default:
			return { caller, principal: { kind: 'app', app: caller.slice(APP_CALLER_PREFIX.length), id: claims.sub } }
	}
}
