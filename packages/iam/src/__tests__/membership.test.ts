import {
	type AppSchema,
	type AppScopeDef,
	buildAccessClaims,
	BUILTIN_ROLE_KEYS,
	type MembershipCaller,
	parseAccessClaims,
	type Scope,
} from '@fabrika/auth-core'
import { unusedDatabase } from '@fabrika/platform/testing'
import { describe, expect, test } from 'bun:test'
import { decodeJwt } from 'jose'
import { ExternalGrantError } from '../db'
import { exchangeAuthCode, issueAuthCode } from '../handoff'
import {
	acceptInvitation,
	assignMember,
	createScope,
	findMember,
	issueLink,
	listMembers,
	requestDelegation,
	revokeLink,
	revokeMember,
} from '../membership'
import { pkceChallenge } from '../oidc'
import { unixNow } from '../repositories/sql'
import { BUILTIN_ROLES } from '../roles'
import { createIamRpc } from '../rpc'
import { hashToken } from '../secret'
import { getSigner } from '../signing'
import { mintFromKey } from '../tokens'
import { createHarness, TEST_SIGNING_ENV, TEST_SIGNING_KEYS, TestSqlDatabase } from './helpers/harness'
import {
	APP,
	BetweenCheckAndWrite,
	CALLER_ENV,
	CapturingEmail,
	CREATE_ENDPOINT,
	INVITE_ENDPOINT,
	inviterCheck,
	InviterRemovedBeforeAcceptance,
	type MembershipFixture,
	membershipFixture,
	NOTES_SCHEMA,
	ORIGIN,
	type Person,
} from './helpers/membership'

// Every membership invariant of this package's CLAUDE.md (ADR-0012 §6), the share links and the
// delegation grants of ADR-0022 rule 6, against the real schema. Each operation is the IAM function the
// RPC surface calls; the caller is a native token signed for the app, as the proxy's would be.

let requestSeq = 0

async function fixture(email: CapturingEmail | null = null): Promise<MembershipFixture> {
	return membershipFixture(createHarness().repositories, { email })
}

async function caller(person: Person, app = APP): Promise<MembershipCaller> {
	requestSeq += 1
	return { app, credential: await person.token(app), requestId: `req-${requestSeq}` }
}

/** A delegation grant for one request to `endpoint`, and that request's caller. */
async function delegated(f: MembershipFixture, person: Person, endpoint = INVITE_ENDPOINT): Promise<MembershipCaller & { delegation: string }> {
	const call = await caller(person)
	const result = await requestDelegation(f.services, CALLER_ENV, f.ctx, { ...call, endpoint })
	if (!result.ok) throw new Error(`no delegation: ${result.reason}`)
	return { ...call, delegation: result.grant }
}

/** A workspace created by `owner`, through the creating endpoint. */
async function workspaceOf(f: MembershipFixture, owner: Person): Promise<Scope> {
	await f.repositories.grants.createRoleGrantUnlessHeld({ principalId: owner.id, app: APP, roleKey: 'starter' })
	const result = await createScope(f.services, CALLER_ENV, f.ctx, { ...(await delegated(f, owner, CREATE_ENDPOINT)), dimension: 'workspace' })
	if (!result.ok) throw new Error(`no workspace: ${result.reason}`)
	return result.scope
}

async function rolesOf(f: MembershipFixture, person: Person, scope: Scope): Promise<string[]> {
	return (await f.repositories.membership.listRoleGrantsAt(APP, person.id, scope)).map((grant) => grant.role_key ?? '')
}

async function assign(f: MembershipFixture, actor: Person, scope: Scope, role: string, member: { principalId: string } | { email: string }) {
	return assignMember(f.services, CALLER_ENV, f.ctx, { ...(await delegated(f, actor)), scope, role, member })
}

async function revoke(
	f: MembershipFixture,
	actor: Person,
	scope: Scope,
	member: { principalId: string; role?: string | null } | { invitationId: string },
) {
	return revokeMember(f.services, CALLER_ENV, f.ctx, { ...(await delegated(f, actor)), scope, member })
}

describe('creates: IAM mints the value and grants the caller the creator role', () => {
	test('the value is new, the caller holds the creator role in it, and the value is recorded', async () => {
		const f = await fixture()
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		const second = await workspaceOf(f, owner)

		expect(scope.type).toBe('workspace')
		expect(second.value).not.toBe(scope.value)
		expect(await rolesOf(f, owner, scope)).toEqual(['owner'])
		await f.ctx.settle()
		const events = await f.repositories.audit.listAuditEvents({ action: 'iam.scope.create', limit: 10 })
		expect(events.map((event) => event.action)).toContain('iam.scope.create')
	})

	test('the caller must hold the creating action globally', async () => {
		const f = await fixture()
		const stranger = await f.person('stranger')
		const result = await createScope(f.services, CALLER_ENV, f.ctx, { ...(await caller(stranger)), delegation: 'none', dimension: 'workspace' })
		expect(result).toEqual({ ok: false, reason: 'invalid_delegation' })
		// A delegation needs the endpoint's action somewhere; holding none of it gets no grant at all.
		expect(await requestDelegation(f.services, CALLER_ENV, f.ctx, { ...(await caller(stranger)), endpoint: CREATE_ENDPOINT })).toEqual({
			ok: false,
			reason: 'not_allowed',
		})
		const owner = await f.person('scoped')
		const scope = await workspaceOf(f, owner)
		await f.repositories.grants.deleteGrantsForPrincipal(owner.id)
		await f.repositories.grants.createGrant({
			principalId: owner.id,
			app: APP,
			permissions: ['workspaces.create'],
			scopeType: 'workspace',
			scopeValue: scope.value,
		})
		const scoped = await createScope(f.services, CALLER_ENV, f.ctx, { ...(await delegated(f, owner, CREATE_ENDPOINT)), dimension: 'workspace' })
		expect(scoped).toEqual({ ok: false, reason: 'not_allowed' })
	})

	test('a workload principal cannot create a value', async () => {
		const f = await fixture()
		const service = await f.repositories.principals.createService('importer')
		await f.repositories.grants.createGrant({ principalId: service.id, app: APP, roleKey: 'starter' })
		const robot: Person = {
			id: service.id,
			token: () => getSigner(TEST_SIGNING_ENV).then((signer) => signer.sign(serviceClaims(service.id))),
		}
		expect(await requestDelegation(f.services, CALLER_ENV, f.ctx, { ...(await caller(robot)), endpoint: CREATE_ENDPOINT })).toEqual({
			ok: false,
			reason: 'not_allowed',
		})
	})

	test('a creating grant does not create a value of another dimension, nor spend on members', async () => {
		const f = await fixture()
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		expect(await createScope(f.services, CALLER_ENV, f.ctx, { ...(await delegated(f, owner, CREATE_ENDPOINT)), dimension: 'note' })).toEqual({
			ok: false,
			reason: 'invalid_delegation',
		})
		const editor = await f.person('editor')
		const misused = await assignMember(f.services, CALLER_ENV, f.ctx, {
			...(await delegated(f, owner, CREATE_ENDPOINT)),
			scope,
			role: 'editor',
			member: { principalId: editor.id },
		})
		expect(misused).toEqual({ ok: false, reason: 'invalid_delegation' })
	})
})

function serviceClaims(id: string) {
	const now = unixNow()
	return buildAccessClaims({
		iss: ORIGIN,
		app: APP,
		subject: id,
		type: 'service',
		label: 'importer',
		permissions: [],
		issuedAt: now,
		expiresAt: now + 300,
	})
}

describe('delegation grants: one request, one endpoint, one caller, once', () => {
	test('a grant is spent by the first operation, also a refused one', async () => {
		const f = await fixture()
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		const editor = await f.person('editor')
		const grant = await delegated(f, owner)
		expect(await assignMember(f.services, CALLER_ENV, f.ctx, { ...grant, scope, role: 'nobody', member: { principalId: editor.id } })).toMatchObject({
			reason: 'invalid_request',
		})
		expect(await assignMember(f.services, CALLER_ENV, f.ctx, { ...grant, scope, role: 'editor', member: { principalId: editor.id } })).toEqual({
			ok: false,
			reason: 'invalid_delegation',
		})
	})

	test('a grant is bound to its request id and its caller', async () => {
		const f = await fixture()
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		const other = await f.person('other')
		const grant = await delegated(f, owner)
		expect(
			await assignMember(f.services, CALLER_ENV, f.ctx, {
				...grant,
				requestId: 'another-request',
				scope,
				role: 'editor',
				member: { principalId: other.id },
			}),
		)
			.toEqual({ ok: false, reason: 'invalid_delegation' })

		const stolen = await delegated(f, owner)
		const thief = await caller(other)
		expect(
			await assignMember(f.services, CALLER_ENV, f.ctx, {
				...thief,
				requestId: stolen.requestId,
				delegation: stolen.delegation,
				scope,
				role: 'editor',
				member: { principalId: other.id },
			}),
		)
			.toEqual({ ok: false, reason: 'invalid_delegation' })
	})

	test('a grant expires, and an undeclared endpoint gets none', async () => {
		const f = await fixture()
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		const grant = await delegated(f, owner)
		await f.repositories.membership.consumeDelegationGrant('unrelated', unixNow())
		const expired = await f.repositories.membership.prune(unixNow() + 3600, 0)
		expect(expired).toBeGreaterThan(0)
		expect(await revokeMember(f.services, CALLER_ENV, f.ctx, { ...grant, scope, member: { principalId: owner.id } })).toEqual({
			ok: false,
			reason: 'invalid_delegation',
		})
		expect(await requestDelegation(f.services, CALLER_ENV, f.ctx, { ...(await caller(owner)), endpoint: 'api.notes.list' })).toEqual({
			ok: false,
			reason: 'invalid_request',
			message: "endpoint 'api.notes.list' declares no membership operation",
		})
	})

	test('a grant for an endpoint the app stopped declaring buys nothing', async () => {
		const f = await fixture()
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		const editor = await f.person('editor')
		const grant = await delegated(f, owner)
		expect((await f.putSchema({ ...NOTES_SCHEMA, delegations: {} })).status).toBe(200)
		expect(await assignMember(f.services, CALLER_ENV, f.ctx, { ...grant, scope, role: 'editor', member: { principalId: editor.id } })).toEqual({
			ok: false,
			reason: 'invalid_delegation',
		})
	})
})

describe('members.assign', () => {
	test('an owner assigns an existing principal, and repeating it answers the same result', async () => {
		const f = await fixture()
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		const editor = await f.person('editor')
		const first = await assign(f, owner, scope, 'editor', { principalId: editor.id })
		const second = await assign(f, owner, scope, 'editor', { principalId: editor.id })
		expect(first).toEqual({ ok: true, assigned: { principalId: editor.id, role: 'editor' } })
		expect(second).toEqual(first)
		expect(await rolesOf(f, editor, scope)).toEqual(['editor'])
	})

	test('the caller holds members.manage there', async () => {
		const f = await fixture()
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		const editor = await f.person('editor')
		await assign(f, owner, scope, 'editor', { principalId: editor.id })
		const target = await f.person('target')
		// An editor of the workspace holds no notes.admin there, so it gets no delegation for the endpoint.
		expect(await requestDelegation(f.services, CALLER_ENV, f.ctx, { ...(await caller(editor)), endpoint: INVITE_ENDPOINT })).toEqual({
			ok: false,
			reason: 'not_allowed',
		})
		// An owner of ANOTHER workspace holds notes.admin, but not in this one.
		const otherOwner = await f.person('other-owner')
		await workspaceOf(f, otherOwner)
		expect(await assign(f, otherOwner, scope, 'editor', { principalId: target.id })).toEqual({ ok: false, reason: 'not_allowed' })
	})

	test('the role is assignable by one of the caller roles there', async () => {
		const f = await fixture()
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		// Support holds notes.admin globally, through an administrator's role, but no role in the workspace.
		const support = await f.person('support')
		await f.repositories.grants.createGrant({ principalId: support.id, app: APP, roleKey: 'support' })
		const target = await f.person('target')
		expect(await assign(f, support, scope, 'editor', { principalId: target.id })).toEqual({ ok: false, reason: 'not_allowed' })
		// A manager may assign an editor, not an owner.
		const manager = await f.person('manager')
		await assign(f, owner, scope, 'manager', { principalId: manager.id })
		expect(await assign(f, manager, scope, 'editor', { principalId: target.id })).toMatchObject({ ok: true })
		expect(await assign(f, manager, scope, 'owner', { principalId: target.id })).toEqual({ ok: false, reason: 'not_allowed' })
	})

	test('the role grants nothing the caller lacks there', async () => {
		const f = await fixture()
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		const target = await f.person('target')
		// Publisher grants notes.publish, which an owner does not hold.
		expect(await assign(f, owner, scope, 'publisher', { principalId: target.id })).toEqual({ ok: false, reason: 'not_allowed' })
	})

	test('a role must be a membership role of the dimension, and the target a user', async () => {
		const f = await fixture()
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		const target = await f.person('target')
		expect(await assign(f, owner, scope, 'starter', { principalId: target.id })).toEqual({
			ok: false,
			reason: 'invalid_request',
			message: "role 'starter' is not a membership role of scope 'workspace'",
		})
		const service = await f.repositories.principals.createService('robot')
		expect(await assign(f, owner, scope, 'editor', { principalId: service.id })).toEqual({ ok: false, reason: 'not_found' })
	})

	test('IAM checks live permissions: a token minted before a revocation buys nothing', async () => {
		const f = await fixture()
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		const target = await f.person('target')
		const grant = await delegated(f, owner)
		await f.repositories.membership.deleteRoleGrant(APP, owner.id, 'owner', scope)
		expect(await assignMember(f.services, CALLER_ENV, f.ctx, { ...grant, scope, role: 'editor', member: { principalId: target.id } })).toEqual({
			ok: false,
			reason: 'not_allowed',
		})
	})

	test('a token of another environment of the app reaches nothing here', async () => {
		const f = await fixture()
		const owner = await f.person('owner')
		await workspaceOf(f, owner)
		expect(await requestDelegation(f.services, CALLER_ENV, f.ctx, { ...(await caller(owner, 'notes@stage')), endpoint: INVITE_ENDPOINT }))
			.toMatchObject({
				ok: false,
			})
	})
})

describe('members.assign by email: an invitation only the verified mailbox can accept', () => {
	test('an invitation is mailed once, repeating it answers the same invitation, and its owner accepts it', async () => {
		const email = new CapturingEmail()
		const f = await fixture(email)
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		const invited = await assign(f, owner, scope, 'editor', { email: ' Invitee@Example.TEST ' })
		const repeated = await assign(f, owner, scope, 'editor', { email: 'invitee@example.test' })
		if (!invited.ok || !('invited' in invited)) throw new Error('expected an invitation')
		expect(repeated).toEqual(invited)
		expect(email.messages).toHaveLength(1)
		expect(email.messages[0]?.to).toBe('invitee@example.test')
		expect(email.messages[0]?.text).toContain(`${ORIGIN}/auth/invitations/accept#token=`)

		const invitee = await f.person('invitee')
		const principal = await f.repositories.principals.getPrincipalById(invitee.id)
		if (principal === null) throw new Error('fixture')
		const accepted = await acceptInvitation(f.services, principal, email.lastToken(), 'accept-req')
		expect(accepted.ok).toBe(true)
		expect(await rolesOf(f, invitee, scope)).toEqual(['editor'])
		expect(await acceptInvitation(f.services, principal, email.lastToken(), 'accept-req')).toEqual({ ok: false, reason: 'invalid' })
	})

	test('a principal that does not own the mailbox cannot accept, even holding the link', async () => {
		const email = new CapturingEmail()
		const f = await fixture(email)
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		await assign(f, owner, scope, 'editor', { email: 'invitee@example.test' })
		const forwardedTo = await f.repositories.principals.getPrincipalById((await f.person('colleague')).id)
		if (forwardedTo === null) throw new Error('fixture')
		expect(await acceptInvitation(f.services, forwardedTo, email.lastToken(), 'accept-req')).toEqual({ ok: false, reason: 'wrong_principal' })
	})

	test('an invitation expires', async () => {
		const email = new CapturingEmail()
		const f = await fixture(email)
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		const invited = await assign(f, owner, scope, 'editor', { email: 'late@example.test' })
		if (!invited.ok || !('invited' in invited)) throw new Error('expected an invitation')
		expect(invited.invited.expiresAt).toBe(unixNow() + 7 * 24 * 60 * 60)
		const late = await f.repositories.principals.getPrincipalById((await f.person('late')).id)
		if (late === null) throw new Error('fixture')
		const realNow = Date.now
		Date.now = () => realNow() + 8 * 24 * 60 * 60 * 1000
		try {
			expect(await acceptInvitation(f.services, late, email.lastToken(), 'accept-req')).toEqual({ ok: false, reason: 'invalid' })
		} finally {
			Date.now = realNow
		}
		expect(await rolesOf(f, { id: late.id, token: () => Promise.reject(new Error('unused')) }, scope)).toEqual([])
	})

	test('an invitation outlives no loss of the inviter authority', async () => {
		const email = new CapturingEmail()
		const f = await fixture(email)
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		await assign(f, owner, scope, 'editor', { email: 'invitee@example.test' })
		const second = await f.person('second-owner')
		await assign(f, owner, scope, 'owner', { principalId: second.id })
		await f.repositories.membership.deleteRoleGrant(APP, owner.id, 'owner', scope)
		const invitee = await f.repositories.principals.getPrincipalById((await f.person('invitee')).id)
		if (invitee === null) throw new Error('fixture')
		expect(await acceptInvitation(f.services, invitee, email.lastToken(), 'accept-req')).toEqual({ ok: false, reason: 'not_allowed' })
	})

	test('without an email service an address cannot be invited, and an existing principal still can be assigned', async () => {
		const f = await fixture(null)
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		expect(await assign(f, owner, scope, 'editor', { email: 'invitee@example.test' })).toEqual({ ok: false, reason: 'invitations_disabled' })
		const editor = await f.person('editor')
		expect(await assign(f, owner, scope, 'editor', { principalId: editor.id })).toMatchObject({ ok: true })
	})

	test('a delivery that was not sent leaves no invitation behind', async () => {
		const f = await fixture(new CapturingEmail('provider_rejected'))
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		expect(await assign(f, owner, scope, 'editor', { email: 'invitee@example.test' })).toEqual({ ok: false, reason: 'delivery_failed' })
		expect(await f.repositories.membership.listOpenInvitations(APP, scope)).toEqual([])
	})

	test('a sender that throws outside the error contract leaves no invitation behind', async () => {
		const f = await fixture(new CapturingEmail('foreign'))
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		expect(await assign(f, owner, scope, 'editor', { email: 'invitee@example.test' })).toEqual({ ok: false, reason: 'delivery_failed' })
		expect(await f.repositories.membership.listOpenInvitations(APP, scope)).toEqual([])
	})

	test('a message that cannot be rendered leaves no invitation behind and sends nothing', async () => {
		const email = new CapturingEmail()
		const f = await fixture(email)
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		f.repositories.appSchema.getPresentation = () => Promise.reject(new Error('template store unavailable'))
		await expect(assign(f, owner, scope, 'editor', { email: 'invitee@example.test' })).rejects.toThrow('template store unavailable')
		expect(await f.repositories.membership.listOpenInvitations(APP, scope)).toEqual([])
		expect(email.messages).toEqual([])
	})

	test('a delivery with an unknown outcome keeps the invitation its link may name', async () => {
		const email = new CapturingEmail('network_error')
		const f = await fixture(email)
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		expect(await assign(f, owner, scope, 'editor', { email: 'invitee@example.test' })).toEqual({ ok: false, reason: 'delivery_failed' })
		expect(await f.repositories.membership.listOpenInvitations(APP, scope)).toHaveLength(1)
		const invitee = await f.repositories.principals.getPrincipalById((await f.person('invitee')).id)
		if (invitee === null) throw new Error('fixture')
		expect(await acceptInvitation(f.services, invitee, email.lastToken(), 'accept-req')).toMatchObject({ ok: true })
	})
})

describe('an application-wide role in assignableBy assigns in every value, held globally', () => {
	/** A staff member holding only the global `staff` role, which `editor`'s `assignableBy` names. */
	async function staffOf(f: MembershipFixture): Promise<{ staff: Person; grantId: string }> {
		const staff = await f.person('staff')
		const grant = await f.repositories.grants.createRoleGrantUnlessHeld({ principalId: staff.id, app: APP, roleKey: 'staff' })
		if (grant === null) throw new Error('fixture')
		return { staff, grantId: grant.id }
	}

	test('a staff member assigns an editor by id into a workspace it did not create, and no owner', async () => {
		const f = await fixture()
		const scope = await workspaceOf(f, await f.person('owner'))
		const { staff } = await staffOf(f)
		const target = await f.person('target')
		expect(await rolesOf(f, staff, scope)).toEqual([])
		expect(await assign(f, staff, scope, 'editor', { principalId: target.id })).toEqual({
			ok: true,
			assigned: { principalId: target.id, role: 'editor' },
		})
		expect(await rolesOf(f, target, scope)).toEqual(['editor'])
		// `owner` names only itself: the global role gives no authority over it.
		expect(await assign(f, staff, scope, 'owner', { principalId: target.id })).toEqual({ ok: false, reason: 'not_allowed' })
		expect(await revoke(f, staff, scope, { principalId: target.id })).toEqual({ ok: true })
		expect(await rolesOf(f, target, scope)).toEqual([])
	})

	test('a staff member invites by e-mail, and the invitation is accepted', async () => {
		const email = new CapturingEmail()
		const f = await fixture(email)
		const scope = await workspaceOf(f, await f.person('owner'))
		const { staff } = await staffOf(f)
		expect(await assign(f, staff, scope, 'editor', { email: 'invitee@example.test' })).toMatchObject({ ok: true, invited: {} })
		const invitee = await f.repositories.principals.getPrincipalById((await f.person('invitee')).id)
		if (invitee === null) throw new Error('fixture')
		expect(await acceptInvitation(f.services, invitee, email.lastToken(), 'accept-req')).toMatchObject({ ok: true })
		expect(await rolesOf(f, { id: invitee.id, token: () => Promise.reject(new Error('unused')) }, scope)).toEqual(['editor'])
	})

	test('after the staff member loses the global role, the open invitation is not_allowed and stays open', async () => {
		const email = new CapturingEmail()
		const f = await fixture(email)
		const scope = await workspaceOf(f, await f.person('owner'))
		const { staff, grantId } = await staffOf(f)
		await assign(f, staff, scope, 'editor', { email: 'invitee@example.test' })
		expect(await f.repositories.grants.deleteGrant(grantId)).toBe(true)
		const invitee = await f.repositories.principals.getPrincipalById((await f.person('invitee')).id)
		if (invitee === null) throw new Error('fixture')
		expect(await acceptInvitation(f.services, invitee, email.lastToken(), 'accept-req')).toEqual({ ok: false, reason: 'not_allowed' })
		const invitation = await f.repositories.membership.getInvitationByHash(await hashToken(email.lastToken()))
		expect([invitation?.accepted_at, invitation?.revoked_at]).toEqual([null, null])
	})

	test('the guarded acceptance write counts the global grant, and refuses once it is gone', async () => {
		const email = new CapturingEmail()
		const f = await fixture(email)
		const scope = await workspaceOf(f, await f.person('owner'))
		const { staff, grantId } = await staffOf(f)
		await assign(f, staff, scope, 'editor', { email: 'first@example.test' })
		const first = await f.repositories.membership.getInvitationByHash(await hashToken(email.lastToken()))
		await assign(f, staff, scope, 'editor', { email: 'second@example.test' })
		const second = await f.repositories.membership.getInvitationByHash(await hashToken(email.lastToken()))
		if (first === null || second === null) throw new Error('fixture')
		const accepting = await f.person('first')
		expect(await f.repositories.membership.acceptInvitation(first, accepting.id, await inviterCheck(f.repositories, first, ['staff']))).toBe('accepted')
		await f.repositories.grants.deleteGrant(grantId)
		expect(
			await f.repositories.membership.acceptInvitation(second, (await f.person('second')).id, await inviterCheck(f.repositories, second, ['staff'])),
		).toBe(
			'not_allowed',
		)
	})

	test('the role held in another value assigns nothing here', async () => {
		const f = await fixture()
		const scope = await workspaceOf(f, await f.person('owner'))
		const other = await workspaceOf(f, await f.person('other-owner'))
		const staff = await f.person('staff')
		await f.repositories.grants.createRoleGrantUnlessHeld({
			principalId: staff.id,
			app: APP,
			roleKey: 'staff',
			scopeType: 'workspace',
			scopeValue: other.value,
		})
		const target = await f.person('target')
		expect(await assign(f, staff, scope, 'editor', { principalId: target.id })).toEqual({ ok: false, reason: 'not_allowed' })
		expect(await assign(f, staff, other, 'editor', { principalId: target.id })).toMatchObject({ ok: true })
	})

	test('an external principal never holds the application-wide role, so never assigns through it', async () => {
		const f = await fixture()
		const scope = await workspaceOf(f, await f.person('owner'))
		const external = await f.external('partner')
		await expect(f.repositories.grants.createRoleGrantUnlessHeld({ principalId: external.id, app: APP, roleKey: 'staff' })).rejects.toBeInstanceOf(
			ExternalGrantError,
		)
		expect(await f.repositories.membership.listAssigningGrants(APP, external.id, scope)).toEqual([])
		expect(await requestDelegation(f.services, CALLER_ENV, f.ctx, { ...(await caller(external)), endpoint: INVITE_ENDPOINT })).toEqual({
			ok: false,
			reason: 'not_allowed',
		})
	})
})

describe('members.revoke', () => {
	test('an owner removes a member, and repeating it answers the same result', async () => {
		const f = await fixture()
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		const editor = await f.person('editor')
		await assign(f, owner, scope, 'editor', { principalId: editor.id })
		expect(await revoke(f, owner, scope, { principalId: editor.id })).toEqual({ ok: true })
		expect(await revoke(f, owner, scope, { principalId: editor.id })).toEqual({ ok: true })
		expect(await rolesOf(f, editor, scope)).toEqual([])
	})

	test('the caller cannot revoke a role it could not assign', async () => {
		const f = await fixture()
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		const manager = await f.person('manager')
		await assign(f, owner, scope, 'manager', { principalId: manager.id })
		const second = await f.person('second-owner')
		await assign(f, owner, scope, 'owner', { principalId: second.id })
		expect(await revoke(f, manager, scope, { principalId: second.id })).toEqual({ ok: false, reason: 'not_allowed' })
		expect(await rolesOf(f, second, scope)).toEqual(['owner'])
	})

	test('the last creator stays, and another owner can leave', async () => {
		const f = await fixture()
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		expect(await revoke(f, owner, scope, { principalId: owner.id })).toEqual({ ok: false, reason: 'last_creator' })
		const second = await f.person('second-owner')
		await assign(f, owner, scope, 'owner', { principalId: second.id })
		expect(await revoke(f, owner, scope, { principalId: owner.id, role: 'owner' })).toEqual({ ok: true })
		expect(await revoke(f, second, scope, { principalId: second.id })).toEqual({ ok: false, reason: 'last_creator' })
		expect(await rolesOf(f, second, scope)).toEqual(['owner'])
	})

	test('a cancelled invitation can no longer be accepted', async () => {
		const email = new CapturingEmail()
		const f = await fixture(email)
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		const invited = await assign(f, owner, scope, 'editor', { email: 'invitee@example.test' })
		if (!invited.ok || !('invited' in invited)) throw new Error('expected an invitation')
		expect(await revoke(f, owner, scope, { invitationId: invited.invited.invitationId })).toEqual({ ok: true })
		expect(await revoke(f, owner, scope, { invitationId: invited.invited.invitationId })).toEqual({ ok: true })
		const invitee = await f.repositories.principals.getPrincipalById((await f.person('invitee')).id)
		if (invitee === null) throw new Error('fixture')
		expect(await acceptInvitation(f.services, invitee, email.lastToken(), 'accept-req')).toEqual({ ok: false, reason: 'invalid' })
	})
})

describe('members.list', () => {
	test('the list action shows members without labels or emails; members.manage adds them and the invitations', async () => {
		const email = new CapturingEmail()
		const f = await fixture(email)
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		const editor = await f.person('editor')
		await assign(f, owner, scope, 'editor', { principalId: editor.id })
		await assign(f, owner, scope, 'editor', { email: 'invitee@example.test' })

		const asEditor = await listMembers(f.services, CALLER_ENV, f.ctx, { ...(await caller(editor)), scope })
		if (!asEditor.ok) throw new Error('expected a list')
		expect(asEditor.members.map((member) => [member.principalId, member.roles, member.label, member.email])).toEqual(
			[[owner.id, ['owner'], null, null], [editor.id, ['editor'], null, null]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
		)
		expect(asEditor.invitations).toEqual([])

		const asOwner = await listMembers(f.services, CALLER_ENV, f.ctx, { ...(await caller(owner)), scope })
		if (!asOwner.ok) throw new Error('expected a list')
		expect(asOwner.members.find((member) => member.principalId === editor.id)).toMatchObject({
			label: 'editor@example.test',
			email: 'editor@example.test',
		})
		expect(asOwner.invitations.map((invitation) => invitation.email)).toEqual(['invitee@example.test'])
	})

	test("a member's last sign-in to the application is IAM's record of its handoff, answered to members.manage only", async () => {
		const f = await fixture()
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		const editor = await f.person('editor')
		await assign(f, owner, scope, 'editor', { principalId: editor.id })
		const signIns = async (person: Person) => {
			const listed = await listMembers(f.services, CALLER_ENV, f.ctx, { ...(await caller(person)), scope })
			if (!listed.ok) throw new Error('expected a list')
			return Object.fromEntries(listed.members.map((member) => [member.principalId, member.lastSignInAt]))
		}
		expect(await signIns(owner)).toEqual({ [owner.id]: null, [editor.id]: null })

		// The editor signs in to the application: its proxy redeems a handoff code of the editor's IAM session.
		const verifier = 'browser-held-verifier-browser-held-verifier-1'
		const parent = await f.repositories.sessions.createSession({
			tokenHash: 'editor-iam-session',
			principalId: editor.id,
			authenticationMethod: 'password',
			expiresAt: unixNow() + 3600,
		})
		const { code } = await issueAuthCode(f.services, {
			app: APP,
			parentSessionId: parent,
			returnUrl: 'https://notes.test/',
			challenge: await pkceChallenge(verifier),
		})
		const before = unixNow()
		expect((await exchangeAuthCode(f.services, { app: APP, code, verifier, requestId: 'sign-in' })).result.ok).toBe(true)

		const asOwner = await signIns(owner)
		expect(asOwner[owner.id]).toBeNull()
		expect(asOwner[editor.id]).toBeGreaterThanOrEqual(before)
		expect(await signIns(editor)).toEqual({ [owner.id]: null, [editor.id]: null })
	})

	test("a dimension that declares directory: 'labels' shows labels to the list action, still no email or invitation", async () => {
		const f = await fixture()
		const labelled: AppSchema = {
			...NOTES_SCHEMA,
			scopes: NOTES_SCHEMA.scopes.map((scope): AppScopeDef => (scope.type === 'workspace' ? { ...scope, directory: 'labels' } : scope)),
		}
		expect((await f.putSchema(labelled)).status).toBe(200)
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		const editor = await f.person('editor')
		await assign(f, owner, scope, 'editor', { principalId: editor.id })

		const asEditor = await listMembers(f.services, CALLER_ENV, f.ctx, { ...(await caller(editor)), scope })
		if (!asEditor.ok) throw new Error('expected a list')
		expect(asEditor.members.map((member) => [member.principalId, member.label, member.email]).sort()).toEqual(
			[[owner.id, 'owner@example.test', null], [editor.id, 'editor@example.test', null]].sort(),
		)
		expect(asEditor.invitations).toEqual([])
		// A reconcile without the declaration takes the labels back.
		expect((await f.putSchema(NOTES_SCHEMA)).status).toBe(200)
		const again = await listMembers(f.services, CALLER_ENV, f.ctx, { ...(await caller(editor)), scope })
		expect(again.ok ? again.members.map((member) => member.label) : null).toEqual([null, null])
	})

	test('a caller without the list action there sees nothing', async () => {
		const f = await fixture()
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		const stranger = await f.person('stranger')
		expect(await listMembers(f.services, CALLER_ENV, f.ctx, { ...(await caller(stranger)), scope })).toEqual({ ok: false, reason: 'not_allowed' })
	})

	test('a member lists its own value only: another value of the dimension is not_allowed, and the list holds no one from it', async () => {
		const f = await fixture()
		const owner = await f.person('owner')
		const first = await workspaceOf(f, owner)
		const second = await workspaceOf(f, owner)
		const editor = await f.person('editor')
		const elsewhere = await f.person('elsewhere')
		await assign(f, owner, first, 'editor', { principalId: editor.id })
		await assign(f, owner, second, 'editor', { principalId: elsewhere.id })

		const listed = await listMembers(f.services, CALLER_ENV, f.ctx, { ...(await caller(editor)), scope: first })
		if (!listed.ok) throw new Error('expected a list')
		expect(listed.members.map((member) => member.principalId).sort()).toEqual([owner.id, editor.id].sort())
		expect(await listMembers(f.services, CALLER_ENV, f.ctx, { ...(await caller(editor)), scope: second })).toEqual({
			ok: false,
			reason: 'not_allowed',
		})
	})
})

describe('members.find: one member, for an endpoint below the directory', () => {
	/** The notes schema whose workspace directory answers lookups for the endpoints of `notes.write`. */
	const LOOKUP_SCHEMA: AppSchema = {
		...NOTES_SCHEMA,
		scopes: NOTES_SCHEMA.scopes.map((scope): AppScopeDef => (scope.type === 'workspace' ? { ...scope, lookups: ['notes.write'] } : scope)),
	}

	/** A workspace with an editor (who holds `notes.write` there), and the lookup as an application asks it. */
	async function findFixture(schema: AppSchema = LOOKUP_SCHEMA) {
		const f = await fixture()
		expect((await f.putSchema(schema)).status).toBe(200)
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		const editor = await f.person('editor')
		await assign(f, owner, scope, 'editor', { principalId: editor.id })
		const find = async (person: Person, principalId: string, overrides: { action?: string; scope?: Scope } = {}) =>
			findMember(f.services, CALLER_ENV, f.ctx, {
				...(await caller(person)),
				scope: overrides.scope ?? scope,
				principalId,
				action: overrides.action ?? 'notes.write',
			})
		return { f, owner, scope, editor, find }
	}

	test('a lookup action held on the workspace finds a member, without its label unless the caller manages the members', async () => {
		const { f, owner, editor, find } = await findFixture()
		const writer = await f.person('writer')
		await assign(f, owner, await workspaceOf(f, owner), 'editor', { principalId: writer.id })
		expect(await find(editor, owner.id)).toEqual({ ok: true, member: { principalId: owner.id, label: null, disabled: false, affiliation: 'internal' } })
		expect(await find(owner, editor.id)).toEqual({
			ok: true,
			member: { principalId: editor.id, label: 'editor@example.test', disabled: false, affiliation: 'internal' },
		})
		// The writer is a member of another workspace only.
		expect(await find(editor, writer.id)).toEqual({ ok: true, member: null })
		expect(await find(editor, 'no-such-principal')).toEqual({ ok: true, member: null })
		expect(await find(editor, '')).toEqual({ ok: true, member: null })
	})

	test("a dimension that declares directory: 'labels' answers the label to every lookup", async () => {
		const labelled: AppSchema = {
			...LOOKUP_SCHEMA,
			scopes: LOOKUP_SCHEMA.scopes.map((scope): AppScopeDef => (scope.type === 'workspace' ? { ...scope, directory: 'labels' } : scope)),
		}
		const { owner, editor, find } = await findFixture(labelled)
		expect(await find(editor, owner.id)).toEqual({
			ok: true,
			member: { principalId: owner.id, label: 'owner@example.test', disabled: false, affiliation: 'internal' },
		})
	})

	test('a grant on a note IAM cannot place, with the scope and its parent both substituted, finds nothing', async () => {
		const { f, owner, editor, find } = await findFixture()
		const victim = await workspaceOf(f, owner)
		const member = await f.person('victim-member')
		await assign(f, owner, victim, 'editor', { principalId: member.id })
		const intruder = await f.person('intruder')
		await f.repositories.grants.createGrant({ principalId: intruder.id, app: APP, permissions: ['notes.write'], scopeType: 'note', scopeValue: 'n1' })
		expect(await find(intruder, member.id, { scope: victim })).toEqual({ ok: false, reason: 'not_allowed' })
		// A member of one workspace asks about another.
		expect(await find(editor, member.id, { scope: victim })).toEqual({ ok: false, reason: 'not_allowed' })
	})

	test('an action that no endpoint below the directory holds is refused, the global creation action included', async () => {
		const { f, owner, editor, find } = await findFixture()
		const starter = await f.person('starter')
		await f.repositories.grants.createRoleGrantUnlessHeld({ principalId: starter.id, app: APP, roleKey: 'starter' })
		expect(await find(starter, editor.id, { action: 'workspaces.create' })).toEqual({ ok: false, reason: 'not_allowed' })
		// notes.read is held there, but no lookup endpoint holds it.
		expect(await find(owner, editor.id, { action: 'notes.read' })).toEqual({ ok: false, reason: 'not_allowed' })
		// Another application's action is no action of this one's lookups.
		expect(await find(owner, editor.id, { action: 'other.write' })).toEqual({ ok: false, reason: 'not_allowed' })
		const stranger = await f.person('stranger')
		expect(await find(stranger, editor.id)).toEqual({ ok: false, reason: 'not_allowed' })
	})

	test('a schema without lookups answers no lookup, and a scope without members is refused', async () => {
		const { owner, editor, find } = await findFixture(NOTES_SCHEMA)
		expect(await find(owner, editor.id)).toEqual({ ok: false, reason: 'not_allowed' })
		expect(await find(owner, editor.id, { scope: { type: 'note', value: 'n1' } })).toMatchObject({ ok: false, reason: 'invalid_request' })
	})

	test('a link holder is no member caller', async () => {
		const { f, owner, scope, editor } = await findFixture()
		const issued = await issueLink(f.services, CALLER_ENV, f.ctx, {
			...(await caller(owner)),
			mount: 'shared',
			chain: [{ type: 'note', value: 'n1' }, scope],
			days: 1,
		})
		if (!issued.ok) throw new Error('expected a link')
		const holder = { app: APP, credential: issued.key, requestId: 'req-holder' }
		const found = await findMember(f.services, CALLER_ENV, f.ctx, { ...holder, scope, principalId: editor.id, action: 'notes.write' })
		expect(found).toEqual({ ok: false, reason: 'not_allowed' })
	})

	test('a lookup that names no action of the catalog is refused at the reconcile', async () => {
		const f = await fixture()
		const unknown: AppSchema = {
			...NOTES_SCHEMA,
			scopes: NOTES_SCHEMA.scopes.map((scope): AppScopeDef => (scope.type === 'workspace' ? { ...scope, lookups: ['notes.unknown'] } : scope)),
		}
		expect((await f.putSchema(unknown)).status).toBe(400)
		expect((await f.putSchema(LOOKUP_SCHEMA)).status).toBe(200)
	})
})

describe('share links', () => {
	async function linkFixture() {
		const f = await fixture()
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		const chain: Scope[] = [{ type: 'note', value: 'n1' }, scope]
		return { f, owner, scope, chain }
	}

	test('a link key mints a token bound to the mount, the chain and the object', async () => {
		const { f, owner, chain } = await linkFixture()
		const issued = await issueLink(f.services, CALLER_ENV, f.ctx, { ...(await caller(owner)), mount: 'shared', chain, days: 7 })
		if (!issued.ok) throw new Error(`expected a link: ${issued.reason}`)
		expect(issued.expiresAt).toBe(unixNow() + 7 * 24 * 60 * 60)

		const minted = await mintFromKey(f.services, TEST_SIGNING_ENV, { app: APP, key: issued.key, requestId: 'req-link' })
		if (!minted.result.ok) throw new Error('expected a token')
		const claims = parseAccessClaims(decodeJwt(minted.result.token))
		expect(claims?.link).toEqual({ mount: 'shared', chain })
		expect(claims?.ptype).toBeUndefined()
		expect(claims?.perms).toEqual([{ action: 'notes.read', scope: { type: 'note', value: 'n1' }, source: 'grant' }])
	})

	test('a link requires an expiry of at most the mount maxDays', async () => {
		const { f, owner, chain } = await linkFixture()
		for (const days of [0, 31, 1.5]) {
			expect(await issueLink(f.services, CALLER_ENV, f.ctx, { ...(await caller(owner)), mount: 'shared', chain, days })).toEqual({
				ok: false,
				reason: 'invalid_request',
				message: "a link of 'shared' lives 1 to 30 days",
			})
		}
	})

	test('the chain starts at the mount dimension and names every container', async () => {
		const { f, owner, scope } = await linkFixture()
		for (const chain of [[scope], [{ type: 'note', value: 'n1' }], [{ type: 'note', value: 'n1' }, { type: 'note', value: 'n2' }]]) {
			expect(await issueLink(f.services, CALLER_ENV, f.ctx, { ...(await caller(owner)), mount: 'shared', chain, days: 1 })).toMatchObject({
				reason: 'invalid_request',
			})
		}
		expect(await issueLink(f.services, CALLER_ENV, f.ctx, { ...(await caller(owner)), mount: 'missing', chain: [scope], days: 1 })).toMatchObject({
			reason: 'invalid_request',
		})
	})

	test('the issuer holds the issuing action and every grant on the chain', async () => {
		const { f, chain } = await linkFixture()
		const stranger = await f.person('stranger')
		expect(await issueLink(f.services, CALLER_ENV, f.ctx, { ...(await caller(stranger)), mount: 'shared', chain, days: 1 })).toEqual({
			ok: false,
			reason: 'not_allowed',
		})
	})

	test('a link is revoked by its issuer or by members.manage on its chain, by nobody else, idempotently', async () => {
		const { f, owner, scope, chain } = await linkFixture()
		const editor = await f.person('editor')
		await assign(f, owner, scope, 'editor', { principalId: editor.id })
		const byEditor = await issueLink(f.services, CALLER_ENV, f.ctx, { ...(await caller(editor)), mount: 'shared', chain, days: 1 })
		const second = await issueLink(f.services, CALLER_ENV, f.ctx, { ...(await caller(editor)), mount: 'shared', chain, days: 1 })
		if (!byEditor.ok || !second.ok) throw new Error('expected links')

		const stranger = await f.person('stranger')
		expect(await revokeLink(f.services, CALLER_ENV, f.ctx, { ...(await caller(stranger)), id: byEditor.id })).toEqual({
			ok: false,
			reason: 'not_allowed',
		})
		expect(await revokeLink(f.services, CALLER_ENV, f.ctx, { ...(await caller(editor)), id: byEditor.id })).toEqual({ ok: true })
		expect(await revokeLink(f.services, CALLER_ENV, f.ctx, { ...(await caller(editor)), id: byEditor.id })).toEqual({ ok: true })
		expect(await revokeLink(f.services, CALLER_ENV, f.ctx, { ...(await caller(owner)), id: second.id })).toEqual({ ok: true })
		expect((await mintFromKey(f.services, TEST_SIGNING_ENV, { app: APP, key: second.key, requestId: 'r' })).result).toEqual({
			ok: false,
			reason: 'invalid_key',
		})
		expect(await revokeLink(f.services, CALLER_ENV, f.ctx, { ...(await caller(owner)), id: 'no-such-link' })).toEqual({
			ok: false,
			reason: 'not_found',
		})
	})

	test('removing the link mount from the schema revokes its keys', async () => {
		const { f, owner, chain } = await linkFixture()
		const issued = await issueLink(f.services, CALLER_ENV, f.ctx, { ...(await caller(owner)), mount: 'shared', chain, days: 1 })
		if (!issued.ok) throw new Error('expected a link')
		expect((await f.putSchema({ ...NOTES_SCHEMA, links: {} })).status).toBe(200)
		expect((await mintFromKey(f.services, TEST_SIGNING_ENV, { app: APP, key: issued.key, requestId: 'r' })).result).toEqual({
			ok: false,
			reason: 'invalid_key',
		})
	})

	test('a link holder is no member caller', async () => {
		const { f, owner, scope, chain } = await linkFixture()
		const issued = await issueLink(f.services, CALLER_ENV, f.ctx, { ...(await caller(owner)), mount: 'shared', chain, days: 1 })
		if (!issued.ok) throw new Error('expected a link')
		const holder = { app: APP, credential: issued.key, requestId: 'req-holder' }
		expect(await listMembers(f.services, CALLER_ENV, f.ctx, { ...holder, scope })).toEqual({ ok: false, reason: 'not_allowed' })
		expect(await issueLink(f.services, CALLER_ENV, f.ctx, { ...holder, mount: 'shared', chain, days: 1 })).toEqual({ ok: false, reason: 'not_allowed' })
	})
})

describe('the RPC surface', () => {
	test('createIamRpc serves the membership operations, the delegation surviving the request-id rule', async () => {
		const h = createHarness()
		const f = await membershipFixture(h.repositories)
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		const editor = await f.person('editor')
		const rpc = createIamRpc({
			DB: unusedDatabase,
			REPOSITORIES: h.repositories,
			HUMAN_EMAIL_DOMAINS: '[]',
			HUMAN_EMAILS: '[]',
			IAM_BOOTSTRAP_ADMINS: '[]',
			ENVIRONMENT: 'stage',
			ISSUER: ORIGIN,
			FABRIKA_IAM_SIGNING_KEYS: TEST_SIGNING_KEYS,
			FABRIKA_IAM_PROVISIONING_KEY: '',
			OIDC_ISSUER: 'https://idp.test',
			OIDC_CLIENT_ID: 'client',
			OIDC_CLIENT_SECRET: 'secret',
			OIDC_SCOPES: '',
			OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
		}, f.ctx)
		const base = { app: APP, credential: await owner.token(), requestId: 'rpc-req-1' }
		const grant = await rpc.requestDelegation({ ...base, endpoint: INVITE_ENDPOINT })
		if (!grant.ok) throw new Error('expected a delegation')
		expect(await rpc.assignMember({ ...base, delegation: grant.grant, scope, role: 'editor', member: { principalId: editor.id } })).toEqual({
			ok: true,
			assigned: { principalId: editor.id, role: 'editor' },
		})
		// A request id the rule replaces is a different request, so the grant does not carry over to it.
		const odd = { ...base, requestId: 'not a valid id!' }
		const oddGrant = await rpc.requestDelegation({ ...odd, endpoint: INVITE_ENDPOINT })
		if (!oddGrant.ok) throw new Error('expected a delegation')
		expect(await rpc.revokeMember({ ...odd, delegation: oddGrant.grant, scope, member: { principalId: editor.id } })).toEqual({
			ok: false,
			reason: 'invalid_delegation',
		})
	})
})

describe('review round 1', () => {
	test('a token minted from a read-only key keeps the key ceiling: it cannot assign an editor', async () => {
		const f = await fixture()
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		const editor = await f.person('editor')
		const key = 'px_read-only-key-of-the-owner-0123456789'
		await f.repositories.credentials.createCredential({
			tokenHash: await hashToken(key),
			principalId: owner.id,
			app: APP,
			issuedBy: owner.id,
			expiresAt: unixNow() + 3600,
			grants: [{ action: 'notes.read', scopeType: scope.type, scopeValue: scope.value }],
		})
		const minted = await mintFromKey(f.services, TEST_SIGNING_ENV, { app: APP, key, requestId: 'req-mint-read-only' })
		if (!minted.result.ok) throw new Error('expected a token')

		for (const credential of [key, minted.result.token]) {
			expect(await requestDelegation(f.services, CALLER_ENV, f.ctx, { app: APP, credential, requestId: 'req-ro', endpoint: INVITE_ENDPOINT })).toEqual({
				ok: false,
				reason: 'not_allowed',
			})
		}
		// A grant obtained with the full session token does not lift the ceiling of the key's token.
		const grant = await delegated(f, owner)
		expect(
			await assignMember(f.services, CALLER_ENV, f.ctx, {
				...grant,
				credential: minted.result.token,
				scope,
				role: 'editor',
				member: { principalId: editor.id },
			}),
		).toEqual({ ok: false, reason: 'not_allowed' })
		expect(await rolesOf(f, editor, scope)).toEqual([])
	})

	test('IAM built-in roles are the keys the schema parser reserves', () => {
		expect(Object.keys(BUILTIN_ROLES)).toEqual([...BUILTIN_ROLE_KEYS])
	})

	test('a membership role named like a built-in is refused at reconcile', async () => {
		const f = await fixture()
		const roles = { ...NOTES_SCHEMA.roles, admin: { name: 'Admin', permissions: ['notes.read'], member: { scope: 'workspace' } } }
		const response = await f.putSchema({
			...NOTES_SCHEMA,
			scopes: [{ type: 'workspace', creator: 'admin', members: { manage: 'notes.admin', list: 'notes.read' } }, { type: 'note', in: 'workspace' }],
			roles,
		})
		expect(response.status).toBe(400)
		expect(await response.text()).toContain('built-in IAM role')
	})

	test('scope creation refuses a creator role the contract rules refuse', async () => {
		const f = await fixture()
		const owner = await f.person('owner')
		await f.repositories.grants.createGrant({ principalId: owner.id, app: APP, roleKey: 'starter' })
		const grant = await delegated(f, owner, CREATE_ENDPOINT)
		// A row written around the reconcile: the contract application's creator role grants a wildcard.
		await f.repositories.appSchema.upsertRole({ app: APP, roleKey: 'owner', name: 'Owner', permissions: ['*'], origin: 'app' })
		expect(await createScope(f.services, CALLER_ENV, f.ctx, { ...grant, dimension: 'workspace' })).toMatchObject({
			ok: false,
			reason: 'invalid_request',
		})
		expect(await f.repositories.membership.listRoleGrantsAt(APP, owner.id, { type: 'workspace', value: 'x' })).toEqual([])
	})

	test('an acceptance replayed in the same second after a revoke restores nothing', async () => {
		const email = new CapturingEmail()
		const f = await fixture(email)
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		await assign(f, owner, scope, 'editor', { email: 'invitee@example.test' })
		const invitation = await f.repositories.membership.getInvitationByHash(await hashToken(email.lastToken()))
		const invitee = await f.person('invitee')
		if (invitation === null) throw new Error('fixture')
		expect(await f.repositories.membership.acceptInvitation(invitation, invitee.id, await inviterCheck(f.repositories, invitation, ['owner']))).toBe(
			'accepted',
		)
		await f.repositories.membership.deleteRoleGrant(APP, invitee.id, 'editor', scope)
		// The second attempt passed its checks with the same open row before the first committed.
		expect(await f.repositories.membership.acceptInvitation(invitation, invitee.id, await inviterCheck(f.repositories, invitation, ['owner']))).toBe(
			'not_open',
		)
		expect(await rolesOf(f, invitee, scope)).toEqual([])
	})

	test('an inviter removed after the acceptance checks passed and before its write grants nothing, and the invitation stays open', async () => {
		const email = new CapturingEmail()
		const harness = createHarness()
		const removing = new InviterRemovedBeforeAcceptance(new TestSqlDatabase(harness.sqlite))
		const f = await membershipFixture({ ...harness.repositories, membership: removing }, { email })
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		const second = await f.person('second-owner')
		await assign(f, owner, scope, 'owner', { principalId: second.id })
		await assign(f, owner, scope, 'editor', { email: 'invitee@example.test' })
		const person = await f.person('invitee')
		const invitee = await f.repositories.principals.getPrincipalById(person.id)
		if (invitee === null) throw new Error('fixture')
		removing.removeBeforeAcceptance = { app: APP, principalId: owner.id, roleKey: 'owner', scope }
		expect(await acceptInvitation(f.services, invitee, email.lastToken(), 'accept-req')).toEqual({ ok: false, reason: 'not_allowed' })
		expect(await rolesOf(f, person, scope)).toEqual([])
		const invitation = await f.repositories.membership.getInvitationByHash(await hashToken(email.lastToken()))
		expect([invitation?.accepted_at, invitation?.revoked_at]).toEqual([null, null])
	})

	test('an inviter whose supplementing grant goes between the check and the write grants nothing, and the invitation stays open', async () => {
		const email = new CapturingEmail()
		const harness = createHarness()
		const membership = new BetweenCheckAndWrite(new TestSqlDatabase(harness.sqlite))
		const f = await membershipFixture({ ...harness.repositories, membership }, { email })
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		// `owner` assigns a publisher but lacks `notes.publish`: this second grant of the owner supplies it.
		const supplement = await f.repositories.grants.createGrant({ principalId: owner.id, app: APP, permissions: ['notes.publish'] })
		expect(await assign(f, owner, scope, 'publisher', { email: 'invitee@example.test' })).toMatchObject({ ok: true, invited: {} })
		const person = await f.person('invitee')
		const invitee = await f.repositories.principals.getPrincipalById(person.id)
		if (invitee === null) throw new Error('fixture')
		membership.between = () => f.repositories.grants.deleteGrant(supplement.id)
		expect(await acceptInvitation(f.services, invitee, email.lastToken(), 'accept-req')).toEqual({ ok: false, reason: 'not_allowed' })
		expect(await rolesOf(f, person, scope)).toEqual([])
		const invitation = await f.repositories.membership.getInvitationByHash(await hashToken(email.lastToken()))
		expect([invitation?.accepted_at, invitation?.revoked_at]).toEqual([null, null])
	})

	test('assigning over an expired grant renews it; an active one stays as it is', async () => {
		const f = await fixture()
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		const editor = await f.person('editor')
		await f.repositories.grants.createGrant({
			principalId: editor.id,
			app: APP,
			roleKey: 'editor',
			scopeType: scope.type,
			scopeValue: scope.value,
			expiresAt: unixNow() - 10,
		})
		expect(await rolesOf(f, editor, scope)).toEqual([])
		expect(await assign(f, owner, scope, 'editor', { principalId: editor.id })).toEqual({
			ok: true,
			assigned: { principalId: editor.id, role: 'editor' },
		})
		expect(await rolesOf(f, editor, scope)).toEqual(['editor'])
		const renewed = await f.repositories.membership.listRoleGrantsAt(APP, editor.id, scope)
		expect(await assign(f, owner, scope, 'editor', { principalId: editor.id })).toEqual({
			ok: true,
			assigned: { principalId: editor.id, role: 'editor' },
		})
		expect(await f.repositories.membership.listRoleGrantsAt(APP, editor.id, scope)).toEqual(renewed)
	})

	test('accepting an invitation over an expired grant renews it', async () => {
		const email = new CapturingEmail()
		const f = await fixture(email)
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		const invitee = await f.person('invitee')
		await f.repositories.grants.createGrant({
			principalId: invitee.id,
			app: APP,
			roleKey: 'editor',
			scopeType: scope.type,
			scopeValue: scope.value,
			expiresAt: unixNow() - 10,
		})
		await assign(f, owner, scope, 'editor', { email: 'invitee@example.test' })
		const principal = await f.repositories.principals.getPrincipalById(invitee.id)
		if (principal === null) throw new Error('fixture')
		expect((await acceptInvitation(f.services, principal, email.lastToken(), 'accept-req')).ok).toBe(true)
		expect(await rolesOf(f, invitee, scope)).toEqual(['editor'])
	})
})

describe('S8: a grant given through delegation ends no later than the authority behind it', () => {
	const T = () => unixNow() + 3600

	async function expiryOf(f: MembershipFixture, person: Person, scope: Scope, role: string): Promise<number | null | undefined> {
		return (await f.repositories.membership.listRoleGrantsAt(APP, person.id, scope)).find((grant) => grant.role_key === role)?.expires_at
	}

	async function expiringStaff(f: MembershipFixture, until: number): Promise<Person> {
		const staff = await f.person('staff')
		await f.repositories.grants.createRoleGrantUnlessHeld({ principalId: staff.id, app: APP, roleKey: 'staff', expiresAt: until })
		return staff
	}

	test('an assignment by id, to another principal or to the assigner itself, carries the assigner expiry', async () => {
		const f = await fixture()
		const scope = await workspaceOf(f, await f.person('owner'))
		const until = T()
		const staff = await expiringStaff(f, until)
		const target = await f.person('target')
		expect(await assign(f, staff, scope, 'editor', { principalId: target.id })).toMatchObject({ ok: true })
		expect(await expiryOf(f, target, scope, 'editor')).toBe(until)
		expect(await assign(f, staff, scope, 'editor', { principalId: staff.id })).toMatchObject({ ok: true })
		expect(await expiryOf(f, staff, scope, 'editor')).toBe(until)
	})

	test('an assigner whose grants never expire gives a grant that never expires', async () => {
		const f = await fixture()
		const owner = await f.person('owner')
		const scope = await workspaceOf(f, owner)
		const target = await f.person('target')
		expect(await assign(f, owner, scope, 'editor', { principalId: target.id })).toMatchObject({ ok: true })
		expect(await expiryOf(f, target, scope, 'editor')).toBeNull()
	})

	test('an accepted invitation carries the inviter expiry at acceptance', async () => {
		const email = new CapturingEmail()
		const f = await fixture(email)
		const scope = await workspaceOf(f, await f.person('owner'))
		const until = T()
		const staff = await expiringStaff(f, until)
		expect(await assign(f, staff, scope, 'editor', { email: 'invitee@example.test' })).toMatchObject({ ok: true, invited: {} })
		const invitee = await f.repositories.principals.getPrincipalById((await f.person('invitee')).id)
		if (invitee === null) throw new Error('fixture')
		expect(await acceptInvitation(f.services, invitee, email.lastToken(), 'accept-req')).toMatchObject({ ok: true })
		expect((await f.repositories.membership.listRoleGrantsAt(APP, invitee.id, scope)).map((grant) => grant.expires_at)).toEqual([until])
	})

	test('a creator holding the creating action until T holds the creator role until T', async () => {
		const f = await fixture()
		const owner = await f.person('owner')
		const until = T()
		await f.repositories.grants.createRoleGrantUnlessHeld({ principalId: owner.id, app: APP, roleKey: 'starter', expiresAt: until })
		const result = await createScope(f.services, CALLER_ENV, f.ctx, { ...(await delegated(f, owner, CREATE_ENDPOINT)), dimension: 'workspace' })
		if (!result.ok) throw new Error(`no workspace: ${result.reason}`)
		expect(await expiryOf(f, owner, result.scope, result.role)).toBe(until)
	})
})
