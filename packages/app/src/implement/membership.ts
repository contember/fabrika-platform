// Scopes, members and share links on the caller's behalf (ADR-0012 §6). The framework asks IAM
// through `@fabrika/auth`'s `IamMembership`, with the caller's verified token and the delegation grant the proxy
// obtained for this request; IAM checks the caller's live permissions, generates every value and issues every key.
// The framework writes no grant and mints no credential.

import type { IamMembership, MembershipRequestCaller } from '@fabrika/auth'
import type { InvitationItem, MemberItem, MembershipFailure, Scope } from '@fabrika/auth-core'
import type { CapabilityAuthority, RefGrant } from '@fabrika/db/capability'
import { joinPath } from '../contract/defaults'
import { ConflictError, ForbiddenError, HttpError, NotFoundError, UnauthorizedError } from '../errors'
import { CapabilityRefusedError, type Ref } from './capability'
import { ServerFault } from './faults'

/** Who a membership is about: an address IAM invites, or a principal it already has. */
export type MemberTarget = { readonly email: string } | { readonly principalId: string }

export type AssignedMember =
	| { readonly assigned: { readonly principalId: string; readonly role: string } }
	| { readonly invited: { readonly invitationId: string; readonly role: string; readonly expiresAt: number } }

export interface MemberList {
	readonly members: readonly MemberItem[]
	readonly invitations: readonly InvitationItem[]
}

/** `ctx.members` of an endpoint whose action is its dimension's `members.manage`: one write per request. */
export interface MemberManagement<D extends string, A extends string, R extends string> {
	/** The members of the value; IAM requires the dimension's `members.list` there. */
	list(ref: Ref<D, A>): Promise<MemberList>
	/** Gives `role` in the value: an existing principal gets the grant, an address an invitation. Repeating it answers the same. */
	assign(ref: Ref<D, A>, member: MemberTarget, role: R): Promise<AssignedMember>
	/** Removes the member's roles there (only `role` when given), or cancels an invitation. Repeating it answers the same. */
	revoke(ref: Ref<D, A>, member: { readonly principalId: string; readonly role?: R } | { readonly invitationId: string }): Promise<void>
}

/** One member of the target, as a member directory lists it. */
export interface DirectoryMember {
	readonly principalId: string
	/** The principal's display label (a user's spelling of its address); null from an IAM that shows it only to `members.manage`. */
	readonly label: string | null
	/** Its membership roles in the target. */
	readonly roles: readonly string[]
	readonly disabled: boolean
}

/**
 * `ctx.members` of an endpoint whose action is its dimension's `members.list`: the members of `ctx.target`, read from
 * IAM, which checks that action live. No emails and no invitations: those stay with `members.manage`.
 */
export interface MemberDirectory {
	list(): Promise<readonly DirectoryMember[]>
}

export interface IssuedLink {
	readonly id: string
	/** `<prefix>/#<key>`: the key travels in the fragment, which never reaches a server or a `Referer`. */
	readonly url: string
	readonly expiresAt: number
}

/** `ctx.links` of an endpoint whose `Ref` carries a link mount's issuing action. */
export interface LinkIssuing<D extends string, A extends string, M extends string> {
	issue(ref: Ref<D, A>, options: { readonly mount: M; readonly days: number }): Promise<IssuedLink>
}

/** One request's authority at IAM: the caller's token, the proxy's request id and the delegation grant it obtained. */
export interface MembershipRequest {
	readonly iam: IamMembership
	readonly caller: MembershipRequestCaller
	readonly delegation: string | null
	/** The endpoint's own access: the dimension a `Ref` passed to IAM must name, and its action. */
	readonly dimension: string
	readonly action: string
	/** The runtime's authority, which the `Ref` passed to IAM must resolve with. */
	readonly capabilities: CapabilityAuthority
}

/** IAM's decided refusal, as the answer the caller gets. A refusal IAM could not decide never arrives here. */
function refusal(failure: MembershipFailure): Error {
	switch (failure.reason) {
		case 'missing_token':
		case 'invalid_token':
		case 'unknown_principal':
		case 'disabled':
			return new UnauthorizedError('IAM does not accept the caller for this operation')
		case 'not_allowed':
			return new ForbiddenError('The caller may not do this here; IAM checked its live permissions')
		case 'invalid_delegation':
			return new ForbiddenError('IAM refused the delegation of this request; one request makes one membership change')
		case 'not_found':
			return new NotFoundError('Not found')
		case 'last_creator':
			return new ConflictError('The last holder of the creator role stays')
		case 'invitations_disabled':
			return new HttpError(409, 'invitations_disabled', 'This installation sends no email, so it cannot invite an address; assign an existing principal')
		case 'delivery_failed':
			return new ServerFault('iam_unavailable', 'IAM could not deliver the invitation', 503)
		case 'invalid_request':
			return new HttpError(400, 'invalid_request', failure.message)
	}
}

/** Runs one IAM call; a thrown transport failure is a 503 that names nothing, a decided refusal is the caller's answer. */
async function ask<T extends { readonly ok: true }>(work: () => Promise<T | MembershipFailure>, operation: string): Promise<T> {
	let result: T | MembershipFailure
	try {
		result = await work()
	} catch {
		throw new ServerFault('iam_unavailable', `IAM could not be asked to ${operation}`, 503)
	}
	if (!result.ok) {
		throw refusal(result)
	}
	return result
}

function delegationOf(request: MembershipRequest): string {
	if (request.delegation === null) {
		throw new ServerFault('delegation_missing', "the request reached a membership endpoint without the proxy's delegation grant", 503)
	}
	return request.delegation
}

/** The grant of a `Ref` this request minted for the endpoint's own dimension and action; anything else is refused. */
function refGrant(request: MembershipRequest, ref: unknown): RefGrant {
	const grant = request.capabilities.resolve(ref)
	if (grant.kind !== 'ref' || grant.dimension !== request.dimension || grant.action !== request.action) {
		throw new CapabilityRefusedError('wrong_target', `pass the ctx.target of this request: a Ref of '${request.dimension}' for '${request.action}'`)
	}
	return grant
}

function scopeOf(grant: RefGrant): Scope {
	return { type: grant.dimension, value: grant.id }
}

/** `creates`: IAM generates the value and grants the caller the dimension's creator role, atomically. */
export async function createScope(request: MembershipRequest): Promise<string> {
	const created = await ask(() => request.iam.createScope(request.caller, delegationOf(request), request.dimension), 'create a scope')
	if (created.scope.type !== request.dimension) {
		throw new ServerFault('iam_answer_mismatch', `IAM created a '${created.scope.type}' for a request to create a '${request.dimension}'`)
	}
	return created.scope.value
}

export function memberManagement(request: MembershipRequest): MemberManagement<string, string, string> {
	return Object.freeze({
		async list(ref: unknown): Promise<MemberList> {
			const listed = await ask(() => request.iam.listMembers(request.caller, scopeOf(refGrant(request, ref))), 'list members')
			return Object.freeze({ members: listed.members, invitations: listed.invitations })
		},
		async assign(ref: unknown, member: MemberTarget, role: string): Promise<AssignedMember> {
			const scope = scopeOf(refGrant(request, ref))
			const target = 'email' in member ? { email: member.email } : { principalId: member.principalId }
			const assigned = await ask(() => request.iam.assignMember(request.caller, delegationOf(request), scope, role, target), 'assign a member')
			return 'assigned' in assigned ? { assigned: assigned.assigned } : { invited: assigned.invited }
		},
		async revoke(ref: unknown, member: { readonly principalId: string; readonly role?: string } | { readonly invitationId: string }): Promise<void> {
			const scope = scopeOf(refGrant(request, ref))
			const target = 'invitationId' in member ? { invitationId: member.invitationId } : { principalId: member.principalId, role: member.role ?? null }
			await ask(() => request.iam.revokeMember(request.caller, delegationOf(request), scope, target), 'revoke a member')
		},
	})
}

/**
 * The members of the request's own target, `target`; IAM requires the dimension's `members.list` there. Every read
 * endpoint of that action has a directory, so a runtime without an IAM membership transport still boots, and only a
 * `list()` call fails.
 */
export function memberDirectory(request: MembershipRequest | null, target: unknown, endpoint: string): MemberDirectory {
	return Object.freeze({
		async list(): Promise<readonly DirectoryMember[]> {
			if (request === null) {
				throw new ServerFault('facility_unbound', `'${endpoint}' lists members, and the runtime adapter supplies no IAM membership transport`, 503)
			}
			const listed = await ask(() => request.iam.listMembers(request.caller, scopeOf(refGrant(request, target))), 'list members')
			return Object.freeze(
				listed.members.map((member) =>
					Object.freeze({ principalId: member.principalId, label: member.label, roles: Object.freeze([...member.roles]), disabled: member.disabled })
				),
			)
		},
	})
}

/** A link mount an endpoint may issue for: its dimension and issuing action are the endpoint's. */
export interface IssuableLink {
	readonly name: string
	readonly prefix: string
}

/**
 * `ctx.links`: IAM issues an anonymous key bound to the object's whole containment chain, read from the `Ref`, so a
 * link whose object moves stops working. `containers` is the object's dimension's containers, nearest first.
 */
export function linkIssuing(
	request: MembershipRequest,
	mounts: readonly IssuableLink[],
	containers: readonly string[],
): LinkIssuing<string, string, string> {
	return Object.freeze({
		async issue(ref: unknown, options: { readonly mount: string; readonly days: number }): Promise<IssuedLink> {
			const grant = refGrant(request, ref)
			const mount = mounts.find((candidate) => candidate.name === options.mount)
			if (mount === undefined) {
				throw new ServerFault(
					'link_mount',
					`'${options.mount}' is not a link mount this endpoint issues (allowed: ${mounts.map((m) => m.name).join(', ')})`,
				)
			}
			const chain: Scope[] = [scopeOf(grant)]
			for (const container of containers) {
				const value = grant.chain.get(container)
				if (value !== undefined) {
					chain.push({ type: container, value })
				}
			}
			const issued = await ask(() => request.iam.issueLink(request.caller, mount.name, chain, options.days), 'issue a share link')
			return Object.freeze({ id: issued.id, url: `${joinPath(mount.prefix, '')}#${issued.key}`, expiresAt: issued.expiresAt })
		},
	})
}
