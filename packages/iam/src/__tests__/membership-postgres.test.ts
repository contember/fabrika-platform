// The membership operations against a REAL Postgres: the statements they depend on — the partial-index
// `ON CONFLICT` of an invitation, `INSERT … SELECT … ON CONFLICT` at acceptance, `DELETE … RETURNING` in a
// batch — and the one property no single connection can show: two concurrent revokes of the last two
// holders of the creator role leave one holder. Skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset.

import type { Scope } from '@fabrika/auth-core'
import { PostgresDatabase } from '@fabrika/platform-node'
import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createPostgresIamRepositories, type IamRepositories } from '../db'
import { acceptInvitation, assignMember, createScope, issueLink, listMembers, requestDelegation, revokeMember } from '../membership'
import { hashToken } from '../secret'
import {
	CALLER_ENV,
	CapturingEmail,
	CREATE_ENDPOINT,
	INVITE_ENDPOINT,
	InviterRemovedBeforeAcceptance,
	type MembershipFixture,
	membershipFixture,
	NOTES_SCHEMA,
	type Person,
} from './helpers/membership'
import { createPostgres, hasPostgres, type PostgresFixture, postgresUrl, skipReason } from './helpers/postgres'

if (!hasPostgres) {
	console.warn(`membership-postgres.test.ts ${skipReason}`)
}

const APP = 'notes@prod'

let fixture: PostgresFixture | null = null
let pool: PostgresDatabase | null = null
let repositories: IamRepositories
let concurrent: IamRepositories

beforeAll(async () => {
	if (!hasPostgres || postgresUrl === null) return
	fixture = await createPostgres('iam_membership')
	repositories = createPostgresIamRepositories(fixture.db)
	// A second pool on the same schema with room for two transactions at once.
	pool = PostgresDatabase.connect(postgresUrl, { connection: { search_path: fixture.schema }, max: 4 })
	concurrent = createPostgresIamRepositories(pool)
})

afterAll(async () => {
	await pool?.close()
	await fixture?.close()
})

let requestSeq = 0

async function delegated(f: MembershipFixture, person: Person, endpoint = INVITE_ENDPOINT) {
	requestSeq += 1
	const call = { app: APP, credential: await person.token(), requestId: `pg-req-${requestSeq}` }
	const result = await requestDelegation(f.services, CALLER_ENV, f.ctx, { ...call, endpoint })
	if (!result.ok) throw new Error(`no delegation: ${result.reason}`)
	return { ...call, delegation: result.grant }
}

async function workspaceOf(f: MembershipFixture, owner: Person): Promise<Scope> {
	await f.repositories.grants.createRoleGrantUnlessHeld({ principalId: owner.id, app: APP, roleKey: 'starter' })
	const result = await createScope(f.services, CALLER_ENV, f.ctx, { ...(await delegated(f, owner, CREATE_ENDPOINT)), dimension: 'workspace' })
	if (!result.ok) throw new Error(`no workspace: ${result.reason}`)
	return result.scope
}

let fixtureSeq = 0

describe.skipIf(!hasPostgres)('membership on Postgres', () => {
	test('a value, an assignment, an invitation accepted once, a list and a link', async () => {
		fixtureSeq += 1
		const email = new CapturingEmail()
		const f = await membershipFixture(repositories, { email })
		const owner = await f.person(`owner-${fixtureSeq}`)
		const scope = await workspaceOf(f, owner)
		const editor = await f.person(`editor-${fixtureSeq}`)
		const assign = { scope, role: 'editor' }

		expect(await assignMember(f.services, CALLER_ENV, f.ctx, { ...(await delegated(f, owner)), ...assign, member: { principalId: editor.id } }))
			.toEqual({ ok: true, assigned: { principalId: editor.id, role: 'editor' } })
		expect(await assignMember(f.services, CALLER_ENV, f.ctx, { ...(await delegated(f, owner)), ...assign, member: { principalId: editor.id } }))
			.toEqual({ ok: true, assigned: { principalId: editor.id, role: 'editor' } })

		const inviteeEmail = `invitee-${fixtureSeq}@example.test`
		const first = await assignMember(f.services, CALLER_ENV, f.ctx, { ...(await delegated(f, owner)), ...assign, member: { email: inviteeEmail } })
		const repeated = await assignMember(f.services, CALLER_ENV, f.ctx, { ...(await delegated(f, owner)), ...assign, member: { email: inviteeEmail } })
		expect(repeated).toEqual(first)
		expect(email.messages).toHaveLength(1)

		const invitee = await f.person(`invitee-${fixtureSeq}`)
		const principal = await repositories.principals.getPrincipalById(invitee.id)
		if (principal === null) throw new Error('fixture')
		expect((await acceptInvitation(f.services, principal, email.lastToken(), 'accept-req')).ok).toBe(true)
		expect(await acceptInvitation(f.services, principal, email.lastToken(), 'accept-req')).toEqual({ ok: false, reason: 'invalid' })

		const listed = await listMembers(f.services, CALLER_ENV, f.ctx, { app: APP, credential: await owner.token(), requestId: 'pg-list', scope })
		if (!listed.ok) throw new Error('expected a list')
		expect(listed.members.map((member) => member.principalId).sort()).toEqual([owner.id, editor.id, invitee.id].sort())

		const link = await issueLink(f.services, CALLER_ENV, f.ctx, {
			app: APP,
			credential: await owner.token(),
			requestId: 'pg-link',
			mount: 'shared',
			chain: [{ type: 'note', value: 'n1' }, scope],
			days: 3,
		})
		expect(link.ok).toBe(true)
		await f.ctx.settle()
	})

	test('two concurrent revokes of the last two creators leave one', async () => {
		fixtureSeq += 1
		const f = await membershipFixture(repositories)
		const first = await f.person(`first-${fixtureSeq}`)
		const scope = await workspaceOf(f, first)
		const second = await f.person(`second-${fixtureSeq}`)
		await assignMember(f.services, CALLER_ENV, f.ctx, { ...(await delegated(f, first)), scope, role: 'owner', member: { principalId: second.id } })

		for (let round = 0; round < 5; round++) {
			const outcomes = await Promise.all([
				concurrent.membership.deleteCreatorGrantUnlessLast(APP, first.id, 'owner', scope),
				concurrent.membership.deleteCreatorGrantUnlessLast(APP, second.id, 'owner', scope),
			])
			const holders = (await repositories.membership.listMemberGrants(APP, scope)).filter((grant) => grant.role_key === 'owner')
			expect(holders).toHaveLength(1)
			expect(outcomes.filter(Boolean)).toHaveLength(1)
			const survivor = holders[0]?.principal_id === first.id ? first : second
			const leaver = survivor === first ? second : first
			await revokeMember(f.services, CALLER_ENV, f.ctx, { ...(await delegated(f, survivor)), scope, member: { principalId: survivor.id } })
			await assignMember(f.services, CALLER_ENV, f.ctx, { ...(await delegated(f, survivor)), scope, role: 'owner', member: { principalId: leaver.id } })
		}
	})

	test('two concurrent revokes of the last two creators an administrator granted leave one', async () => {
		const f = await membershipFixture(repositories)
		for (let round = 0; round < 5; round++) {
			fixtureSeq += 1
			const scope = { type: 'workspace', value: `admin-made-${fixtureSeq}` }
			const owners = [await f.person(`admin-a-${fixtureSeq}`), await f.person(`admin-b-${fixtureSeq}`)]
			for (const owner of owners) {
				await repositories.grants.createGrant({ principalId: owner.id, app: APP, roleKey: 'owner', scopeType: scope.type, scopeValue: scope.value })
			}
			const outcomes = await Promise.all(owners.map((owner) => concurrent.membership.deleteCreatorGrantUnlessLast(APP, owner.id, 'owner', scope)))
			expect(outcomes.filter(Boolean)).toHaveLength(1)
			expect((await repositories.membership.listMemberGrants(APP, scope)).filter((grant) => grant.role_key === 'owner')).toHaveLength(1)
		}
	})

	test('concurrent acceptances of one invitation write one grant, and none survives a revoke', async () => {
		const email = new CapturingEmail()
		const f = await membershipFixture(repositories, { email })
		fixtureSeq += 1
		const owner = await f.person(`accept-owner-${fixtureSeq}`)
		const scope = await workspaceOf(f, owner)
		await assignMember(f.services, CALLER_ENV, f.ctx, {
			...(await delegated(f, owner)),
			scope,
			role: 'editor',
			member: { email: `accept-invitee-${fixtureSeq}@example.test` },
		})
		const invitee = await f.person(`accept-invitee-${fixtureSeq}`)
		const invitation = await repositories.membership.getInvitationByHash(await hashToken(email.lastToken()))
		if (invitation === null) throw new Error('fixture')
		const outcomes = await Promise.all([1, 2, 3].map(() => concurrent.membership.acceptInvitation(invitation, invitee.id, ['owner'])))
		expect(outcomes.filter((outcome) => outcome === 'accepted')).toHaveLength(1)
		await repositories.membership.deleteRoleGrant(APP, invitee.id, 'editor', scope)
		expect(await concurrent.membership.acceptInvitation(invitation, invitee.id, ['owner'])).toBe('not_open')
		expect(await repositories.membership.listRoleGrantsAt(APP, invitee.id, scope)).toEqual([])
	})

	test('an inviter removed after the acceptance checks passed and before its write grants nothing, and the invitation stays open', async () => {
		if (fixture === null) throw new Error('fixture')
		const email = new CapturingEmail()
		const removing = new InviterRemovedBeforeAcceptance(fixture.db, { dialect: 'postgres' })
		const f = await membershipFixture({ ...repositories, membership: removing }, { email })
		fixtureSeq += 1
		const owner = await f.person(`removed-owner-${fixtureSeq}`)
		const scope = await workspaceOf(f, owner)
		const second = await f.person(`remaining-owner-${fixtureSeq}`)
		await assignMember(f.services, CALLER_ENV, f.ctx, { ...(await delegated(f, owner)), scope, role: 'owner', member: { principalId: second.id } })
		const invitedEmail = `removed-invitee-${fixtureSeq}@example.test`
		await assignMember(f.services, CALLER_ENV, f.ctx, { ...(await delegated(f, owner)), scope, role: 'editor', member: { email: invitedEmail } })
		const invitee = await repositories.principals.getPrincipalById((await f.person(`removed-invitee-${fixtureSeq}`)).id)
		if (invitee === null) throw new Error('fixture')
		removing.removeBeforeAcceptance = { app: APP, principalId: owner.id, roleKey: 'owner', scope }
		expect(await acceptInvitation(f.services, invitee, email.lastToken(), 'accept-req')).toEqual({ ok: false, reason: 'not_allowed' })
		expect(await repositories.membership.listRoleGrantsAt(APP, invitee.id, scope)).toEqual([])
		const invitation = await repositories.membership.getInvitationByHash(await hashToken(email.lastToken()))
		expect([invitation?.accepted_at, invitation?.revoked_at]).toEqual([null, null])
	})

	test("an acceptance waits for a removal that holds the inviter's grant, then grants nothing", async () => {
		if (fixture === null || postgresUrl === null) throw new Error('fixture')
		const email = new CapturingEmail()
		const f = await membershipFixture(repositories, { email })
		fixtureSeq += 1
		const owner = await f.person(`locked-owner-${fixtureSeq}`)
		const scope = await workspaceOf(f, owner)
		const second = await f.person(`locked-second-${fixtureSeq}`)
		await assignMember(f.services, CALLER_ENV, f.ctx, { ...(await delegated(f, owner)), scope, role: 'owner', member: { principalId: second.id } })
		await assignMember(f.services, CALLER_ENV, f.ctx, {
			...(await delegated(f, owner)),
			scope,
			role: 'editor',
			member: { email: `locked-invitee-${fixtureSeq}@example.test` },
		})
		const invitee = await f.person(`locked-invitee-${fixtureSeq}`)
		const invitation = await repositories.membership.getInvitationByHash(await hashToken(email.lastToken()))
		if (invitation === null) throw new Error('fixture')

		// The removal's transaction has deleted the inviter's grant and not committed yet.
		const removal = new SQL({ url: postgresUrl, max: 1, connection: { search_path: fixture.schema } })
		const reserved = await removal.reserve()
		try {
			await reserved.unsafe('BEGIN')
			await reserved.unsafe('DELETE FROM grants WHERE app = $1 AND principal_id = $2 AND role_key = $3 AND scope_value = $4', [
				APP,
				owner.id,
				'owner',
				scope.value,
			])
			let settled = false
			const acceptance = concurrent.membership.acceptInvitation(invitation, invitee.id, ['owner']).finally(() => {
				settled = true
			})
			await Bun.sleep(300)
			expect(settled).toBe(false)
			await reserved.unsafe('COMMIT')
			expect(await acceptance).toBe('not_allowed')
		} finally {
			reserved.release()
			await removal.close()
		}
		expect(await repositories.membership.listRoleGrantsAt(APP, invitee.id, scope)).toEqual([])
	})

	test('a link issued while a reconcile removes its mount is never left usable', async () => {
		const f = await membershipFixture(repositories)
		fixtureSeq += 1
		const owner = await f.person(`link-owner-${fixtureSeq}`)
		const scope = await workspaceOf(f, owner)
		if (pool === null) throw new Error('fixture')
		// A reconcile that has deleted the mount and holds its transaction open, as a slow one would.
		const removal = pool.batch([
			pool.prepare("DELETE FROM app_link_mounts WHERE app = ? AND mount = 'shared'").bind(APP),
			pool.prepare('SELECT pg_sleep(0.4)'),
			pool.prepare(`UPDATE credentials SET revoked_at = 1 WHERE app = ? AND link_mount IS NOT NULL AND revoked_at IS NULL AND NOT EXISTS (
				SELECT 1 FROM app_link_mounts m WHERE m.app = credentials.app AND m.mount = credentials.link_mount AND m.dimension = credentials.link_dimension)`)
				.bind(APP),
		])
		await Bun.sleep(100)
		const issued = await concurrent.credentials.createLinkCredential({
			tokenHash: `race-${fixtureSeq}`,
			label: 'link:shared',
			app: APP,
			issuedBy: owner.id,
			expiresAt: Math.floor(Date.now() / 1000) + 60,
			grants: [{ action: 'notes.read', scopeType: 'note', scopeValue: 'n1' }],
			link: { mount: 'shared', chain: [{ type: 'note', value: 'n1' }, scope] },
		})
		await removal
		expect(issued).toBeNull()
		expect((await f.putSchema(NOTES_SCHEMA)).status).toBe(200)
	})
})
