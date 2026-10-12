// The test kit's stand-in for IAM's membership transport: it answers a member directory (`ctx.members.list()` and
// `get()`) from the kit's own callers, as IAM answers it from its grants. Scope creation, membership changes and share links need a
// real or a hand-written `IamMembershipRpc` (`testKit(app, { membership })`); the stand-in refuses them by name.

import {
	type ContractArtifact,
	directoryLookups,
	endpointMembers,
	type FindMemberInput,
	type FindMemberResult,
	type IamMembershipRpc,
	type ListMembersInput,
	type ListMembersResult,
	type MemberItem,
	type MembershipFailure,
	permits,
} from '@fabrika/auth-core'
import type { TestCaller, TestScope } from './caller'

/** A membership role a test caller holds in one scope value. */
export interface TestMembership {
	readonly role: string
	readonly scope: TestScope
}

export interface DirectoryCallers {
	/** The caller a membership request's credential (its token or `px_` key) belongs to. */
	byCredential(credential: string): TestCaller | undefined
	/** Every caller with its membership roles. */
	all(): readonly { readonly caller: TestCaller; readonly memberships: readonly TestMembership[] }[]
}

const ONLY_DIRECTORY: MembershipFailure = {
	ok: false,
	reason: 'invalid_request',
	message: 'the test kit answers member directories only: pass testKit(app, { membership }) for scopes, members and share links',
}

/**
 * Whether serving the contract writes through IAM: a `creates` endpoint, one of a dimension's `members.manage`, or one
 * whose action issues a link mount's keys. Such a contract gets no stand-in, so `boot` names the transport it lacks.
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

function listMembers(artifact: ContractArtifact, callers: DirectoryCallers, input: ListMembersInput): ListMembersResult {
	const caller = input.credential === null ? undefined : callers.byCredential(input.credential)
	if (caller === undefined) return { ok: false, reason: 'invalid_token' }
	const dimension = Object.hasOwn(artifact.dimensions, input.scope.type) ? artifact.dimensions[input.scope.type] : undefined
	if (dimension?.members === null || dimension?.members === undefined) {
		return { ok: false, reason: 'invalid_request', message: `scope '${input.scope.type}' declares no members` }
	}
	if (!permits([...caller.perms], dimension.members.list, input.scope)) return { ok: false, reason: 'not_allowed' }
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
		})
	}
	return { ok: true, members, invitations: [] }
}

/** The membership roles held in exactly `scope`, as IAM counts a member of its dimension. */
function rolesIn(artifact: ContractArtifact, memberships: readonly TestMembership[], scope: TestScope): string[] {
	return memberships
		.filter((held) => held.scope.type === scope.type && held.scope.value === scope.value && artifact.roles[held.role]?.member?.scope === scope.type)
		.map(({ role }) => role)
}

function findMember(artifact: ContractArtifact, callers: DirectoryCallers, input: FindMemberInput): FindMemberResult {
	const caller = input.credential === null ? undefined : callers.byCredential(input.credential)
	if (caller === undefined) return { ok: false, reason: 'invalid_token' }
	const dimension = Object.hasOwn(artifact.dimensions, input.scope.type) ? artifact.dimensions[input.scope.type] : undefined
	if (dimension?.members === null || dimension?.members === undefined) {
		return { ok: false, reason: 'invalid_request', message: `scope '${input.scope.type}' declares no members` }
	}
	// As IAM: one of the dimension's lookup actions, held on the directory's value itself.
	if (!directoryLookups(artifact, input.scope.type).includes(input.action) || !permits([...caller.perms], input.action, input.scope)) {
		return { ok: false, reason: 'not_allowed' }
	}
	const found = callers.all().find(({ caller: member, memberships }) =>
		member.id === input.principalId && rolesIn(artifact, memberships, input.scope).length > 0
	)
	if (found === undefined) return { ok: true, member: null }
	const manager = permits([...caller.perms], dimension.members.manage, input.scope)
	return {
		ok: true,
		member: { principalId: found.caller.id, label: manager || dimension.directory === 'labels' ? found.caller.label : null, disabled: false },
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
