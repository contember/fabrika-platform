/**
 * The membership operations of a multi-tenant application (the framework document, section 6; ADR-0022
 * rule 6): delegation grants, scope creation, membership, invitations and share links.
 *
 * Every operation resolves the caller from its own credential and evaluates it against the caller's LIVE
 * permissions at the credential's verified app. The application names no actor and writes no grant: IAM
 * generates every value, writes every grant and issues every key. Scopes stay flat — a value is checked as
 * itself; only a share link names its containment chain, and the framework re-checks that chain per request.
 */

import {
	API_KEY_PREFIX,
	type AssignMemberInput,
	type AssignMemberResult,
	type CreateScopeInput,
	type CreateScopeResult,
	DELEGATION_GRANT_TTL_SECONDS,
	type IssueLinkInput,
	type IssueLinkResult,
	type ListMembersInput,
	type ListMembersResult,
	matchAction,
	type MemberItem,
	type MembershipCaller,
	type MembershipFailure,
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
import { uuidv7 } from '@fabrika/platform'
import { resolveCaller } from './auth'
import { contractGrantProblem } from './contract-rules'
import { type AppScopeRow, type DelegatedEndpointRow, type InvitationRow, type PrincipalRow, principalStatus, type RoleRow } from './db'
import { normalizeEmailIdentity } from './email-identity'
import type { Env, RequestContext } from './env'
import { invitationEmail } from './invitation-email'
import { logError } from './log'
import { randomToken } from './oidc'
import { unixNow } from './repositories/sql'
import { resolvePermissionsAt } from './resolve'
import { BUILTIN_ROLES } from './roles'
import { generateToken, hashToken } from './secret'
import type { Services } from './services'
import { parseStoredChain } from './stored-chain'
import { parseStoredPermissions } from './stored-permissions'

/** How long an invitation may wait for its addressee. */
export const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60

/** The path of IAM's page that accepts an invitation; the one-time token rides in the fragment. */
export const INVITATION_ACCEPT_PATH = '/auth/invitations/accept'

/** The longest containment chain a link may name, and the longest scope coordinate part. */
const MAX_CHAIN_LENGTH = 8
const MAX_SCOPE_PART_LENGTH = 200
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
	const resolution = await resolveCaller(services, env, input)
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
	if (input.credential?.startsWith(API_KEY_PREFIX) === true) {
		return { ok: true, caller: { principal, permissions: caller.permissions, app: verifiedApp } }
	}
	// A token is a ceiling too: one minted from a downscoped key carries only that key's grants.
	const live = await resolvePermissionsAt(services, principal, verifiedApp)
	const permissions = caller.permissions.filter((entry) => permits(live, entry.action, entry.scope ?? undefined))
	return { ok: true, caller: { principal, permissions, app: verifiedApp } }
}

function scopeProblem(scope: Scope): string | null {
	for (const part of [scope.type, scope.value]) {
		if (part === '' || part.length > MAX_SCOPE_PART_LENGTH) {
			return `a scope type and value are 1 to ${MAX_SCOPE_PART_LENGTH} characters`
		}
	}
	return null
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
): Promise<{ ok: true; dimension: AppScopeRow } | MembershipFailure> {
	const dimension = await services.repositories.appSchema.getScope(actor.app, scope.type)
	if (dimension === null || dimension.members_manage === null) {
		return invalid(`scope '${scope.type}' declares no members`)
	}
	if (!permits(actor.permissions, dimension.members_manage, scope)) {
		return NOT_ALLOWED
	}
	return { ok: true, dimension }
}

/**
 * Could `actor` give `role` in `scope`? The role is a membership role of the scope's dimension, the actor
 * holds there a role that `assignableBy` names, and the role grants nothing the actor lacks there. The
 * same question decides an assignment, a revocation and, again at acceptance, an invitation.
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
	const held = (await services.repositories.membership.listRoleGrantsAt(actor.app, actor.principalId, scope)).map((grant) => grant.role_key)
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

/** Record a decided change. Kept alive past the answer, and a failed write is logged, never surfaced. */
function audit(
	services: Services,
	ctx: RequestContext,
	caller: MemberCaller,
	requestId: string,
	event: { action: string; resourceType: string; resourceId: string; metadata?: unknown },
): void {
	ctx.waitUntil(
		services.repositories.audit
			.writeAuditEvent({ requestId, principalId: caller.principal.id, principalLabel: caller.principal.label, app: caller.app, ...event })
			.catch((err: unknown) => logError('membership audit write failed', err)),
	)
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
	const scope: Scope = { type: input.dimension, value: uuidv7() }
	await services.repositories.membership.createScope({ app: caller.app, scope, createdBy: caller.principal.id, roleKey: role.role_key })
	audit(services, ctx, caller, input.requestId, {
		action: 'iam.scope.create',
		resourceType: 'scope',
		resourceId: scopeId(scope),
		metadata: { role: role.role_key, endpoint: spent.endpoint.endpoint },
	})
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
	const problem = scopeProblem(input.scope)
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
		const target = await services.repositories.principals.getPrincipalById(input.member.principalId)
		if (target === null || target.type !== 'user') {
			return NOT_FOUND
		}
		const created = await services.repositories.membership.grantMembershipRole({
			app: caller.app,
			principalId: target.id,
			roleKey: role.role_key,
			scope: input.scope,
			grantedBy: caller.principal.id,
		})
		if (created !== null) {
			audit(services, ctx, caller, input.requestId, {
				action: 'iam.member.assign',
				resourceType: 'scope',
				resourceId: scopeId(input.scope),
				metadata: { principalId: target.id, role: role.role_key },
			})
		}
		return { ok: true, assigned: { principalId: target.id, role: role.role_key } }
	}

	return invite(services, ctx, caller, input, role, input.member.email)
}

async function invite(
	services: Services,
	ctx: RequestContext,
	caller: MemberCaller,
	input: AssignMemberInput,
	role: RoleRow,
	address: string,
): Promise<AssignMemberResult> {
	if (services.email === null) {
		return { ok: false, reason: 'invitations_disabled' }
	}
	const email = normalizeEmailIdentity(address)
	if (email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) {
		return invalid('the member email is not an address')
	}
	const token = randomToken(32)
	const { invitation, created } = await services.repositories.membership.openInvitation({
		tokenHash: await hashToken(token),
		app: caller.app,
		scope: input.scope,
		roleKey: role.role_key,
		email,
		invitedBy: caller.principal.id,
		expiresAt: unixNow() + INVITATION_TTL_SECONDS,
	})
	if (created) {
		const url = new URL(INVITATION_ACCEPT_PATH, services.config.issuer)
		// A fragment never reaches an access log; the page copies it into its POST form in the browser.
		url.hash = new URLSearchParams({ token }).toString()
		try {
			await services.email.send(invitationEmail({
				to: email,
				app: caller.app,
				role: role.role_key,
				dimension: input.scope.type,
				acceptUrl: url.toString(),
				idempotencyKey: `iam-invitation-${invitation.id}`,
			}))
		} catch (err) {
			logError(`invitation email failed for request '${input.requestId}'`, err)
			await services.repositories.membership.deleteInvitation(invitation.id)
			return { ok: false, reason: 'delivery_failed' }
		}
		audit(services, ctx, caller, input.requestId, {
			action: 'iam.member.invite',
			resourceType: 'scope',
			resourceId: scopeId(input.scope),
			metadata: { invitationId: invitation.id, role: role.role_key },
		})
	}
	return { ok: true, invited: { invitationId: invitation.id, role: invitation.role_key, expiresAt: invitation.expires_at } }
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
	const problem = scopeProblem(input.scope)
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
		if (await services.repositories.membership.revokeInvitation(invitation.id)) {
			audit(services, ctx, caller, input.requestId, {
				action: 'iam.member.uninvite',
				resourceType: 'scope',
				resourceId: scopeId(input.scope),
				metadata: { invitationId: invitation.id, role: invitation.role_key },
			})
		}
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

	const creator = manage.dimension.creator_role
	const ordered = [...roles].sort((a, b) => Number(b.role_key === creator) - Number(a.role_key === creator))
	const removed: string[] = []
	for (const role of ordered) {
		if (role.role_key === creator) {
			if (!(await services.repositories.membership.deleteCreatorGrantUnlessLast(caller.app, target, role.role_key, input.scope))) {
				const stillHeld = (await services.repositories.membership.listRoleGrantsAt(caller.app, target, input.scope))
					.some((grant) => grant.role_key === role.role_key)
				if (stillHeld) return { ok: false, reason: 'last_creator' }
				continue
			}
			removed.push(role.role_key)
		} else if (await services.repositories.membership.deleteRoleGrant(caller.app, target, role.role_key, input.scope)) {
			removed.push(role.role_key)
		}
	}
	if (removed.length > 0) {
		audit(services, ctx, caller, input.requestId, {
			action: 'iam.member.revoke',
			resourceType: 'scope',
			resourceId: scopeId(input.scope),
			metadata: { principalId: target, roles: removed },
		})
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
	const problem = scopeProblem(input.scope)
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
				label: manager ? row.label : null,
				email: manager ? row.email : null,
				roles: [row.role_key],
				disabled: row.disabled_at !== null,
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

// ── Invitation acceptance (IAM's own page) ────────────────────────────────────

export type AcceptInvitationOutcome =
	| { ok: true; invitation: InvitationRow }
	/** Unknown, used, cancelled or expired: one answer, so a page reveals nothing about a token. */
	| { ok: false; reason: 'invalid' }
	/** The signed-in principal does not own the invited mailbox. */
	| { ok: false; reason: 'wrong_principal' }
	/** The inviter could no longer give the role. */
	| { ok: false; reason: 'not_allowed' }

/**
 * Accept an invitation for a signed-in principal. The emailed one-time token proves control of the
 * mailbox, and the principal must own that mailbox. The inviter's authority is checked again here,
 * against its permissions now, so an invitation outlives no revocation of the person who sent it.
 */
export async function acceptInvitation(services: Services, principal: PrincipalRow, token: string): Promise<AcceptInvitationOutcome> {
	const invitation = await services.repositories.membership.getInvitationByHash(await hashToken(token))
	const now = unixNow()
	if (invitation === null || invitation.accepted_at !== null || invitation.revoked_at !== null || invitation.expires_at <= now) {
		return { ok: false, reason: 'invalid' }
	}
	if (principal.type !== 'user' || principal.email === null || principal.email !== invitation.email) {
		return { ok: false, reason: 'wrong_principal' }
	}
	const inviter = await services.repositories.principals.getPrincipalById(invitation.invited_by)
	const role = await services.repositories.appSchema.getRole(invitation.app, invitation.role_key)
	if (inviter === null || principalStatus(inviter) === 'disabled' || role === null) {
		return { ok: false, reason: 'not_allowed' }
	}
	const scope: Scope = { type: invitation.scope_type, value: invitation.scope_value }
	const actor = { app: invitation.app, principalId: inviter.id, permissions: await resolvePermissionsAt(services, inviter, invitation.app) }
	const manage = await manageAuthority(services, actor, scope)
	if (!manage.ok || (await roleAuthorityProblem(services, actor, scope, role)) !== null) {
		return { ok: false, reason: 'not_allowed' }
	}
	if (!(await services.repositories.membership.acceptInvitation(invitation, principal.id))) {
		return { ok: false, reason: 'invalid' }
	}
	return { ok: true, invitation }
}

// ── Share links ───────────────────────────────────────────────────────────────

/** Why `chain` is not a containment chain of `dimension` in the app's schema, or null. */
async function chainProblem(services: Services, app: string, dimension: string, chain: Scope[]): Promise<string | null> {
	if (chain.length === 0 || chain.length > MAX_CHAIN_LENGTH) {
		return `a link chain names 1 to ${MAX_CHAIN_LENGTH} values`
	}
	let expected: string | null = dimension
	for (const scope of chain) {
		const problem = scopeProblem(scope)
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
 * link of the chain — the delegation rule of every key IAM issues.
 */
export async function issueLink(services: Services, env: CallerEnv, ctx: RequestContext, input: IssueLinkInput): Promise<IssueLinkResult> {
	const resolved = await resolveMemberCaller(services, env, input, false)
	if (!resolved.ok) return resolved
	const { caller } = resolved
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
	const key = `${API_KEY_PREFIX}${generateToken()}`
	const expiresAt = unixNow() + input.days * DAY_SECONDS
	const id = await services.repositories.credentials.createLinkCredential({
		tokenHash: await hashToken(key),
		label: `link:${mount.mount}`,
		app: caller.app,
		issuedBy: caller.principal.id,
		expiresAt,
		grants: grants.map((action) => ({ action, scopeType: object.type, scopeValue: object.value })),
		link: { mount: mount.mount, chain: input.chain.map((scope) => ({ type: scope.type, value: scope.value })) },
	})
	if (id === null) {
		// A reconcile removed the mount between the checks above and the write.
		return invalid(`unknown link mount '${input.mount}'`)
	}
	audit(services, ctx, caller, input.requestId, {
		action: 'iam.link.issue',
		resourceType: 'credential',
		resourceId: id,
		metadata: { mount: mount.mount, chain: input.chain, days: input.days },
	})
	return { ok: true, key, id, expiresAt }
}

/** Revoke a link: by its issuer, or by a holder of `members.manage` on a value of its chain. */
export async function revokeLink(services: Services, env: CallerEnv, ctx: RequestContext, input: RevokeLinkInput): Promise<RevokeLinkResult> {
	const resolved = await resolveMemberCaller(services, env, input, false)
	if (!resolved.ok) return resolved
	const { caller } = resolved
	const credential = await services.repositories.credentials.getCredentialById(input.id)
	if (credential === null || credential.app !== caller.app || credential.link_mount === null || credential.link_chain === null) {
		return NOT_FOUND
	}
	if (credential.issued_by !== caller.principal.id) {
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
	if (await services.repositories.credentials.revokeCredential(credential.id)) {
		audit(services, ctx, caller, input.requestId, {
			action: 'iam.link.revoke',
			resourceType: 'credential',
			resourceId: credential.id,
			metadata: { mount: credential.link_mount },
		})
	}
	return { ok: true }
}
