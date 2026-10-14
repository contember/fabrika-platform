// Scopes, members and share links on the caller's behalf (ADR-0012 §6). The framework asks IAM
// through `@fabrika/auth`'s `IamMembership`, with the caller's verified token and the delegation grant the proxy
// obtained for this request; IAM checks the caller's live permissions, generates every value and issues every key.
// The framework writes no grant and mints no credential.

import type { IamMembership, MembershipRequestCaller } from '@fabrika/auth'
import type {
	EndpointDirectory,
	InvitationItem,
	InvitationOptions,
	IssueLinkResult,
	MemberItem,
	MembershipFailure,
	PrincipalAffiliation,
	Scope,
} from '@fabrika/auth-core'
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
	/**
	 * Gives `role` in the value: an existing principal gets the grant, an address an invitation. Repeating it answers the
	 * same and sends nothing. For an address, `options` names the company (`label`, at most 200 characters on one line)
	 * and a personal `message` (at most 1000 characters of plain text) the e-mail carries, and `resend` gives an open
	 * invitation a new link and a new 7 days and sends it again; the old link stops working.
	 */
	assign(ref: Ref<D, A>, member: MemberTarget, role: R, options?: InvitationOptions): Promise<AssignedMember>
	/** Removes the member's roles there (only `role` when given), or cancels an invitation. Repeating it answers the same. */
	revoke(ref: Ref<D, A>, member: { readonly principalId: string; readonly role?: R } | { readonly invitationId: string }): Promise<void>
}

/** One member of the target, as a member directory lists it. */
export interface DirectoryMember<L extends string | null = string | null> {
	readonly principalId: string
	/**
	 * The principal's display label (a user's spelling of its address): `string` where the directory's dimension declares
	 * `directory: 'labels'`, since IAM then answers it to every caller; elsewhere null unless the caller manages its members.
	 */
	readonly label: L
	/** Its membership roles in the target. */
	readonly roles: readonly string[]
	readonly disabled: boolean
	/** `external`: a person from outside the organization (ADR-0051), for a staff UI to show. */
	readonly affiliation: PrincipalAffiliation
}

/** One member a lookup found: never its email, and its label only where the directory shows labels. */
export interface Member<L extends string | null = string | null> {
	readonly principalId: string
	/** The principal's display label, as `DirectoryMember.label`. */
	readonly label: L
	readonly disabled: boolean
	readonly affiliation: PrincipalAffiliation
}

/**
 * `ctx.members` of an endpoint on or in a dimension below a member directory (its own dimension's, or the nearest one
 * containing it): the members of the value its object lies in. IAM checks the endpoint's own action on that value.
 */
export interface MemberLookup<L extends string | null = string | null> {
	/** The principal, when it is a member of the directory's value; null otherwise, an unknown id included. */
	get(principalId: string): Promise<Member<L> | null>
}

/**
 * `ctx.members` of an endpoint whose action is the directory's `members.list`: also every member, read from IAM, which
 * checks that action live on the directory's value. No emails and no invitations: those stay with `members.manage`.
 */
export interface MemberDirectory<L extends string | null = string | null> extends MemberLookup<L> {
	list(): Promise<readonly DirectoryMember<L>[]>
}

/** One role a person holds at the application: globally (`scope: null`), or in one value. */
export interface ApplicationMemberRole {
	readonly role: string
	readonly scope: Scope | null
}

/** One of the application's own people, as its directory lists them. */
export interface ApplicationMember {
	readonly principalId: string
	/** The principal's display label; null unless the vocabulary declares `directory: 'labels'` or the caller manages the people. */
	readonly label: string | null
	/** The person's address; null unless the caller holds the application's `members.manage` globally. */
	readonly email: string | null
	/** Unix seconds of the person's last sign-in to the application; null for one who never did, and as `email`. */
	readonly lastSignInAt: number | null
	/** Every role the person holds at the application, a global one first. */
	readonly roles: readonly ApplicationMemberRole[]
	readonly disabled: boolean
	readonly affiliation: PrincipalAffiliation
}

export interface ApplicationMemberPage {
	readonly members: readonly ApplicationMember[]
	/** The `after` of the following page; null on the last one. */
	readonly next: string | null
}

/**
 * `ctx.members` of an `app: true` endpoint whose action is the application's `members.list`: every principal holding a
 * role of the application, globally or in a value, a page of at most 100 at a time. IAM checks the action live.
 */
export interface ApplicationDirectory {
	list(options?: { readonly after?: string | undefined }): Promise<ApplicationMemberPage>
}

/**
 * The application's own directory, read from IAM with the caller's token. A runtime without an IAM membership transport
 * still boots, and only a call fails.
 */
export function applicationDirectory(iam: IamMembership | null, caller: MembershipRequestCaller, endpoint: string): ApplicationDirectory {
	return Object.freeze({
		async list(options?: { readonly after?: string | undefined }): Promise<ApplicationMemberPage> {
			if (iam === null) {
				throw new ServerFault(
					'facility_unbound',
					`'${endpoint}' reads the application's people, and the runtime adapter supplies no IAM membership transport`,
					503,
				)
			}
			const after = options?.after
			if (after !== undefined && (typeof after !== 'string' || after === '')) {
				throw new HttpError(400, 'invalid_request', "after is the next of a previous page of the application's people")
			}
			const listed = await ask(() => iam.listAppMembers(caller, after), "list the application's people")
			return Object.freeze({
				members: Object.freeze(
					listed.members.map((member) =>
						Object.freeze({
							principalId: member.principalId,
							label: member.label,
							email: member.email,
							lastSignInAt: member.lastSignInAt,
							roles: Object.freeze(member.roles.map((held) => Object.freeze({ role: held.role, scope: held.scope }))),
							disabled: member.disabled,
							affiliation: member.affiliation,
						})
					),
				),
				next: listed.next,
			})
		},
	})
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
		case 'internal_mailbox':
			return new HttpError(
				409,
				'internal_mailbox',
				'The organization names this address, so IAM never creates it as an external person; it signs in through the organization first',
			)
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
		async assign(ref: unknown, member: MemberTarget, role: string, options?: InvitationOptions): Promise<AssignedMember> {
			const scope = scopeOf(refGrant(request, ref))
			const target = 'email' in member ? { email: member.email } : { principalId: member.principalId }
			const assigned = await ask(
				() => request.iam.assignMember(request.caller, delegationOf(request), scope, role, target, invitationOptionsOf(options)),
				'assign a member',
			)
			return 'assigned' in assigned ? { assigned: assigned.assigned } : { invited: assigned.invited }
		},
		async revoke(ref: unknown, member: { readonly principalId: string; readonly role?: string } | { readonly invitationId: string }): Promise<void> {
			const scope = scopeOf(refGrant(request, ref))
			const target = 'invitationId' in member ? { invitationId: member.invitationId } : { principalId: member.principalId, role: member.role ?? null }
			await ask(() => request.iam.revokeMember(request.caller, delegationOf(request), scope, target), 'revoke a member')
		},
	})
}

/** The invitation options as IAM takes them: only the fields given, each of its own type, so a handler's extra keys stay here. */
function invitationOptionsOf(options: InvitationOptions | undefined): InvitationOptions | undefined {
	if (options === undefined) return undefined
	return {
		...(options.label === undefined ? {} : { label: options.label }),
		...(options.message === undefined ? {} : { message: options.message }),
		...(options.resend === undefined ? {} : { resend: options.resend }),
	}
}

/** The directory an endpoint reads (`endpointDirectory`), and whether its dimension declares `directory: 'labels'`. */
export interface ReadDirectory extends EndpointDirectory {
	readonly labels: boolean
}

/** The directory an endpoint reads, with the endpoint a fault names. */
export interface DirectoryReach extends ReadDirectory {
	readonly endpoint: string
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
	// IAM answers every member's label under a labels directory, and the type promises one: a null there is a fault.
	const labelOf = (label: string | null): string | null => {
		if (reach.labels && label === null) {
			throw new ServerFault('iam_answer_unlabelled', `IAM answered a member of ${reach.dimension} without a label, and its directory shows labels`)
		}
		return label
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
				label: labelOf(found.member.label),
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
						label: labelOf(member.label),
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
