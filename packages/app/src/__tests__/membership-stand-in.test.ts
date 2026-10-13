// The endpoint access kit's stand-in for IAM's membership writes: each operation answers under IAM's rules for the
// caller's grants and spends one delegation grant, and none of them grants the kit's callers anything.

import type { MembershipCaller, MemberTarget, PermissionEntry, Scope } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { compileContract } from '../contract/compile'
import type { LabelledTestCaller, LinkTestCaller, TestCaller } from '../testing/caller'
import { kitMembership, type TestMembership } from '../testing/membership'
import { contract } from './fixtures/multi-tenant/fabrika.contract'
import { tables } from './fixtures/multi-tenant/src/db/tables'

const artifact = compileContract(contract, tables)
const ACME: Scope = { type: 'workspace', value: 'acme' }
const OTHER: Scope = { type: 'workspace', value: 'other' }
const NOTE: Scope = { type: 'note', value: 'n-1' }

const entry = (action: string, scope: Scope | null = null): PermissionEntry => ({ action, scope, source: 'grant' })
const roleEntries = (role: 'owner' | 'editor', scope: Scope): PermissionEntry[] =>
	(artifact.roles[role]?.grants ?? []).map((action) => entry(action, scope))

/** The kit's callers, each with its credential, its permissions and its membership roles. */
function callersOf(...callers: { readonly caller: TestCaller; readonly memberships: readonly TestMembership[] }[]) {
	return {
		byCredential: (credential: string) => callers.find(({ caller }) => caller.key === credential)?.caller,
		all: () => callers,
	}
}

function person(id: string, perms: readonly PermissionEntry[], kind: LabelledTestCaller['kind'] = 'human'): LabelledTestCaller {
	return { kind, app: null, link: null, id, label: `${id}@notes.test`, perms, key: `px_${id}`, cookie: null }
}

const holder: LinkTestCaller = {
	kind: 'link',
	app: null,
	link: { mount: 'shared', chain: [NOTE, ACME] },
	id: 'link-1',
	label: null,
	perms: [entry('notes.read', NOTE)],
	key: 'px_holder',
	cookie: null,
}

const owner = person('owner', roleEntries('owner', ACME))
const editor = person('editor', roleEntries('editor', ACME))
const manager = person('manager', [entry('notes.admin', ACME), ...roleEntries('editor', ACME)])
const starter = person('starter', [entry('workspaces.create')])
const scopedStarter = person('scoped-starter', [entry('workspaces.create', ACME)])
const script = person('script', [entry('workspaces.create')], 'machine')
const sharer = person('sharer', [entry('notes.share', ACME)])
const outsider = person('outsider', roleEntries('owner', OTHER))

const standIn = () =>
	kitMembership(
		artifact,
		callersOf(
			{ caller: owner, memberships: [{ role: 'owner', scope: ACME }] },
			{ caller: editor, memberships: [{ role: 'editor', scope: ACME }] },
			{ caller: manager, memberships: [{ role: 'editor', scope: ACME }] },
			{ caller: starter, memberships: [] },
			{ caller: scopedStarter, memberships: [] },
			{ caller: script, memberships: [] },
			{ caller: sharer, memberships: [] },
			{ caller: outsider, memberships: [{ role: 'owner', scope: OTHER }] },
			{ caller: holder, memberships: [] },
		),
	)

const as = (caller: TestCaller, requestId = 'req-1'): MembershipCaller => ({ app: 'notes@test', credential: caller.key, requestId })

/** A grant the proxy would obtain for `endpoint`, or the refusal's reason. */
async function delegation(membership: ReturnType<typeof standIn>, caller: TestCaller, endpoint: string, requestId = 'req-1'): Promise<string> {
	const granted = await membership.rpc.requestDelegation({ ...as(caller, requestId), endpoint })
	return granted.ok ? granted.grant : granted.reason
}

describe('the stand-in issues a delegation grant as IAM does', () => {
	test('to a person who holds the endpoint action somewhere, for an endpoint that spends one', async () => {
		const membership = standIn()
		expect(await delegation(membership, owner, 'api.members.invite')).toStartWith('grant_')
		expect(await delegation(membership, editor, 'api.members.invite')).toBe('not_allowed')
		expect(await delegation(membership, script, 'api.workspaces.create')).toBe('not_allowed')
		expect(await delegation(membership, owner, 'api.notes.get')).toBe('invalid_request')
	})

	test('a grant is spent once, by its own caller and request, and a mismatched attempt spends it too', async () => {
		const membership = standIn()
		const invite = { scope: ACME, role: 'editor', member: { email: 'ann@example.test' } }
		const grant = await delegation(membership, owner, 'api.members.invite')
		expect(await membership.rpc.assignMember({ ...as(owner, 'req-2'), delegation: grant, ...invite })).toMatchObject({ reason: 'invalid_delegation' })
		expect(await membership.rpc.assignMember({ ...as(owner), delegation: grant, ...invite })).toMatchObject({ reason: 'invalid_delegation' })
		const fresh = await delegation(membership, owner, 'api.members.invite')
		expect(await membership.rpc.assignMember({ ...as(owner), delegation: fresh, ...invite })).toMatchObject({ ok: true })
		expect(await membership.rpc.assignMember({ ...as(owner), delegation: fresh, ...invite })).toMatchObject({ reason: 'invalid_delegation' })
	})
})

describe('the stand-in creates a scope for a global holder of the creating action only', () => {
	test('a global grant creates a new value with the creator role; a grant in one value is not_allowed', async () => {
		const membership = standIn()
		const created = await membership.rpc.createScope({
			...as(starter),
			delegation: await delegation(membership, starter, 'api.workspaces.create'),
			dimension: 'workspace',
		})
		expect(created).toMatchObject({ ok: true, scope: { type: 'workspace' }, role: 'owner' })
		const refused = await membership.rpc.createScope({
			...as(scopedStarter),
			delegation: await delegation(membership, scopedStarter, 'api.workspaces.create'),
			dimension: 'workspace',
		})
		expect(refused).toEqual({ ok: false, reason: 'not_allowed' })
		expect(membership.asked.map((write) => `${write.operation} ${write.principalId}`)).toEqual(['createScope starter'])
	})
})

describe('the stand-in assigns and revokes under members.manage, assignableBy and the role ceiling', () => {
	const assign = async (
		membership: ReturnType<typeof standIn>,
		caller: TestCaller,
		scope: Scope,
		role: string,
		member: MemberTarget = { email: 'ann@example.test' },
	) => membership.rpc.assignMember({ ...as(caller), delegation: await delegation(membership, caller, 'api.members.invite'), scope, role, member })

	test('an owner invites an address and assigns a known person; neither changes the directory', async () => {
		const membership = standIn()
		expect(await assign(membership, owner, ACME, 'editor')).toMatchObject({ ok: true, invited: { role: 'editor' } })
		expect(await assign(membership, owner, ACME, 'owner', { principalId: 'starter' })).toMatchObject({
			ok: true,
			assigned: { principalId: 'starter', role: 'owner' },
		})
		expect(await assign(membership, owner, ACME, 'editor', { principalId: 'nobody' })).toEqual({ ok: false, reason: 'not_found' })
		const listed = await membership.rpc.listMembers({ ...as(owner), scope: ACME })
		expect(listed.ok ? listed.members.map((member) => member.principalId).sort() : listed.reason).toEqual(['editor', 'manager', 'owner'])
	})

	test('members.manage counts in the value itself; a holder of it without an assigning role is not_allowed', async () => {
		const membership = standIn()
		expect(await assign(membership, owner, OTHER, 'editor')).toEqual({ ok: false, reason: 'not_allowed' })
		expect(await assign(membership, manager, ACME, 'editor')).toEqual({ ok: false, reason: 'not_allowed' })
		expect(await assign(membership, owner, ACME, 'starter')).toMatchObject({ reason: 'invalid_request' })
	})

	test('a revoke needs the authority to assign each role it removes; an unknown invitation is not_found', async () => {
		const membership = standIn()
		const revoke = async (caller: TestCaller, member: { principalId: string } | { invitationId: string }) =>
			membership.rpc.revokeMember({ ...as(caller), delegation: await delegation(membership, caller, 'api.members.remove'), scope: ACME, member })
		expect(await revoke(owner, { principalId: 'editor' })).toEqual({ ok: true })
		expect(await revoke(manager, { principalId: 'editor' })).toEqual({ ok: false, reason: 'not_allowed' })
		expect(await revoke(owner, { invitationId: 'invitation-unknown' })).toEqual({ ok: false, reason: 'not_found' })
		const invited = await assign(membership, owner, ACME, 'editor')
		const invitationId = invited.ok && 'invited' in invited ? invited.invited.invitationId : ''
		expect(await revoke(owner, { invitationId })).toEqual({ ok: true })
	})
})

describe('the stand-in issues a share link for a holder of issuedBy and every granted action on the chain', () => {
	const issue = (membership: ReturnType<typeof standIn>, caller: TestCaller, chain: Scope[] = [NOTE, ACME], days = 7) =>
		membership.rpc.issueLink({ ...as(caller), mount: 'shared', chain, days })

	test('an owner issues; a holder of notes.share without notes.read, a link holder and a bad chain or expiry do not', async () => {
		const membership = standIn()
		expect(await issue(membership, owner)).toMatchObject({ ok: true, key: expect.stringMatching(/^px_/) })
		expect(await issue(membership, sharer)).toEqual({ ok: false, reason: 'not_allowed' })
		expect(await issue(membership, holder)).toEqual({ ok: false, reason: 'not_allowed' })
		expect(await issue(membership, owner, [NOTE])).toMatchObject({ reason: 'invalid_request' })
		expect(await issue(membership, owner, [ACME])).toMatchObject({ reason: 'invalid_request' })
		expect(await issue(membership, owner, [NOTE, ACME], 31)).toMatchObject({ reason: 'invalid_request' })
	})

	test('its issuer or a members.manage holder on its chain revokes it; another caller and an unknown id do not', async () => {
		const membership = standIn()
		const issued = await issue(membership, editor)
		const id = issued.ok ? issued.id : ''
		expect(await membership.rpc.revokeLink({ ...as(outsider), id })).toEqual({ ok: false, reason: 'not_allowed' })
		expect(await membership.rpc.revokeLink({ ...as(owner), id })).toEqual({ ok: true })
		expect(await membership.rpc.revokeLink({ ...as(editor), id: 'link-unknown' })).toEqual({ ok: false, reason: 'not_found' })
	})
})
