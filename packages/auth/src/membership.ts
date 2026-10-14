import type {
	AssignMemberResult,
	CreateScopeResult,
	FindMemberResult,
	IamMembershipRpc,
	InvitationOptions,
	IssueLinkResult,
	ListAppMembersResult,
	ListMembersResult,
	MemberTarget,
	RequestDelegationResult,
	RevokeLinkResult,
	RevokeMemberInput,
	RevokeMemberResult,
	Scope,
} from '@fabrika/auth-core'

/**
 * The caller a membership request is made for: the verified token the proxy injected on THIS request, and
 * the request's correlation id. IAM resolves the caller from the token and checks its live permissions; a
 * delegation grant is bound to the request id, so both calls of one request carry the same one.
 */
export interface MembershipRequestCaller {
	readonly credential: string
	readonly requestId: string
}

/** The env `createIamMembership` reads; an application's `env` satisfies it structurally. */
export interface IamMembershipEnv {
	/** IAM's application entrypoint on Cloudflare, or `HttpIamRpc` off it. */
	IAM?: IamMembershipRpc
	FABRIKA_IAM_APP_ID?: string
}

/**
 * The SDK half of the membership operations. It REQUESTS, on the caller's behalf: IAM decides, generates
 * every value, writes every grant and issues every key. Nothing here mints, signs or names an actor, and
 * every result is IAM's answer as it came.
 */
export class IamMembership {
	constructor(
		private readonly binding: IamMembershipRpc,
		private readonly appId: string,
	) {}

	/** A single-use grant for one request to `endpoint`, which the app's schema lists as a membership endpoint. */
	requestDelegation(caller: MembershipRequestCaller, endpoint: string): Promise<RequestDelegationResult> {
		return this.binding.requestDelegation({ ...this.caller(caller), endpoint })
	}

	/** A new value of `dimension`, with the caller granted the dimension's creator role in it. */
	createScope(caller: MembershipRequestCaller, delegation: string, dimension: string): Promise<CreateScopeResult> {
		return this.binding.createScope({ ...this.caller(caller), delegation, dimension })
	}

	/** `invitation` goes with an address only: its label, message and resend (`InvitationOptions`). */
	assignMember(
		caller: MembershipRequestCaller,
		delegation: string,
		scope: Scope,
		role: string,
		member: MemberTarget,
		invitation?: InvitationOptions,
	): Promise<AssignMemberResult> {
		return this.binding.assignMember({ ...this.caller(caller), delegation, scope, role, member, ...(invitation === undefined ? {} : { invitation }) })
	}

	revokeMember(caller: MembershipRequestCaller, delegation: string, scope: Scope, member: RevokeMemberInput['member']): Promise<RevokeMemberResult> {
		return this.binding.revokeMember({ ...this.caller(caller), delegation, scope, member })
	}

	listMembers(caller: MembershipRequestCaller, scope: Scope): Promise<ListMembersResult> {
		return this.binding.listMembers({ ...this.caller(caller), scope })
	}

	/** One page of the application's own people; `after` is the previous page's `next`. */
	listAppMembers(caller: MembershipRequestCaller, after?: string): Promise<ListAppMembersResult> {
		return this.binding.listAppMembers({ ...this.caller(caller), ...(after === undefined ? {} : { after }) })
	}

	/** One principal among the members of `scope`, for an endpoint of `action` on, in or below its dimension. */
	findMember(caller: MembershipRequestCaller, scope: Scope, principalId: string, action: string): Promise<FindMemberResult> {
		return this.binding.findMember({ ...this.caller(caller), scope, principalId, action })
	}

	/** A share link of `mount` for `chain[0]`; `chain` is the object and every value containing it, outward. */
	issueLink(caller: MembershipRequestCaller, mount: string, chain: Scope[], days: number): Promise<IssueLinkResult> {
		return this.binding.issueLink({ ...this.caller(caller), mount, chain, days })
	}

	revokeLink(caller: MembershipRequestCaller, id: string): Promise<RevokeLinkResult> {
		return this.binding.revokeLink({ ...this.caller(caller), id })
	}

	private caller(caller: MembershipRequestCaller): { app: string; credential: string; requestId: string } {
		return { app: this.appId, credential: caller.credential, requestId: caller.requestId }
	}
}

/** Build the membership client from the env. Throws when the app id or the binding is missing. */
export function createIamMembership(env: IamMembershipEnv, opts: { appId?: string } = {}): IamMembership {
	const appId = opts.appId ?? env.FABRIKA_IAM_APP_ID
	if (appId === undefined || appId === '') {
		throw new Error('createIamMembership: app id is required — pass opts.appId or set env.FABRIKA_IAM_APP_ID')
	}
	if (env.IAM === undefined) {
		throw new Error('createIamMembership: the IAM binding is missing (env.IAM)')
	}
	return new IamMembership(env.IAM, appId)
}
