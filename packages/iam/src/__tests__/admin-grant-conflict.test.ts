/**
 * `grants.create` for a role grant the principal already holds answers 409 (backlog 82) — on BOTH
 * backends, through the shipped admin router. The insert statement decides the conflict, so a held
 * grant that disappears before the message lookup is still a 409, and an unrelated insert failure is
 * still an opaque 500 even while a matching grant is held.
 */

import { unusedDatabase } from '@fabrika/platform/testing'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createIamApp } from '../app'
import { createIamRepositories, type IamRepositories } from '../db'
import type { Env } from '../env'
import { prop } from '../json'
import { adminTokenFor, createHarness, seedAppAction, TEST_SIGNING_KEYS } from './helpers/harness'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

const ORIGIN = 'https://iam.example.com'

type Call = (method: string, input: unknown) => Promise<Response>

interface Backend {
	repositories: IamRepositories
	registerApp(app: string): Promise<void>
}

function env(repositories: IamRepositories): Env {
	return {
		DB: unusedDatabase,
		REPOSITORIES: repositories,
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

function grantConflictSuite(backend: () => Backend): void {
	async function setup(): Promise<{ repositories: IamRepositories; registerApp: (app: string) => Promise<void>; call: Call; principalId: string }> {
		const { repositories, registerApp } = backend()
		const unique = crypto.randomUUID()
		const adminUser = await repositories.principals.createUser(`sub-admin-${unique}`, `admin-${unique}@example.com`)
		await repositories.grants.createGrant({ principalId: adminUser.id, roleKey: 'admin' })
		const bearer = await adminTokenFor(repositories, adminUser.id, { issuer: ORIGIN })
		const grantee = await repositories.principals.createUser(`sub-grantee-${unique}`, `grantee-${unique}@example.com`)
		const call: Call = (method, input) =>
			createIamApp().fetch(
				new Request(`${ORIGIN}/admin/rpc`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
					body: JSON.stringify({ method, input }),
				}),
				env(repositories),
				{ waitUntil() {} },
			)
		return { repositories, registerApp, call, principalId: grantee.id }
	}

	test('a duplicate cross-app grant answers 409 naming the grant it would duplicate', async () => {
		const { repositories, call, principalId } = await setup()
		const grant = { principalId, roleKey: 'admin', app: null }

		const first = await call('grants.create', grant)
		const held = prop(prop(await first.json(), 'result'), 'id')
		const second = await call('grants.create', grant)

		expect(first.status).toBe(200)
		expect(typeof held).toBe('string')
		expect(second.status).toBe(409)
		expect(prop(await second.json(), 'error')).toEqual({ type: 'conflict', message: `principal ${principalId} already holds this grant: ${held}` })
		expect(await repositories.grants.listGrants(principalId)).toHaveLength(1)
	})

	test('a duplicate scoped grant for a registered app answers 409', async () => {
		const { registerApp, call, principalId } = await setup()
		await registerApp('delivery')
		const grant = { principalId, roleKey: 'admin', app: 'delivery', scopeType: 'team', scopeValue: 'acme' }

		expect((await call('grants.create', grant)).status).toBe(200)
		expect((await call('grants.create', grant)).status).toBe(409)
		expect((await call('grants.create', { ...grant, scopeValue: 'globex' })).status).toBe(200)
	})

	test('the same role for a different app is a second grant, not a duplicate', async () => {
		const { repositories, registerApp, call, principalId } = await setup()
		await registerApp('delivery')
		await registerApp('operations')

		expect((await call('grants.create', { principalId, roleKey: 'admin', app: 'delivery' })).status).toBe(200)
		expect((await call('grants.create', { principalId, roleKey: 'admin', app: 'operations' })).status).toBe(200)
		expect(await repositories.grants.listGrants(principalId)).toHaveLength(2)
	})

	test('a duplicate whose held grant is gone before the message lookup still answers 409', async () => {
		const { repositories, call, principalId } = await setup()
		const grant = { principalId, roleKey: 'admin', app: null }
		const held = prop(prop(await (await call('grants.create', grant)).json(), 'result'), 'id')
		if (typeof held !== 'string') throw new Error('expected a grant id')
		const listGrants = repositories.grants.listGrants.bind(repositories.grants)
		repositories.grants.listGrants = async (id) => {
			await repositories.grants.deleteGrant(held)
			return listGrants(id)
		}

		const response = await call('grants.create', grant)

		expect(response.status).toBe(409)
		expect(prop(await response.json(), 'error')).toEqual({ type: 'conflict', message: `principal ${principalId} already holds this grant` })
	})

	test('an unrelated insert failure stays an opaque 500 while a matching grant is held', async () => {
		const { repositories, call, principalId } = await setup()
		const grant = { principalId, roleKey: 'admin', app: null }
		expect((await call('grants.create', grant)).status).toBe(200)
		repositories.grants.createRoleGrantUnlessHeld = () => Promise.reject(new Error('secret grant failure'))

		const response = await call('grants.create', grant)
		const body: unknown = await response.json()

		expect(response.status).toBe(500)
		expect(body).toEqual({ error: { type: 'internal', message: 'internal error' } })
	})
}

describe('grants.create conflicts on SQLite', () => {
	grantConflictSuite(() => {
		const h = createHarness()
		return {
			repositories: h.repositories,
			registerApp: (app) => Promise.resolve(seedAppAction(h.sqlite, app, 'deploy.run')),
		}
	})
})

if (!hasPostgres) console.warn(`admin-grant-conflict.test.ts ${skipReason}`)
let fixture: PostgresFixture | null = null

beforeAll(async () => {
	if (hasPostgres) fixture = await createPostgres('iam_grants')
})
afterAll(async () => {
	await fixture?.close()
})

describe.skipIf(!hasPostgres)('grants.create conflicts on Postgres', () => {
	grantConflictSuite(() => {
		if (fixture === null) throw new Error('the Postgres fixture is not up')
		const db = fixture.db
		return {
			repositories: createIamRepositories(db),
			registerApp: async (app) => {
				await db.prepare('INSERT INTO app_actions (app, action, description) VALUES (?, ?, NULL) ON CONFLICT DO NOTHING').bind(app, 'deploy.run').run()
			},
		}
	})
})
