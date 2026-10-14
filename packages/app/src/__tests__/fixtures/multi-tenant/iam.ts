// A stand-in for IAM's membership operations: it records every request and answers what the test set. IAM's own
// rules are IAM's tests; these check what the framework sends and how it treats each answer.

import type {
	AssignMemberInput,
	AssignMemberResult,
	CreateScopeInput,
	CreateScopeResult,
	FindMemberInput,
	FindMemberResult,
	IamMembershipRpc,
	IssueLinkInput,
	IssueLinkResult,
	ListMembersInput,
	ListMembersResult,
	MembershipFailure,
	RequestDelegationInput,
	RequestDelegationResult,
	RevokeLinkInput,
	RevokeLinkResult,
	RevokeMemberInput,
	RevokeMemberResult,
} from '@fabrika/auth-core'

export type MembershipCall =
	| { readonly method: 'createScope'; readonly input: CreateScopeInput }
	| { readonly method: 'assignMember'; readonly input: AssignMemberInput }
	| { readonly method: 'revokeMember'; readonly input: RevokeMemberInput }
	| { readonly method: 'listMembers'; readonly input: ListMembersInput }
	| { readonly method: 'findMember'; readonly input: FindMemberInput }
	| { readonly method: 'issueLink'; readonly input: IssueLinkInput }
	| { readonly method: 'revokeLink'; readonly input: RevokeLinkInput }

export class RecordingMembership implements IamMembershipRpc {
	readonly calls: MembershipCall[] = []
	/** The delegation grants a proxy asked for: the test kit's proxy asks here, the framework never does. */
	readonly delegations: RequestDelegationInput[] = []
	/** The next answer's refusal, or `null` to succeed. */
	refuse: MembershipFailure | null = null
	/** Throw instead of answering, as a transport failure does. */
	unreachable = false

	#answer<T>(success: T): T | MembershipFailure {
		if (this.unreachable) {
			throw new Error('IAM is down')
		}
		const refusal = this.refuse
		this.refuse = null
		return refusal ?? success
	}

	async requestDelegation(input: RequestDelegationInput): Promise<RequestDelegationResult> {
		this.delegations.push(input)
		return { ok: true, grant: `grant-for-${input.requestId}`, expiresAt: 1 }
	}

	async createScope(input: CreateScopeInput): Promise<CreateScopeResult> {
		this.calls.push({ method: 'createScope', input })
		return this.#answer({ ok: true, scope: { type: input.dimension, value: 'w-new' }, role: 'owner' })
	}

	async assignMember(input: AssignMemberInput): Promise<AssignMemberResult> {
		this.calls.push({ method: 'assignMember', input })
		return this.#answer({ ok: true, invited: { invitationId: 'inv-1', role: input.role, expiresAt: 1 } })
	}

	async revokeMember(input: RevokeMemberInput): Promise<RevokeMemberResult> {
		this.calls.push({ method: 'revokeMember', input })
		return this.#answer({ ok: true })
	}

	async listMembers(input: ListMembersInput): Promise<ListMembersResult> {
		this.calls.push({ method: 'listMembers', input })
		return this.#answer({
			ok: true,
			members: [{ principalId: 'user-1', label: null, email: null, lastSignInAt: null, roles: ['owner'], disabled: false, affiliation: 'internal' }],
			invitations: [],
		})
	}

	async findMember(input: FindMemberInput): Promise<FindMemberResult> {
		this.calls.push({ method: 'findMember', input })
		return this.#answer({
			ok: true,
			member: input.principalId === 'user-1' ? { principalId: 'user-1', label: null, disabled: false, affiliation: 'internal' } : null,
		})
	}

	async issueLink(input: IssueLinkInput): Promise<IssueLinkResult> {
		this.calls.push({ method: 'issueLink', input })
		return this.#answer({ ok: true, key: 'px_sharedkey123', id: 'link-1', expiresAt: 2 })
	}

	async revokeLink(input: RevokeLinkInput): Promise<RevokeLinkResult> {
		this.calls.push({ method: 'revokeLink', input })
		return this.#answer({ ok: true })
	}
}
