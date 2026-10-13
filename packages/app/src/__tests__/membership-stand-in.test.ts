// The endpoint access kit's stand-in for IAM's membership writes: each operation answers under IAM's rules for the
// caller's grants and spends one delegation grant, and none of them grants the kit's callers anything.

import { defineContract } from '@fabrika/app/contract'
import {
	DELEGATION_GRANT_TTL_SECONDS,
	MAX_INVITATION_EMAIL_LENGTH,
	MAX_LINK_CHAIN_LENGTH,
	MAX_MEMBERSHIP_SCOPE_PART_LENGTH,
	type MembershipCaller,
	type MemberTarget,
	type PermissionEntry,
	type Scope,
} from '@fabrika/auth-core'
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { z } from 'zod/v4'
import { compileContract } from '../contract/compile'
import type { LabelledTestCaller, LinkTestCaller, TestCaller } from '../testing/caller'
import { managerGrants } from '../testing/endpoint-access'
import { credentialCallers, kitMembership, type MintedToken, type TestMembership } from '../testing/membership'
import { contract } from './fixtures/multi-tenant/fabrika.contract'
import { tables } from './fixtures/multi-tenant/src/db/tables'

const artifact = compileContract(contract, tables)
const ACME: Scope = { type: 'workspace', value: 'acme' }
const OTHER: Scope = { type: 'workspace', value: 'other' }
const NOTE: Scope = { type: 'note', value: 'n-1' }

const entry = (action: string, scope: Scope | null = null): PermissionEntry => ({ action, scope, source: 'grant' })
const roleEntries = (role: 'owner' | 'editor', scope: Scope): PermissionEntry[] =>
	(artifact.roles[role]?.grants ?? []).map((action) => entry(action, scope))

const APP = 'notes@test'

type Held = { readonly caller: TestCaller; readonly memberships: readonly TestMembership[] }

/** The kit's callers of `APP`, each with its `px_` key, its permissions and its membership roles. */
function callersOf(callers: readonly Held[], tokens: ReadonlyMap<string, MintedToken> = new Map()) {
	const keys = new Map(callers.flatMap(({ caller }) => (caller.key === null ? [] : [[caller.key, caller] as const])))
	return credentialCallers(APP, keys, tokens, () => callers)
}

function person(id: string, perms: readonly PermissionEntry[], kind: LabelledTestCaller['kind'] = 'human'): LabelledTestCaller {
	return { kind, app: null, link: null, id, label: `${id}@notes.test`, affiliation: 'internal', perms, key: `px_${id}`, cookie: null }
}

const holder: LinkTestCaller = {
	kind: 'link',
	app: null,
	link: { mount: 'shared', chain: [NOTE, ACME] },
	id: 'link-1',
	label: null,
	affiliation: 'internal',
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
const coOwner = person('co-owner', roleEntries('owner', ACME))
const connector = person('connector', [entry('notes.share', ACME), entry('notes.read', ACME), entry('notes.admin', ACME)], 'app')

const standIn = (extra: readonly Held[] = []) =>
	kitMembership(
		artifact,
		callersOf([
			...extra,
			{ caller: owner, memberships: [{ role: 'owner', scope: ACME }] },
			{ caller: editor, memberships: [{ role: 'editor', scope: ACME }] },
			{ caller: manager, memberships: [{ role: 'editor', scope: ACME }] },
			{ caller: starter, memberships: [] },
			{ caller: scopedStarter, memberships: [] },
			{ caller: script, memberships: [] },
			{ caller: sharer, memberships: [] },
			{ caller: outsider, memberships: [{ role: 'owner', scope: OTHER }] },
			{ caller: holder, memberships: [] },
			{ caller: connector, memberships: [] },
		]),
	)

const as = (caller: TestCaller, requestId = 'req-1'): MembershipCaller => ({ app: APP, credential: caller.key, requestId })

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

	test('an external person is assigned only a role the contract declares external, as IAM does', async () => {
		const partner: LabelledTestCaller = { ...person('partner', []), affiliation: 'external' }
		const membership = standIn([{ caller: partner, memberships: [] }])
		expect(await assign(membership, owner, ACME, 'editor', { principalId: 'partner' })).toMatchObject({ ok: false, reason: 'invalid_request' })
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
		expect(await revoke(manager, { principalId: 'editor' })).toEqual({ ok: false, reason: 'not_allowed' })
		expect(await revoke(owner, { principalId: 'editor' })).toEqual({ ok: true })
		expect(await revoke(manager, { principalId: 'editor' })).toEqual({ ok: true })
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

describe('the stand-in keeps the last creator, as IAM does', () => {
	const revoke = async (membership: ReturnType<typeof standIn>, caller: TestCaller, principalId: string) =>
		membership.rpc.revokeMember({
			...as(caller),
			delegation: await delegation(membership, caller, 'api.members.remove'),
			scope: ACME,
			member: { principalId },
		})

	test("the only owner's own revoke is last_creator", async () => {
		expect(await revoke(standIn(), owner, 'owner')).toEqual({ ok: false, reason: 'last_creator' })
	})

	test('with another owner one revoke passes, and the next one of the remaining owner is last_creator', async () => {
		const membership = standIn([{ caller: coOwner, memberships: [{ role: 'owner', scope: ACME }] }])
		expect(await revoke(membership, owner, 'co-owner')).toEqual({ ok: true })
		expect(await revoke(membership, owner, 'owner')).toEqual({ ok: false, reason: 'last_creator' })
	})

	test('an owner it revoked assigns nothing more, as IAM reads the live grants', async () => {
		const membership = standIn([{ caller: coOwner, memberships: [{ role: 'owner', scope: ACME }] }])
		expect(await revoke(membership, owner, 'co-owner')).toEqual({ ok: true })
		const invited = await membership.rpc.assignMember({
			...as(coOwner),
			delegation: await delegation(membership, coOwner, 'api.members.invite'),
			scope: ACME,
			role: 'editor',
			member: { email: 'ann@example.test' },
		})
		expect(invited).toEqual({ ok: false, reason: 'not_allowed' })
	})

	test("a creator's own revoke in the value it just created is last_creator, and the directory shows nobody new", async () => {
		const founder = person('founder', ['workspaces.create', 'notes.read', 'notes.write', 'notes.share', 'notes.admin'].map((action) => entry(action)))
		const membership = standIn([{ caller: founder, memberships: [] }])
		const created = await membership.rpc.createScope({
			...as(founder),
			delegation: await delegation(membership, founder, 'api.workspaces.create'),
			dimension: 'workspace',
		})
		const scope = created.ok ? created.scope : ACME
		expect(created).toMatchObject({ ok: true, role: 'owner' })
		const revoked = await membership.rpc.revokeMember({
			...as(founder),
			delegation: await delegation(membership, founder, 'api.members.remove'),
			scope,
			member: { principalId: 'founder' },
		})
		expect(revoked).toEqual({ ok: false, reason: 'last_creator' })
		expect(await membership.rpc.listMembers({ ...as(founder), scope })).toEqual({ ok: true, members: [], invitations: [] })
	})

	test('an owner it assigned counts as another holder, and the directory still shows nobody new', async () => {
		const membership = standIn()
		const assigned = await membership.rpc.assignMember({
			...as(owner),
			delegation: await delegation(membership, owner, 'api.members.invite'),
			scope: ACME,
			role: 'owner',
			member: { principalId: 'starter' },
		})
		expect(assigned).toMatchObject({ ok: true })
		expect(await revoke(membership, owner, 'owner')).toEqual({ ok: true })
		const listed = await membership.rpc.listMembers({ ...as(owner), scope: ACME })
		expect(listed.ok ? listed.members.map((member) => member.principalId).sort() : listed.reason).toEqual(['editor', 'manager', 'owner'])
	})
})

describe("the stand-in applies IAM's input bounds", () => {
	const longest = 'v'.repeat(MAX_MEMBERSHIP_SCOPE_PART_LENGTH)

	test('a scope type or value is 1 to the maximum characters', async () => {
		const membership = standIn()
		const list = (scope: Scope) => membership.rpc.listMembers({ ...as(owner), scope })
		expect(await list({ type: 'workspace', value: '' })).toMatchObject({ reason: 'invalid_request' })
		expect(await list({ type: 'workspace', value: `${longest}v` })).toMatchObject({ reason: 'invalid_request' })
		expect(await list({ type: 'workspace', value: longest })).toEqual({ ok: false, reason: 'not_allowed' })
		const assigned = await membership.rpc.assignMember({
			...as(owner),
			delegation: await delegation(membership, owner, 'api.members.invite'),
			scope: { type: 'workspace', value: '' },
			role: 'editor',
			member: { email: 'ann@example.test' },
		})
		expect(assigned).toMatchObject({ reason: 'invalid_request' })
	})

	test('a link chain names at most the maximum values, each one in bounds', async () => {
		const membership = standIn()
		const issue = (chain: Scope[]) => membership.rpc.issueLink({ ...as(owner), mount: 'shared', chain, days: 1 })
		expect(await issue([{ type: 'note', value: '' }, ACME])).toMatchObject({ reason: 'invalid_request' })
		const tooLong = Array.from({ length: MAX_LINK_CHAIN_LENGTH + 1 }, () => NOTE)
		expect(await issue(tooLong)).toEqual({ ok: false, reason: 'invalid_request', message: `a link chain names 1 to ${MAX_LINK_CHAIN_LENGTH} values` })
	})

	test('an invited address is normalized and at most the maximum length', async () => {
		const membership = standIn()
		const invite = async (email: string) =>
			membership.rpc.assignMember({
				...as(owner),
				delegation: await delegation(membership, owner, 'api.members.invite'),
				scope: ACME,
				role: 'editor',
				member: { email },
			})
		const local = 'a'.repeat(MAX_INVITATION_EMAIL_LENGTH - '@example.test'.length)
		expect(await invite(`${local}a@example.test`)).toMatchObject({ reason: 'invalid_request' })
		expect(await invite(` Ann@Example.TEST `)).toMatchObject({ ok: true })
		const [write] = membership.asked
		expect(write?.operation === 'assignMember' ? write.member : null).toEqual({ email: 'ann@example.test' })
		expect(await invite(`${local}@example.test`)).toMatchObject({ ok: true })
	})

	test('a lookup of an empty or too long principal id finds no member', async () => {
		const blank = person('', roleEntries('editor', ACME))
		const membership = standIn([{ caller: blank, memberships: [{ role: 'editor', scope: ACME }] }])
		const find = (principalId: string) => membership.rpc.findMember({ ...as(owner), scope: ACME, principalId, action: 'notes.read' })
		expect(await find('')).toEqual({ ok: true, member: null })
		expect(await find(`${longest}v`)).toEqual({ ok: true, member: null })
		expect(await find('editor')).toMatchObject({ ok: true, member: { principalId: 'editor' } })
	})
})

describe('the stand-in resolves a credential as IAM does', () => {
	test('a credential presented for another application is invalid_token', async () => {
		const membership = standIn()
		const asked = await membership.rpc.requestDelegation({ ...as(owner), app: 'other@test', endpoint: 'api.members.invite' })
		expect(asked).toEqual({ ok: false, reason: 'invalid_token' })
	})

	test("another application's connector manages no member, lists none and issues no link", async () => {
		const membership = standIn()
		expect(await membership.rpc.requestDelegation({ ...as(connector), endpoint: 'api.members.invite' })).toEqual({ ok: false, reason: 'invalid_token' })
		expect(await membership.rpc.listMembers({ ...as(connector), scope: ACME })).toEqual({ ok: false, reason: 'invalid_token' })
		expect(await membership.rpc.issueLink({ ...as(connector), mount: 'shared', chain: [NOTE, ACME], days: 1 })).toEqual({
			ok: false,
			reason: 'invalid_token',
		})
	})

	test('a token counts until its exp, and not at it', () => {
		const at = Math.floor(Date.now() / 1000)
		const tokens = new Map<string, MintedToken>([['live', { caller: owner, expiresAt: at + 60 }], ['spent', { caller: owner, expiresAt: at }]])
		const callers = callersOf([], tokens)
		expect(callers.byCredential(APP, 'live')).toBe(owner)
		expect(callers.byCredential(APP, 'spent')).toBeUndefined()
		expect(callers.byCredential('other@test', 'live')).toBeUndefined()
	})
})

describe('a delegation grant expires at its expiresAt, as IAM consumes it', () => {
	afterEach(() => {
		setSystemTime()
	})

	test('a grant spent one second before it passes; one spent at it is invalid_delegation', async () => {
		const start = new Date('2026-10-13T12:00:00Z')
		const revokeAt = async (offset: number) => {
			setSystemTime(start)
			const membership = standIn()
			const grant = await delegation(membership, owner, 'api.members.remove')
			setSystemTime(new Date(start.getTime() + offset * 1000))
			return membership.rpc.revokeMember({ ...as(owner), delegation: grant, scope: ACME, member: { principalId: 'editor' } })
		}
		expect(await revokeAt(DELEGATION_GRANT_TTL_SECONDS - 1)).toEqual({ ok: true })
		expect(await revokeAt(DELEGATION_GRANT_TTL_SECONDS)).toEqual({ ok: false, reason: 'invalid_delegation' })
	})
})

describe('a member manager of the generated cases holds the least IAM requires', () => {
	const team = compileContract(
		defineContract({
			app: 'teams',
			dimensions: { team: { members: { manage: 'teams.admin', list: 'teams.read' } } },
			actions: { 'teams.read': 'Read', 'teams.write': 'Write', 'teams.audit': 'Audit', 'teams.admin': 'Manage members' },
			roles: {
				viewer: { grants: ['teams.read'], member: { scope: 'team', assignableBy: ['lead'] } },
				editor: { grants: ['teams.read', 'teams.write'], member: { scope: 'team', assignableBy: ['lead', 'editor'] } },
				auditor: { grants: ['teams.read', 'teams.audit'], member: { scope: 'team', assignableBy: ['lead'] } },
				lead: { grants: ['teams.read', 'teams.write', 'teams.admin'], member: { scope: 'team', assignableBy: ['lead'] } },
			},
		}, (c) => ({
			api: c.rpc('/api', { callers: ['human'] }, {
				invite: c.mutation({
					input: z.strictObject({ teamId: z.string(), role: z.string() }),
					output: z.strictObject({ ok: z.boolean() }),
					access: { action: 'teams.admin', in: 'team', from: 'teamId' },
				}),
			}),
		})),
		{},
	)
	const scope = { type: 'team', value: 't-1' }

	test('the role the input names: one assigning role and its actions, no other role', () => {
		expect(managerGrants(team, 'teams.admin', { teamId: 't-1', role: 'editor' }, scope)).toEqual([
			{ action: 'teams.admin', scope },
			{ action: 'teams.read', scope },
			{ action: 'teams.write', scope },
			{ role: 'editor', scope },
		])
	})

	test('the assigner is the role that adds the fewest actions beyond those held anyway, not the one with fewest grants', () => {
		const shop = compileContract(
			defineContract({
				app: 'shop',
				dimensions: { team: { members: { manage: 'teams.admin', list: 'teams.read' } } },
				actions: { 'teams.read': 'Read', 'teams.write': 'Write', 'teams.audit': 'Audit', 'teams.admin': 'Manage members' },
				roles: {
					editor: { grants: ['teams.read', 'teams.write'], member: { scope: 'team', assignableBy: ['owner', 'auditor'] } },
					owner: { grants: ['teams.read', 'teams.write', 'teams.admin'], member: { scope: 'team', assignableBy: ['owner'] } },
					auditor: { grants: ['teams.audit'], member: { scope: 'team', assignableBy: ['owner'] } },
				},
			}, (c) => ({
				api: c.rpc('/api', { callers: ['human'] }, {
					invite: c.mutation({
						input: z.strictObject({ teamId: z.string(), role: z.string() }),
						output: z.strictObject({ ok: z.boolean() }),
						access: { action: 'teams.admin', in: 'team', from: 'teamId' },
					}),
				}),
			})),
			{},
		)
		expect(managerGrants(shop, 'teams.admin', { teamId: 't-1', role: 'editor' }, scope)).toEqual([
			{ action: 'teams.admin', scope },
			{ action: 'teams.read', scope },
			{ action: 'teams.write', scope },
			{ role: 'owner', scope },
		])
	})

	test('an input that names no role covers every membership role through the one role that assigns them all', () => {
		expect(managerGrants(team, 'teams.admin', { teamId: 't-1' }, scope)).toEqual([
			{ action: 'teams.admin', scope },
			{ action: 'teams.audit', scope },
			{ action: 'teams.read', scope },
			{ action: 'teams.write', scope },
			{ role: 'lead', scope },
		])
	})
})

describe('an application-wide role in assignableBy assigns as IAM counts it: held globally, or in the value', () => {
	const staffed = compileContract(
		defineContract({
			app: 'teams',
			dimensions: { team: { members: { manage: 'teams.admin', list: 'teams.read' } } },
			actions: { 'teams.read': 'Read', 'teams.write': 'Write', 'teams.audit': 'Audit', 'teams.admin': 'Manage members' },
			roles: {
				editor: { grants: ['teams.read', 'teams.write'], member: { scope: 'team', assignableBy: ['lead', 'staff'] } },
				lead: { grants: ['teams.read', 'teams.write', 'teams.audit', 'teams.admin'], member: { scope: 'team', assignableBy: ['lead'] } },
				staff: { grants: ['teams.read', 'teams.write', 'teams.admin'] },
			},
		}, (c) => ({
			api: c.rpc('/api', { callers: ['human'] }, {
				invite: c.mutation({
					input: z.strictObject({ teamId: z.string(), role: z.string() }),
					output: z.strictObject({ ok: z.boolean() }),
					access: { action: 'teams.admin', in: 'team', from: 'teamId' },
				}),
			}),
		})),
		{},
	)
	const T1: Scope = { type: 'team', value: 't-1' }
	const T2: Scope = { type: 'team', value: 't-2' }
	const staffActions = ['teams.read', 'teams.write', 'teams.admin']
	const globalStaff = person('global-staff', staffActions.map((action) => entry(action)))
	const otherStaff = person('other-staff', staffActions.map((action) => entry(action, T2)))
	const membership = kitMembership(
		staffed,
		callersOf([
			{ caller: globalStaff, memberships: [{ role: 'staff', scope: null }] },
			{ caller: otherStaff, memberships: [{ role: 'staff', scope: T2 }] },
		]),
	).rpc
	const assign = async (caller: TestCaller, scope: Scope, role: string) => {
		const granted = await membership.requestDelegation({ ...as(caller), endpoint: 'api.invite' })
		const grant = granted.ok ? granted.grant : granted.reason
		return membership.assignMember({ ...as(caller), delegation: grant, scope, role, member: { email: 'ann@example.test' } })
	}

	test('a global holder assigns in every value, a role assignableBy does not name excepted', async () => {
		expect(await assign(globalStaff, T1, 'editor')).toMatchObject({ ok: true, invited: { role: 'editor' } })
		expect(await assign(globalStaff, T1, 'lead')).toEqual({ ok: false, reason: 'not_allowed' })
	})

	test('a holder in another value assigns there and not here', async () => {
		expect(await assign(otherStaff, T2, 'editor')).toMatchObject({ ok: true })
		expect(await assign(otherStaff, T1, 'editor')).toEqual({ ok: false, reason: 'not_allowed' })
	})

	test('the generated cases hold the application-wide assigner in the value where it adds the fewest actions', () => {
		expect(managerGrants(staffed, 'teams.admin', { teamId: 't-1', role: 'editor' }, T1)).toEqual([
			{ action: 'teams.admin', scope: T1 },
			{ action: 'teams.read', scope: T1 },
			{ action: 'teams.write', scope: T1 },
			{ role: 'staff', scope: T1 },
		])
	})
})
