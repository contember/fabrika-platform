// The test kit's stand-ins for IAM's membership transport. Both answer a member directory (`ctx.members.list()` and
// `get()`) from the kit's own callers, as IAM answers it from its grants. `kitDirectory`, the default of `testKit`,
// refuses every write by name. `kitMembership`, which the endpoint access kit boots with, also answers the writes
// under IAM's rules for the caller's grants: the delegation grant, `members.manage`, `assignableBy`, the role's
// actions, a link mount's `issuedBy`, the last creator and IAM's input bounds. It records each write it allowed and
// grants the kit's callers nothing.

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
	endpointMembers,
	type FindMemberInput,
	type FindMemberResult,
	type IamMembershipRpc,
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

export interface KitMembership {
	readonly rpc: IamMembershipRpc
	/** Every write it allowed, in order. */
	readonly asked: readonly AskedWrite[]
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

const ONLY_DIRECTORY: MembershipFailure = {
	ok: false,
	reason: 'invalid_request',
	message: 'the test kit answers member directories only: pass testKit(app, { membership }) for scopes, members and share links',
}

function invalid(message: string): MembershipFailure {
	return { ok: false, reason: 'invalid_request', message }
}

const randomId = (): string => crypto.randomUUID().replaceAll('-', '')
const now = (): number => Math.floor(Date.now() / 1000)

/**
 * Whether serving the contract writes through IAM: a `creates` endpoint, one of a dimension's `members.manage`, or one
 * whose action issues a link mount's keys. Under `kitDirectory` such a contract gets no transport, so `boot` names it.
 */
export function writesThroughIam(artifact: ContractArtifact): boolean {
	const issuing = Object.values(artifact.mounts).flatMap((mount) => (mount.kind === 'link' ? [`${mount.dimension} ${mount.issuedBy}`] : []))
	return artifact.endpoints.some((row) => {
		if (row.requirement?.kind !== 'action') return false
		const { action, access } = row.requirement
		return access.form === 'creates' || endpointMembers(artifact, row) === 'manage'
			|| ((access.form === 'on' || access.form === 'in') && issuing.includes(`${access.dimension} ${action}`))
	})
}

/**
 * The caller of a membership operation, as IAM resolves it: another application's connector calls none, a link holder
 * is never a member caller, and `userOnly` refuses a script, which creates no scope and manages no member.
 */
function memberCaller(callers: DirectoryCallers, input: MembershipCaller, userOnly: boolean): LabelledTestCaller | MembershipFailure {
	if (input.credential === null) return { ok: false, reason: 'missing_token' }
	const caller = callers.byCredential(input.app, input.credential)
	if (caller === undefined || caller.kind === 'app') return { ok: false, reason: 'invalid_token' }
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

function listMembers(artifact: ContractArtifact, callers: DirectoryCallers, input: ListMembersInput): ListMembersResult {
	const caller = memberCaller(callers, input, false)
	if (isFailure(caller)) return caller
	const problem = membershipScopeProblem(input.scope)
	if (problem !== null) return invalid(problem)
	const dimension = dimensionOf(artifact, input.scope.type)
	if (dimension?.members === null || dimension?.members === undefined) {
		return invalid(`scope '${input.scope.type}' declares no members`)
	}
	if (!permits([...caller.perms], dimension.members.list, input.scope)) return NOT_ALLOWED
	const manager = permits([...caller.perms], dimension.members.manage, input.scope)
	const members: MemberItem[] = []
	for (const { caller: member, memberships } of callers.all()) {
		const roles = rolesIn(artifact, memberships, input.scope)
		if (roles.length === 0) continue
		members.push({
			principalId: member.id,
			label: manager || dimension.directory === 'labels' ? member.label : null,
			email: manager ? member.label : null,
			roles,
			disabled: false,
			affiliation: member.affiliation,
		})
	}
	return { ok: true, members, invitations: [] }
}

function findMember(artifact: ContractArtifact, callers: DirectoryCallers, input: FindMemberInput): FindMemberResult {
	const caller = memberCaller(callers, input, false)
	if (isFailure(caller)) return caller
	const problem = membershipScopeProblem(input.scope)
	if (problem !== null) return invalid(problem)
	const dimension = dimensionOf(artifact, input.scope.type)
	if (dimension?.members === null || dimension?.members === undefined) {
		return invalid(`scope '${input.scope.type}' declares no members`)
	}
	// As IAM: one of the dimension's lookup actions, held on the directory's value itself.
	if (!directoryLookups(artifact, input.scope.type).includes(input.action) || !permits([...caller.perms], input.action, input.scope)) {
		return NOT_ALLOWED
	}
	if (input.principalId === '' || input.principalId.length > MAX_MEMBERSHIP_SCOPE_PART_LENGTH) return { ok: true, member: null }
	const found = callers.all().find(({ caller: member, memberships }) =>
		member.id === input.principalId && rolesIn(artifact, memberships, input.scope).length > 0
	)
	if (found === undefined) return { ok: true, member: null }
	const manager = permits([...caller.perms], dimension.members.manage, input.scope)
	return {
		ok: true,
		member: {
			principalId: found.caller.id,
			label: manager || dimension.directory === 'labels' ? found.caller.label : null,
			disabled: false,
			affiliation: found.caller.affiliation,
		},
	}
}

/** The kit's default membership transport: the directory of its callers, and a refusal for every write. */
export function kitDirectory(artifact: ContractArtifact, callers: DirectoryCallers): IamMembershipRpc {
	const refused = () => Promise.resolve(ONLY_DIRECTORY)
	return {
		listMembers: (input) => Promise.resolve(listMembers(artifact, callers, input)),
		findMember: (input) => Promise.resolve(findMember(artifact, callers, input)),
		requestDelegation: refused,
		createScope: refused,
		assignMember: refused,
		revokeMember: refused,
		issueLink: refused,
		revokeLink: refused,
	}
}

/**
 * The membership roles held after the stand-in's own scope creations, assignments and revocations: the assigner's roles
 * IAM checks, what a revoke removes and whether a value keeps a creator. It never reaches the kit's callers, whose
 * tokens and directory stay as the test made them.
 */
function membershipChanges(artifact: ContractArtifact, callers: DirectoryCallers) {
	const key = (principalId: string, role: string, scope: Scope) => JSON.stringify([principalId, role, scope.type, scope.value])
	const added = new Map<string, { readonly principalId: string; readonly role: string; readonly scope: Scope }>()
	const removed = new Set<string>()
	const rolesOf = (principalId: string, scope: Scope): string[] => {
		const held = [
			...rolesIn(artifact, membershipsOf(callers, principalId), scope),
			...[...added.values()].filter((grant) => grant.principalId === principalId && sameScope(grant.scope, scope)).map((grant) => grant.role),
		]
		return [...new Set(held)].filter((role) => !removed.has(key(principalId, role, scope)))
	}
	const principals = () => [...new Set([...callers.all().map(({ caller }) => caller.id), ...[...added.values()].map((grant) => grant.principalId)])]
	return {
		rolesOf,
		othersHold: (principalId: string, role: string, scope: Scope): boolean =>
			principals().some((other) => other !== principalId && rolesOf(other, scope).includes(role)),
		assign(principalId: string, role: string, scope: Scope): void {
			removed.delete(key(principalId, role, scope))
			added.set(key(principalId, role, scope), { principalId, role, scope })
		},
		revoke(principalId: string, role: string, scope: Scope): void {
			removed.add(key(principalId, role, scope))
		},
	}
}

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

/** The directory of the kit's callers, and every write checked against the caller's grants as IAM checks it. */
export function kitMembership(artifact: ContractArtifact, callers: DirectoryCallers): KitMembership {
	const asked: AskedWrite[] = []
	const grants = new Map<string, DelegationGrant>()
	const changes = membershipChanges(artifact, callers)

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
		return permits([...caller.perms], members.manage, scope) ? null : NOT_ALLOWED
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
		return declared.grants.every((action) => permits([...caller.perms], action, scope)) ? null : NOT_ALLOWED
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
		if (!caller.perms.some((entry) => matchAction(entry.action, action))) return NOT_ALLOWED
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
		if (!permits([...caller.perms], spent.action)) return NOT_ALLOWED
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
		const invitationId = `invitation-${randomId()}`
		asked.push({ operation: 'assignMember', principalId: caller.id, scope: input.scope, role: input.role, member: { email }, invitationId })
		return { ok: true, invited: { invitationId, role: input.role, expiresAt: now() + INVITATION_TTL_SECONDS } }
	}

	/** An invitation this stand-in opened: IAM knows no other, so any other id is `not_found`. */
	const invitationOf = (id: string, scope: Scope) =>
		asked.find((write) =>
			write.operation === 'assignMember' && write.invitationId === id && write.scope.type === scope.type && write.scope.value === scope.value
		)

	const revokeMember = (input: RevokeMemberInput): RevokeMemberResult => {
		const caller = memberCaller(callers, input, true)
		if (isFailure(caller)) return caller
		const spent = spend(caller, input, 'members', input.scope.type)
		if ('ok' in spent) return spent
		const scopeProblem = membershipScopeProblem(input.scope)
		if (scopeProblem !== null) return invalid(scopeProblem)
		const manage = manageProblem(caller, input.scope)
		if (manage !== null) return manage
		let roles: string[]
		if ('invitationId' in input.member) {
			const invitation = invitationOf(input.member.invitationId, input.scope)
			if (invitation?.operation !== 'assignMember') return NOT_FOUND
			roles = [invitation.role]
		} else {
			const only = input.member.role ?? null
			if (only !== null && artifact.roles[only]?.member?.scope !== input.scope.type) {
				return invalid(`role '${only}' is not a membership role of scope '${input.scope.type}'`)
			}
			roles = changes.rolesOf(input.member.principalId, input.scope).filter((role) => only === null || role === only)
		}
		for (const role of roles) {
			const problem = roleProblem(caller, input.scope, role)
			if (problem !== null) return problem
		}
		asked.push({ operation: 'revokeMember', principalId: caller.id, scope: input.scope, member: input.member })
		if ('invitationId' in input.member) return { ok: true }
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
		const heldOnChain = (action: string): boolean => input.chain.some((scope) => permits([...caller.perms], action, scope))
		if (!heldOnChain(mount.issuedBy) || !mount.grants.every(heldOnChain)) return NOT_ALLOWED
		const id = `link-${randomId()}`
		asked.push({ operation: 'issueLink', principalId: caller.id, id, mount: input.mount, chain: input.chain })
		return { ok: true, key: `${API_KEY_PREFIX}link_${randomId()}`, id, expiresAt: now() + input.days * DAY_SECONDS }
	}

	/** A link this stand-in issued, by its issuer or a holder of `members.manage` on a value of its chain. */
	const revokeLink = (input: RevokeLinkInput): RevokeLinkResult => {
		const caller = memberCaller(callers, input, false)
		if (isFailure(caller)) return caller
		const link = asked.find((write) => write.operation === 'issueLink' && write.id === input.id)
		if (link?.operation !== 'issueLink') return NOT_FOUND
		const manager = link.chain.some((scope) => {
			const members = dimensionOf(artifact, scope.type)?.members
			return members !== null && members !== undefined && permits([...caller.perms], members.manage, scope)
		})
		if (link.principalId !== caller.id && !manager) return NOT_ALLOWED
		asked.push({ operation: 'revokeLink', principalId: caller.id, id: input.id })
		return { ok: true }
	}

	const rpc: IamMembershipRpc = {
		listMembers: (input) => Promise.resolve(listMembers(artifact, callers, input)),
		findMember: (input) => Promise.resolve(findMember(artifact, callers, input)),
		requestDelegation: (input) => Promise.resolve(requestDelegation(input)),
		createScope: (input) => Promise.resolve(createScope(input)),
		assignMember: (input) => Promise.resolve(assignMember(input)),
		revokeMember: (input) => Promise.resolve(revokeMember(input)),
		issueLink: (input) => Promise.resolve(issueLink(input)),
		revokeLink: (input) => Promise.resolve(revokeLink(input)),
	}
	return Object.freeze({ rpc, asked })
}
