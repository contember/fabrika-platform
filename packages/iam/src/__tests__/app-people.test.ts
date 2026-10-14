// An application's own people: the directory over every principal holding one of its roles
// (`listAppMembers`), and the administration of its global roles by whoever holds its `members.manage` globally there,
// through IAM's administration API and audited by IAM, with no installation admin involved.

import type { AppSchema } from '@fabrika/auth-core'
import { unusedDatabase } from '@fabrika/platform/testing'
import { describe, expect, test } from 'bun:test'
import { createIamApp } from '../app'
import { prop } from '../json'
import { listAppMembers } from '../membership'
import { resolvePermissionsAt } from '../resolve'
import { adminTokenFor, createHarness, TEST_SIGNING_KEYS } from './helpers/harness'
import { APP, CALLER_ENV, type MembershipFixture, membershipFixture, NOTES_SCHEMA, ORIGIN, type Person } from './helpers/membership'

/** `NOTES_SCHEMA` with people of its own: `people.manage` administers them, `people.list` reads the directory. */
const PEOPLE_SCHEMA: AppSchema = {
	...NOTES_SCHEMA,
	actions: [...NOTES_SCHEMA.actions, { action: 'people.manage' }, { action: 'people.list' }],
	roles: {
		...NOTES_SCHEMA.roles,
		// The application's administrator: it manages its people and holds what `staff` grants.
		administrator: { name: 'Administrator', permissions: ['people.manage', 'people.list', 'notes.read', 'notes.write', 'notes.share', 'notes.admin'] },
		reader: { name: 'Reader', permissions: ['people.list'] },
		publisher: NOTES_SCHEMA.roles['publisher'] ?? { name: 'Publisher', permissions: [] },
		auditor: { name: 'Auditor', permissions: ['notes.read', 'notes.publish'] },
	},
	members: { manage: 'people.manage', list: 'people.list' },
}

let seq = 0

async function people(schema: AppSchema = PEOPLE_SCHEMA): Promise<MembershipFixture> {
	const f = await membershipFixture(createHarness().repositories)
	expect((await f.putSchema(schema)).status).toBe(200)
	return f
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

/** Call `/admin/rpc` with the console token of `principalId`, as Control's gateway forwards it. */
async function consoleRpc(f: MembershipFixture, principalId: string, method: string, input: unknown): Promise<{ status: number; body: unknown }> {
	const bearer = await adminTokenFor(f.repositories, principalId, { issuer: ORIGIN })
	const response = await createIamApp().fetch(
		new Request(`${ORIGIN}/admin/rpc`, {
			method: 'POST',
			headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
			body: JSON.stringify({ method, input }),
		}),
		{
			DB: unusedDatabase,
			REPOSITORIES: f.repositories,
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
		},
		f.ctx,
	)
	return { status: response.status, body: await response.json() }
}

const result = (body: unknown): unknown => prop(body, 'result')
const errorType = (body: unknown): unknown => prop(prop(body, 'error'), 'type')

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
		const target = await f.person('target')
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

	test('a disabled administrator administers nothing', async () => {
		const f = await people()
		const administrator = await holding(f, 'administrator', 'administrator')
		await f.repositories.principals.disablePrincipal(administrator.id)
		const refused = await consoleRpc(f, administrator.id, 'appPeople.apps', null)
		expect(refused.status).toBe(403)
	})
})
