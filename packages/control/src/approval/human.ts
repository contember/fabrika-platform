// The human rule of ADR-0050 §4–5, shared by approving, changing `protected`, deleting a protected environment,
// deploying to one by hand and redirecting what it deploys. These checks are authorization; the proxy's session
// admission keeps another site's page out (ADR-0022).

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
 * key and any agent credential are not, whatever they carry. A user principal's bearer counts too.
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

/** Why a manual run of a protected environment is refused: the HTTP status its creation answers, and the message. */
export interface ProtectedRunRefusal {
	readonly status: 400 | 403
	readonly message: string
}

/** The refs a protected environment's manual run names: a full branch or tag ref, or a commit SHA. */
const PROTECTED_REF = /^(?:refs\/(?:heads|tags)\/[^/].*|[0-9a-f]{40})$/

/**
 * A manual run of a protected environment: only a person starts one (ADR-0050 §4), and it names a full ref or a commit
 * SHA, never a workspace branch (ADR-0049 rules 4 and 7). A SHA or a tag is not traced back to a workspace. Checked when
 * the run is created and again when it starts, since the flag may have been set in between. Null when it may run.
 */
export function protectedRunRefusal(appEnv: AppEnvRow, run: { readonly byPerson: boolean; readonly ref: string }): ProtectedRunRefusal | null {
	if (appEnv.protected !== 1) return null
	const refusal = protectedRunCause(appEnv.env, run)
	if (refusal === null || appEnv.authoring !== 1) return refusal
	// Both flags predate ADR-0049 rule 7, which now keeps them apart; only an operator can clear one.
	return {
		status: refusal.status,
		message: `${refusal.message}. It is also the app's authoring target, which a protected environment no longer is: an operator `
			+ 'clears its authoring flag (apps.environments.put with authoring: false) or its protection',
	}
}

function protectedRunCause(env: string, run: { readonly byPerson: boolean; readonly ref: string }): ProtectedRunRefusal | null {
	if (!run.byPerson) {
		return {
			status: 403,
			message: `environment \`${env}\` is protected: only a person deploys it by hand, from the console; an agent, a builder key or a `
				+ "service key cannot. A push to the environment's trigger ref still deploys it",
		}
	}
	if (!PROTECTED_REF.test(run.ref)) {
		return {
			status: 400,
			message: `environment \`${env}\` is protected: ref \`${run.ref}\` must be a full ref (refs/heads/<branch>, refs/tags/<tag>) `
				+ 'or a 40-character commit SHA',
		}
	}
	if (isWorkspaceRef(run.ref)) {
		return {
			status: 403,
			message: `environment \`${env}\` is protected: a workspace branch reaches it only after it is merged into the environment's trigger ref`,
		}
	}
	return null
}

/** `protectedRunRefusal` for a caller creating a manual run; a bearer counts, since `isPerson` reads no header. */
export function requirePersonForProtectedDeploy(auth: AuthContext, appEnv: AppEnvRow, ref: string): void {
	const refusal = protectedRunRefusal(appEnv, { byPerson: isPerson(auth), ref })
	if (refusal !== null) fail(refusal.status, refusal.message)
}

/**
 * Changing what a deploy of a protected environment runs (its trigger ref, its application's source and build) takes a
 * person too, or a key would redirect the environment it cannot deploy by hand. `protectedEnv` names the protected
 * environment the change reaches, null when none.
 */
export function requirePersonToRedirect(auth: AuthContext, protectedEnv: string | null, change: string): void {
	if (protectedEnv === null || isPerson(auth)) return
	fail(
		403,
		`environment \`${protectedEnv}\` is protected: only a person changes ${change}, which decides what a deploy there runs; `
			+ 'an agent, a builder key or a service key cannot',
	)
}
