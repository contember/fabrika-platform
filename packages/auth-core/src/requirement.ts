import { APP_CALLER_PREFIX, type Caller, CONNECT_PREFIX, type EndpointRequirement } from './contract'
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
 * `machine`, a connector key of application `<id>` is `app:<id>`, and a token bound to no principal is a share link.
 * A job or webhook token and an OAuth resource token are no caller: `null` is refused by every endpoint.
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
		case 'app':
			return claims.workload === undefined ? null : `app:${claims.workload}`
		case 'job':
		case 'webhook':
			return null
		case undefined:
			return 'link'
	}
}

/**
 * Whether a caller may be admitted at an endpoint path. A connector caller `app:<id>` reaches only an export's paths
 * (ADR-0022 "Principal kinds"); every other caller is not limited by the path.
 */
export function callerAdmittedAt(caller: Caller, path: string): boolean {
	return !caller.startsWith(APP_CALLER_PREFIX) || path.startsWith(`${CONNECT_PREFIX}/`)
}
