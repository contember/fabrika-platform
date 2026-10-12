// The IAM operations a multi-tenant application requests on its caller's behalf (ADR-0012 §6): scope
// creation, membership and share links. IAM evaluates every request against the caller's LIVE permissions, generates every value and issues every key; the application supplies the
// caller's token as proof and nothing that names an actor.
//
// A SEPARATE interface from `IamRpc`, like `IamHandoffRpc`: an application's IAM entrypoint serves it,
// and a platform component that implements `IamRpc` does not have to.

import type { ContractArtifact, EndpointRow } from './contract'
import type { Scope } from './types'

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
}

export interface InvitationItem {
	id: string
	email: string
	role: string
	expiresAt: number
}

export type ListMembersResult = { ok: true; members: MemberItem[]; invitations: InvitationItem[] } | MembershipFailure

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
	issueLink(input: IssueLinkInput): Promise<IssueLinkResult>
	revokeLink(input: RevokeLinkInput): Promise<RevokeLinkResult>
}
