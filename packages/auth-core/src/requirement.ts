import { APP_CALLER_PREFIX, CONNECT_PREFIX, type EndpointRequirement } from './contract'
import { type AuthenticatedRequirement, OAUTH_CALLER, type TokenCaller } from './installation-endpoint'
import { permits } from './permissions'
import type { AccessTokenClaims } from './token'
import type { PermissionEntry } from './types'

/**
 * Whether a token's permissions meet an endpoint's requirement. This is authorization, not a gate: it reads only the
 * token. `member` is any permission of this application; an action is that action in some scope, global included.
 * The access form narrows it to one scope afterwards, against the application's own data. The `app` form is the
 * action held as a global grant, so an entry scoped to any value does not meet it. `authenticated`, which only an
 * installation row carries, needs no permission.
 */
export function satisfies(requirement: EndpointRequirement | AuthenticatedRequirement, perms: readonly PermissionEntry[]): boolean {
	if (requirement.kind === 'authenticated') {
		return true
	}
	if (requirement.kind === 'member') {
		return perms.length > 0
	}
	if (requirement.access.form === 'app') {
		return perms.some((entry) => permits([entry], requirement.action))
	}
	return perms.some((entry) => permits([entry], requirement.action, entry.scope ?? undefined))
}

/**
 * The caller kind a verified token presents: a `user` principal is `human`, a `service` principal is `machine`, a
 * connector key of application `<id>` is `app:<id>`, and a token bound to no principal is a share link. An OAuth
 * resource token is `oauth`, which only an installation row admits. A job, webhook or public procedure token is no
 * caller: `null` is refused by every endpoint.
 */
export function callerOf(claims: AccessTokenClaims): TokenCaller | null {
	if (claims.oauth !== undefined) {
		return OAUTH_CALLER
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
		case 'public':
			return null
		case undefined:
			return 'link'
	}
}

/**
 * Whether a caller may be admitted at an endpoint path. A connector caller `app:<id>` reaches only an export's paths
 * (ADR-0022 "Principal kinds"); every other caller is not limited by the path.
 */
export function callerAdmittedAt(caller: TokenCaller, path: string): boolean {
	return !caller.startsWith(APP_CALLER_PREFIX) || path.startsWith(`${CONNECT_PREFIX}/`)
}
