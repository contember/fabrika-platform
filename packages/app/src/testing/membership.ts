// The test kit's stand-in for IAM's membership transport, which every kit boots with unless a test passes its own. It
// answers a member directory (`ctx.members.list()` and `get()`) from the kit's callers, as IAM answers it from its
// grants, and the writes under IAM's rules for the caller's grants: the delegation grant, `members.manage`,
// `assignableBy`, the role's actions, a link mount's `issuedBy`, the last creator and IAM's input bounds; and its answers
// to an invitation: the open one again, a resend's new lifetime, an organization's mailbox refused for an external role.
// It records each write it allowed. A role it assigns or revokes is live, as in IAM: the directory, the stand-in's own
// checks and the kit's next token of that principal read it.

import {
	API_KEY_PREFIX,
	type AssignMemberInput,
	type AssignMemberResult,
	type ContractArtifact,
	type CreateScopeInput,
	type CreateScopeResult,
	DELEGATION_GRANT_TTL_SECONDS,
	directoryLookups,
	type EndpointDelegation,
	endpointDelegation,
	type FindMemberInput,
	type FindMemberResult,
	type IamMembershipRpc,
	invitationOptionsProblem,
	invitedAddress,
	type IssueLinkInput,
	type IssueLinkResult,
	type ListMembersInput,
	type ListMembersResult,
	matchAction,
	MAX_LINK_CHAIN_LENGTH,
	MAX_MEMBERSHIP_SCOPE_PART_LENGTH,
	type MemberItem,
	type MembershipCaller,
	type MembershipFailure,
	membershipScopeProblem,
	type MemberTarget,
	normalizeEmailIdentity,
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
import type { LabelledTestCaller, TestCaller, TestScope } from './caller'

/** A role a test caller holds in one scope value, or globally (`null`). */
export interface TestMembership {
	readonly role: string
	readonly scope: TestScope | null
}

export interface DirectoryCallers {
	/**
	 * The caller a membership request's credential (its token or `px_` key) belongs to, as IAM verifies it for `app`:
	 * none for a credential of another application or an expired token.
	 */
	byCredential(app: string, credential: string): TestCaller | undefined
	/** Every caller with its role grants. */
	all(): readonly { readonly caller: TestCaller; readonly memberships: readonly TestMembership[] }[]
}

/** A write `kitMembership` allowed, by the principal that asked; the credential and the delegation grant are left out. */
export type AskedWrite =
	| { readonly operation: 'createScope'; readonly principalId: string; readonly scope: Scope; readonly role: string }
	| {
		readonly operation: 'assignMember'
		readonly principalId: string
		readonly scope: Scope
		readonly role: string
		readonly member: MemberTarget
		/** The invitation it answered for an address; `null` for an existing principal. */
		readonly invitationId: string | null
	}
	| { readonly operation: 'revokeMember'; readonly principalId: string; readonly scope: Scope; readonly member: RevokeMemberInput['member'] }
	| { readonly operation: 'issueLink'; readonly principalId: string; readonly id: string; readonly mount: string; readonly chain: readonly Scope[] }
	| { readonly operation: 'revokeLink'; readonly principalId: string; readonly id: string }

/** An invitation its addressee accepted: the role it gave, in its scope, to the invited address. */
export interface AcceptedInvitation {
	readonly scope: Scope
	readonly role: string
	readonly email: string
}

export interface KitMembership {
	readonly rpc: IamMembershipRpc
	/** Every write it allowed, in order. */
	readonly asked: readonly AskedWrite[]
	/** The permissions IAM signs for `caller` now: the test's grants, with the roles this stand-in assigned or revoked. */
	permsOf(caller: TestCaller): readonly PermissionEntry[]
	/**
	 * Closes the open invitation `invitationId` as accepted, as IAM's onboarding does, and answers what it gives. With
	 * `recipient`, that person holds the role from now on; without one the kit makes the new person who holds it. As IAM,
	 * it refuses an external recipient of a role not declared external (`not_eligible`) and an invitation whose inviter
	 * could no longer give the role (`not_allowed`), and then leaves the invitation open.
	 */
	accept(invitationId: string, recipient?: TestCaller): AcceptedInvitation
	/** An open invitation of `role` in `scope` to `email`, as an earlier request opened it; answers its id. */
	seedInvitation(scope: Scope, role: string, email: string): string
	/** A share link of `mount` bound to `chain`, as `issuer` issued it in an earlier request; answers its id. */
	seedLink(issuer: string, mount: string, chain: readonly Scope[]): string
}

/**
 * The addresses the organization names, as IAM's configuration does (its human e-mails, its e-mail domains): IAM never
 * invites one to an external role (`internal_mailbox`).
 */
export interface OrganizationMailboxes {
	readonly emails: readonly string[]
	readonly domains: readonly string[]
}

const NO_ORGANIZATION: OrganizationMailboxes = { emails: [], domains: [] }

/** An invitation the stand-in opened, open until it is cancelled, accepted or its lifetime ends. */
interface KitInvitation {
	readonly id: string
	readonly scope: Scope
	readonly role: string
	readonly email: string
	readonly expiresAt: number
	readonly closed: 'cancelled' | 'accepted' | null
	/** The principal that opened it, whose authority IAM checks again at acceptance; `null` for a seeded one. */
	readonly inviter: string | null
}

/** A share link the stand-in issued; a revoked one is still found, so a repeated revoke answers the same. */
interface KitLink {
	readonly id: string
	readonly issuer: string
	readonly mount: string
	readonly chain: readonly Scope[]
}

/** A token the kit's IAM signed, for the caller it was minted for, until its `exp`. */
export interface MintedToken {
	readonly caller: TestCaller
	readonly expiresAt: number
}

/**
 * The kit's callers as IAM resolves a membership request's credential for `app`: a `px_` key the kit issued, or a token
 * it signed that has not expired; nothing for another application.
 */
export function credentialCallers(
	app: string,
	keys: ReadonlyMap<string, TestCaller>,
	tokens: ReadonlyMap<string, MintedToken>,
	memberships: () => ReturnType<DirectoryCallers['all']>,
): DirectoryCallers {
	return {
		byCredential(audience, credential) {
			if (audience !== app) return undefined
			const minted = tokens.get(credential)
			if (minted === undefined) return keys.get(credential)
			return minted.expiresAt > now() ? minted.caller : undefined
		},
		all: memberships,
	}
}

const NOT_ALLOWED: MembershipFailure = { ok: false, reason: 'not_allowed' }
const NOT_FOUND: MembershipFailure = { ok: false, reason: 'not_found' }
const INVALID_DELEGATION: MembershipFailure = { ok: false, reason: 'invalid_delegation' }
const DAY_SECONDS = 24 * 60 * 60
const INVITATION_TTL_SECONDS = 7 * DAY_SECONDS

function invalid(message: string): MembershipFailure {
	return { ok: false, reason: 'invalid_request', message }
}

const randomId = (): string => crypto.randomUUID().replaceAll('-', '')
const now = (): number => Math.floor(Date.now() / 1000)

/**
 * The caller of a membership operation, as IAM resolves it: another application's connector calls none, a link holder
 * is never a member caller, and `userOnly` refuses a script, which creates no scope and manages no member.
 */
function memberCaller(callers: DirectoryCallers, input: MembershipCaller, userOnly: boolean): LabelledTestCaller | MembershipFailure {
	if (input.credential === null) return { ok: false, reason: 'missing_token' }
	const caller = callers.byCredential(input.app, input.credential)
	if (caller === undefined || caller.kind === 'app') return { ok: false, reason: 'invalid_token' }
	if (caller.disabled) return { ok: false, reason: 'disabled' }
	if (caller.kind === 'link' || (userOnly && caller.kind !== 'human')) return NOT_ALLOWED
	return caller
}

const isFailure = (outcome: LabelledTestCaller | MembershipFailure): outcome is MembershipFailure => 'ok' in outcome

function dimensionOf(artifact: ContractArtifact, type: string) {
	return Object.hasOwn(artifact.dimensions, type) ? artifact.dimensions[type] : undefined
}

/** The membership roles held in exactly `scope`, as IAM counts a member of its dimension. */
function rolesIn(artifact: ContractArtifact, memberships: readonly TestMembership[], scope: Scope): string[] {
	return memberships
		.filter((held) => held.scope !== null && sameScope(held.scope, scope) && artifact.roles[held.role]?.member?.scope === scope.type)
		.map(({ role }) => role)
}

function membershipsOf(callers: DirectoryCallers, principalId: string): readonly TestMembership[] {
	return callers.all().find(({ caller }) => caller.id === principalId)?.memberships ?? []
}

type PermsOf = (caller: TestCaller) => readonly PermissionEntry[]

function listMembers(artifact: ContractArtifact, callers: DirectoryCallers, permsOf: PermsOf, input: ListMembersInput): ListMembersResult {
	const caller = memberCaller(callers, input, false)
	if (isFailure(caller)) return caller
	const perms = [...permsOf(caller)]
	const problem = membershipScopeProblem(input.scope)
	if (problem !== null) return invalid(problem)
	const dimension = dimensionOf(artifact, input.scope.type)
	if (dimension?.members === null || dimension?.members === undefined) {
		return invalid(`scope '${input.scope.type}' declares no members`)
	}
	if (!permits(perms, dimension.members.list, input.scope)) return NOT_ALLOWED
	const manager = permits(perms, dimension.members.manage, input.scope)
	const members: MemberItem[] = []
	for (const { caller: member, memberships } of callers.all()) {
		const roles = rolesIn(artifact, memberships, input.scope)
		if (roles.length === 0) continue
		members.push({
			principalId: member.id,
			label: manager || dimension.directory === 'labels' ? member.label : null,
			email: manager ? member.email : null,
			lastSignInAt: manager ? member.lastSignInAt : null,
			roles,
			disabled: member.disabled,
			affiliation: member.affiliation,
		})
	}
	return { ok: true, members, invitations: [] }
}

function findMember(artifact: ContractArtifact, callers: DirectoryCallers, permsOf: PermsOf, input: FindMemberInput): FindMemberResult {
	const caller = memberCaller(callers, input, false)
	if (isFailure(caller)) return caller
	const perms = [...permsOf(caller)]
	const problem = membershipScopeProblem(input.scope)
	if (problem !== null) return invalid(problem)
	const dimension = dimensionOf(artifact, input.scope.type)
	if (dimension?.members === null || dimension?.members === undefined) {
		return invalid(`scope '${input.scope.type}' declares no members`)
	}
	// As IAM: one of the dimension's lookup actions, held on the directory's value itself.
	if (!directoryLookups(artifact, input.scope.type).includes(input.action) || !permits(perms, input.action, input.scope)) {
		return NOT_ALLOWED
	}
	if (input.principalId === '' || input.principalId.length > MAX_MEMBERSHIP_SCOPE_PART_LENGTH) return { ok: true, member: null }
	const found = callers.all().find(({ caller: member, memberships }) =>
		member.id === input.principalId && rolesIn(artifact, memberships, input.scope).length > 0
	)
	if (found === undefined) return { ok: true, member: null }
	const manager = permits(perms, dimension.members.manage, input.scope)
	return {
		ok: true,
		member: {
			principalId: found.caller.id,
			label: manager || dimension.directory === 'labels' ? found.caller.label : null,
			disabled: found.caller.disabled,
			affiliation: found.caller.affiliation,
		},
	}
}

/**
 * The membership roles held after the stand-in's own scope creations, assignments and revocations, over the roles the
 * test gave its callers: what IAM reads live for the assigner's roles, what a revoke removes, whether a value keeps a
 * creator, the directory, and the permissions of a principal's next token.
 */
function membershipChanges(artifact: ContractArtifact, callers: DirectoryCallers) {
	const key = (principalId: string, role: string, scope: Scope) => JSON.stringify([principalId, role, scope.type, scope.value])
	const added = new Map<string, { readonly principalId: string; readonly role: string; readonly scope: Scope }>()
	const removed = new Set<string>()
	const touched = new Set<string>()
	const rolesOf = (principalId: string, scope: Scope): string[] => {
		const held = [
			...rolesIn(artifact, membershipsOf(callers, principalId), scope),
			...[...added.values()].filter((grant) => grant.principalId === principalId && sameScope(grant.scope, scope)).map((grant) => grant.role),
		]
		return [...new Set(held)].filter((role) => !removed.has(key(principalId, role, scope)))
	}
	/** Every role `principalId` holds now: the test's grants it was not revoked, and the ones the stand-in assigned. */
	const heldBy = (principalId: string, given: readonly TestMembership[]): readonly TestMembership[] => {
		if (!touched.has(principalId)) return given
		const kept = given.filter((held) => held.scope === null || !removed.has(key(principalId, held.role, held.scope)))
		const gained = [...added.entries()].filter(([entry, grant]) =>
			grant.principalId === principalId && !removed.has(entry)
			&& !kept.some((held) => held.role === grant.role && held.scope !== null && sameScope(held.scope, grant.scope))
		).map(([, grant]) => ({ role: grant.role, scope: grant.scope }))
		return [...kept, ...gained]
	}
	const principals = () => [...new Set([...callers.all().map(({ caller }) => caller.id), ...[...added.values()].map((grant) => grant.principalId)])]
	return {
		rolesOf,
		heldBy,
		touched: (principalId: string): boolean => touched.has(principalId),
		othersHold: (principalId: string, role: string, scope: Scope): boolean =>
			principals().some((other) => other !== principalId && rolesOf(other, scope).includes(role)),
		assign(principalId: string, role: string, scope: Scope): void {
			touched.add(principalId)
			removed.delete(key(principalId, role, scope))
			added.set(key(principalId, role, scope), { principalId, role, scope })
		},
		revoke(principalId: string, role: string, scope: Scope): void {
			touched.add(principalId)
			removed.add(key(principalId, role, scope))
		},
	}
}

/** The permissions a role grants in `scope`, as IAM resolves a membership. */
function roleEntries(artifact: ContractArtifact, held: TestMembership): PermissionEntry[] {
	const scope = held.scope === null ? null : { type: held.scope.type, value: held.scope.value }
	return (artifact.roles[held.role]?.grants ?? []).map((action) => ({ action, scope, source: 'grant' }))
}

const samePermission = (left: PermissionEntry, right: PermissionEntry): boolean =>
	left.action === right.action && left.source === right.source
	&& (left.scope === null ? right.scope === null : right.scope !== null && sameScope(left.scope, right.scope))

const sameScope = (left: Scope, right: Scope): boolean => left.type === right.type && left.value === right.value

interface DelegationGrant {
	readonly principalId: string
	readonly endpoint: string
	readonly requestId: string
	readonly purpose: EndpointDelegation
	/** The dimension the endpoint creates a value of or manages the members of. */
	readonly dimension: string
	readonly action: string
	readonly expiresAt: number
}

/**
 * The directory of the kit's callers, and every write checked against the caller's grants as IAM checks it.
 * `organization` names the mailboxes IAM's configuration would; by default none.
 */
export function kitMembership(artifact: ContractArtifact, callers: DirectoryCallers, organization = NO_ORGANIZATION): KitMembership {
	const asked: AskedWrite[] = []
	const grants = new Map<string, DelegationGrant>()
	const changes = membershipChanges(artifact, callers)
	const invitations = new Map<string, KitInvitation>()
	const links = new Map<string, KitLink>()
	const live: DirectoryCallers = {
		byCredential: (app, credential) => callers.byCredential(app, credential),
		all: () => callers.all().map(({ caller, memberships }) => ({ caller, memberships: changes.heldBy(caller.id, memberships) })),
	}

	/** The test's permissions of `caller`, less one entry for each action of a role it lost, plus those of each role it gained. */
	const permsOf = (caller: TestCaller): readonly PermissionEntry[] => {
		if (!changes.touched(caller.id)) return caller.perms
		const given = membershipsOf(callers, caller.id)
		const held = changes.heldBy(caller.id, given)
		const sameMembership = (left: TestMembership) => (right: TestMembership) =>
			left.role === right.role && (left.scope === null ? right.scope === null : right.scope !== null && sameScope(left.scope, right.scope))
		const perms = [...caller.perms]
		for (const lost of given.filter((membership) => !held.some(sameMembership(membership)))) {
			for (const entry of roleEntries(artifact, lost)) {
				const at = perms.findIndex((candidate) => samePermission(candidate, entry))
				if (at >= 0) perms.splice(at, 1)
			}
		}
		const gained = held.filter((membership) => !given.some(sameMembership(membership)))
		return Object.freeze([...perms, ...gained.flatMap((membership) => roleEntries(artifact, membership))])
	}

	const organizationMailbox = (email: string): boolean => {
		const domain = email.slice(email.lastIndexOf('@') + 1)
		return organization.emails.some((named) => normalizeEmailIdentity(named) === email)
			|| organization.domains.some((named) => named.toLowerCase() === domain)
	}

	/** The open invitation of `role` in `scope` to `email`; as IAM, an expired one is closed first and never answered. */
	const openInvitation = (scope: Scope, role: string, email: string): KitInvitation | undefined =>
		[...invitations.values()].find((invitation) =>
			invitation.closed === null && invitation.expiresAt > now() && sameScope(invitation.scope, scope) && invitation.role === role
			&& invitation.email === email
		)

	const openNew = (scope: Scope, role: string, email: string, inviter: string | null): KitInvitation => {
		const invitation = { id: `invitation-${randomId()}`, scope, role, email, expiresAt: now() + INVITATION_TTL_SECONDS, closed: null, inviter }
		invitations.set(invitation.id, invitation)
		return invitation
	}

	/** Spends the request's grant before its binding is compared, as IAM does, so each attempt is single use. */
	const spend = (caller: TestCaller, input: { delegation: string; requestId: string }, purpose: EndpointDelegation, dimension: string) => {
		const grant = grants.get(input.delegation)
		grants.delete(input.delegation)
		if (
			grant === undefined || grant.expiresAt <= now() || grant.principalId !== caller.id || grant.requestId !== input.requestId
			|| grant.purpose !== purpose || grant.dimension !== dimension
		) {
			return INVALID_DELEGATION
		}
		return grant
	}

	/** `members.manage` of the scope's dimension, held there: a value is checked as itself, flat. */
	const manageProblem = (caller: TestCaller, scope: Scope): MembershipFailure | null => {
		const members = dimensionOf(artifact, scope.type)?.members
		if (members === null || members === undefined) return invalid(`scope '${scope.type}' declares no members`)
		return permits([...permsOf(caller)], members.manage, scope) ? null : NOT_ALLOWED
	}

	/** As IAM (ADR-0051): an external principal holds only a role the contract declares external. */
	const externalProblem = (principal: TestCaller, role: string): MembershipFailure | null => {
		if (principal.affiliation !== 'external' || artifact.roles[role]?.external === true) return null
		return invalid(`an external principal holds only a role its application declares external, and '${role}' is not one`)
	}

	/**
	 * Could `caller` give `role` in `scope`: it holds an assigning role — there, or an application-wide role globally —
	 * and every action the role grants there.
	 */
	const roleProblem = (caller: TestCaller, scope: Scope, role: string): MembershipFailure | null => {
		const declared = Object.hasOwn(artifact.roles, role) ? artifact.roles[role] : undefined
		if (declared?.member === null || declared?.member === undefined || declared.member.scope !== scope.type) {
			return invalid(`role '${role}' is not a membership role of scope '${scope.type}'`)
		}
		// IAM reads the assigner's live roles: its membership roles there after this stand-in's own changes, and the
		// application-wide roles the test gave it there or globally, which no membership write removes.
		const appWide = membershipsOf(callers, caller.id).filter((held) =>
			artifact.roles[held.role]?.member === null && (held.scope === null || sameScope(held.scope, scope))
		)
		const held = [...changes.rolesOf(caller.id, scope), ...appWide.map((grant) => grant.role)]
		if (!declared.member.assignableBy.some((assigner) => held.includes(assigner))) return NOT_ALLOWED
		const perms = [...permsOf(caller)]
		return declared.grants.every((action) => permits(perms, action, scope)) ? null : NOT_ALLOWED
	}

	const requestDelegation = (input: RequestDelegationInput): RequestDelegationResult => {
		const caller = memberCaller(callers, input, true)
		if (isFailure(caller)) return caller
		const row = artifact.endpoints.find((candidate) => candidate.id === input.endpoint)
		const purpose = row === undefined ? null : endpointDelegation(artifact, row)
		if (row?.requirement?.kind !== 'action' || purpose === null || row.requirement.access.form === 'app') {
			return invalid(`endpoint '${input.endpoint}' declares no membership operation`)
		}
		const { action, access } = row.requirement
		if (!permsOf(caller).some((entry) => matchAction(entry.action, action))) return NOT_ALLOWED
		const grant = `grant_${randomId()}`
		const expiresAt = now() + DELEGATION_GRANT_TTL_SECONDS
		grants.set(grant, { principalId: caller.id, endpoint: row.id, requestId: input.requestId, purpose, dimension: access.dimension, action, expiresAt })
		return { ok: true, grant, expiresAt }
	}

	/** A value of a top-level dimension, for a holder of the creating endpoint's action as a global grant. */
	const createScope = (input: CreateScopeInput): CreateScopeResult => {
		const caller = memberCaller(callers, input, true)
		if (isFailure(caller)) return caller
		const spent = spend(caller, input, 'creates', input.dimension)
		if ('ok' in spent) return spent
		const dimension = dimensionOf(artifact, input.dimension)
		if (dimension === undefined || dimension.creator === null || dimension.in !== null) {
			return invalid(`scope '${input.dimension}' is not created by IAM: it needs a creator role and no containing scope`)
		}
		if (!permits([...permsOf(caller)], spent.action)) return NOT_ALLOWED
		const external = externalProblem(caller, dimension.creator)
		if (external !== null) return external
		const scope: Scope = { type: input.dimension, value: crypto.randomUUID() }
		changes.assign(caller.id, dimension.creator, scope)
		asked.push({ operation: 'createScope', principalId: caller.id, scope, role: dimension.creator })
		return { ok: true, scope, role: dimension.creator }
	}

	const assignMember = (input: AssignMemberInput): AssignMemberResult => {
		const caller = memberCaller(callers, input, true)
		if (isFailure(caller)) return caller
		const spent = spend(caller, input, 'members', input.scope.type)
		if ('ok' in spent) return spent
		const scopeProblem = membershipScopeProblem(input.scope)
		if (scopeProblem !== null) return invalid(scopeProblem)
		const problem = manageProblem(caller, input.scope) ?? roleProblem(caller, input.scope, input.role)
		if (problem !== null) return problem
		if ('principalId' in input.member) {
			if (input.invitation !== undefined) return invalid('a label, a message and a resend go with an invitation by address')
			const { principalId } = input.member
			const target = callers.all().find(({ caller: candidate }) => candidate.id === principalId && candidate.kind === 'human')?.caller
			if (target === undefined) return NOT_FOUND
			const external = externalProblem(target, input.role)
			if (external !== null) return external
			changes.assign(principalId, input.role, input.scope)
			asked.push({ operation: 'assignMember', principalId: caller.id, scope: input.scope, role: input.role, member: input.member, invitationId: null })
			return { ok: true, assigned: { principalId, role: input.role } }
		}
		const email = invitedAddress(input.member.email)
		if (email === null) return invalid('the member email is not an address')
		const wording = invitationOptionsProblem(input.invitation ?? {})
		if (wording !== null) return invalid(wording)
		if (artifact.roles[input.role]?.external === true && organizationMailbox(email)) return { ok: false, reason: 'internal_mailbox' }
		// As IAM: a repeat answers the open invitation and sends nothing; a resend gives it a new link and 7 days.
		const open = openInvitation(input.scope, input.role, email)
		const invitation = open === undefined
			? openNew(input.scope, input.role, email, caller.id)
			: input.invitation?.resend === true
			? { ...open, expiresAt: now() + INVITATION_TTL_SECONDS }
			: open
		invitations.set(invitation.id, invitation)
		asked.push({
			operation: 'assignMember',
			principalId: caller.id,
			scope: input.scope,
			role: input.role,
			member: { email },
			invitationId: invitation.id,
		})
		return { ok: true, invited: { invitationId: invitation.id, role: invitation.role, expiresAt: invitation.expiresAt } }
	}

	/** An invitation this stand-in opened in `scope`, cancelled ones included: IAM knows no other, so any other id is `not_found`. */
	const invitationOf = (id: string, scope: Scope): KitInvitation | undefined => {
		const invitation = invitations.get(id)
		return invitation !== undefined && sameScope(invitation.scope, scope) ? invitation : undefined
	}

	const revokeMember = (input: RevokeMemberInput): RevokeMemberResult => {
		const caller = memberCaller(callers, input, true)
		if (isFailure(caller)) return caller
		const spent = spend(caller, input, 'members', input.scope.type)
		if ('ok' in spent) return spent
		const scopeProblem = membershipScopeProblem(input.scope)
		if (scopeProblem !== null) return invalid(scopeProblem)
		const manage = manageProblem(caller, input.scope)
		if (manage !== null) return manage
		if ('invitationId' in input.member) {
			const invitation = invitationOf(input.member.invitationId, input.scope)
			if (invitation === undefined) return NOT_FOUND
			const problem = roleProblem(caller, input.scope, invitation.role)
			if (problem !== null) return problem
			asked.push({ operation: 'revokeMember', principalId: caller.id, scope: input.scope, member: input.member })
			invitations.set(invitation.id, { ...invitation, closed: 'cancelled' })
			return { ok: true }
		}
		const only = input.member.role ?? null
		if (only !== null && artifact.roles[only]?.member?.scope !== input.scope.type) {
			return invalid(`role '${only}' is not a membership role of scope '${input.scope.type}'`)
		}
		const roles = changes.rolesOf(input.member.principalId, input.scope).filter((role) => only === null || role === only)
		for (const role of roles) {
			const problem = roleProblem(caller, input.scope, role)
			if (problem !== null) return problem
		}
		asked.push({ operation: 'revokeMember', principalId: caller.id, scope: input.scope, member: input.member })
		// As IAM: every other role goes, and the creator role only while another principal still holds it there.
		const target = input.member.principalId
		const creator = dimensionOf(artifact, input.scope.type)?.creator ?? null
		const lastCreator = creator !== null && roles.includes(creator) && !changes.othersHold(target, creator, input.scope)
		for (const role of roles) {
			if (!lastCreator || role !== creator) changes.revoke(target, role, input.scope)
		}
		return lastCreator ? { ok: false, reason: 'last_creator' } : { ok: true }
	}

	/** Why `chain` is not the object of the mount's dimension followed by each value containing it, or `null`. */
	const chainProblem = (dimension: string, chain: readonly Scope[]): string | null => {
		if (chain.length === 0 || chain.length > MAX_LINK_CHAIN_LENGTH) return `a link chain names 1 to ${MAX_LINK_CHAIN_LENGTH} values`
		let expected: string | null = dimension
		for (const scope of chain) {
			const problem = membershipScopeProblem(scope)
			if (problem !== null) return problem
			if (scope.type !== expected) return `the link chain names '${scope.type}' where the schema contains '${expected ?? 'nothing'}'`
			expected = dimensionOf(artifact, scope.type)?.in ?? null
		}
		return expected === null ? null : `the link chain stops before '${expected}'`
	}

	/** A share link, for a holder of the mount's `issuedBy` and of every action it grants on some value of the chain. */
	const issueLink = (input: IssueLinkInput): IssueLinkResult => {
		const caller = memberCaller(callers, input, false)
		if (isFailure(caller)) return caller
		const mount = Object.hasOwn(artifact.mounts, input.mount) ? artifact.mounts[input.mount] : undefined
		if (mount?.kind !== 'link') return invalid(`unknown link mount '${input.mount}'`)
		const problem = chainProblem(mount.dimension, input.chain)
		if (problem !== null) return invalid(problem)
		if (!Number.isSafeInteger(input.days) || input.days < 1 || input.days > mount.maxDays) {
			return invalid(`a link of '${input.mount}' lives 1 to ${mount.maxDays} days`)
		}
		const perms = [...permsOf(caller)]
		const heldOnChain = (action: string): boolean => input.chain.some((scope) => permits(perms, action, scope))
		if (!heldOnChain(mount.issuedBy) || !mount.grants.every(heldOnChain)) return NOT_ALLOWED
		const id = `link-${randomId()}`
		links.set(id, { id, issuer: caller.id, mount: input.mount, chain: input.chain })
		asked.push({ operation: 'issueLink', principalId: caller.id, id, mount: input.mount, chain: input.chain })
		return { ok: true, key: `${API_KEY_PREFIX}link_${randomId()}`, id, expiresAt: now() + input.days * DAY_SECONDS }
	}

	/** A link this stand-in issued, by its issuer or a holder of `members.manage` on a value of its chain. */
	const revokeLink = (input: RevokeLinkInput): RevokeLinkResult => {
		const caller = memberCaller(callers, input, false)
		if (isFailure(caller)) return caller
		const link = links.get(input.id)
		if (link === undefined) return NOT_FOUND
		const manager = link.chain.some((scope) => {
			const members = dimensionOf(artifact, scope.type)?.members
			return members !== null && members !== undefined && permits([...permsOf(caller)], members.manage, scope)
		})
		if (link.issuer !== caller.id && !manager) return NOT_ALLOWED
		asked.push({ operation: 'revokeLink', principalId: caller.id, id: input.id })
		return { ok: true }
	}

	const rpc: IamMembershipRpc = {
		listMembers: (input) => Promise.resolve(listMembers(artifact, live, permsOf, input)),
		findMember: (input) => Promise.resolve(findMember(artifact, live, permsOf, input)),
		requestDelegation: (input) => Promise.resolve(requestDelegation(input)),
		createScope: (input) => Promise.resolve(createScope(input)),
		assignMember: (input) => Promise.resolve(assignMember(input)),
		revokeMember: (input) => Promise.resolve(revokeMember(input)),
		issueLink: (input) => Promise.resolve(issueLink(input)),
		revokeLink: (input) => Promise.resolve(revokeLink(input)),
	}
	const seedInvitation = (scope: Scope, role: string, email: string): string => {
		const address = invitedAddress(email)
		if (address === null) throw new Error(`a seeded invitation goes to an address, not '${email}'`)
		return (openInvitation(scope, role, address) ?? openNew(scope, role, address, null)).id
	}
	const seedLink = (issuer: string, mount: string, chain: readonly Scope[]): string => {
		const id = `link-${randomId()}`
		links.set(id, { id, issuer, mount, chain })
		return id
	}
	const accept = (invitationId: string, recipient?: TestCaller): AcceptedInvitation => {
		const invitation = invitations.get(invitationId)
		if (invitation === undefined || invitation.closed !== null || invitation.expiresAt <= now()) {
			throw new Error(`no open invitation ${invitationId}: the kit's IAM opened none by that id, or it was cancelled, accepted or expired`)
		}
		if (recipient !== undefined && externalProblem(recipient, invitation.role) !== null) {
			throw new Error(`not_eligible: an external person accepts only a role the contract declares external, and '${invitation.role}' is not one`)
		}
		// As IAM: the inviter's authority now, its live roles and permissions, not what it held when it invited.
		const inviter = invitation.inviter === null ? undefined : callers.all().find(({ caller }) => caller.id === invitation.inviter)?.caller
		const authority = inviter === undefined || inviter.disabled
			? NOT_ALLOWED
			: (manageProblem(inviter, invitation.scope) ?? roleProblem(inviter, invitation.scope, invitation.role))
		if (authority !== null) {
			throw new Error(
				invitation.inviter === null
					? `not_allowed: ${invitationId} is a seeded invitation, which has no inviter to accept it under`
					: `not_allowed: the inviter can no longer give '${invitation.role}' in that ${invitation.scope.type}`,
			)
		}
		invitations.set(invitation.id, { ...invitation, closed: 'accepted' })
		if (recipient !== undefined) changes.assign(recipient.id, invitation.role, invitation.scope)
		return { scope: invitation.scope, role: invitation.role, email: invitation.email }
	}
	return Object.freeze({ rpc, asked, permsOf, accept, seedInvitation, seedLink })
}
