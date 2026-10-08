import type { Caller, EndpointRequirement } from './contract'
import { permits } from './permissions'
import type { AccessTokenClaims } from './token'
import type { PermissionEntry } from './types'

/**
 * Whether a token's permissions meet an endpoint's requirement. This is authorization, not a gate: it reads only the
 * token. `member` is any permission of this application; an action is that action in some scope, global included.
 * The access form narrows it to one scope afterwards, against the application's own data.
 */
export function satisfies(requirement: EndpointRequirement, perms: readonly PermissionEntry[]): boolean {
	if (requirement.kind === 'member') {
		return perms.length > 0
	}
	return perms.some((entry) => permits([entry], requirement.action, entry.scope ?? undefined))
}

/**
 * The caller kind a verified application token presents: a `user` principal is `human`, a `service` principal is
 * `machine`, and a token bound to no principal is a share link. An OAuth resource token is no caller, and no token
 * kind is an `app:<id>` connector yet. `null` is refused by every endpoint.
 */
export function callerOf(claims: AccessTokenClaims): Caller | null {
	if (claims.oauth !== undefined) {
		return null
	}
	switch (claims.ptype) {
		case 'user':
			return 'human'
		case 'service':
			return 'machine'
		case undefined:
			return 'link'
		default:
			return null
	}
}
