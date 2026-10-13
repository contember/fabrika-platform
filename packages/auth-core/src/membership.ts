// The IAM operations a multi-tenant application requests on its caller's behalf (ADR-0012 §6): scope
// creation, membership and share links. IAM evaluates every request against the caller's LIVE permissions, generates every value and issues every key; the application supplies the
// caller's token as proof and nothing that names an actor.
//
// A SEPARATE interface from `IamRpc`, like `IamHandoffRpc`: an application's IAM entrypoint serves it,
// and a platform component that implements `IamRpc` does not have to.

import type { ContractArtifact, DimensionArtifact, EndpointRow } from './contract'
import type { PrincipalAffiliation, Scope } from './types'

/**
 * What an endpoint may ask IAM about the members of its own target (`ctx.members`): `manage` where its action is the
 * dimension's `members.manage`, `list` where it is the dimension's `members.list`, on or in that dimension. IAM checks
 * the same action live, so the endpoint's own access already names what IAM requires.
 */
export function endpointMembers(artifact: Pick<ContractArtifact, 'dimensions'>, row: EndpointRow): 'manage' | 'list' | null {
	if (row.requirement?.kind !== 'action') {
		return null
	}
	const { action, access } = row.requirement
	if (access.form !== 'on' && access.form !== 'in') {
		return null
	}
	const members = Object.hasOwn(artifact.dimensions, access.dimension) ? artifact.dimensions[access.dimension]?.members : null
	return members?.manage === action ? 'manage' : members?.list === action ? 'list' : null
}

/**
 * The member directory an endpoint reads through `ctx.members` when it does not manage members: the nearest dimension,
 * its own or one containing it, that declares members. Every such endpoint (access `on` or `in`) may look up one member
 * it names; `lists` where its action is that dimension's `members.list`, which alone may list them. IAM checks either
 * action live on the directory's value itself.
 */
export interface EndpointDirectory {
	readonly dimension: string
	readonly lists: boolean
}

/**
 * The directory reach an endpoint's access form gives it, from the dimensions alone: what `buildArtifact` records in
 * `ContractArtifact.directories`. Nothing else derives it, so an approved artifact holds every reach the runtime grants.
 */
export function directoryReach(dimensions: ContractArtifact['dimensions'], row: EndpointRow): EndpointDirectory | null {
	// Only a procedure of an RPC mount has a handler with `ctx.members`: a file endpoint and an export have none.
	const procedure = (row.kind === 'query' || row.kind === 'mutation') && row.source.kind === 'mount'
	if (!procedure || row.requirement?.kind !== 'action' || endpointMembers({ dimensions }, row) === 'manage') {
		return null
	}
	const { action, access } = row.requirement
	// A link procedure (`from: null`) acts for an anonymous key holder, which IAM never answers a membership question.
	if ((access.form !== 'on' && access.form !== 'in') || access.from === null) {
		return null
	}
	const seen = new Set<string>()
	let dimension: string | null = access.dimension
	while (dimension !== null && !seen.has(dimension) && Object.hasOwn(dimensions, dimension)) {
		seen.add(dimension)
		const definition: DimensionArtifact | undefined = dimensions[dimension]
		if (definition === undefined) {
			return null
		}
		if (definition.members !== null) {
			return { dimension, lists: definition.members.list === action }
		}
		dimension = definition.in
	}
	return null
}

/** The directory reach the artifact records for the endpoint; an artifact compiled before it recorded any grants none. */
export function endpointDirectory(artifact: Pick<ContractArtifact, 'directories'>, row: EndpointRow): EndpointDirectory | null {
	const directories = artifact.directories
	return directories !== undefined && Object.hasOwn(directories, row.id) ? (directories[row.id] ?? null) : null
}

/**
 * The actions of the endpoints whose directory is `dimension`, sorted: what IAM's schema holds as the dimension's
 * `lookups`, so IAM answers a lookup only for an action an approved endpoint below the dimension holds.
 */
export function directoryLookups(artifact: Pick<ContractArtifact, 'directories' | 'endpoints'>, dimension: string): string[] {
	const actions = new Set<string>()
	for (const row of artifact.endpoints) {
		if (row.requirement?.kind === 'action' && endpointDirectory(artifact, row)?.dimension === dimension) {
			actions.add(row.requirement.action)
		}
	}
	return [...actions].sort()
}

/** Every request carries the caller's own credential; `app` is superseded by the credential's verified app. */
export interface MembershipCaller {
	app: string
	/** The caller's verified access token, or a `px_` key bound to a user principal. */
	credential: string | null
	requestId: string
}

/**
 * Why IAM refused. `not_allowed` is a lack of authority; `invalid_delegation` a missing, spent or
 * mismatched delegation grant; `invalid_request` a request the app's schema cannot express, with a
 * message naming the problem.
 */
export type MembershipFailure =
	| { ok: false; reason: 'missing_token' | 'invalid_token' | 'unknown_principal' | 'disabled' | 'not_allowed' | 'invalid_delegation' | 'not_found' }
	/** Revoking would leave the value without a holder of its creator role. */
	| { ok: false; reason: 'last_creator' }
	/** The installation sends no email, so it cannot verify an invited address. */
	| { ok: false; reason: 'invitations_disabled' | 'delivery_failed' }
	| { ok: false; reason: 'invalid_request'; message: string }

export type MembershipFailureReason = MembershipFailure['reason']

/** The longest scope type or value a membership operation takes; a lookup of a longer principal id finds no member. */
export const MAX_MEMBERSHIP_SCOPE_PART_LENGTH = 200

/** The most values a share link's chain names: its object and each value containing it. */
export const MAX_LINK_CHAIN_LENGTH = 8

/** The longest address IAM invites, after `normalizeEmailIdentity`. */
export const MAX_INVITATION_EMAIL_LENGTH = 254

/** Why IAM refuses `scope` as a membership operation's coordinate, or `null`. */
export function membershipScopeProblem(scope: Scope): string | null {
	for (const part of [scope.type, scope.value]) {
		if (part === '' || part.length > MAX_MEMBERSHIP_SCOPE_PART_LENGTH) {
			return `a scope type and value are 1 to ${MAX_MEMBERSHIP_SCOPE_PART_LENGTH} characters`
		}
	}
	return null
}

/** Normalize an email identity for case-insensitive exact-mailbox comparisons. */
export function normalizeEmailIdentity(value: string): string {
	return value.normalize('NFC').trim().toLocaleLowerCase('en-US')
}

/** The normalized address IAM invites for `address`, or `null` for one it refuses as no address. */
export function invitedAddress(address: string): string | null {
	const email = normalizeEmailIdentity(address)
	return email.length > MAX_INVITATION_EMAIL_LENGTH || !/^[^\s@]+@[^\s@]+$/.test(email) ? null : email
}

/** How long a delegation grant may be held before it is spent. One request, so seconds. */
export const DELEGATION_GRANT_TTL_SECONDS = 120

/**
 * Obtain a single-use delegation grant for ONE request to one endpoint. The endpoint must be one the
 * app's schema lists under `delegations`, and the grant is spent by one membership operation of the same
 * caller and request id.
 */
export interface RequestDelegationInput extends MembershipCaller {
	endpoint: string
}

export type RequestDelegationResult = { ok: true; grant: string; expiresAt: number } | MembershipFailure

/** Create a value of `dimension`: IAM generates it and grants the caller the dimension's creator role, atomically. */
export interface CreateScopeInput extends MembershipCaller {
	/** A grant for an endpoint whose purpose is `creates` for this dimension. */
	delegation: string
	dimension: string
}

export type CreateScopeResult = { ok: true; scope: Scope; role: string } | MembershipFailure

/** Who a membership operation is about: an existing principal, or an address IAM invites. */
export type MemberTarget = { principalId: string } | { email: string }

/**
 * Give `role` in `scope`. The caller holds the dimension's `members.manage` there, holds a role there
 * that may assign `role`, and holds every action `role` grants there. An existing principal receives the
 * grant; an address receives an invitation that only its verified owner can accept. Repeating the call
 * answers the same result.
 */
export interface AssignMemberInput extends MembershipCaller {
	/** A grant for an endpoint whose purpose is `members` for `scope.type`. */
	delegation: string
	scope: Scope
	role: string
	member: MemberTarget
}

export type AssignMemberResult =
	| { ok: true; assigned: { principalId: string; role: string } }
	| { ok: true; invited: { invitationId: string; role: string; expiresAt: number } }
	| MembershipFailure

/**
 * Remove a principal's membership roles in `scope` (only `role` when given), or cancel an invitation.
 * Each removed role must be one the caller could assign; the last holder of the creator role stays.
 * Repeating the call answers the same result.
 */
export interface RevokeMemberInput extends MembershipCaller {
	delegation: string
	scope: Scope
	member: { principalId: string; role?: string | null } | { invitationId: string }
}

export type RevokeMemberResult = { ok: true } | MembershipFailure

/** The members of `scope`, with their labels. Needs the dimension's `members.list` there; emails and invitations only to `members.manage`. */
export interface ListMembersInput extends MembershipCaller {
	scope: Scope
}

export interface MemberItem {
	principalId: string
	/** The principal's display label (a user's spelling of its address); null from an IAM that shows it only to `members.manage`. */
	label: string | null
	/** Null unless the caller holds the dimension's `members.manage` in the scope. */
	email: string | null
	roles: string[]
	disabled: boolean
	/** An `external` member is a person from outside the organization (ADR-0051). */
	affiliation: PrincipalAffiliation
}

export interface InvitationItem {
	id: string
	email: string
	role: string
	expiresAt: number
}

export type ListMembersResult = { ok: true; members: MemberItem[]; invitations: InvitationItem[] } | MembershipFailure

/**
 * Look up ONE principal in the members of `scope`, for an endpoint on, in or below its dimension. `action` is the
 * endpoint's own: IAM answers only when the schema lists it among the dimension's `lookups` and the caller holds it on
 * `scope` itself, so the application names no chain IAM would have to trust. Listing stays with `members.list`.
 */
export interface FindMemberInput extends MembershipCaller {
	scope: Scope
	principalId: string
	action: string
}

export interface FoundMember {
	principalId: string
	/** The principal's display label; null unless the dimension declares `directory: 'labels'` or the caller holds `members.manage` there. */
	label: string | null
	disabled: boolean
	affiliation: PrincipalAffiliation
}

/** `member` is null for a principal that holds no membership role in `scope`, unknown ones included. */
export type FindMemberResult = { ok: true; member: FoundMember | null } | MembershipFailure

/**
 * Issue a share link of `mount` for the object `chain[0]`. `chain` names the object and every value
 * containing it, outward, as the app resolved it from its database; the framework re-checks it on every
 * link request, so a link whose object moved stops working. The caller holds the mount's `issuedBy` and
 * every granted action on some link of the chain.
 */
export interface IssueLinkInput extends MembershipCaller {
	mount: string
	chain: Scope[]
	/** Required, at most the mount's `maxDays`. */
	days: number
}

export type IssueLinkResult = { ok: true; key: string; id: string; expiresAt: number } | MembershipFailure

/** Revoke a share link: its issuer, or a holder of `members.manage` on a value of its chain. Idempotent. */
export interface RevokeLinkInput extends MembershipCaller {
	id: string
}

export type RevokeLinkResult = { ok: true } | MembershipFailure

export interface IamMembershipRpc {
	requestDelegation(input: RequestDelegationInput): Promise<RequestDelegationResult>
	createScope(input: CreateScopeInput): Promise<CreateScopeResult>
	assignMember(input: AssignMemberInput): Promise<AssignMemberResult>
	revokeMember(input: RevokeMemberInput): Promise<RevokeMemberResult>
	listMembers(input: ListMembersInput): Promise<ListMembersResult>
	findMember(input: FindMemberInput): Promise<FindMemberResult>
	issueLink(input: IssueLinkInput): Promise<IssueLinkResult>
	revokeLink(input: RevokeLinkInput): Promise<RevokeLinkResult>
}
