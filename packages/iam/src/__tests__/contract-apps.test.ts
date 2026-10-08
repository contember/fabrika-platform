import { appEnvironmentId, type AppSchema } from '@fabrika/auth-core'
import { unusedDatabase } from '@fabrika/platform/testing'
import { describe, expect, test } from 'bun:test'
import { handleAdmin } from '../admin/router'
import { createIamApp } from '../app'
import type { Env, RequestContext } from '../env'
import { createHarness, type Harness, seedGrant, seedUser, TEST_SIGNING_ENV, TEST_SIGNING_KEYS } from './helpers/harness'

// ADR-0022 rule 6, for a contract application: IAM refuses a wildcard action on every write path and
// a global grant of a membership role. An app whose schema is not a contract keeps the pattern rule.

const ORIGIN = 'https://iam.example.com'
const NOTES = appEnvironmentId('notes', 'prod')
const LEGACY = appEnvironmentId('legacy', 'prod')

const CONTRACT_SCHEMA: AppSchema = {
	contract: true,
	scopes: [{ type: 'workspace' }],
	actions: [{ action: 'note.read' }, { action: 'note.write' }, { action: 'members.manage' }],
	roles: {
		owner: { name: 'Owner', permissions: ['note.read', 'note.write', 'members.manage'], member: { scope: 'workspace' } },
		reader: { name: 'Reader', permissions: ['note.read'] },
	},
}

class FakeRequestContext implements RequestContext {
	waitUntil(_promise: Promise<unknown>): void {}
}

function env(h: Harness): Env {
	return {
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
	}
}

interface Admin {
	h: Harness
	bearer: string
	grantee: string
}

async function asAdmin(): Promise<Admin> {
	const h = createHarness()
	const id = seedUser(h.sqlite, { sub: 'sub-admin', email: 'admin@example.com' })
	seedGrant(h.sqlite, id, 'admin', null)
	const grantee = seedUser(h.sqlite, { sub: 'sub-grantee', email: 'grantee@example.com' })
	return { h, bearer: await h.adminToken(id, { issuer: ORIGIN }), grantee }
}

async function putSchema(admin: Admin, app: string, schema: unknown): Promise<Response> {
	const request = new Request(`${ORIGIN}/admin/apps/${encodeURIComponent(app)}/schema`, {
		method: 'PUT',
		headers: { authorization: `Bearer ${admin.bearer}`, 'content-type': 'application/json' },
		body: JSON.stringify(schema),
	})
	return handleAdmin(request, admin.h.makeServices({ environment: 'stage', issuer: ORIGIN }), {
		...TEST_SIGNING_ENV,
		FABRIKA_IAM_PROVISIONING_KEY: '',
	}, new FakeRequestContext())
}

async function rpc(admin: Admin, method: string, input: unknown): Promise<{ status: number; message: string }> {
	const response = await createIamApp().fetch(
		new Request(`${ORIGIN}/admin/rpc`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.bearer}` },
			body: JSON.stringify({ method, input }),
		}),
		env(admin.h),
		{ waitUntil() {} },
	)
	const body: unknown = await response.json()
	const error = body !== null && typeof body === 'object' && 'error' in body ? body.error : null
	const message = error !== null && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : ''
	return { status: response.status, message }
}

async function withContractApp(): Promise<Admin> {
	const admin = await asAdmin()
	expect((await putSchema(admin, NOTES, CONTRACT_SCHEMA)).status).toBe(200)
	expect((await putSchema(admin, LEGACY, { ...CONTRACT_SCHEMA, contract: false })).status).toBe(200)
	return admin
}

describe('the schema of a contract application', () => {
	test('registers under <app>@<env>, decoded from the path', async () => {
		const admin = await withContractApp()
		expect(await admin.h.repositories.appSchema.listKnownApps()).toEqual([LEGACY, NOTES])
		expect(await admin.h.repositories.appSchema.isContractApp(NOTES)).toBe(true)
		expect(await admin.h.repositories.appSchema.isContractApp(LEGACY)).toBe(false)
	})

	test('refuses a role that lists a wildcard', async () => {
		const admin = await asAdmin()
		const schema = { ...CONTRACT_SCHEMA, roles: { editor: { name: 'Editor', permissions: ['note.*'] } } }
		const response = await putSchema(admin, NOTES, schema)
		expect(response.status).toBe(400)
		expect(await response.text()).toContain('lists the wildcard `note.*`')
		expect(await admin.h.repositories.appSchema.listKnownApps()).toEqual([])
	})

	test('refuses a membership role in an undeclared scope', async () => {
		const admin = await asAdmin()
		const schema = { ...CONTRACT_SCHEMA, roles: { owner: { name: 'Owner', permissions: ['note.read'], member: { scope: 'team' } } } }
		const response = await putSchema(admin, NOTES, schema)
		expect(response.status).toBe(400)
		expect(await response.text()).toContain('undeclared scope')
	})

	test('a re-reconcile without the flag clears it', async () => {
		const admin = await withContractApp()
		expect((await putSchema(admin, NOTES, { ...CONTRACT_SCHEMA, contract: undefined })).status).toBe(200)
		expect(await admin.h.repositories.appSchema.isContractApp(NOTES)).toBe(false)
	})
})

describe('grants at a contract application', () => {
	test.each([
		['an inline wildcard', { permissions: ['note.*'] }, 'not the wildcard: note.*'],
		['the built-in admin role', { roleKey: 'admin' }, "role 'admin' lists the wildcard *"],
		['a global grant of a membership role', { roleKey: 'owner' }, "membership role 'owner' is granted only in a value of scope 'workspace'"],
		['a membership role in another dimension', { roleKey: 'owner', scopeType: 'team', scopeValue: 't1' }, "scope 'workspace'"],
	])('refuses %s', async (_name, grant, message) => {
		const admin = await withContractApp()
		const result = await rpc(admin, 'grants.create', { principalId: admin.grantee, app: NOTES, ...grant })
		expect(result.status).toBe(400)
		expect(result.message).toContain(message)
	})

	test('accepts exact actions, a plain role, and a membership role in its own scope', async () => {
		const admin = await withContractApp()
		for (
			const grant of [
				{ permissions: ['note.read'] },
				{ roleKey: 'reader' },
				{ roleKey: 'owner', scopeType: 'workspace', scopeValue: 'w1' },
			]
		) {
			expect((await rpc(admin, 'grants.create', { principalId: admin.grantee, app: NOTES, ...grant })).status).toBe(200)
		}
	})

	test('an app that is not a contract keeps the pattern rule, and its membership role still needs its scope', async () => {
		const admin = await withContractApp()
		expect((await rpc(admin, 'grants.create', { principalId: admin.grantee, app: LEGACY, permissions: ['note.*'] })).status).toBe(200)
		expect((await rpc(admin, 'grants.create', { principalId: admin.grantee, app: LEGACY, roleKey: 'admin' })).status).toBe(200)
		expect((await rpc(admin, 'grants.create', { principalId: admin.grantee, app: LEGACY, roleKey: 'owner' })).status).toBe(400)
	})

	test('a provisioned api key refuses a wildcard grant', async () => {
		const admin = await withContractApp()
		const result = await rpc(admin, 'apiKeys.provision', { label: 'ci', type: 'service', app: NOTES, permissions: ['*'] })
		expect(result.status).toBe(400)
		expect(result.message).toContain('not the wildcard: *')
	})

	test('a custom policy refuses a wildcard on create and on update', async () => {
		const admin = await withContractApp()
		const created = await rpc(admin, 'policies.create', { app: NOTES, policy: { key: 'p1', name: 'P1', permissions: ['note.*'] } })
		expect(created.status).toBe(400)
		expect(created.message).toContain('not the wildcard: note.*')
		expect((await rpc(admin, 'policies.create', { app: NOTES, policy: { key: 'p1', name: 'P1', permissions: ['note.read'] } })).status).toBe(200)
		expect((await rpc(admin, 'policies.update', { app: NOTES, key: 'p1', policy: { name: 'P1', permissions: ['*'] } })).status).toBe(400)
		expect((await rpc(admin, 'policies.create', { app: LEGACY, policy: { key: 'p1', name: 'P1', permissions: ['note.*'] } })).status).toBe(200)
	})
})
