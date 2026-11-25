// ADR-0083 §4: while an application's console grants wait, a grant change becomes a request that resolves nothing until
// another administrator of the application, a person in a session, approves it; the approval makes the change in the
// transaction that claims the request. On SQLite always, and on a real Postgres when FABRIKA_TEST_POSTGRES_URL is set.

import type { SqlDatabase } from '@fabrika/platform'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createPostgresIamRepositories, type IamRepositories } from '../db'
import { prop } from '../json'
import { resolvePermissionsAt } from '../resolve'
import { bearerRpc, consoleRpc, errorType, PEOPLE_SCHEMA, result } from './helpers/app-people'
import { adminTokenFor, createHarness, TestSqlDatabase } from './helpers/harness'
import { APP, type MembershipFixture, membershipFixture, ORIGIN, type Person } from './helpers/membership'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

let seq = 0
const PROVISIONING_KEY = 'px_provisioning-key-of-this-suite'

interface World {
	readonly f: MembershipFixture
	/** Two installation administrators, each a person in a signed-in console session. */
	readonly ada: Person
	readonly bob: Person
	readonly grantee: Person
	readonly granteeEmail: string
	readonly db: SqlDatabase
	call(as: Person, method: string, input: unknown): Promise<{ status: number; body: unknown }>
	/** Make the application's grants wait, as Control does with the provisioning key, at Control's protection revision. */
	gate(required: boolean, options?: { app?: string; revision?: number }): Promise<{ status: number; body: unknown }>
	permissions(principalId: string): Promise<string[]>
}

interface Backend {
	readonly repositories: IamRepositories
	readonly db: SqlDatabase
}

function grantRequestSuite(backend: () => Backend): void {
	async function world(): Promise<World> {
		const { repositories, db } = backend()
		// The Postgres fixture is one schema for the whole file, and every world uses the application `APP`.
		await db.prepare('DELETE FROM grant_requests').run()
		await db.prepare('DELETE FROM app_grant_approvals').run()
		const f = await membershipFixture(repositories)
		expect((await f.putSchema(PEOPLE_SCHEMA)).status).toBe(200)
		seq += 1
		const administrator = async (name: string): Promise<Person> => {
			const person = await f.person(`${name}-${seq}`)
			await f.repositories.grants.createGrant({ principalId: person.id, roleKey: 'admin' })
			return person
		}
		const ada = await administrator('ada')
		const bob = await administrator('bob')
		const grantee = await f.person(`grantee-${seq}`)
		let revision = 0
		return {
			f,
			ada,
			bob,
			grantee,
			granteeEmail: `grantee-${seq}@example.test`,
			db,
			call: (as, method, input) => consoleRpc(f, as.id, method, input),
			gate: async (required, options = {}) => {
				revision += 1
				const input = { app: options.app ?? APP, required, revision: options.revision ?? revision }
				return await bearerRpc(f, PROVISIONING_KEY, 'grantApproval.set', input, { FABRIKA_IAM_PROVISIONING_KEY: PROVISIONING_KEY })
			},
			permissions: async (principalId) => {
				const principal = await f.repositories.principals.getPrincipalById(principalId)
				if (principal === null) throw new Error(`no principal ${principalId}`)
				return (await resolvePermissionsAt(f.services, principal, APP)).map((entry) => entry.action).sort()
			},
		}
	}

	const pendingId = (body: unknown): string => {
		const id = prop(prop(result(body), 'pending'), 'id')
		if (typeof id !== 'string') throw new Error(`no pending request in ${JSON.stringify(body)}`)
		return id
	}

	const staffGrant = (w: World) => ({ principalId: w.grantee.id, app: APP, roleKey: 'staff' })

	async function actions(w: World, requestId: string): Promise<string[]> {
		const events = await w.f.repositories.audit.listAuditEvents({ limit: 200 })
		const names = (metadata: string | null): unknown => (metadata === null ? null : prop(JSON.parse(metadata), 'grantRequestId'))
		return events.filter((event) => event.resource_id === requestId || names(event.metadata) === requestId).map((event) => event.action).sort()
	}

	test('an application whose grants do not wait applies a grant at once, as before', async () => {
		const w = await world()
		const created = await w.call(w.ada, 'grants.create', staffGrant(w))
		expect(created.status).toBe(200)
		expect(prop(result(created.body), 'roleKey')).toBe('staff')
		expect(await w.permissions(w.grantee.id)).toContain('notes.write')
	})

	test('a gated grant is a pending request that grants nothing until another administrator approves it', async () => {
		const w = await world()
		expect((await w.gate(true)).status).toBe(200)

		const requested = await w.call(w.ada, 'grants.create', staffGrant(w))
		expect(requested.status).toBe(200)
		const id = pendingId(requested.body)
		expect(prop(prop(result(requested.body), 'pending'), 'status')).toBe('pending')
		expect(await w.f.repositories.grants.listGrants(w.grantee.id)).toEqual([])
		expect(await w.permissions(w.grantee.id)).toEqual([])

		const listed = await w.call(w.bob, 'grantRequests.list', {})
		const items = prop(result(listed.body), 'items')
		expect(Array.isArray(items) ? items.map((item: unknown) => prop(item, 'id')) : items).toEqual([id])

		const own = await w.call(w.ada, 'grantRequests.decide', { id, decision: 'approve' })
		expect([own.status, errorType(own.body)]).toEqual([403, 'forbidden'])
		expect(await w.permissions(w.grantee.id)).toEqual([])

		const approved = await w.call(w.bob, 'grantRequests.decide', { id, decision: 'approve' })
		expect(approved.status).toBe(200)
		expect(prop(result(approved.body), 'status')).toBe('approved')
		expect(prop(result(approved.body), 'decidedBy')).toBe(w.bob.id)
		expect(await w.permissions(w.grantee.id)).toContain('notes.write')
		expect(await actions(w, id)).toEqual(['iam.grant.create', 'iam.grant.request'])

		const again = await w.call(w.bob, 'grantRequests.decide', { id, decision: 'approve' })
		expect(again.status).toBe(409)
		expect(await w.f.repositories.grants.listGrants(w.grantee.id)).toHaveLength(1)
	})

	test('the Control approval request a console grant carries is recorded, bounded, and changes neither who may grant nor the gate', async () => {
		const w = await world()
		const approvalRequest = { id: 'req-1', requester: { id: 'kim', label: 'kim via agent', clientId: 'https://agent.example.test/client.json' } }
		const oversized = [
			{ ...approvalRequest, id: 'r'.repeat(201) },
			{ ...approvalRequest, requester: { ...approvalRequest.requester, id: 'k'.repeat(201) } },
			{ ...approvalRequest, requester: { ...approvalRequest.requester, label: 'l'.repeat(501) } },
			{ ...approvalRequest, requester: { ...approvalRequest.requester, clientId: `https://agent.example.test/${'c'.repeat(2048)}` } },
		]
		for (const field of oversized) {
			const refused = await w.call(w.ada, 'grants.create', { ...staffGrant(w), approvalRequest: field })
			expect([refused.status, errorType(refused.body)]).toEqual([400, 'validation'])
		}
		expect(await w.f.repositories.grants.listGrants(w.grantee.id)).toEqual([])
		// Who may grant is unchanged: a person who administers nothing is refused with it as without it.
		expect((await w.call(w.grantee, 'grants.create', { ...staffGrant(w), approvalRequest })).status).toBe(403)

		const created = await w.call(w.ada, 'grants.create', { ...staffGrant(w), approvalRequest })
		expect(created.status).toBe(200)
		const grantId = prop(result(created.body), 'id')
		const events = await w.f.repositories.audit.listAuditEvents({ limit: 200 })
		const record = events.find((event) => event.action === 'iam.grant.create' && event.resource_id === grantId)
		expect(record?.principal_id).toBe(w.ada.id)
		expect(prop(JSON.parse(record?.metadata ?? 'null'), 'approvalRequest')).toEqual(approvalRequest)

		// The gate is unchanged: with the application's grants waiting, it becomes a request, which records it too.
		expect((await w.gate(true)).status).toBe(200)
		const waiting = await w.call(w.ada, 'grants.create', { principalId: w.grantee.id, app: APP, roleKey: 'reader', approvalRequest })
		const id = pendingId(waiting.body)
		expect((await w.f.repositories.grants.listGrants(w.grantee.id)).map((grant) => grant.role_key)).toEqual(['staff'])
		const requested = (await w.f.repositories.audit.listAuditEvents({ limit: 200 })).find((event) =>
			event.action === 'iam.grant.request' && event.resource_id === id
		)
		expect(prop(JSON.parse(requested?.metadata ?? 'null'), 'approvalRequest')).toEqual(approvalRequest)
	})

	test('the requester withdraws a request, which then grants nothing and cannot be approved', async () => {
		const w = await world()
		await w.gate(true)
		const id = pendingId((await w.call(w.ada, 'grants.create', staffGrant(w))).body)
		const withdrawn = await w.call(w.ada, 'grantRequests.decide', { id, decision: 'reject' })
		expect(prop(result(withdrawn.body), 'status')).toBe('rejected')
		expect((await w.call(w.bob, 'grantRequests.decide', { id, decision: 'approve' })).status).toBe(409)
		expect(await w.permissions(w.grantee.id)).toEqual([])
		expect(await actions(w, id)).toEqual(['iam.grant.request', 'iam.grant.request.reject'])
	})

	test('a revocation and an edit wait too: the grant stays as it was until the approval', async () => {
		const w = await world()
		const grant = prop(result((await w.call(w.ada, 'grants.create', staffGrant(w))).body), 'id')
		await w.gate(true)

		const edit = pendingId((await w.call(w.ada, 'grants.update', { id: grant, roleKey: 'reader' })).body)
		expect(await w.permissions(w.grantee.id)).toContain('notes.write')
		expect((await w.call(w.bob, 'grantRequests.decide', { id: edit, decision: 'approve' })).status).toBe(200)
		expect(await w.permissions(w.grantee.id)).toEqual(['people.list'])

		const revocation = await w.call(w.ada, 'grants.delete', { id: grant })
		const id = pendingId(revocation.body)
		expect(await w.permissions(w.grantee.id)).toEqual(['people.list'])
		expect((await w.call(w.bob, 'grantRequests.decide', { id, decision: 'approve' })).status).toBe(200)
		expect(await w.f.repositories.grants.listGrants(w.grantee.id)).toEqual([])
		expect(await actions(w, id)).toEqual(['iam.grant.request', 'iam.grant.revoke'])
	})

	test("an application administrator's grant through appPeople waits as well", async () => {
		const w = await world()
		const administrator = await w.f.person(`app-admin-${seq}`)
		await w.f.repositories.grants.createRoleGrantUnlessHeld({ principalId: administrator.id, app: APP, roleKey: 'administrator' })
		await w.gate(true)
		const granted = await w.call(administrator, 'appPeople.grant', { app: APP, role: 'staff', email: w.granteeEmail })
		expect(granted.status).toBe(200)
		const id = pendingId(granted.body)
		expect(await w.permissions(w.grantee.id)).toEqual([])
		expect((await w.call(w.ada, 'grantRequests.decide', { id, decision: 'approve' })).status).toBe(200)
		expect(await w.permissions(w.grantee.id)).toContain('notes.write')
	})

	test('a cross-app grant reaches no application and never waits', async () => {
		const w = await world()
		await w.gate(true)
		const created = await w.call(w.ada, 'grants.create', { principalId: w.grantee.id, app: null, roleKey: 'admin' })
		expect(created.status).toBe(200)
		expect(prop(result(created.body), 'pending')).toBeUndefined()
	})

	test('a request past its expiry is no longer listed and cannot be approved', async () => {
		const w = await world()
		await w.gate(true)
		const id = pendingId((await w.call(w.ada, 'grants.create', staffGrant(w))).body)
		await w.db.prepare('UPDATE grant_requests SET expires_at = 1 WHERE id = ?').bind(id).run()
		expect(prop(result((await w.call(w.bob, 'grantRequests.list', {})).body), 'items')).toEqual([])
		expect((await w.call(w.bob, 'grantRequests.decide', { id, decision: 'approve' })).status).toBe(409)
		expect(await w.permissions(w.grantee.id)).toEqual([])
	})

	test('a key never decides: only a person in a signed-in session', async () => {
		const w = await world()
		await w.gate(true)
		const id = pendingId((await w.call(w.ada, 'grants.create', staffGrant(w))).body)
		const bearer = await adminTokenFor(w.f.repositories, w.bob.id, { issuer: ORIGIN, session: false })
		expect((await bearerRpc(w.f, bearer, 'grantRequests.decide', { id, decision: 'approve' })).status).toBe(403)
		expect(await w.permissions(w.grantee.id)).toEqual([])
	})

	test('dropping the gate applies grants at once again; the gate is set only on an application environment', async () => {
		const w = await world()
		await w.gate(true)
		await w.gate(false)
		expect(prop(result((await w.call(w.ada, 'grants.create', staffGrant(w))).body), 'pending')).toBeUndefined()
		expect((await w.gate(true, { app: 'vozka' })).status).toBe(400)
		expect((await w.gate(true, { app: 'notes' })).status).toBe(400)
	})

	test('only the provisioning key sets the gate: an installation administrator cannot switch it off to grant past it', async () => {
		const w = await world()
		await w.gate(true, { revision: 1 })
		const input = { app: APP, required: false, revision: 2 }
		const administrator = await w.call(w.ada, 'grantApproval.set', input)
		expect([administrator.status, errorType(administrator.body)]).toEqual([403, 'forbidden'])
		expect((await w.call(w.grantee, 'grantApproval.set', input)).status).toBe(403)
		expect(prop(result((await w.call(w.ada, 'grants.create', staffGrant(w))).body), 'pending')).toBeDefined()
	})

	test('a gate change older than the one IAM holds changes nothing, so a late release cannot undo a newer gate', async () => {
		const w = await world()
		const gateRecords = async () =>
			(await w.f.repositories.audit.listAuditEvents({ limit: 500 })).filter((event) => event.action === 'iam.grant_approval.set')
		const earlier = new Set((await gateRecords()).map((event) => event.id))
		expect(result((await w.gate(true, { revision: 5 })).body)).toEqual({ app: APP, required: true, revision: 5 })
		expect(result((await w.gate(false, { revision: 4 })).body)).toEqual({ app: APP, required: true, revision: 5 })
		expect(prop(result((await w.call(w.ada, 'grants.create', staffGrant(w))).body), 'pending')).toBeDefined()
		expect(result((await w.gate(true, { revision: 6 })).body)).toEqual({ app: APP, required: true, revision: 6 })
		expect(result((await w.gate(false, { revision: 6 })).body)).toEqual({ app: APP, required: false, revision: 6 })
		const records = (await gateRecords()).filter((event) => !earlier.has(event.id))
		expect(records.map((event) => prop(JSON.parse(event.metadata ?? 'null'), 'required'))).toEqual([false, true])
	})

	test('an approval checks the role again: a request for a role the application no longer declares is refused', async () => {
		const w = await world()
		await w.gate(true)
		const id = pendingId((await w.call(w.ada, 'grants.create', { principalId: w.grantee.id, app: APP, roleKey: 'auditor' })).body)
		const { auditor: _dropped, ...roles } = PEOPLE_SCHEMA.roles
		expect((await w.f.putSchema({ ...PEOPLE_SCHEMA, roles })).status).toBe(200)
		const refused = await w.call(w.bob, 'grantRequests.decide', { id, decision: 'approve' })
		expect(refused.status).toBe(409)
		expect(await w.f.repositories.grants.listGrants(w.grantee.id)).toEqual([])
	})

	test('a claimed request whose change writes nothing ends failed in the same batch, with no grant and no record of one', async () => {
		const w = await world()
		await w.gate(true)
		const first = pendingId((await w.call(w.ada, 'grants.create', staffGrant(w))).body)
		const second = pendingId((await w.call(w.ada, 'grants.create', staffGrant(w))).body)
		expect((await w.call(w.bob, 'grantRequests.decide', { id: first, decision: 'approve' })).status).toBe(200)
		// The approval's own check refuses a held role, so the race it guards against is driven at the repository.
		const request = await w.f.repositories.grantRequests.get(second)
		if (request === null) throw new Error('the request is missing')
		const now = Math.floor(Date.now() / 1000)
		const applied = await w.f.repositories.grants.applyRequest(request, null, { id: crypto.randomUUID(), by: w.bob.id, at: now }, (grantId) => ({
			requestId: 'race',
			principalId: w.bob.id,
			principalLabel: w.bob.id,
			app: APP,
			action: 'iam.grant.create',
			resourceType: 'grant',
			resourceId: grantId,
			metadata: { grantRequestId: second },
		}))
		expect(applied).toEqual({ claimed: true, changed: null })
		expect((await w.f.repositories.grantRequests.get(second))?.status).toBe('failed')
		expect(await w.f.repositories.grants.listGrants(w.grantee.id)).toHaveLength(1)
		expect(await actions(w, second)).toEqual(['iam.grant.request'])
	})

	test('an expired role is renewed in place through an approved appPeople request, as the direct path renews it', async () => {
		const w = await world()
		const administrator = await w.f.person(`app-admin-${seq}`)
		await w.f.repositories.grants.createRoleGrantUnlessHeld({ principalId: administrator.id, app: APP, roleKey: 'administrator' })
		await w.f.repositories.grants.createRoleGrantUnlessHeld({ principalId: w.grantee.id, app: APP, roleKey: 'staff' })
		const [expired] = await w.f.repositories.grants.listGrants(w.grantee.id)
		if (expired === undefined) throw new Error('the grant is missing')
		await w.db.prepare('UPDATE grants SET expires_at = 1 WHERE id = ?').bind(expired.id).run()
		expect(await w.permissions(w.grantee.id)).toEqual([])
		await w.gate(true)
		const id = pendingId((await w.call(administrator, 'appPeople.grant', { app: APP, role: 'staff', email: w.granteeEmail })).body)
		expect((await w.call(w.ada, 'grantRequests.decide', { id, decision: 'approve' })).status).toBe(200)
		expect(await w.permissions(w.grantee.id)).toContain('notes.write')
		expect((await w.f.repositories.grants.listGrants(w.grantee.id)).map((grant) => grant.id)).toEqual([expired.id])
	})

	test("an application administrator lists and withdraws its own appPeople request, and decides no one else's", async () => {
		const w = await world()
		const administrator = await w.f.person(`app-admin-${seq}`)
		await w.f.repositories.grants.createRoleGrantUnlessHeld({ principalId: administrator.id, app: APP, roleKey: 'administrator' })
		await w.gate(true)
		const own = pendingId((await w.call(administrator, 'appPeople.grant', { app: APP, role: 'staff', email: w.granteeEmail })).body)
		const other = pendingId((await w.call(w.ada, 'grants.create', { principalId: w.grantee.id, app: APP, roleKey: 'reader' })).body)
		const listed = prop(result((await w.call(administrator, 'grantRequests.list', {})).body), 'items')
		expect(Array.isArray(listed) ? listed.map((item: unknown) => prop(item, 'id')) : listed).toEqual([own])
		expect((await w.call(administrator, 'grantRequests.decide', { id: other, decision: 'reject' })).status).toBe(404)
		expect((await w.call(administrator, 'grantRequests.decide', { id: own, decision: 'approve' })).status).toBe(404)
		const withdrawn = await w.call(administrator, 'grantRequests.decide', { id: own, decision: 'reject' })
		expect(prop(result(withdrawn.body), 'status')).toBe('rejected')
		expect(await actions(w, own)).toEqual(['iam.grant.request', 'iam.grant.request.reject'])
	})
}

describe('grant requests on SQLite', () => {
	grantRequestSuite(() => {
		const h = createHarness()
		return { repositories: h.repositories, db: new TestSqlDatabase(h.sqlite) }
	})
})

if (!hasPostgres) console.warn(`grant-requests.test.ts ${skipReason}`)
let fixture: PostgresFixture | null = null

beforeAll(async () => {
	if (hasPostgres) fixture = await createPostgres('iam_grant_requests')
})
afterAll(async () => {
	await fixture?.close()
})

describe.skipIf(!hasPostgres)('grant requests on Postgres', () => {
	grantRequestSuite(() => {
		if (fixture === null) throw new Error('the Postgres fixture is not up')
		return { repositories: createPostgresIamRepositories(fixture.db), db: fixture.db }
	})
})
