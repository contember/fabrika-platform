// The human rule of ADR-0050 §4–5, shared by approving, changing `protected`, deleting a protected environment and
// deploying to one by hand. These checks are authorization; the proxy's session admission keeps another site's page out
// (ADR-0022).

import type { AuthContext } from '@fabrika/auth'
import { CONTROL_ACTIONS } from '@fabrika/control-contract'
import { fail } from '../api/domain'
import { canAtCoordinates } from '../api/runs'
import type { AppEnvRow } from '../db'
import { isWorkspaceRef } from '../ref-match'

/** The request a console call arrived on. */
export interface ConsoleAdmission {
	readonly request: Request
}

/**
 * The caller is a person: a user principal, not an OAuth (MCP) token or a share link. A service principal, the builder
 * key and any agent credential are not, whatever they carry. A person's own CLI login is one.
 */
export function isPerson(auth: AuthContext): boolean {
	const principal = auth.principal
	return principal !== null && principal.type === 'user' && auth.oauth === undefined && auth.link === undefined
}

/**
 * The caller is a person in the console: a person (`isPerson`) on a session, not a key (`Authorization`). A service
 * principal, the builder key and any agent credential are refused whatever they carry.
 */
export function requireHumanApprover(auth: AuthContext, admission: ConsoleAdmission | undefined): { readonly id: string; readonly label: string } {
	const principal = auth.principal
	if (principal === null || !isPerson(auth)) fail(403, 'only a person signed in to the console can approve an access change')
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

/**
 * A manual run of a protected environment: only a person starts one, from the console or their own CLI login, so a
 * bearer is allowed here (ADR-0050 §4). A workspace branch never reaches one, whoever asks (ADR-0049 rules 4 and 7).
 */
export function requirePersonForProtectedDeploy(auth: AuthContext, appEnv: AppEnvRow, ref: string): void {
	if (appEnv.protected !== 1) return
	if (!isPerson(auth)) {
		fail(
			403,
			`environment \`${appEnv.env}\` is protected: only a person deploys to it, from the console or their own CLI login; `
				+ 'an agent, a builder key or a service key cannot',
		)
	}
	if (isWorkspaceRef(ref)) {
		fail(403, `environment \`${appEnv.env}\` is protected: a workspace branch reaches it only after it is merged into the environment's trigger ref`)
	}
}
