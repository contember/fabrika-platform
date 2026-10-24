/**
 * The membership operations of a multi-tenant application (ADR-0012 §6; ADR-0022
 * rule 6): delegation grants, scope creation, membership, invitations and share links.
 *
 * Every operation resolves the caller from its own credential and evaluates it against the caller's LIVE
 * permissions at the credential's verified app. The application names no actor and writes no grant: IAM
 * generates every value, writes every grant and issues every key. Scopes stay flat — a value is checked as
 * itself; only a share link names its containment chain, and the framework re-checks that chain per request.
 */

import {
	API_KEY_PREFIX,
	type AppMemberItem,
	type AssignMemberInput,
	type AssignMemberResult,
	type CreateScopeInput,
	type CreateScopeResult,
	DELEGATION_GRANT_TTL_SECONDS,
	type FindMemberInput,
	type FindMemberResult,
	type InvitationOptions,
	invitationOptionsProblem,
	invitedAddress,
	type IssueLinkInput,
	type IssueLinkResult,
	type ListAppMembersInput,
	type ListAppMembersResult,
	type ListMembersInput,
	type ListMembersResult,
	matchAction,
	MAX_APP_MEMBERS_PAGE,
	MAX_LINK_CHAIN_LENGTH,
	MAX_MEMBERSHIP_SCOPE_PART_LENGTH,
	type MemberItem,
	type MembershipCaller,
	type MembershipFailure,
	membershipScopeProblem,
	parseJsonStringArray,
	type PermissionEntry,
	permits,
	type RequestDelegationInput,
	type RequestDelegationResult,
	type RevokeLinkInput,
	type RevokeLinkResult,
	type RevokeMemberInput,
	type RevokeMemberResult,
	type Scope,
} from '@fabrika/auth-core'
import { EmailDeliveryError, type EmailMessage } from '@fabrika/email'
import { uuidv7 } from '@fabrika/platform'
import { appQuery, presentationFor } from './app-presentation'
import { type CallerResolution, resolveCaller, resolveLinkCaller } from './auth'
import { contractGrantProblem, externalGrantProblem } from './contract-rules'
import {
	type AppMembersRow,
	type AppScopeRow,
	type AuditEventInput,
	auditLabelOf,
	type DelegatedEndpointRow,
	type InvitationRow,
	type InviterCheck,
	type PrincipalRow,
	principalStatus,
	type RoleRow,
} from './db'
import { issuerAuthority } from './delegation'
import type { Env, RequestContext } from './env'
import { organizationMailbox } from './human-admission'
import { logError } from './log'
import { EMAIL_SEND_DEADLINE_MS, renderEmail } from './messages'
import { randomToken } from './oidc'
import type { StoredPasswordHash } from './password-crypto'
import { unixNow } from './repositories/sql'
import { authorityDeadline, type HeldEntry, resolveAuthorityAt } from './resolve'
import { BUILTIN_ROLES } from './roles'
import { generateToken, hashToken } from './secret'
import type { Services } from './services'
import { parseStoredChain } from './stored-chain'
import { parseStoredPermissions } from './stored-permissions'
import { authorityOnTerminal } from './tokens'

/** How long an invitation may wait for its addressee. */
export const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60

/** The path of IAM's page that accepts an invitation; the one-time token rides in the fragment. */
export const INVITATION_ACCEPT_PATH = '/auth/invitations/accept'

const DAY_SECONDS = 24 * 60 * 60

type CallerEnv = Pick<Env, 'FABRIKA_IAM_SIGNING_KEYS' | 'FABRIKA_IAM_PROVISIONING_KEY' | 'ENVIRONMENT'>

const NOT_ALLOWED: MembershipFailure = { ok: false, reason: 'not_allowed' }
const NOT_FOUND: MembershipFailure = { ok: false, reason: 'not_found' }
const INVALID_DELEGATION: MembershipFailure = { ok: false, reason: 'invalid_delegation' }

function invalid(message: string): MembershipFailure {
	return { ok: false, reason: 'invalid_request', message }
}

/** The caller of a membership operation, with its permissions at the verified app as IAM holds them now. */
interface MemberCaller {
	readonly principal: PrincipalRow
	readonly permissions: PermissionEntry[]
	/** What the principal holds live and until when: what a grant it gives may not outlive (S8). */
	readonly supports: readonly HeldEntry[]
	readonly app: string
}

type CallerOutcome = { ok: true; caller: MemberCaller } | MembershipFailure

/**
 * Resolve the caller and its LIVE permissions, never more than its credential carries. A token's `perms`
 * are a snapshot up to five minutes old, so only the entries the principal still holds count; a `px_` key
 * is already resolved live, downscoped by its own grants. An
 * anonymous credential, a share link included, is never a member caller. `userOnly` refuses a service
 * principal: a workload creates no scope and manages no member, so a form plus a job cannot sign anyone up.
 */
async function resolveMemberCaller(services: Services, env: CallerEnv, input: MembershipCaller, userOnly: boolean): Promise<CallerOutcome> {
	return memberCallerOf(services, input, await resolveCaller(services, env, input), userOnly)
}

async function memberCallerOf(services: Services, input: MembershipCaller, resolution: CallerResolution, userOnly: boolean): Promise<CallerOutcome> {
	if (!resolution.ok) {
		return { ok: false, reason: resolution.reason }
	}
	const { caller, verifiedApp } = resolution
	if (caller.type === undefined || (userOnly && caller.type !== 'user')) {
		return NOT_ALLOWED
	}
	const principal = await services.repositories.principals.getPrincipalById(caller.id)
	if (principal === null) {
		return { ok: false, reason: 'unknown_principal' }
	}
	if (principalStatus(principal) === 'disabled') {
		return { ok: false, reason: 'disabled' }
	}
	const live = await resolveAuthorityAt(services, principal, verifiedApp)
	if (input.credential?.startsWith(API_KEY_PREFIX) === true) {
		return { ok: true, caller: { principal, permissions: caller.permissions, supports: live.supports, app: verifiedApp } }
	}
	// A token is a ceiling too: one minted from a downscoped key carries only that key's grants. A person's token from a
	// terminal is held to what that terminal brings now: the ceiling-narrowed person and the terminal's own grants.
	const held = caller.terminal === undefined ? live : await authorityOnTerminal(services, principal, caller.terminal, verifiedApp)
	if (held === null) {
		return { ok: false, reason: 'invalid_token' }
	}
	const permissions = caller.permissions.filter((entry) => permits(held.permissions, entry.action, entry.scope ?? undefined))
	return { ok: true, caller: { principal, permissions, supports: held.supports, app: verifiedApp } }
}

/**
 * The caller of a link operation. A job is admitted only while the app's schema declares that it issues a link mount
 * (`app_workloads.issues`, reconciled from the approved artifact): `job` names it and that mount, null for a member
 * caller. A job's permissions are its declared actions, app-wide, never more than its token carries.
 */
interface IssuingJob {
	readonly name: string
	readonly issues: string
	/** The job's declared actions as IAM read them: the issuance is written only while they are still declared. */
	readonly actions: readonly string[]
}

type LinkCallerOutcome = { ok: true; caller: MemberCaller; job: IssuingJob | null } | MembershipFailure

async function resolveLinkOperationCaller(services: Services, env: CallerEnv, input: MembershipCaller): Promise<LinkCallerOutcome> {
	const resolution = await resolveLinkCaller(services, env, input)
	if (!resolution.ok) {
		return { ok: false, reason: resolution.reason }
	}
	const { verifiedApp } = resolution
	const { type, ...caller } = resolution.caller
	if (type !== 'job') {
		const member = await memberCallerOf(
			services,
			input,
			{ ok: true, caller: { ...caller, ...(type === undefined ? {} : { type }) }, verifiedApp },
			false,
		)
		return member.ok ? { ...member, job: null } : member
	}
	const principal = await services.repositories.principals.getPrincipalById(caller.id)
	if (principal === null) {
		return { ok: false, reason: 'unknown_principal' }
	}
	if (principalStatus(principal) === 'disabled') {
		return { ok: false, reason: 'disabled' }
	}
	const workload = await services.repositories.workloads.getByPrincipal(principal.id)
	if (workload === null || workload.kind !== 'job' || workload.app !== verifiedApp) {
		return NOT_ALLOWED
	}
	const declaration = await services.repositories.workloads.declaration(workload.app, 'job', workload.name)
	if (declaration === null || declaration.issues === null) {
		return NOT_ALLOWED
	}
	const permissions = caller.permissions.filter((entry) => entry.scope === null && declaration.actions.includes(entry.action))
	return {
		ok: true,
		caller: { principal, permissions, supports: permissions.map((entry) => ({ action: entry.action, scope: null, until: null })), app: verifiedApp },
		job: { name: workload.name, issues: declaration.issues, actions: declaration.actions },
	}
}

/**
 * Spend the request's delegation grant. It is consumed BEFORE its binding is compared, as a handoff code
 * is, so every attempt is single-use, a mismatched one included. The endpoint is read from the schema
 * again: a grant for an endpoint the app no longer declares, or for another purpose or dimension, buys nothing.
 */
async function spendDelegation(
	services: Services,
	caller: MemberCaller,
	input: { delegation: string; requestId: string },
	purpose: DelegatedEndpointRow['purpose'],
	dimension: string,
): Promise<{ ok: true; endpoint: DelegatedEndpointRow } | MembershipFailure> {
	const grant = await services.repositories.membership.consumeDelegationGrant(await hashToken(input.delegation), unixNow())
	if (grant === null || grant.app !== caller.app || grant.principal_id !== caller.principal.id || grant.request_id !== input.requestId) {
		return INVALID_DELEGATION
	}
	const endpoint = await services.repositories.appSchema.getDelegatedEndpoint(caller.app, grant.endpoint)
	if (endpoint === null || endpoint.purpose !== purpose || endpoint.dimension !== dimension) {
		return INVALID_DELEGATION
	}
	return { ok: true, endpoint }
}

/** The dimension of `scope`, when it declares members, and the caller holds its `members.manage` there. */
async function manageAuthority(
	services: Services,
	actor: { app: string; permissions: PermissionEntry[] },
	scope: Scope,
): Promise<{ ok: true; dimension: AppScopeRow; manage: string } | MembershipFailure> {
	const dimension = await services.repositories.appSchema.getScope(actor.app, scope.type)
	if (dimension === null || dimension.members_manage === null) {
		return invalid(`scope '${scope.type}' declares no members`)
	}
	if (!permits(actor.permissions, dimension.members_manage, scope)) {
		return NOT_ALLOWED
	}
	return { ok: true, dimension, manage: dimension.members_manage }
}

/**
 * Could `actor` give `role` in `scope`? The role is a membership role of the scope's dimension, the actor
 * holds a role that `assignableBy` names — there, or an application-wide role globally — and the role grants
 * nothing the actor lacks there. The same question decides an assignment, a revocation and, again at
 * acceptance, an invitation.
 */
async function roleAuthorityProblem(
	services: Services,
	actor: { app: string; principalId: string; permissions: PermissionEntry[] },
	scope: Scope,
	role: RoleRow,
): Promise<MembershipFailure | null> {
	if (role.member_scope !== scope.type || Object.hasOwn(BUILTIN_ROLES, role.role_key)) {
		return invalid(`role '${role.role_key}' is not a membership role of scope '${scope.type}'`)
	}
	const assigners = role.assignable_by === null ? [] : parseJsonStringArray(role.assignable_by)
	const held = (await services.repositories.membership.listAssigningGrants(actor.app, actor.principalId, scope)).map((grant) => grant.role_key)
	if (!assigners.some((assigner) => held.includes(assigner))) {
		return NOT_ALLOWED
	}
	if (!parseStoredPermissions(role.permissions).every((action) => permits(actor.permissions, action, scope))) {
		return NOT_ALLOWED
	}
	const contract = await contractGrantProblem(services.repositories.appSchema, actor.app, {
		roleKey: role.role_key,
		permissions: null,
		scopeType: scope.type,
	})
	return contract === null ? null : invalid(contract)
}

/**
 * The latest expiry a grant of `role` in `scope` given by `actor` may carry (S8): no later than the earliest expiry
 * among the grants that authorize it — the assigning role held there or globally, the dimension's `manage` action and
 * every action of the role there. `null` is no expiry. Asked only after `roleAuthorityProblem` admitted the actor.
 */
async function delegationDeadline(
	services: Services,
	actor: { app: string; principalId: string; supports: readonly HeldEntry[] },
	scope: Scope,
	role: RoleRow,
	manage: string,
): Promise<number | null> {
	const assigners = role.assignable_by === null ? [] : parseJsonStringArray(role.assignable_by)
	const assigning = (await services.repositories.membership.listAssigningGrants(actor.app, actor.principalId, scope))
		.filter((grant) => grant.role_key !== null && assigners.includes(grant.role_key))
	const now = unixNow()
	const assignerUntil = assigning.some((grant) => grant.expires_at === null)
		? null
		: Math.max(now, ...assigning.map((grant) => grant.expires_at ?? now))
	const carried = [manage, ...parseStoredPermissions(role.permissions)].map((action): PermissionEntry => ({ action, scope, source: 'grant' }))
	return earliest(assignerUntil, authorityDeadline(actor, carried, now))
}

/** The earlier of two deadlines, where `null` is none. */
function earliest(a: number | null, b: number | null): number | null {
	return a === null ? b : b === null ? a : Math.min(a, b)
}

/** The record of a change the caller made. The repository writes it in the change's own transaction. */
function memberEvent(
	caller: MemberCaller,
	requestId: string,
	event: { action: string; resourceType: string; resourceId: string; metadata?: unknown },
): AuditEventInput {
	return { requestId, principalId: caller.principal.id, principalLabel: auditLabelOf(caller.principal), app: caller.app, ...event }
}

function scopeId(scope: Scope): string {
	return `${scope.type}:${scope.value}`
}

// ── Delegation grants ─────────────────────────────────────────────────────────

export async function requestDelegation(
	services: Services,
	env: CallerEnv,
	ctx: RequestContext,
	input: RequestDelegationInput,
): Promise<RequestDelegationResult> {
	const resolved = await resolveMemberCaller(services, env, input, true)
	if (!resolved.ok) return resolved
	const { caller } = resolved
	const endpoint = await services.repositories.appSchema.getDelegatedEndpoint(caller.app, input.endpoint)
	if (endpoint === null) {
		return invalid(`endpoint '${input.endpoint}' declares no membership operation`)
	}
	if (!caller.permissions.some((entry) => matchAction(entry.action, endpoint.action))) {
		return NOT_ALLOWED
	}
	const grant = generateToken()
	const expiresAt = unixNow() + DELEGATION_GRANT_TTL_SECONDS
	await services.repositories.membership.issueDelegationGrant({
		grantHash: await hashToken(grant),
		app: caller.app,
		principalId: caller.principal.id,
		endpoint: endpoint.endpoint,
		requestId: input.requestId,
		expiresAt,
	})
	return { ok: true, grant, expiresAt }
}

// ── Scope creation ────────────────────────────────────────────────────────────

/**
 * A value of a top-level dimension. The caller holds the creating endpoint's action globally: a value it
 * does not yet belong to cannot be the scope of its authority. A contained dimension's values are rows of
 * the application, not values IAM creates.
 */
export async function createScope(services: Services, env: CallerEnv, ctx: RequestContext, input: CreateScopeInput): Promise<CreateScopeResult> {
	const resolved = await resolveMemberCaller(services, env, input, true)
	if (!resolved.ok) return resolved
	const { caller } = resolved
	const spent = await spendDelegation(services, caller, input, 'creates', input.dimension)
	if (!spent.ok) return spent
	const dimension = await services.repositories.appSchema.getScope(caller.app, input.dimension)
	if (dimension === null || dimension.creator_role === null || dimension.parent_scope !== null) {
		return invalid(`scope '${input.dimension}' is not created by IAM: it needs a creator role and no containing scope`)
	}
	if (!permits(caller.permissions, spent.endpoint.action)) {
		return NOT_ALLOWED
	}
	const role = await services.repositories.appSchema.getRole(caller.app, dimension.creator_role)
	if (role === null || role.member_scope !== input.dimension || Object.hasOwn(BUILTIN_ROLES, role.role_key)) {
		return invalid(`the creator role '${dimension.creator_role}' is not a membership role of scope '${input.dimension}'`)
	}
	const contract = await contractGrantProblem(services.repositories.appSchema, caller.app, {
		roleKey: role.role_key,
		permissions: null,
		scopeType: input.dimension,
	})
	if (contract !== null) return invalid(contract)
	const external = await externalGrantProblem(services.repositories.appSchema, caller.principal, caller.app, { roleKey: role.role_key })
	if (external !== null) return invalid(external)
	const scope: Scope = { type: input.dimension, value: uuidv7() }
	// The creator gives itself the role on the strength of the creating action, so the grant ends when that action does.
	const expiresAt = authorityDeadline(caller, [{ action: spent.endpoint.action, scope: null, source: 'grant' }], unixNow())
	const created = await services.repositories.membership.createScope(
		{ app: caller.app, scope, createdBy: caller.principal.id, roleKey: role.role_key, expiresAt },
		memberEvent(caller, input.requestId, {
			action: 'iam.scope.create',
			resourceType: 'scope',
			resourceId: scopeId(scope),
			metadata: { role: role.role_key, endpoint: spent.endpoint.endpoint },
		}),
	)
	if (!created) {
		// A reconcile narrowed the creator role after the check above; the write carries the condition itself.
		return invalid(`the creator role '${role.role_key}' is not declared external, and the caller is an external principal`)
	}
	return { ok: true, scope, role: role.role_key }
}

// ── Membership ────────────────────────────────────────────────────────────────

/**
 * Assign a role, or invite an address to it. An address always becomes an invitation, also when a
 * principal already holds it: only the mailbox's owner, proving it with the emailed link, may accept.
 */
export async function assignMember(services: Services, env: CallerEnv, ctx: RequestContext, input: AssignMemberInput): Promise<AssignMemberResult> {
	const resolved = await resolveMemberCaller(services, env, input, true)
	if (!resolved.ok) return resolved
	const { caller } = resolved
	const spent = await spendDelegation(services, caller, input, 'members', input.scope.type)
	if (!spent.ok) return spent
	const problem = membershipScopeProblem(input.scope)
	if (problem !== null) return invalid(problem)
	const manage = await manageAuthority(services, caller, input.scope)
	if (!manage.ok) return manage
	const role = await services.repositories.appSchema.getRole(caller.app, input.role)
	if (role === null) {
		return invalid(`unknown role '${input.role}'`)
	}
	const authority = await roleAuthorityProblem(services, { ...caller, principalId: caller.principal.id }, input.scope, role)
	if (authority !== null) return authority

	if ('principalId' in input.member) {
		if (input.invitation !== undefined) {
			return invalid('a label, a message and a resend go with an invitation by address')
		}
		const target = await services.repositories.principals.getPrincipalById(input.member.principalId)
		if (target === null || target.type !== 'user') {
			return NOT_FOUND
		}
		const external = await externalGrantProblem(services.repositories.appSchema, target, caller.app, { roleKey: role.role_key })
		if (external !== null) return invalid(external)
		// The same rule whoever the target is, the caller itself included: the grant ends with the authority behind it.
		const expiresAt = await delegationDeadline(services, { ...caller, principalId: caller.principal.id }, input.scope, role, manage.manage)
		const granted = await services.repositories.membership.grantMembershipRole(
			{ app: caller.app, principalId: target.id, roleKey: role.role_key, scope: input.scope, grantedBy: caller.principal.id, expiresAt },
			memberEvent(caller, input.requestId, {
				action: 'iam.member.assign',
				resourceType: 'scope',
				resourceId: scopeId(input.scope),
				metadata: { principalId: target.id, role: role.role_key },
			}),
		)
		const eligible = { principalId: target.id, app: caller.app, roleKey: role.role_key }
		if (granted === null && !(await services.repositories.grants.isEligibleGrant(eligible))) {
			// Not held but refused: a reconcile narrowed the role after the check above.
			return invalid(`role '${role.role_key}' is not declared external, and the member is an external principal`)
		}
		return { ok: true, assigned: { principalId: target.id, role: role.role_key } }
	}

	return invite(services, caller, input, role, input.member.email, input.invitation ?? {})
}

/**
 * Open an invitation and mail its link, or answer the open one. Repeating it sends nothing; `resend` gives the open
 * invitation a new link and a new lifetime and sends that, so the earlier link stops working. A role declared external
 * creates its principal at acceptance for a mailbox no principal holds, so IAM refuses one the organization names
 * (`organizationMailbox`) before anything is written: it never becomes an external principal.
 */
async function invite(
	services: Services,
	caller: MemberCaller,
	input: AssignMemberInput,
	role: RoleRow,
	address: string,
	options: InvitationOptions,
): Promise<AssignMemberResult> {
	if (services.email === null) {
		return { ok: false, reason: 'invitations_disabled' }
	}
	const email = invitedAddress(address)
	if (email === null) {
		return invalid('the member email is not an address')
	}
	const wording = invitationOptionsProblem(options)
	if (wording !== null) {
		return invalid(wording)
	}
	if (role.external === 1 && organizationMailbox(email, services.config)) {
		return { ok: false, reason: 'internal_mailbox' }
	}
	const companyLabel = nonEmpty(options.label)
	const message = nonEmpty(options.message)
	const token = randomToken(32)
	const tokenHash = await hashToken(token)
	const expiresAt = unixNow() + INVITATION_TTL_SECONDS
	const event = (action: string, invitationId: string) =>
		memberEvent(caller, input.requestId, {
			action,
			resourceType: 'scope',
			resourceId: scopeId(input.scope),
			metadata: { invitationId, role: role.role_key },
		})
	const opened = await services.repositories.membership.openInvitation({
		tokenHash,
		app: caller.app,
		scope: input.scope,
		roleKey: role.role_key,
		email,
		invitedBy: caller.principal.id,
		expiresAt,
		companyLabel,
		message,
	}, (invitationId) => event('iam.member.invite', invitationId))
	let invitation = opened.invitation
	if (!opened.created) {
		if (options.resend !== true) {
			return invitedResult(invitation)
		}
		const rotated = await services.repositories.membership.rotateInvitation(
			{ id: invitation.id, tokenHash, expiresAt, companyLabel, message },
			event('iam.member.reinvite', invitation.id),
		)
		if (rotated === null) {
			// Accepted or cancelled since it was read: nothing open is left to send again.
			return NOT_FOUND
		}
		invitation = rotated
	}
	const withdrawCreated = async (): Promise<void> => {
		if (!opened.created) return
		await services.repositories.membership.deleteInvitation(
			invitation.id,
			memberEvent(caller, input.requestId, {
				action: 'iam.member.uninvite',
				resourceType: 'scope',
				resourceId: scopeId(input.scope),
				metadata: { invitationId: invitation.id, role: role.role_key, reason: 'delivery_failed' },
			}),
		)
	}
	// A resend is a new message with a new link: the sender must not take it for a retry of the first.
	const idempotencyKey = opened.created ? `iam-invitation-${invitation.id}` : `iam-invitation-${invitation.id}-${uuidv7()}`
	let invitationMessage: EmailMessage
	try {
		invitationMessage = await invitationEmail(services, caller, invitation, role, token, idempotencyKey)
	} catch (err) {
		await withdrawCreated()
		throw err
	}
	try {
		await services.email.send(invitationMessage, AbortSignal.timeout(EMAIL_SEND_DEADLINE_MS))
	} catch (err) {
		logError(`invitation email failed for request '${input.requestId}'`, err)
		// The link may have arrived, so the invitation it names stays open.
		const mayHaveArrived = err instanceof EmailDeliveryError && err.outcome === 'unknown'
		if (!mayHaveArrived) await withdrawCreated()
		// A resent invitation stays open under a link that may not have arrived; resending again sends a new one.
		return { ok: false, reason: 'delivery_failed' }
	}
	return invitedResult(invitation)
}

function invitedResult(invitation: InvitationRow): AssignMemberResult {
	return { ok: true, invited: { invitationId: invitation.id, role: invitation.role_key, expiresAt: invitation.expires_at } }
}

function nonEmpty(value: string | undefined): string | null {
	return value === undefined || value === '' ? null : value
}

/** The invitation's e-mail, with the link to `token`, in its application's language and wording. */
async function invitationEmail(
	services: Services,
	caller: MemberCaller,
	invitation: InvitationRow,
	role: RoleRow,
	token: string,
	idempotencyKey: string,
): Promise<EmailMessage> {
	// An e-mail shows no logo, so the brand is not read.
	const presentation = await presentationFor(services, invitation.app, null)
	// The query names the application for the page's language; the fragment never reaches an access log, and the
	// page copies it into its POST form in the browser.
	const url = new URL(`${INVITATION_ACCEPT_PATH}${appQuery(presentation)}`, services.config.issuer)
	url.hash = new URLSearchParams({ token }).toString()
	return renderEmail(services, {
		to: invitation.email,
		presentation,
		kind: 'invitation',
		values: {
			appName: presentation.displayName ?? invitation.app,
			role: role.name,
			scope: invitation.scope_type,
			recipient: invitation.email,
			inviterLabel: caller.principal.label,
			companyLabel: invitation.company_label ?? '',
			message: invitation.message ?? '',
			actionUrl: url.toString(),
			expiresAt: invitation.expires_at,
		},
		idempotencyKey,
	})
}

/**
 * Remove membership roles, or cancel an invitation. Every role removed must be one the caller could
 * assign, checked before anything is removed. The creator role goes first and only while another
 * principal still holds it, so a value never loses its last creator.
 */
export async function revokeMember(services: Services, env: CallerEnv, ctx: RequestContext, input: RevokeMemberInput): Promise<RevokeMemberResult> {
	const resolved = await resolveMemberCaller(services, env, input, true)
	if (!resolved.ok) return resolved
	const { caller } = resolved
	const spent = await spendDelegation(services, caller, input, 'members', input.scope.type)
	if (!spent.ok) return spent
	const problem = membershipScopeProblem(input.scope)
	if (problem !== null) return invalid(problem)
	const manage = await manageAuthority(services, caller, input.scope)
	if (!manage.ok) return manage
	const actor = { ...caller, principalId: caller.principal.id }

	if ('invitationId' in input.member) {
		const invitation = await services.repositories.membership.getInvitationById(input.member.invitationId)
		if (invitation === null || invitation.app !== caller.app || !sameScope(invitation, input.scope)) {
			return NOT_FOUND
		}
		const role = await services.repositories.appSchema.getRole(caller.app, invitation.role_key)
		const authority = role === null ? null : await roleAuthorityProblem(services, actor, input.scope, role)
		if (authority !== null) return authority
		await services.repositories.membership.revokeInvitation(
			invitation.id,
			memberEvent(caller, input.requestId, {
				action: 'iam.member.uninvite',
				resourceType: 'scope',
				resourceId: scopeId(input.scope),
				metadata: { invitationId: invitation.id, role: invitation.role_key },
			}),
		)
		return { ok: true }
	}

	const target = input.member.principalId
	const only = input.member.role ?? null
	const roles: RoleRow[] = []
	if (only !== null) {
		const role = await services.repositories.appSchema.getRole(caller.app, only)
		if (role === null || role.member_scope !== input.scope.type) {
			return invalid(`role '${only}' is not a membership role of scope '${input.scope.type}'`)
		}
	}
	for (const grant of await services.repositories.membership.listRoleGrantsAt(caller.app, target, input.scope)) {
		if (grant.role_key === null || (only !== null && grant.role_key !== only)) continue
		const role = await services.repositories.appSchema.getRole(caller.app, grant.role_key)
		if (role !== null && role.member_scope === input.scope.type) roles.push(role)
	}
	for (const role of roles) {
		const authority = await roleAuthorityProblem(services, actor, input.scope, role)
		if (authority !== null) return authority
	}

	if (roles.length === 0) {
		return { ok: true }
	}
	const creator = manage.dimension.creator_role
	const removed = await services.repositories.membership.revokeMemberRoles(
		{ app: caller.app, principalId: target, scope: input.scope, roles: roles.map((role) => role.role_key), creatorRole: creator },
		(roleKey) =>
			memberEvent(caller, input.requestId, {
				action: 'iam.member.revoke',
				resourceType: 'scope',
				resourceId: scopeId(input.scope),
				metadata: { principalId: target, role: roleKey },
			}),
	)
	if (creator !== null && roles.some((role) => role.role_key === creator) && !removed.includes(creator)) {
		const stillHeld = (await services.repositories.membership.listRoleGrantsAt(caller.app, target, input.scope))
			.some((grant) => grant.role_key === creator)
		if (stillHeld) return { ok: false, reason: 'last_creator' }
	}
	return { ok: true }
}

function sameScope(invitation: InvitationRow, scope: Scope): boolean {
	return invitation.scope_type === scope.type && invitation.scope_value === scope.value
}

export async function listMembers(services: Services, env: CallerEnv, ctx: RequestContext, input: ListMembersInput): Promise<ListMembersResult> {
	const resolved = await resolveMemberCaller(services, env, input, false)
	if (!resolved.ok) return resolved
	const { caller } = resolved
	const problem = membershipScopeProblem(input.scope)
	if (problem !== null) return invalid(problem)
	const dimension = await services.repositories.appSchema.getScope(caller.app, input.scope.type)
	if (dimension === null || dimension.members_list === null) {
		return invalid(`scope '${input.scope.type}' declares no members`)
	}
	if (!permits(caller.permissions, dimension.members_list, input.scope)) {
		return NOT_ALLOWED
	}
	const manager = dimension.members_manage !== null && permits(caller.permissions, dimension.members_manage, input.scope)
	const members = new Map<string, MemberItem>()
	for (const row of await services.repositories.membership.listMemberGrants(caller.app, input.scope)) {
		const member = members.get(row.principal_id)
		if (member === undefined) {
			members.set(row.principal_id, {
				principalId: row.principal_id,
				label: manager || dimension.members_directory === 'labels' ? row.label : null,
				email: manager ? row.email : null,
				lastSignInAt: manager ? row.signed_in_at : null,
				roles: [row.role_key],
				disabled: row.disabled_at !== null,
				affiliation: row.affiliation,
			})
		} else {
			member.roles.push(row.role_key)
		}
	}
	const invitations = manager
		? (await services.repositories.membership.listOpenInvitations(caller.app, input.scope)).map((row) => ({
			id: row.id,
			email: row.email,
			role: row.role_key,
			expiresAt: row.expires_at,
		}))
		: []
	return { ok: true, members: [...members.values()], invitations }
}

/**
 * One principal among the members of `scope`, for an endpoint on, in or below its dimension. IAM establishes the
 * authority itself, from nothing the application asserts: `action` must be one of the dimension's `lookups` (the
 * actions of the approved endpoints that read this directory, from the reconciled schema), and the caller must hold it
 * on `scope` itself (global included). IAM holds no containment below a value, so a grant on a contained object does
 * not count. The caller learns only whether the principal it named is a member, and its label where the directory
 * shows labels; an unknown id answers the same `null` as a non-member.
 */
/**
 * One page of the application's own people: every principal holding a role of it (`listAppMemberIds`). Needs the
 * application's `members.list` held globally; labels where it declares `directory: 'labels'` or to its `members.manage`
 * held globally, which alone sees addresses and last sign-ins.
 */
export async function listAppMembers(
	services: Services,
	env: CallerEnv,
	_ctx: RequestContext,
	input: ListAppMembersInput,
): Promise<ListAppMembersResult> {
	const resolved = await resolveMemberCaller(services, env, input, false)
	if (!resolved.ok) return resolved
	const { caller } = resolved
	const people = await services.repositories.appSchema.getAppMembers(caller.app)
	if (people === null) {
		return invalid('the application declares no members')
	}
	if (!permits(caller.permissions, people.list)) {
		return NOT_ALLOWED
	}
	const limit = input.limit ?? MAX_APP_MEMBERS_PAGE
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_APP_MEMBERS_PAGE) {
		return invalid(`a page holds 1 to ${MAX_APP_MEMBERS_PAGE} members`)
	}
	if (input.after !== undefined && (input.after === '' || input.after.length > MAX_MEMBERSHIP_SCOPE_PART_LENGTH)) {
		return invalid('after is the next of a previous page')
	}
	const page = await appMemberPage(services, caller.app, people, permits(caller.permissions, people.manage), input.after ?? null, limit)
	return { ok: true, ...page }
}

/**
 * One page of the people of `app`, as a holder of its `members.list` sees them; `manager` adds labels, addresses and last
 * sign-ins. `next` is the page's last id while another principal follows it, null on the last page.
 */
export async function appMemberPage(
	services: Services,
	app: string,
	people: AppMembersRow,
	manager: boolean,
	after: string | null,
	limit: number,
): Promise<{ members: AppMemberItem[]; next: string | null }> {
	const read = await services.repositories.membership.listAppMemberIds(app, after, limit + 1)
	const ids = read.slice(0, limit)
	const members = new Map<string, AppMemberItem>()
	for (const row of await services.repositories.membership.listAppMemberGrants(app, ids)) {
		const scope = row.scope_type === null || row.scope_value === null ? null : { type: row.scope_type, value: row.scope_value }
		const member = members.get(row.principal_id)
		if (member === undefined) {
			members.set(row.principal_id, {
				principalId: row.principal_id,
				label: manager || people.directory === 'labels' ? row.label : null,
				email: manager ? row.email : null,
				lastSignInAt: manager ? row.signed_in_at : null,
				roles: [{ role: row.role_key, scope }],
				disabled: row.disabled_at !== null,
				affiliation: row.affiliation,
			})
		} else {
			member.roles.push({ role: row.role_key, scope })
		}
	}
	for (const member of members.values()) {
		member.roles.sort((a, b) => byCodeUnit(a.role, b.role) || byCodeUnit(scopeKey(a.scope), scopeKey(b.scope)))
	}
	const listed = ids.flatMap((id) => {
		const member = members.get(id)
		return member === undefined ? [] : [member]
	})
	return { members: listed, next: read.length > limit ? (ids.at(-1) ?? null) : null }
}

/** A global grant first, then values by type and value. */
function scopeKey(scope: Scope | null): string {
	return scope === null ? '' : `${scope.type}\u0000${scope.value}`
}

function byCodeUnit(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

export async function findMember(services: Services, env: CallerEnv, ctx: RequestContext, input: FindMemberInput): Promise<FindMemberResult> {
	const resolved = await resolveMemberCaller(services, env, input, false)
	if (!resolved.ok) return resolved
	const { caller } = resolved
	const problem = membershipScopeProblem(input.scope)
	if (problem !== null) return invalid(problem)
	const dimension = await services.repositories.appSchema.getScope(caller.app, input.scope.type)
	if (dimension === null || dimension.members_list === null) {
		return invalid(`scope '${input.scope.type}' declares no members`)
	}
	const lookups = dimension.members_lookup === null ? [] : parseStoredPermissions(dimension.members_lookup)
	if (!lookups.includes(input.action) || !permits(caller.permissions, input.action, input.scope)) {
		return NOT_ALLOWED
	}
	if (input.principalId === '' || input.principalId.length > MAX_MEMBERSHIP_SCOPE_PART_LENGTH) {
		return { ok: true, member: null }
	}
	const [grant] = await services.repositories.membership.listMemberGrantsOf(caller.app, input.scope, input.principalId)
	if (grant === undefined) {
		return { ok: true, member: null }
	}
	const manager = dimension.members_manage !== null && permits(caller.permissions, dimension.members_manage, input.scope)
	return {
		ok: true,
		member: {
			principalId: grant.principal_id,
			label: manager || dimension.members_directory === 'labels' ? grant.label : null,
			disabled: grant.disabled_at !== null,
			affiliation: grant.affiliation,
		},
	}
}

// ── Invitation acceptance (IAM's own page) ────────────────────────────────────

export type AcceptInvitationOutcome =
	| { ok: true; invitation: InvitationRow }
	/** Unknown, used, cancelled or expired: one answer, so a page reveals nothing about a token. */
	| { ok: false; reason: 'invalid' }
	/** The signed-in principal does not own the invited mailbox. */
	| { ok: false; reason: 'wrong_principal' }
	/** The inviter could no longer give the role. */
	| { ok: false; reason: 'not_allowed' }
	/** The signed-in principal is external and the role is not declared external (ADR-0051). */
	| { ok: false; reason: 'not_eligible' }

/**
 * Accept an invitation for a signed-in principal. The emailed one-time token proves control of the
 * mailbox, and the principal must own that mailbox. The inviter's authority is checked again here,
 * against its permissions now, and its assigning role once more inside the write that consumes the
 * invitation, so an invitation outlives no revocation of the person who sent it.
 */
export async function acceptInvitation(
	services: Services,
	principal: PrincipalRow,
	token: string,
	requestId: string,
): Promise<AcceptInvitationOutcome> {
	const invitation = await openInvitationOf(services, token)
	if (invitation === null) {
		return { ok: false, reason: 'invalid' }
	}
	if (principal.type !== 'user' || principal.email === null || principal.email !== invitation.email) {
		return { ok: false, reason: 'wrong_principal' }
	}
	if ((await externalGrantProblem(services.repositories.appSchema, principal, invitation.app, { roleKey: invitation.role_key })) !== null) {
		return { ok: false, reason: 'not_eligible' }
	}
	const inviter = await inviterAssigners(services, invitation)
	if (inviter === null) {
		return { ok: false, reason: 'not_allowed' }
	}
	const accepted = await services.repositories.membership.acceptInvitation(
		invitation,
		principal.id,
		inviter,
		acceptanceEvent(invitation, principal.id, requestId),
	)
	if (accepted === 'not_eligible') {
		return { ok: false, reason: 'not_eligible' }
	}
	if (accepted !== 'accepted') {
		return { ok: false, reason: accepted === 'not_allowed' ? 'not_allowed' : 'invalid' }
	}
	return { ok: true, invitation }
}

/** The open invitation of a link's one-time token, or null for an unknown, used, cancelled, rotated or expired one. */
async function openInvitationOf(services: Services, token: string): Promise<InvitationRow | null> {
	const invitation = await services.repositories.membership.getInvitationByHash(await hashToken(token))
	if (invitation === null || invitation.accepted_at !== null || invitation.revoked_at !== null || invitation.expires_at <= unixNow()) {
		return null
	}
	return invitation
}

/**
 * The authority that lets the inviter give the invitation's role there against its permissions now: the roles that make
 * it an assigner, the schema revision read before anything else and the inviter's grant revision read before its
 * permissions, so the acceptance's write requires the declarations and the grants this check read (`InviterCheck`).
 * Null when it could not give the role.
 */
async function inviterAssigners(services: Services, invitation: InvitationRow): Promise<InviterCheck | null> {
	const revision = await services.repositories.appSchema.getSchemaRevision(invitation.app)
	const inviter = await services.repositories.principals.getPrincipalById(invitation.invited_by)
	const role = await services.repositories.appSchema.getRole(invitation.app, invitation.role_key)
	if (inviter === null || principalStatus(inviter) === 'disabled' || role === null) {
		return null
	}
	const scope: Scope = { type: invitation.scope_type, value: invitation.scope_value }
	const live = await resolveAuthorityAt(services, inviter, invitation.app)
	const actor = { app: invitation.app, principalId: inviter.id, permissions: live.permissions, supports: live.supports }
	const manage = await manageAuthority(services, actor, scope)
	if (!manage.ok || (await roleAuthorityProblem(services, actor, scope, role)) !== null) {
		return null
	}
	return {
		assigners: role.assignable_by === null ? [] : parseJsonStringArray(role.assignable_by),
		revision,
		grantRevision: inviter.grant_revision,
		expiresAt: await delegationDeadline(services, actor, scope, role, manage.manage),
	}
}

/** The record of an acceptance, by the principal that accepted. A user's audit label is its id. */
function acceptanceEvent(invitation: InvitationRow, principalId: string, requestId: string): AuditEventInput {
	return {
		requestId,
		principalId,
		principalLabel: principalId,
		app: invitation.app,
		action: 'iam.member.accept',
		resourceType: 'scope',
		resourceId: scopeId({ type: invitation.scope_type, value: invitation.scope_value }),
		metadata: { invitationId: invitation.id, role: invitation.role_key },
	}
}

/**
 * What an invitation link offers the browser that submits it. `create`: the role is declared external, the
 * installation enables password authentication and e-mail, no principal holds the invited mailbox, the organization
 * does not name it (`organizationMailbox`), and the inviter could still give the role — so accepting creates the
 * external principal with a password the person chooses (ADR-0020). `sign_in`: every other open invitation, accepted
 * by the mailbox's principal signed in here. Reading the offer changes nothing.
 */
export type InvitationOffer =
	| { readonly kind: 'invalid' }
	| { readonly kind: 'not_allowed' }
	| { readonly kind: 'sign_in' }
	| { readonly kind: 'create'; readonly invitation: InvitationRow }

export async function invitationOffer(services: Services, token: string): Promise<InvitationOffer> {
	const invitation = await openInvitationOf(services, token)
	if (invitation === null) {
		return { kind: 'invalid' }
	}
	if (!(await createsPrincipal(services, invitation))) {
		return { kind: 'sign_in' }
	}
	return (await inviterAssigners(services, invitation)) === null ? { kind: 'not_allowed' } : { kind: 'create', invitation }
}

async function createsPrincipal(services: Services, invitation: InvitationRow): Promise<boolean> {
	if (!services.config.authentication.password.enabled || services.email === null || organizationMailbox(invitation.email, services.config)) {
		return false
	}
	const role = await services.repositories.appSchema.getRole(invitation.app, invitation.role_key)
	return role?.external === 1 && (await services.repositories.principals.getUserByEmail(invitation.email)) === null
}

export type AcceptCreatingOutcome =
	| { ok: true; invitation: InvitationRow; principal: PrincipalRow }
	| { ok: false; reason: 'invalid' | 'not_allowed' | 'not_eligible' }
	/**
	 * The invitation creates no principal now: another acceptance or sign-in gave the mailbox one first, or the
	 * installation or the organization's addresses changed. Whoever holds the mailbox signs in and accepts.
	 */
	| { ok: false; reason: 'sign_in' }

/**
 * Accept an `InvitationOffer` of kind `create` with the password the person chose (already checked by the password
 * policy and hashed): the external principal, its password, the grant, the consumed invitation and their records in
 * one transaction (`MembershipRepository.acceptAsNewPrincipal`). Everything the offer checked is checked again.
 */
export async function acceptCreatingPrincipal(
	services: Services,
	invitation: InvitationRow,
	password: StoredPasswordHash,
	requestId: string,
): Promise<AcceptCreatingOutcome> {
	if (!(await createsPrincipal(services, invitation))) {
		return { ok: false, reason: 'sign_in' }
	}
	const inviter = await inviterAssigners(services, invitation)
	if (inviter === null) {
		return { ok: false, reason: 'not_allowed' }
	}
	const accepted = await services.repositories.membership.acceptAsNewPrincipal({ invitation, inviter, password }, (principalId) => ({
		principal: {
			requestId,
			principalId,
			principalLabel: principalId,
			app: 'propustka',
			action: 'iam.principal.create',
			resourceType: 'principal',
			resourceId: principalId,
			metadata: { affiliation: 'external', invitationId: invitation.id },
		},
		acceptance: acceptanceEvent(invitation, principalId, requestId),
		password: {
			requestId,
			principalId,
			principalLabel: principalId,
			app: 'propustka',
			action: 'iam.password.enrollment.complete',
			resourceType: 'principal',
			resourceId: principalId,
			metadata: { invitationId: invitation.id },
		},
	}))
	switch (accepted.outcome) {
		case 'accepted':
			return { ok: true, invitation, principal: accepted.principal }
		case 'account_exists':
			return { ok: false, reason: 'sign_in' }
		case 'not_eligible':
			return { ok: false, reason: 'not_eligible' }
		case 'not_allowed':
			return { ok: false, reason: 'not_allowed' }
		case 'not_open':
			return { ok: false, reason: 'invalid' }
	}
}

// ── Share links ───────────────────────────────────────────────────────────────

/** Why `chain` is not a containment chain of `dimension` in the app's schema, or null. */
async function chainProblem(services: Services, app: string, dimension: string, chain: Scope[]): Promise<string | null> {
	if (chain.length === 0 || chain.length > MAX_LINK_CHAIN_LENGTH) {
		return `a link chain names 1 to ${MAX_LINK_CHAIN_LENGTH} values`
	}
	let expected: string | null = dimension
	for (const scope of chain) {
		const problem = membershipScopeProblem(scope)
		if (problem !== null) return problem
		if (scope.type !== expected) {
			return `the link chain names '${scope.type}' where the schema contains '${expected ?? 'nothing'}'`
		}
		const row = await services.repositories.appSchema.getScope(app, scope.type)
		if (row === null) return `unknown scope '${scope.type}'`
		expected = row.parent_scope
	}
	return expected === null ? null : `the link chain stops before '${expected}'`
}

/**
 * Issue a share link: an anonymous `px_` key bound to the app, the mount and the whole chain, with the
 * mount's grants frozen on the object. The caller holds the mount's `issuedBy` and every grant on some
 * link of the chain — the delegation rule of every key IAM issues. A job issues only for the mount its
 * declaration names, and holds those actions app-wide: it issues for any object of the mount's dimension.
 */
export async function issueLink(services: Services, env: CallerEnv, ctx: RequestContext, input: IssueLinkInput): Promise<IssueLinkResult> {
	const resolved = await resolveLinkOperationCaller(services, env, input)
	if (!resolved.ok) return resolved
	const { caller, job } = resolved
	if (job !== null && job.issues !== input.mount) {
		return NOT_ALLOWED
	}
	const mount = await services.repositories.appSchema.getLinkMount(caller.app, input.mount)
	if (mount === null) {
		return invalid(`unknown link mount '${input.mount}'`)
	}
	const problem = await chainProblem(services, caller.app, mount.dimension, input.chain)
	if (problem !== null) return invalid(problem)
	if (!Number.isSafeInteger(input.days) || input.days < 1 || input.days > mount.max_days) {
		return invalid(`a link of '${mount.mount}' lives 1 to ${mount.max_days} days`)
	}
	const grants = parseStoredPermissions(mount.grants)
	const heldOnChain = (action: string): boolean => input.chain.some((scope) => permits(caller.permissions, action, scope))
	if (!heldOnChain(mount.issued_by) || !grants.every(heldOnChain)) {
		return NOT_ALLOWED
	}
	const [object] = input.chain
	if (object === undefined) return invalid('a link chain names its object first')
	// S8: the link ends no later than the issuer's grants behind it, so a lapse cannot revive with a later grant.
	const backing = await issuerAuthority(
		services,
		caller.principal.id,
		caller.app,
		mount.mount,
		[mount.issued_by, ...grants].map((action) => ({ action, on: input.chain })),
	)
	if (!backing.ok) return NOT_ALLOWED
	const requested = unixNow() + input.days * DAY_SECONDS
	const expiresAt = backing.expiresAt === null ? requested : Math.min(requested, backing.expiresAt)
	if (expiresAt <= unixNow()) return NOT_ALLOWED
	const key = `${API_KEY_PREFIX}${generateToken()}`
	const id = await services.repositories.credentials.createLinkCredential({
		tokenHash: await hashToken(key),
		label: `link:${mount.mount}`,
		app: caller.app,
		issuedBy: caller.principal.id,
		expiresAt,
		grants: grants.map((action) => ({ action, scopeType: object.type, scopeValue: object.value })),
		link: { mount: mount.mount, chain: input.chain.map((scope) => ({ type: scope.type, value: scope.value })) },
		checked: {
			grants,
			issuedBy: mount.issued_by,
			maxDays: mount.max_days,
			...(job === null ? {} : { job: { name: job.name, actions: job.actions } }),
		},
	}, (credentialId) =>
		memberEvent(caller, input.requestId, {
			action: 'iam.link.issue',
			resourceType: 'credential',
			resourceId: credentialId,
			metadata: { mount: mount.mount, chain: input.chain, days: input.days },
		}))
	if (id === null) {
		// A reconcile changed what was checked above (the mount, the containment or the job) before the write.
		return NOT_ALLOWED
	}
	return { ok: true, key, id, expiresAt }
}

/**
 * Revoke a link: by its issuer, or by a holder of `members.manage` on a value of its chain. A job revokes only a link
 * it issued, of the mount its declaration still names.
 */
export async function revokeLink(services: Services, env: CallerEnv, ctx: RequestContext, input: RevokeLinkInput): Promise<RevokeLinkResult> {
	const resolved = await resolveLinkOperationCaller(services, env, input)
	if (!resolved.ok) return resolved
	const { caller, job } = resolved
	const credential = await services.repositories.credentials.getCredentialById(input.id)
	if (credential === null || credential.app !== caller.app || credential.link_mount === null || credential.link_chain === null) {
		return NOT_FOUND
	}
	if (job !== null) {
		if (credential.issued_by !== caller.principal.id || credential.link_mount !== job.issues) return NOT_ALLOWED
	} else if (credential.issued_by !== caller.principal.id) {
		let manager = false
		for (const scope of parseStoredChain(credential.link_chain) ?? []) {
			const dimension = await services.repositories.appSchema.getScope(caller.app, scope.type)
			if (dimension?.members_manage != null && permits(caller.permissions, dimension.members_manage, scope)) {
				manager = true
				break
			}
		}
		if (!manager) return NOT_ALLOWED
	}
	await services.repositories.credentials.revokeCredential(
		credential.id,
		memberEvent(caller, input.requestId, {
			action: 'iam.link.revoke',
			resourceType: 'credential',
			resourceId: credential.id,
			metadata: { mount: credential.link_mount },
		}),
	)
	return { ok: true }
}
