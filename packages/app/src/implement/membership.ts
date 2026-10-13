// Scopes, members and share links on the caller's behalf (ADR-0012 §6). The framework asks IAM
// through `@fabrika/auth`'s `IamMembership`, with the caller's verified token and the delegation grant the proxy
// obtained for this request; IAM checks the caller's live permissions, generates every value and issues every key.
// The framework writes no grant and mints no credential.

import type { IamMembership, MembershipRequestCaller } from '@fabrika/auth'
import type { InvitationItem, IssueLinkResult, MemberItem, MembershipFailure, PrincipalAffiliation, Scope } from '@fabrika/auth-core'
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
	/** `external`: a person from outside the organization (ADR-0051), for a staff UI to show. */
	readonly affiliation: PrincipalAffiliation
}

/** One member a lookup found: never its email, and its label only where the directory shows labels. */
export interface Member {
	readonly principalId: string
	/** The principal's display label; null unless the dimension declares `directory: 'labels'` or the caller manages its members. */
	readonly label: string | null
	readonly disabled: boolean
	readonly affiliation: PrincipalAffiliation
}

/**
 * `ctx.members` of an endpoint on or in a dimension below a member directory (its own dimension's, or the nearest one
 * containing it): the members of the value its object lies in. IAM checks the endpoint's own action on that value.
 */
export interface MemberLookup {
	/** The principal, when it is a member of the directory's value; null otherwise, an unknown id included. */
	get(principalId: string): Promise<Member | null>
}

/**
 * `ctx.members` of an endpoint whose action is the directory's `members.list`: also every member, read from IAM, which
 * checks that action live on the directory's value. No emails and no invitations: those stay with `members.manage`.
 */
export interface MemberDirectory extends MemberLookup {
	list(): Promise<readonly DirectoryMember[]>
}

export interface IssuedLink {
	readonly id: string
	/** `<prefix>/#<key>`: the key travels in the fragment, which never reaches a server or a `Referer`. */
	readonly url: string
	readonly expiresAt: number
}

/** `ctx.links` of a site that declares the link mount it issues. */
export interface LinkIssuing<D extends string, A extends string, M extends string> {
	issue(ref: Ref<D, A>, options: { readonly mount: M; readonly days: number }): Promise<IssuedLink>
	/**
	 * Ends the link `id` (`IssuedLink.id`) at IAM: its issuer or a holder of `members.manage` on its chain may; a job only
	 * a link it issued. Repeating it answers the same. A token minted from it still works until it expires, at most 300 s.
	 */
	revoke(id: string): Promise<void>
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

/** The directory an endpoint reads: the dimension that declares it, and whether the endpoint may list it. */
export interface DirectoryReach {
	readonly endpoint: string
	readonly dimension: string
	readonly lists: boolean
}

/**
 * The member directory of the request's own target, `target`: its dimension's when it declares members, else the
 * nearest container's, at the value the target's chain holds. A runtime without an IAM membership transport still
 * boots, and only a call fails.
 */
export function memberDirectory(request: MembershipRequest | null, target: unknown, reach: DirectoryReach): MemberLookup | MemberDirectory {
	const directoryOf = (): { readonly request: MembershipRequest; readonly scope: Scope } => {
		if (request === null) {
			throw new ServerFault('facility_unbound', `'${reach.endpoint}' reads members, and the runtime adapter supplies no IAM membership transport`, 503)
		}
		const grant = refGrant(request, target)
		const value = grant.dimension === reach.dimension ? grant.id : grant.chain.get(reach.dimension)
		if (value === undefined) {
			throw new ServerFault(
				'directory_unlocated',
				`'${reach.endpoint}' reads the members of ${reach.dimension}, and no table locates the ${grant.dimension}'s ${reach.dimension}`,
			)
		}
		return { request, scope: { type: reach.dimension, value } }
	}
	const lookup: MemberLookup = {
		async get(principalId: string): Promise<Member | null> {
			const { request, scope } = directoryOf()
			if (typeof principalId !== 'string' || principalId === '') {
				return null
			}
			const found = await ask(() => request.iam.findMember(request.caller, scope, principalId, request.action), 'look up a member')
			if (found.member === null) {
				return null
			}
			if (found.member.principalId !== principalId) {
				throw new ServerFault('iam_answer_mismatch', `IAM answered '${found.member.principalId}' for a lookup of another principal`)
			}
			return Object.freeze({
				principalId: found.member.principalId,
				label: found.member.label,
				disabled: found.member.disabled,
				affiliation: found.member.affiliation,
			})
		},
	}
	if (!reach.lists) {
		return Object.freeze(lookup)
	}
	return Object.freeze({
		...lookup,
		async list(): Promise<readonly DirectoryMember[]> {
			const { request, scope } = directoryOf()
			const listed = await ask(() => request.iam.listMembers(request.caller, scope), 'list members')
			return Object.freeze(
				listed.members.map((member) =>
					Object.freeze({
						principalId: member.principalId,
						label: member.label,
						roles: Object.freeze([...member.roles]),
						disabled: member.disabled,
						affiliation: member.affiliation,
					})
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

/** The object of `grant` and every value containing it, outward: what IAM binds a link to. */
function chainOf(grant: RefGrant, containers: readonly string[]): Scope[] {
	const chain: Scope[] = [scopeOf(grant)]
	for (const container of containers) {
		const value = grant.chain.get(container)
		if (value !== undefined) {
			chain.push({ type: container, value })
		}
	}
	return chain
}

function issuedLink(issued: IssueLinkResult & { readonly ok: true }, prefix: string): IssuedLink {
	return Object.freeze({ id: issued.id, url: `${joinPath(prefix, '')}#${issued.key}`, expiresAt: issued.expiresAt })
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
			const chain = chainOf(grant, containers)
			const issued = await ask(() => request.iam.issueLink(request.caller, mount.name, chain, options.days), 'issue a share link')
			return issuedLink(issued, mount.prefix)
		},
		async revoke(id: string): Promise<void> {
			await ask(() => request.iam.revokeLink(request.caller, id), 'revoke a share link')
		},
	})
}

/** The link mount a cron job declares it `issues`, as the artifact states it. */
export interface JobLinkMount {
	readonly name: string
	readonly prefix: string
	readonly dimension: string
	readonly issuedBy: string
}

/** A job's authority at IAM: its link mount, and the token IAM signs from its key now. */
export interface JobLinkRequest {
	readonly iam: IamMembership
	readonly job: string
	readonly mount: JobLinkMount
	/** The mount dimension's containers, nearest first. */
	readonly containers: readonly string[]
	/** The job's current token and this attempt's id; it throws a 503 when IAM signs none. */
	caller(): Promise<MembershipRequestCaller>
	/** Throws once the attempt has ended. It runs synchronously right before each IAM operation, after every await. */
	assertLive(): void
	readonly capabilities: CapabilityAuthority
}

/**
 * `ctx.links` of a job that declares `issues`. IAM admits the job's token on `issueLink` and `revokeLink` only while the
 * approved schema says the job issues this mount, so a job holds no more than its declaration; it revokes only its own.
 */
export function jobLinkIssuing(request: JobLinkRequest): LinkIssuing<string, string, string> {
	const { mount } = request
	return Object.freeze({
		async issue(ref: unknown, options: { readonly mount: string; readonly days: number }): Promise<IssuedLink> {
			if (options.mount !== mount.name) {
				throw new ServerFault('link_mount', `'${options.mount}' is not the link mount job '${request.job}' issues (issues: '${mount.name}')`)
			}
			const grant = request.capabilities.resolve(ref)
			if (grant.kind !== 'ref' || grant.dimension !== mount.dimension || grant.action !== mount.issuedBy) {
				throw new CapabilityRefusedError(
					'wrong_target',
					`a link of '${mount.name}' is issued for ctx.ref('${mount.issuedBy}', '${mount.dimension}', id) of this attempt`,
				)
			}
			const chain = chainOf(grant, request.containers)
			const caller = await request.caller()
			request.assertLive()
			const issued = await ask(() => request.iam.issueLink(caller, mount.name, chain, options.days), 'issue a share link')
			return issuedLink(issued, mount.prefix)
		},
		async revoke(id: string): Promise<void> {
			const caller = await request.caller()
			request.assertLive()
			await ask(() => request.iam.revokeLink(caller, id), 'revoke a share link')
		},
	})
}
