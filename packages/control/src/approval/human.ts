// The human rule of ADR-0050 §4–5, shared by approving, changing `protected`, deleting a protected environment,
// deploying to one by hand and redirecting what it deploys. These checks are authorization; the proxy's session
// admission keeps another site's page out (ADR-0022).

import type { AuthContext } from '@fabrika/auth'
import { type ActionCategory, CONTROL_ACTIONS, gate } from '@fabrika/control-contract'
import { fail } from '../api/domain'
import { canAtCoordinates } from '../api/runs'
import { type AppEnvRow, type ControlRepositories, defaultProtected, type RunRow } from '../db'
import { isPerson } from '../iam'
import { isWorkspaceRef } from '../ref-match'
import { appEnvPolicy } from './categories'

/** The request a console call arrived on. */
export interface ConsoleAdmission {
	readonly request: Request
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

/** The person behind a pending item's request (`requesterPersonId`): null when it cannot be known. */
export interface RequesterPerson {
	readonly personId: string | null
	/** Who asked, as the request recorded them: the person, or the service principal that holds the key. */
	readonly label: string
}

/**
 * Under `requesterMayApprove: false`, the approver is someone other than the requester's person (ADR-0083 §8). A service
 * key's token names no issuer, so its person is unknown and nobody may approve the item: it fails closed, and a
 * refusal, or a person with `access.approve` changing the setting, still decides it.
 */
export function requireOtherThanRequester(approver: { readonly id: string }, requester: RequesterPerson, item: 'deploy' | 'request'): void {
	if (requester.personId === null) {
		fail(
			403,
			`${requester.label} asked for this ${item} with a service key whose issuer Control cannot know, and the environment lets only `
				+ "someone other than the requester's person approve it (requesterMayApprove: false), so nobody can approve it; it can be refused",
		)
	}
	if (requester.personId === approver.id) {
		fail(
			403,
			`this ${item} was asked for on your behalf, and the environment lets only someone other than the requester's person approve it `
				+ '(requesterMayApprove: false); another person with access.approve decides it',
		)
	}
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
 * A person in the console (ADR-0083 §6): a person (`isPerson`) on a request without an `Authorization` header. Every
 * bearer is a non-person, a person's own `px_` key included, so an agent handed that key cannot pass as its owner.
 */
export function isConsolePerson(auth: AuthContext, admission: ConsoleAdmission | undefined): boolean {
	return isPerson(auth) && admission !== undefined && admission.request.headers.get('Authorization') === null
}

/**
 * Whether the gate lets a non-person's action of `category` through on this environment without a person: it is not
 * protected, or its mode for the category is `off` (ADR-0083 §3).
 */
export function gatePasses(appEnv: AppEnvRow, category: ActionCategory): boolean {
	return appEnv.protected !== 1 || gate({ lines: [], actions: [category] }, appEnvPolicy(appEnv)).kind === 'pass'
}

/** Why a manual run of a protected environment is refused: the HTTP status its creation answers, and the message. */
export interface ProtectedRunRefusal {
	readonly kind: 'refuse'
	readonly status: 400 | 403
	readonly message: string
}

/**
 * What a manual run of an environment does (ADR-0050 §4): it runs, it is a non-person's request that parks for a person
 * whatever its lines (`deploy-request: person`), or it is refused.
 */
export type ProtectedRunDecision = { readonly kind: 'run' } | { readonly kind: 'request' } | ProtectedRunRefusal

/** The refs a protected environment's manual run names: a full branch or tag ref, or a commit SHA. */
const PROTECTED_REF = /^(?:refs\/(?:heads|tags)\/[^/].*|[0-9a-f]{40})$/
const COMMIT_SHA = /^[0-9a-f]{40}$/

/**
 * A manual run of a protected environment (ADR-0050 §4): a person's names a full ref or a commit SHA, never a workspace
 * branch (ADR-0049 rules 4 and 7); a non-person's is judged by the environment's `deploy-request` mode through `gate`,
 * and one that asks names a commit SHA. A SHA or a tag is not traced back to a workspace. Decided when the run is
 * created and again when it starts, since the flag or the mode may have changed in between.
 */
export function protectedRunDecision(appEnv: AppEnvRow, run: { readonly byPerson: boolean; readonly ref: string }): ProtectedRunDecision {
	if (appEnv.protected !== 1) return { kind: 'run' }
	const decision = protectedRunCause(appEnv, run)
	if (decision.kind !== 'refuse' || appEnv.authoring !== 1) return decision
	// Both flags predate ADR-0049 rule 7, which now keeps them apart; only an operator can clear one.
	return {
		...decision,
		message: `${decision.message}. It is also the app's authoring target, which a protected environment no longer is: an operator `
			+ 'clears its authoring flag (apps.environments.put with authoring: false) or its protection',
	}
}

function protectedRunCause(appEnv: AppEnvRow, run: { readonly byPerson: boolean; readonly ref: string }): ProtectedRunDecision {
	const env = appEnv.env
	if (isWorkspaceRef(run.ref)) {
		return {
			kind: 'refuse',
			status: 403,
			message: `environment \`${env}\` is protected: a workspace branch reaches it only after it is merged into the environment's trigger ref`,
		}
	}
	const outcome = run.byPerson ? null : gate({ lines: [], actions: ['deploy-request'] }, appEnvPolicy(appEnv))
	if (outcome?.kind === 'refuse') {
		return {
			kind: 'refuse',
			status: 403,
			message: `environment \`${env}\` is protected and refuses a deploy a non-person asks for (deploy-request: refuse): only a person `
				+ "deploys it by hand, from the console; an agent, a builder key or an API key cannot. A push to the environment's trigger ref "
				+ 'still deploys it',
		}
	}
	if (outcome?.kind === 'wait') {
		if (COMMIT_SHA.test(run.ref)) return { kind: 'request' }
		return {
			kind: 'refuse',
			status: 400,
			message: `environment \`${env}\` is protected: a deploy an agent or a key asks for names a 40-character commit SHA, not \`${run.ref}\`, `
				+ 'and waits for a person to approve it',
		}
	}
	if (!PROTECTED_REF.test(run.ref)) {
		return {
			kind: 'refuse',
			status: 400,
			message: `environment \`${env}\` is protected: ref \`${run.ref}\` must be a full ref (refs/heads/<branch>, refs/tags/<tag>) `
				+ 'or a 40-character commit SHA',
		}
	}
	return { kind: 'run' }
}

/**
 * `protectedRunDecision` for a caller creating a manual run, which is a person only in the console (`isConsolePerson`).
 * A refusal answers its status; otherwise the decision and whether a person started the run, which the run records.
 */
export function protectedDeployOf(
	auth: AuthContext,
	admission: ConsoleAdmission | undefined,
	appEnv: AppEnvRow,
	ref: string,
): { readonly byPerson: boolean; readonly decision: Exclude<ProtectedRunDecision, ProtectedRunRefusal> } {
	const byPerson = isConsolePerson(auth, admission)
	const decision = protectedRunDecision(appEnv, { byPerson, ref })
	if (decision.kind === 'refuse') fail(decision.status, decision.message)
	return { byPerson, decision }
}

/**
 * Whether a person started a manual run, as it recorded. A run created before the record reads as its actor did then:
 * a `user:` actor was a person, so a run admitted under the earlier rule is judged by it again, never refused anew.
 */
export function startedByPerson(run: Pick<RunRow, 'by_person' | 'actor'>): boolean {
	return run.by_person === null ? run.actor?.startsWith('user:') === true : run.by_person === 1
}

/**
 * Changing what a deploy of a protected environment runs (its trigger ref, its application's source and build) takes a
 * person too, or a key would redirect the environment it cannot deploy by hand. `protectedEnv` names the protected
 * environment the change reaches, null when none.
 */
export function requirePersonToRedirect(
	auth: AuthContext,
	admission: ConsoleAdmission | undefined,
	protectedEnv: string | null,
	change: string,
): void {
	if (protectedEnv === null || isConsolePerson(auth, admission)) return
	fail(
		403,
		`environment \`${protectedEnv}\` is protected: only a person changes ${change}, which decides what a deploy there runs; `
			+ 'an agent, a builder key or a service key cannot',
	)
}

/** Whether the environment is protected, or a new one starts protected: as `prod` or as a deleted protected one. */
export async function startsProtected(
	registry: Pick<ControlRepositories['registry'], 'getKeptProtection'>,
	appId: string,
	env: string,
	existing: AppEnvRow | null,
): Promise<boolean> {
	if (existing !== null) return existing.protected === 1
	return ((await registry.getKeptProtection(appId, env)) ?? defaultProtected(env)) === 1
}

/**
 * Naming the trigger ref of an environment that is protected, or of a new one that starts protected, takes a person
 * (`apps.environments.put`, `apps.register`), unless an existing one's `registry` mode is `off`: there the gate already
 * let the write through, and a new one has no request to wait in. Clearing it stops push deploys and stays open to a key.
 */
export async function requirePersonToPointTriggerRef(
	c: { readonly auth: AuthContext; readonly admission?: ConsoleAdmission; readonly repositories: Pick<ControlRepositories, 'registry'> },
	target: { readonly appId: string; readonly env: string; readonly existing: AppEnvRow | null; readonly triggerRef: string | null },
): Promise<void> {
	const { appId, env, existing, triggerRef } = target
	if (triggerRef === null || triggerRef === existing?.trigger_ref || isConsolePerson(c.auth, c.admission)) return
	if (existing !== null && gatePasses(existing, 'registry')) return
	if (await startsProtected(c.repositories.registry, appId, env, existing)) requirePersonToRedirect(c.auth, c.admission, env, 'its trigger ref')
}

/**
 * Naming the public origin of an environment that is protected, or of a new one that starts protected, takes a person,
 * like its domain: IAM sends an administrator's short-lived key to that origin to ask the application for a dimension's
 * values (ADR-0085 §4). An existing one whose `registry` mode is `off` takes a key, as the gate did. Clearing it stays
 * open to a key.
 */
export async function requirePersonToPointPublicOrigin(
	c: { readonly auth: AuthContext; readonly admission?: ConsoleAdmission; readonly repositories: Pick<ControlRepositories, 'registry'> },
	target: { readonly appId: string; readonly env: string; readonly existing: AppEnvRow | null; readonly publicOrigin: string | null },
): Promise<void> {
	const { appId, env, existing, publicOrigin } = target
	if (publicOrigin === null || publicOrigin === existing?.public_origin || isConsolePerson(c.auth, c.admission)) return
	if (existing !== null && gatePasses(existing, 'registry')) return
	if (await startsProtected(c.repositories.registry, appId, env, existing)) {
		fail(403, `environment \`${env}\` is protected: only a person changes its public origin; an agent, a builder key or a service key cannot`)
	}
}

/**
 * Naming the domain of an environment that is protected, or of a new one that starts protected, takes a person
 * (`apps.environments.put`): the domain receives its traffic and, once deployed there, Control's ops key. Clearing it
 * stays open to a key, and so does an existing one whose `registry` mode is `off`, as the gate did.
 */
export async function requirePersonToPointDomain(
	c: { readonly auth: AuthContext; readonly admission?: ConsoleAdmission; readonly repositories: Pick<ControlRepositories, 'registry'> },
	target: { readonly appId: string; readonly env: string; readonly existing: AppEnvRow | null; readonly domain: string | null },
): Promise<void> {
	const { appId, env, existing, domain } = target
	if (domain === null || domain === existing?.domain || isConsolePerson(c.auth, c.admission)) return
	if (existing !== null && gatePasses(existing, 'registry')) return
	if (await startsProtected(c.repositories.registry, appId, env, existing)) {
		fail(403, `environment \`${env}\` is protected: only a person changes its domain; an agent, a builder key or a service key cannot`)
	}
}
