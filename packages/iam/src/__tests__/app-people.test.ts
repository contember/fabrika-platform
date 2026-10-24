// An application's own people: the directory over every principal holding one of its roles
// (`listAppMembers`), and the administration of its global roles by whoever holds its `members.manage` globally there,
// through IAM's administration API and audited by IAM, with no installation admin involved.

import type { AppSchema } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { AuditWriter } from '../db'
import { prop } from '../json'
import { listAppMembers } from '../membership'
import { resolvePermissionsAt } from '../resolve'
import { hashToken } from '../secret'
import { mintFromKey } from '../tokens'
import { bearerRpc, consoleRpc, DelegatedBetweenCheckAndWrite, errorType, PEOPLE_SCHEMA, result, WIDENED_STAFF_SCHEMA } from './helpers/app-people'
import { CONSOLE_APP, createHarness, TEST_SIGNING_ENV, TestSqlDatabase } from './helpers/harness'
import { APP, CALLER_ENV, type MembershipFixture, membershipFixture, NOTES_SCHEMA, type Person } from './helpers/membership'

let seq = 0

async function people(schema: AppSchema = PEOPLE_SCHEMA): Promise<MembershipFixture> {
	const f = await membershipFixture(createHarness().repositories)
	expect((await f.putSchema(schema)).status).toBe(200)
	return f
}

/** `people()` whose delegated changes run `grants.between` after their check and before their write. */
async function racing(): Promise<{ f: MembershipFixture; grants: DelegatedBetweenCheckAndWrite }> {
	const h = createHarness()
	const db = new TestSqlDatabase(h.sqlite)
	const grants = new DelegatedBetweenCheckAndWrite(db, new AuditWriter(db, 'sqlite'))
	const f = await membershipFixture({ ...h.repositories, grants })
	expect((await f.putSchema(PEOPLE_SCHEMA)).status).toBe(200)
	return { f, grants }
}

async function holding(f: MembershipFixture, name: string, roleKey: string): Promise<Person> {
	const person = await f.person(name)
	await f.repositories.grants.createRoleGrantUnlessHeld({ principalId: person.id, app: APP, roleKey })
	return person
}

async function directory(f: MembershipFixture, person: Person, page: { after?: string; limit?: number } = {}) {
	seq += 1
	return listAppMembers(f.services, CALLER_ENV, f.ctx, { app: APP, credential: await person.token(), requestId: `people-${seq}`, ...page })
}

describe("the application's directory", () => {
	test('lists every principal holding a role of the application, global or in a value, with its roles', async () => {
		const f = await people()
		const reader = await holding(f, 'reader', 'reader')
		const staff = await holding(f, 'staff', 'staff')
		const editor = await f.person('editor')
		await f.repositories.grants.createRoleGrantUnlessHeld({
			principalId: editor.id,
			app: APP,
			roleKey: 'editor',
			scopeType: 'workspace',
			scopeValue: 'w1',
		})
		await f.person('stranger')

		const listed = await directory(f, reader)
		if (!listed.ok) throw new Error(`no directory: ${listed.reason}`)
		expect(Object.fromEntries(listed.members.map((member) => [member.principalId, member.roles]))).toEqual({
			[reader.id]: [{ role: 'reader', scope: null }],
			[staff.id]: [{ role: 'staff', scope: null }],
			[editor.id]: [{ role: 'editor', scope: { type: 'workspace', value: 'w1' } }],
		})
		// Without `directory: 'labels'` the list action sees no label, and never an address or a sign-in.
		expect(listed.members.map((member) => [member.label, member.email, member.lastSignInAt])).toEqual([[null, null, null], [null, null, null], [
			null,
			null,
			null,
		]])
		expect(listed.next).toBeNull()
	})

	test("labels under directory: 'labels'; addresses only to the application's members.manage", async () => {
		const f = await people({ ...PEOPLE_SCHEMA, directory: 'labels' })
		const reader = await holding(f, 'reader', 'reader')
		const administrator = await holding(f, 'administrator', 'administrator')
		const asReader = await directory(f, reader)
		if (!asReader.ok) throw new Error('no directory')
		expect(asReader.members.map((member) => [member.label, member.email]).sort()).toEqual([
			['administrator@example.test', null],
			['reader@example.test', null],
		])
		const asAdministrator = await directory(f, administrator)
		if (!asAdministrator.ok) throw new Error('no directory')
		expect(asAdministrator.members.map((member) => member.email).sort()).toEqual(['administrator@example.test', 'reader@example.test'])
	})

	test('pages run by principal id, at most the bound', async () => {
		const f = await people()
		const reader = await holding(f, 'reader', 'reader')
		for (const name of ['a', 'b', 'c']) await holding(f, `staff-${name}`, 'staff')
		const first = await directory(f, reader, { limit: 3 })
		if (!first.ok || first.next === null) throw new Error('expected a full first page')
		const second = await directory(f, reader, { after: first.next, limit: 3 })
		if (!second.ok) throw new Error('expected a second page')
		expect(second.next).toBeNull()
		const ids = [...first.members, ...second.members].map((member) => member.principalId)
		expect(ids).toHaveLength(4)
		expect([...ids].sort()).toEqual(ids)
		expect(await directory(f, reader, { limit: 101 })).toMatchObject({ ok: false, reason: 'invalid_request' })
	})

	test('needs the list action held globally, and an application that declares no people has no directory', async () => {
		const f = await people()
		const scopedReader = await f.person('scoped-reader')
		await f.repositories.grants.createGrant({
			principalId: scopedReader.id,
			app: APP,
			permissions: ['people.list'],
			scopeType: 'workspace',
			scopeValue: 'w1',
		})
		expect(await directory(f, scopedReader)).toEqual({ ok: false, reason: 'not_allowed' })
		expect(await directory(f, await holding(f, 'staff', 'staff'))).toEqual({ ok: false, reason: 'not_allowed' })

		const without = await people(NOTES_SCHEMA)
		expect(await directory(without, await holding(without, 'staff', 'staff'))).toMatchObject({ ok: false, reason: 'invalid_request' })
	})

	test('the reconcile refuses a members action outside the catalog, and a directory without members', async () => {
		const f = await membershipFixture(createHarness().repositories)
		expect((await f.putSchema({ ...PEOPLE_SCHEMA, members: { manage: 'people.manage', list: 'people.everyone' } })).status).toBe(400)
		expect((await f.putSchema({ ...NOTES_SCHEMA, directory: 'labels' })).status).toBe(400)
	})
})

describe("the application's administrator grants and revokes its global roles in IAM", () => {
	test('a grant by address writes the role and its audit row under the application; repeating it answers the same', async () => {
		const f = await people()
		const administrator = await holding(f, 'administrator', 'administrator')
		const newcomer = await f.person('newcomer')

		const apps = await consoleRpc(f, administrator.id, 'appPeople.apps', null)
		expect(apps.status).toBe(200)
		expect(prop(result(apps.body), 'items')).toEqual([{
			app: APP,
			displayName: null,
			// `auditor` and `starter` grant what the administrator lacks; `editor` and `publisher` are membership roles.
			roles: [
				{
					key: 'administrator',
					name: 'Administrator',
					permissions: ['people.manage', 'people.list', 'notes.read', 'notes.write', 'notes.share', 'notes.admin'],
				},
				{ key: 'reader', name: 'Reader', permissions: ['people.list'] },
				{ key: 'staff', name: 'Staff', permissions: ['notes.read', 'notes.write', 'notes.share', 'notes.admin'] },
				{ key: 'support', name: 'Support', permissions: ['notes.read', 'notes.admin'] },
			],
		}])

		const granted = await consoleRpc(f, administrator.id, 'appPeople.grant', { app: APP, role: 'staff', email: 'Newcomer@Example.test' })
		expect(granted).toEqual({ status: 200, body: { result: { principalId: newcomer.id, role: 'staff', granted: true } } })
		const principal = await f.repositories.principals.getPrincipalById(newcomer.id)
		if (principal === null) throw new Error('fixture')
		expect((await resolvePermissionsAt(f.services, principal, APP)).map((entry) => entry.action).sort()).toEqual([
			'notes.admin',
			'notes.read',
			'notes.share',
			'notes.write',
		])
		const events = await f.repositories.audit.listAuditEvents({ action: 'iam.grant.create', limit: 10 })
		expect(events.map((event) => [event.app, event.principal_id, event.resource_type])).toEqual([[APP, administrator.id, 'grant']])
		expect(JSON.stringify(events)).not.toContain('newcomer@example.test')

		expect(await consoleRpc(f, administrator.id, 'appPeople.grant', { app: APP, role: 'staff', email: 'newcomer@example.test' })).toEqual({
			status: 200,
			body: { result: { principalId: newcomer.id, role: 'staff', granted: false } },
		})
		expect(await f.repositories.audit.listAuditEvents({ action: 'iam.grant.create', limit: 10 })).toHaveLength(1)

		const listed = await consoleRpc(f, administrator.id, 'appPeople.list', { app: APP })
		expect(prop(result(listed.body), 'members')).toContainEqual(expect.objectContaining({ principalId: newcomer.id, email: 'newcomer@example.test' }))
	})

	test('a grant ends no later than the administrator grants behind it (S8)', async () => {
		const f = await people()
		const administrator = await f.person('administrator')
		const until = Math.floor(Date.now() / 1000) + 3600
		await f.repositories.grants.createRoleGrantUnlessHeld({ principalId: administrator.id, app: APP, roleKey: 'administrator', expiresAt: until })
		const newcomer = await f.person('newcomer')
		const granted = await consoleRpc(f, administrator.id, 'appPeople.grant', { app: APP, role: 'staff', email: 'newcomer@example.test' })
		expect(granted.status).toBe(200)
		const grants = (await f.repositories.grants.listGrants(newcomer.id)).filter((grant) => grant.role_key === 'staff')
		expect(grants.map((grant) => grant.expires_at)).toEqual([until])
	})

	test('a revoke removes the global grant with its audit row; repeating it answers the same', async () => {
		const f = await people()
		const administrator = await holding(f, 'administrator', 'administrator')
		const staff = await holding(f, 'staff', 'staff')
		expect(await consoleRpc(f, administrator.id, 'appPeople.revoke', { app: APP, role: 'staff', principalId: staff.id })).toEqual({
			status: 200,
			body: { result: { revoked: true } },
		})
		expect((await f.repositories.grants.listGrants(staff.id)).map((grant) => grant.role_key)).toEqual([])
		const events = await f.repositories.audit.listAuditEvents({ action: 'iam.grant.revoke', limit: 10 })
		expect(events.map((event) => [event.app, event.principal_id])).toEqual([[APP, administrator.id]])
		expect(await consoleRpc(f, administrator.id, 'appPeople.revoke', { app: APP, role: 'staff', principalId: staff.id })).toEqual({
			status: 200,
			body: { result: { revoked: false } },
		})
	})

	test('it gives no role it could not hold, no membership role or built-in, no unknown person, and no external one', async () => {
		const f = await people()
		const administrator = await holding(f, 'administrator', 'administrator')
		const target = await f.person('target')
		const grant = (role: string, email = 'target@example.test') => consoleRpc(f, administrator.id, 'appPeople.grant', { app: APP, role, email })

		for (const role of ['auditor', 'editor', 'admin', 'nonexistent']) {
			const refused = await grant(role)
			expect([role, refused.status, errorType(refused.body)]).toEqual([role, 403, 'forbidden'])
		}
		const unknown = await grant('staff', 'nobody@example.test')
		expect([unknown.status, errorType(unknown.body)]).toEqual([404, 'not_found'])
		await f.external('partner')
		const refused = await grant('staff', 'partner@partner.test')
		expect([refused.status, errorType(refused.body)]).toEqual([409, 'conflict'])
		expect((await f.repositories.grants.listGrants(target.id)).length).toBe(0)
	})

	test('a person without the application members.manage administers nothing, and gets the answer of an unknown application', async () => {
		const f = await people()
		const staff = await holding(f, 'staff', 'staff')
		await f.person('target')
		expect(prop(result((await consoleRpc(f, staff.id, 'appPeople.apps', null)).body), 'items')).toEqual([])
		for (const app of [APP, 'nowhere@prod']) {
			const refused = await consoleRpc(f, staff.id, 'appPeople.grant', { app, role: 'staff', email: 'target@example.test' })
			expect([app, refused.status, errorType(refused.body)]).toEqual([app, 404, 'not_found'])
		}
		// The administrator of the application holds no authority over another one's people.
		const administrator = await holding(f, 'administrator', 'administrator')
		const elsewhere = await consoleRpc(f, administrator.id, 'appPeople.list', { app: 'notes@stage' })
		expect([elsewhere.status, errorType(elsewhere.body)]).toEqual([404, 'not_found'])
	})

	test('a user key the proxy exchanged for a console token administers nothing: only a signed-in session does', async () => {
		const f = await people()
		const administrator = await holding(f, 'administrator', 'administrator')
		const target = await f.person('target')
		const key = 'px_console-bound-key'
		await f.repositories.credentials.createCredential({
			tokenHash: await hashToken(key),
			principalId: administrator.id,
			app: CONSOLE_APP,
			issuedBy: administrator.id,
			grants: [{ action: 'iam.principals.read' }],
		})
		// What the proxy does with a `px_` bearer at the console: mint a token of the console's audience from the key.
		const minted = await mintFromKey(f.services, TEST_SIGNING_ENV, { app: CONSOLE_APP, key, requestId: 'proxy-mint' })
		if (!minted.result.ok) throw new Error(`no token: ${minted.result.reason}`)
		const bearer = minted.result.token
		for (
			const [method, input] of [
				['appPeople.apps', null],
				['appPeople.list', { app: APP }],
				['appPeople.grant', { app: APP, role: 'staff', email: 'target@example.test' }],
				['appPeople.revoke', { app: APP, role: 'administrator', principalId: administrator.id }],
			] as const
		) {
			const refused = await bearerRpc(f, bearer, method, input)
			expect([method, refused.status, errorType(refused.body)]).toEqual([method, 403, 'forbidden'])
		}
		expect((await f.repositories.grants.listGrants(target.id)).length).toBe(0)
		expect((await f.repositories.grants.listGrants(administrator.id)).map((grant) => grant.role_key)).toEqual(['administrator'])
	})

	test('a reconcile widening the role between the check and the write: the grant writes nothing and records nothing', async () => {
		const { f, grants } = await racing()
		const administrator = await holding(f, 'administrator', 'administrator')
		const target = await f.person('target')
		grants.between = async () => expect((await f.putSchema(WIDENED_STAFF_SCHEMA)).status).toBe(200)
		const refused = await consoleRpc(f, administrator.id, 'appPeople.grant', { app: APP, role: 'staff', email: 'target@example.test' })
		expect([refused.status, errorType(refused.body)]).toEqual([409, 'conflict'])
		expect(await f.repositories.grants.listGrants(target.id)).toEqual([])
		expect(await f.repositories.audit.listAuditEvents({ action: 'iam.grant.create', limit: 10 })).toEqual([])
	})

	test("the administrator's role removed between the check and the write: neither a grant nor a revoke lands", async () => {
		const { f, grants } = await racing()
		const administrator = await holding(f, 'administrator', 'administrator')
		const [managing] = await f.repositories.grants.listGrants(administrator.id)
		if (managing === undefined) throw new Error('fixture')
		const supplement = await f.repositories.grants.createGrant({ principalId: administrator.id, app: APP, roleKey: 'support' })
		const target = await f.person('target')
		const staff = await holding(f, 'staff', 'staff')

		// A removal of another grant of the administrator moves its revision as surely as one of the managing grant.
		grants.between = () => f.repositories.grants.deleteGrant(supplement.id)
		const granted = await consoleRpc(f, administrator.id, 'appPeople.grant', { app: APP, role: 'staff', email: 'target@example.test' })
		expect([granted.status, errorType(granted.body)]).toEqual([409, 'conflict'])
		expect(await f.repositories.grants.listGrants(target.id)).toEqual([])

		grants.between = () => f.repositories.grants.deleteGrant(managing.id)
		const revoked = await consoleRpc(f, administrator.id, 'appPeople.revoke', { app: APP, role: 'staff', principalId: staff.id })
		expect([revoked.status, errorType(revoked.body)]).toEqual([409, 'conflict'])
		expect((await f.repositories.grants.listGrants(staff.id)).map((grant) => grant.role_key)).toEqual(['staff'])
		expect(await f.repositories.audit.listAuditEvents({ action: 'iam.grant.create', limit: 10 })).toEqual([])
		expect(await f.repositories.audit.listAuditEvents({ action: 'iam.grant.revoke', limit: 10 })).toEqual([])
	})

	test('an administrator revokes its own role, which moves the revision the guard reads', async () => {
		const f = await people()
		const administrator = await holding(f, 'administrator', 'administrator')
		expect(await consoleRpc(f, administrator.id, 'appPeople.revoke', { app: APP, role: 'administrator', principalId: administrator.id })).toEqual({
			status: 200,
			body: { result: { revoked: true } },
		})
		expect(await f.repositories.grants.listGrants(administrator.id)).toEqual([])
		expect(await f.repositories.audit.listAuditEvents({ action: 'iam.grant.revoke', limit: 10 })).toHaveLength(1)
	})

	test('a disabled administrator administers nothing', async () => {
		const f = await people()
		const administrator = await holding(f, 'administrator', 'administrator')
		await f.repositories.principals.disablePrincipal(administrator.id)
		const refused = await consoleRpc(f, administrator.id, 'appPeople.apps', null)
		expect(refused.status).toBe(403)
	})
})
