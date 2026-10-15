// The human rule of ADR-0050 §5, shared by approving, changing `protected`, and deleting a protected environment.
// These checks are authorization; the proxy's session admission keeps another site's page out (ADR-0022).

import type { AuthContext } from '@fabrika/auth'
import { CONTROL_ACTIONS } from '@fabrika/control-contract'
import { fail } from '../api/domain'
import { canAtCoordinates } from '../api/runs'
import type { AppEnvRow } from '../db'

/** The request a console call arrived on. */
export interface ConsoleAdmission {
	readonly request: Request
}

/**
 * The caller is a person in the console: a user principal on a session, not a key (`Authorization`), an OAuth (MCP)
 * token or a share link. A service principal, the builder key and any agent credential are refused whatever they carry.
 */
export function requireHumanApprover(auth: AuthContext, admission: ConsoleAdmission | undefined): { readonly id: string; readonly label: string } {
	const principal = auth.principal
	if (principal === null || principal.type !== 'user' || auth.oauth !== undefined || auth.link !== undefined) {
		fail(403, 'only a person signed in to the console can approve an access change')
	}
	if (admission === undefined) fail(403, 'an access change is approved from the console itself')
	if (admission.request.headers.get('Authorization') !== null) fail(403, 'an access change is approved in the console, not with a key')
	return { id: principal.id, label: principal.label }
}

/**
 * Deleting a protected environment erases the policy a human set, so it takes the same human with `access.approve`
 * at its coordinates as unprotecting it. An unprotected environment needs nothing beyond the caller's own action.
 */
export function requireHumanForProtectedDelete(auth: AuthContext, admission: ConsoleAdmission | undefined, envs: readonly AppEnvRow[]): void {
	const protectedEnvs = envs.filter((row) => row.protected === 1)
	if (protectedEnvs.length === 0) return
	requireHumanApprover(auth, admission)
	for (const row of protectedEnvs) {
		if (!canAtCoordinates(auth, CONTROL_ACTIONS.ACCESS_APPROVE, row.app_id, row.env)) {
			fail(403, `environment \`${row.env}\` is protected; deleting it takes \`access.approve\``)
		}
	}
}
