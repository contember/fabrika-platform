import type { EndpointRequirement } from './contract'
import { permits } from './permissions'
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
