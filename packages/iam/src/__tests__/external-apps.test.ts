// The OAuth client registry of ADR-0089 through `/admin/rpc`, on SQLite and, with FABRIKA_TEST_POSTGRES_URL, on Postgres:
// the import that runs once, the refusals before it, an external application's whole-aggregate writes with the
// adoption of an earlier deploy's roles, the rules for its id and resource, the two writers that refuse each other's
// clients, and the grants a removed client loses.

import { IAM_APP_ID } from '@fabrika/iam-contract'
import { uuidv7 } from '@fabrika/platform'
import { unusedDatabase } from '@fabrika/platform/testing'
import { afterEach, describe, expect, test } from 'bun:test'
import { createIamApp } from '../app'
import { type AuditEventInput, createIamRepositories, ExternalAppResourceTaken, type IamRepositories, type RegistryEvents } from '../db'
import type { Env } from '../env'
import { prop } from '../json'
import { registeredClient } from '../oauth-clients'
import { type ManagedOAuthClient, type OAuthConfig, parseOAuthConfig } from '../oauth-config'
import { DEFAULT_PLATFORM_AUDIENCES } from '../services'
import { adminTokenFor, createHarness, makeServicesFor, TEST_SIGNING_KEYS } from './helpers/harness'
import { createPostgres, hasPostgres, skipReason } from './helpers/postgres'

if (!hasPostgres) console.warn(`external-apps.test.ts (Postgres half) ${skipReason}`)

const ORIGIN = 'https://iam.example.com'
const PROVISIONING_KEY = 'px_provisioning-key-of-the-registry-suite'
const OAUTH_CONFIG = JSON.stringify({
	clients: [],
	resources: [{
		app: 'vozka',
		resource: 'https://console.example.com/mcp',
		scopeGrants: [{ scope: 'authoring', permissions: [{ action: 'a.read' }] }],
	}],
	hosts: ['console.example.com', 'operations.example.com'],
})
const CONFIG: OAuthConfig = configured(parseOAuthConfig(OAUTH_CONFIG, DEFAULT_PLATFORM_AUDIENCES))

function configured(config: OAuthConfig | null): OAuthConfig {
	if (config === null) throw new Error('no OAUTH_CONFIG')
	return config
}

const OPS = {
	app: 'ops-tool',
	name: 'Operations tool',
	resource: 'https://ops.example.net',
	roles: [{ key: 'operator', name: 'Operator' }, { key: 'viewer', name: 'Viewer' }],
	clients: [{ clientId: 'https://ops.example.net/oauth/web.json', redirectUris: ['https://ops.example.net/callback'] }],
}
const DESKTOP = { clientId: 'https://ops.example.net/oauth/desktop.json', redirectUris: ['http://127.0.0.1:8123/callback'] }
const CLAUDE = { clientId: 'https://claude.example.org/oauth/client.json', label: 'claude', redirectUris: ['https://claude.example.org/callback'] }

interface Engine {
	repositories: IamRepositories
	/** A write past every repository, to store what IAM itself never would. */
	exec(sql: string, ...binds: string[]): Promise<void>
	close(): Promise<void>
}

const ENGINES: { name: string; skip: boolean; open(): Promise<Engine> }[] = [
	{
		name: 'SQLite',
		skip: false,
		open: () => {
			const harness = createHarness()
			return Promise.resolve({
				repositories: harness.repositories,
				exec: (sql, ...binds) => Promise.resolve(void harness.sqlite.prepare(sql).run(...binds)),
				close: () => Promise.resolve(),
			})
		},
	},
	{
		name: 'Postgres',
		skip: !hasPostgres,
		open: async () => {
			const fixture = await createPostgres('iam_registry')
			return {
				repositories: createIamRepositories(fixture.db, {}, 'postgres'),
				exec: async (sql, ...binds) => void (await fixture.db.prepare(sql).bind(...binds).run()),
				close: () => fixture.close(),
			}
		},
	},
]

let opened: Engine | null = null
afterEach(async () => {
	await opened?.close()
	opened = null
})

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
		FABRIKA_IAM_PROVISIONING_KEY: PROVISIONING_KEY,
		OIDC_ISSUER: 'https://idp.test',
		OIDC_CLIENT_ID: 'client',
		OIDC_CLIENT_SECRET: 'secret',
		OIDC_SCOPES: '',
		OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
		OAUTH_CONFIG,
	}
}

interface Outcome {
	status: number
	result: unknown
	error: string | null
}

async function setup(engine: (typeof ENGINES)[number]) {
	opened = await engine.open()
	const { repositories } = opened
	const admin = await repositories.principals.createUser(uuidv7(), `${uuidv7()}@example.com`)
	await repositories.grants.createGrant({ principalId: admin.id, roleKey: 'admin' })
	const adminBearer = await adminTokenFor(repositories, admin.id, { issuer: ORIGIN })
	const app = createIamApp()
	async function call(method: string, input: unknown, bearer: string = adminBearer): Promise<Outcome> {
		const response = await app.fetch(
			new Request(`${ORIGIN}/admin/rpc`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
				body: JSON.stringify({ method, input }),
			}),
			env(repositories),
			{ waitUntil() {} },
		)
		const body: unknown = await response.json()
		const message = prop(prop(body, 'error'), 'message')
		return { status: response.status, result: prop(body, 'result'), error: typeof message === 'string' ? message : null }
	}
	const provisioning = (method: string, input: unknown) => call(method, input, PROVISIONING_KEY)
	/** A deploy's schema reconcile (`PUT /admin/apps/:app/schema`), as the provisioning key sends it. */
	async function putSchema(appId: string, schema: unknown): Promise<number> {
		const response = await app.fetch(
			new Request(`${ORIGIN}/admin/apps/${appId}/schema`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${PROVISIONING_KEY}` },
				body: JSON.stringify(schema),
			}),
			env(repositories),
			{ waitUntil() {} },
		)
		return response.status
	}
	/** A console bearer of a new person who holds `permissions` at IAM's own app id. */
	async function personWith(permissions: string[]): Promise<string> {
		const person = await repositories.principals.createUser(uuidv7(), `${uuidv7()}@example.com`)
		await repositories.grants.createGrant({ principalId: person.id, app: IAM_APP_ID, permissions })
		return adminTokenFor(repositories, person.id, { issuer: ORIGIN })
	}
	/** A person signed in with a live OAuth grant of `clientId`. */
	async function oauthGrant(clientId: string, app: string): Promise<string> {
		const person = await repositories.principals.createUser(uuidv7(), `${uuidv7()}@example.com`)
		const sessionId = await repositories.sessions.createSession({
			tokenHash: uuidv7(),
			principalId: person.id,
			authenticationMethod: 'password',
			expiresAt: Math.floor(Date.now() / 1000) + 3600,
		})
		const id = uuidv7()
		const now = Math.floor(Date.now() / 1000)
		await repositories.oauth.createGrant(
			{
				id,
				principal_id: person.id,
				session_id: sessionId,
				client_id: clientId,
				app,
				resource: OPS.resource,
				resources: null,
				scopes: '["identity"]',
				created_at: now,
				expires_at: now + 3600,
				revoked_at: null,
				agent_label: null,
			},
			{ token_hash: uuidv7(), redirect_uri: 'https://ops.example.net/callback', challenge: 'c', expires_at: now + 60 },
		)
		return id
	}
	const revoked = async (grantId: string) => (await repositories.oauth.grant(grantId))?.revoked_at !== null
	const services = () => makeServicesFor(repositories, { issuer: ORIGIN, oauth: CONFIG })
	return { repositories, exec: opened.exec, admin, call, provisioning, putSchema, personWith, oauthGrant, revoked, services }
}

/** The records of a registry change written past the use cases. */
function registryEvents(action: string): RegistryEvents {
	const event = (name: string): AuditEventInput => ({
		requestId: uuidv7(),
		principalId: null,
		principalLabel: 'test',
		app: IAM_APP_ID,
		action: name,
		resourceType: 'test',
	})
	return { change: event(action), revocation: () => event('test.revoke') }
}

/** An earlier deploy's roles reconcile of an external application (ADR-0084): roles alone, each granting no action. */
async function reconciledRoles(repositories: IamRepositories, app: string): Promise<void> {
	await repositories.appSchema.reconcileAppSchema({
		app,
		scopes: [],
		actions: [],
		roles: [{ roleKey: 'operator', name: 'Operator', permissions: [] }],
	})
}

for (const engine of ENGINES) {
	describe.skipIf(engine.skip)(`the OAuth client registry on ${engine.name}`, () => {
		test('before the import IAM serves OAUTH_CONFIG and refuses registry writes; after it, the registry only', async () => {
			const f = await setup(engine)
			const legacy: ManagedOAuthClient = {
				provider: 'claude',
				clientId: CLAUDE.clientId,
				redirectUris: CLAUDE.redirectUris,
				metadataUrl: CLAUDE.clientId,
			}
			const config: OAuthConfig = { ...CONFIG, clients: [legacy] }
			expect(await registeredClient(f.services(), config, CLAUDE.clientId)).toEqual(legacy)

			const put = await f.call('externalApps.put', OPS)
			expect(put.status).toBe(409)
			expect(put.error).toContain('oauthClients.importOnce')
			expect((await f.provisioning('oauthClients.put', CLAUDE)).status).toBe(409)

			expect((await f.provisioning('oauthClients.importOnce', { clients: [] })).result).toEqual({
				status: 'imported',
				externalApps: [],
				oauthClients: [],
			})
			// The configured client is no longer served once the mark exists.
			expect(await registeredClient(f.services(), config, CLAUDE.clientId)).toBeNull()
			expect((await f.call('externalApps.put', OPS)).status).toBe(200)
		})

		test("importOnce is the provisioning key's, writes once, and later calls write nothing", async () => {
			const f = await setup(engine)
			const refused = await f.call('oauthClients.importOnce', { clients: [] })
			expect(refused.status).toBe(403)
			expect(await f.repositories.oauthRegistry.imported()).toBe(false)

			// An earlier deploy reconciled the roles; a person holds one. The import adopts the vocabulary with the grant.
			await reconciledRoles(f.repositories, OPS.app)
			const person = await f.repositories.principals.createUser(uuidv7(), `${uuidv7()}@example.com`)
			const grant = await f.repositories.grants.createGrant({ principalId: person.id, app: OPS.app, roleKey: 'operator' })
			const identity = { app: OPS.app, resource: OPS.resource, roles: [{ key: 'operator', name: 'Operator' }] }
			const entries = [
				{ provider: 'external', clientId: OPS.clients[0]?.clientId, redirectUris: OPS.clients[0]?.redirectUris, identity },
				{ provider: 'external', ...DESKTOP, metadataUrl: 'https://ops.example.net/oauth/desktop-document.json', identity },
				{ provider: CLAUDE.label, clientId: CLAUDE.clientId, redirectUris: CLAUDE.redirectUris },
			]
			const first = await f.provisioning('oauthClients.importOnce', { clients: entries })
			expect(first.result).toEqual({
				status: 'imported',
				externalApps: [OPS.app],
				oauthClients: [OPS.clients[0]?.clientId, DESKTOP.clientId, CLAUDE.clientId],
			})
			expect((await f.call('externalApps.get', { app: OPS.app })).result).toMatchObject({
				app: OPS.app,
				name: null,
				resource: OPS.resource,
				roles: [{ key: 'operator', name: 'Operator' }],
				clients: [
					{ clientId: DESKTOP.clientId, redirectUris: DESKTOP.redirectUris, metadataUrl: 'https://ops.example.net/oauth/desktop-document.json' },
					{ clientId: OPS.clients[0]?.clientId, redirectUris: OPS.clients[0]?.redirectUris, metadataUrl: null },
				],
			})
			expect((await f.repositories.grants.getActiveGrantsForApp(person.id, OPS.app, { includeCrossApp: false })).map((row) => row.id)).toEqual([
				grant.id,
			])
			const served = await registeredClient(f.services(), CONFIG, DESKTOP.clientId)
			expect(served?.identity).toEqual(identity)
			expect(served?.metadataUrl).toBe('https://ops.example.net/oauth/desktop-document.json')

			const again = await f.provisioning('oauthClients.importOnce', { clients: [] })
			expect(again.result).toEqual({ status: 'already_imported' })
			expect((await f.call('oauthClients.list', null)).result).toMatchObject({ items: { length: 3 } })
			const imports = await f.repositories.audit.listAuditEvents({ action: 'iam.oauth_registry.import', limit: 10 })
			expect(imports).toHaveLength(1)
		})

		test('an import that cannot adopt a vocabulary writes nothing, the mark included', async () => {
			const f = await setup(engine)
			await f.repositories.appSchema.reconcileAppSchema({ app: OPS.app, scopes: [], actions: [{ action: 'accounts.manage' }], roles: [] })
			const identity = { app: OPS.app, resource: OPS.resource }
			const refused = await f.provisioning('oauthClients.importOnce', {
				clients: [{ provider: 'external', clientId: OPS.clients[0]?.clientId, redirectUris: OPS.clients[0]?.redirectUris, identity }],
			})
			expect(refused.status).toBe(409)
			expect(refused.error).toContain('actions')
			expect(await f.repositories.oauthRegistry.imported()).toBe(false)
			expect(await f.repositories.oauthRegistry.listClients()).toEqual([])
			// A malformed entry, or two clients of one app that disagree, are refused as well.
			expect((await f.provisioning('oauthClients.importOnce', { clients: [{ provider: 'claude' }] })).status).toBe(400)
			const disagreeing = [
				{ provider: 'external', clientId: OPS.clients[0]?.clientId, redirectUris: OPS.clients[0]?.redirectUris, identity },
				{ provider: 'external', ...DESKTOP, identity: { ...identity, roles: [{ key: 'viewer', name: 'Viewer' }] } },
			]
			expect((await f.provisioning('oauthClients.importOnce', { clients: disagreeing })).status).toBe(400)
			expect(await f.repositories.oauthRegistry.imported()).toBe(false)
		})

		test('put replaces the whole application, get and apps.list show it, delete removes it with its vocabulary', async () => {
			const f = await setup(engine)
			await f.provisioning('oauthClients.importOnce', { clients: [] })
			const put = await f.call('externalApps.put', OPS)
			expect(put.status).toBe(200)
			expect(put.result).toMatchObject({ app: OPS.app, name: OPS.name, resource: OPS.resource, roles: OPS.roles })
			expect((await f.call('externalApps.list', null)).result).toMatchObject({ items: [{ app: OPS.app }] })
			expect((await f.call('apps.list', null)).result).toMatchObject({
				items: expect.arrayContaining([{ id: OPS.app, displayName: OPS.name, installation: false, externalApplication: true }]),
			})
			expect((await f.repositories.appSchema.listRolesByOrigin(OPS.app, 'app')).map((row) => [row.role_key, row.permissions])).toEqual([
				['operator', '[]'],
				['viewer', '[]'],
			])
			const served = await registeredClient(f.services(), CONFIG, OPS.clients[0]?.clientId ?? '')
			expect(served?.identity).toEqual({ app: OPS.app, resource: OPS.resource, roles: OPS.roles })

			// Dropping the roles clears the vocabulary; a second client is added.
			const replaced = await f.call('externalApps.put', { ...OPS, roles: null, clients: [...OPS.clients, DESKTOP] })
			expect(replaced.result).toMatchObject({ roles: null, clients: { length: 2 } })
			expect(await f.repositories.appSchema.listRolesByOrigin(OPS.app, 'app')).toEqual([])

			expect((await f.call('externalApps.delete', { app: OPS.app })).result).toEqual({ ok: true })
			expect((await f.call('externalApps.get', { app: OPS.app })).status).toBe(404)
			expect((await f.call('externalApps.delete', { app: OPS.app })).status).toBe(404)
			expect(await f.repositories.oauthRegistry.listClients()).toEqual([])
			expect(await f.repositories.appSchema.getPresentation(OPS.app)).toBeNull()
			const recorded = await f.repositories.audit.listAuditEvents({ resourceType: 'external_app', resourceId: OPS.app, limit: 10 })
			expect(recorded.map((row) => row.action)).toEqual(['iam.external_app.delete', 'iam.external_app.put', 'iam.external_app.put'])
		})

		test("removing a client, or the application, revokes the client's grants", async () => {
			const f = await setup(engine)
			await f.provisioning('oauthClients.importOnce', { clients: [] })
			await f.call('externalApps.put', { ...OPS, clients: [...OPS.clients, DESKTOP] })
			const web = await f.oauthGrant(OPS.clients[0]?.clientId ?? '', OPS.app)
			const desktop = await f.oauthGrant(DESKTOP.clientId, OPS.app)

			expect((await f.call('externalApps.put', OPS)).status).toBe(200)
			expect(await f.revoked(desktop)).toBe(true)
			expect(await f.revoked(web)).toBe(false)
			// Unchanged clients revoke nothing, so a put that removes none writes no revocation record.
			expect((await f.call('externalApps.put', OPS)).status).toBe(200)

			await f.call('externalApps.delete', { app: OPS.app })
			expect(await f.revoked(web)).toBe(true)
			const revocations = await f.repositories.audit.listAuditEvents({ action: 'iam.oauth.grant.revoke', resourceId: OPS.app, limit: 5 })
			expect(revocations.map((row) => [row.resource_type, row.metadata])).toEqual([
				['external_app', JSON.stringify({ reason: 'application_removed' })],
				['external_app', JSON.stringify({ reason: 'client_removed' })],
			])
		})

		test('a delete that finds the application gone writes nothing', async () => {
			const f = await setup(engine)
			await f.provisioning('oauthClients.importOnce', { clients: [] })
			await f.call('externalApps.put', OPS)
			const events = registryEvents('test.delete')
			expect(await f.repositories.oauthRegistry.deleteExternalApp(OPS.app, events)).toBe(true)
			// What a concurrent delete that lost would meet: no record, and a vocabulary written under the id since.
			await reconciledRoles(f.repositories, OPS.app)
			expect(await f.repositories.oauthRegistry.deleteExternalApp(OPS.app, events)).toBe(false)
			expect((await f.repositories.appSchema.listRolesByOrigin(OPS.app, 'app')).map((row) => row.role_key)).toEqual(['operator'])
			expect(await f.repositories.audit.listAuditEvents({ action: 'test.delete', limit: 5 })).toHaveLength(1)
		})

		test('a new resource revokes the grants for the earlier one, which stay revoked when it comes back', async () => {
			const f = await setup(engine)
			await f.provisioning('oauthClients.importOnce', { clients: [] })
			await f.call('externalApps.put', OPS)
			const grant = await f.oauthGrant(OPS.clients[0]?.clientId ?? '', OPS.app)
			// An authoring client's grant for the application's resource goes as well.
			const authoring = await f.oauthGrant(CLAUDE.clientId, OPS.app)

			expect((await f.call('externalApps.put', OPS)).status).toBe(200)
			expect(await f.revoked(grant)).toBe(false)
			expect((await f.call('externalApps.put', { ...OPS, resource: 'https://ops.example.net/v2' })).status).toBe(200)
			expect([await f.revoked(grant), await f.revoked(authoring)]).toEqual([true, true])
			expect((await f.call('externalApps.put', OPS)).status).toBe(200)
			expect(await f.revoked(grant)).toBe(true)
			const revocations = await f.repositories.audit.listAuditEvents({ action: 'iam.oauth.grant.revoke', resourceId: OPS.app, limit: 5 })
			expect(revocations.map((row) => row.metadata)).toEqual([JSON.stringify({ reason: 'resource_changed' })])
		})

		test("a resource another application took meanwhile is the repository's typed refusal, and nothing is written", async () => {
			const f = await setup(engine)
			await f.provisioning('oauthClients.importOnce', { clients: [] })
			await f.call('externalApps.put', OPS)
			const write = { app: 'other-tool', displayName: null, resource: OPS.resource, roles: [], clients: [] }
			const events = registryEvents('test.put')
			await expect(f.repositories.oauthRegistry.putExternalApp(write, events)).rejects.toBeInstanceOf(ExternalAppResourceTaken)
			expect(await f.repositories.oauthRegistry.externalApp('other-tool')).toBeNull()
		})

		test('the in-batch guard refuses a client id another writer owns, writing nothing', async () => {
			const f = await setup(engine)
			await f.provisioning('oauthClients.importOnce', { clients: [] })
			expect((await f.provisioning('oauthClients.put', CLAUDE)).status).toBe(200)
			const write = {
				app: OPS.app,
				displayName: null,
				resource: OPS.resource,
				roles: [{ key: 'operator', name: 'Operator' }],
				clients: [{ clientId: CLAUDE.clientId, redirectUris: OPS.clients[0]?.redirectUris ?? [], metadataUrl: null }],
			}
			const events = registryEvents('test.put')
			const refused = await f.repositories.oauthRegistry.putExternalApp(write, events).then(() => null, (error: unknown) => error)
			expect(refused).toBeInstanceOf(Error)
			expect(refused).not.toBeInstanceOf(ExternalAppResourceTaken)
			expect(await f.repositories.oauthRegistry.externalApp(OPS.app)).toBeNull()
			expect(await f.repositories.appSchema.listRolesByOrigin(OPS.app, 'app')).toEqual([])
			expect((await f.repositories.oauthRegistry.client(CLAUDE.clientId))?.external_app).toBeNull()
			expect(await f.repositories.audit.listAuditEvents({ action: 'test.put', limit: 5 })).toEqual([])
		})

		test('a registry row the client parser refuses is not served', async () => {
			const f = await setup(engine)
			await f.provisioning('oauthClients.importOnce', { clients: [] })
			await f.call('externalApps.put', OPS)
			const clientId = OPS.clients[0]?.clientId ?? ''
			expect(await registeredClient(f.services(), CONFIG, clientId)).not.toBeNull()

			// A role key the identity parser refuses (a built-in one), written past the use case.
			await f.repositories.appSchema.reconcileAppSchema({
				app: OPS.app,
				scopes: [],
				actions: [],
				roles: [{ roleKey: 'admin', name: 'Admin', permissions: [] }],
			})
			expect(await registeredClient(f.services(), CONFIG, clientId)).toBeNull()

			await f.call('externalApps.put', OPS)
			expect(await registeredClient(f.services(), CONFIG, clientId)).not.toBeNull()
			await f.exec("UPDATE oauth_clients SET redirect_uris = 'not json' WHERE client_id = ?", clientId)
			expect(await registeredClient(f.services(), CONFIG, clientId)).toBeNull()
		})

		test('a deploy cannot reconcile a schema under an external application, nor a registered id keep a foreign one', async () => {
			const f = await setup(engine)
			await f.provisioning('oauthClients.importOnce', { clients: [] })
			await f.call('externalApps.put', OPS)
			const schema = { scopes: [], actions: [{ action: 'accounts.manage' }], roles: {} }
			expect(await f.putSchema(OPS.app, schema)).toBe(409)
			expect(await f.putSchema('notes', schema)).toBe(200)
			expect((await f.repositories.appSchema.listRolesByOrigin(OPS.app, 'app')).map((row) => row.role_key)).toEqual(['operator', 'viewer'])

			// A vocabulary written under the id past the registry (a deploy of an older release): the next put refuses it.
			await f.repositories.appSchema.reconcileAppSchema({ app: OPS.app, scopes: [], actions: [{ action: 'accounts.manage' }], roles: [] })
			const refused = await f.call('externalApps.put', OPS)
			expect(refused.status).toBe(409)
			expect(refused.error).toContain('actions')
		})

		test('a user administrator, and an iam.admin key that is not the provisioning key, are refused', async () => {
			const f = await setup(engine)
			await f.provisioning('oauthClients.importOnce', { clients: [] })
			const userAdmin = await f.personWith(['iam.users.manage'])
			expect((await f.call('me', null, userAdmin)).status).toBe(200)
			const calls: [string, unknown][] = [
				['externalApps.list', null],
				['externalApps.get', { app: OPS.app }],
				['externalApps.put', OPS],
				['externalApps.delete', { app: OPS.app }],
			]
			for (const [method, input] of calls) {
				expect([method, (await f.call(method, input, userAdmin)).status]).toEqual([method, 403])
			}

			const provisioned = await f.call('apiKeys.provision', {
				label: 'automation',
				type: 'service',
				roleKey: 'admin',
				app: null,
				expiresAt: Math.floor(Date.now() / 1000) + 86_400,
			})
			expect(provisioned.status).toBe(200)
			const apiKey = prop(provisioned.result, 'apiKey')
			if (typeof apiKey !== 'string') throw new Error('no api key')
			expect((await f.call('externalApps.list', null, apiKey)).status).toBe(200)
			const provisioningOnly: [string, unknown][] = [
				['oauthClients.importOnce', { clients: [] }],
				['oauthClients.put', CLAUDE],
				['oauthClients.delete', { clientId: CLAUDE.clientId }],
			]
			for (const [method, input] of provisioningOnly) expect([method, (await f.call(method, input, apiKey)).status]).toEqual([method, 403])
		})

		test('an id is adopted only with roles that grant no action and nothing else declared', async () => {
			const f = await setup(engine)
			await f.provisioning('oauthClients.importOnce', { clients: [] })
			await reconciledRoles(f.repositories, OPS.app)
			expect((await f.call('externalApps.put', OPS)).status).toBe(200)

			await f.repositories.appSchema.reconcileAppSchema({
				app: 'notes',
				scopes: [],
				actions: [{ action: 'notes.read' }],
				roles: [{ roleKey: 'reader', name: 'Reader', permissions: ['notes.read'] }],
			})
			const withActions = await f.call('externalApps.put', { ...OPS, app: 'notes', resource: 'https://notes.example.net', clients: [] })
			expect(withActions.status).toBe(409)
			expect(withActions.error).toContain('actions')

			await reconciledRoles(f.repositories, 'portal')
			await f.repositories.handoff.setReturnOrigins('portal', ['https://portal.example.net'])
			const handedOff = await f.call('externalApps.put', { ...OPS, app: 'portal', resource: 'https://portal.example.net/id', clients: [] })
			expect(handedOff.status).toBe(409)
			expect(handedOff.error).toContain('return origins')
		})

		test("refuses an installation service's id, a resource on an installation host, and another application's resource", async () => {
			const f = await setup(engine)
			await f.provisioning('oauthClients.importOnce', { clients: [] })
			const put = (changes: Record<string, unknown>) => f.call('externalApps.put', { ...OPS, clients: [], ...changes })
			for (const app of ['vozka', 'propustka', 'operations', 'notes@prod', 'Ops']) expect([app, (await put({ app })).status]).toEqual([app, 400])
			for (
				const resource of [
					'https://console.example.com/mcp',
					'https://console.example.com/elsewhere',
					'https://operations.example.com',
					'https://iam.example.com/ops',
					'http://ops.example.net',
				]
			) {
				expect([resource, (await put({ resource })).status]).toEqual([resource, 400])
			}
			expect((await put({ name: '' })).status).toBe(400)
			expect((await put({})).status).toBe(200)
			const taken = await put({ app: 'other-tool' })
			expect(taken.status).toBe(409)
			expect(taken.error).toContain(OPS.app)
		})

		test('each writer refuses a client id the other owns, and only the provisioning key writes an authoring client', async () => {
			const f = await setup(engine)
			await f.provisioning('oauthClients.importOnce', { clients: [] })
			expect((await f.call('oauthClients.put', CLAUDE)).status).toBe(403)
			expect((await f.provisioning('oauthClients.put', CLAUDE)).result).toMatchObject({ clientId: CLAUDE.clientId, externalApp: null })
			expect((await f.call('externalApps.put', { ...OPS, clients: [{ clientId: CLAUDE.clientId, redirectUris: OPS.clients[0]?.redirectUris }] })).status)
				.toBe(409)

			await f.call('externalApps.put', OPS)
			const bound = { ...CLAUDE, clientId: OPS.clients[0]?.clientId }
			expect((await f.provisioning('oauthClients.put', bound)).status).toBe(409)
			expect((await f.provisioning('oauthClients.delete', { clientId: bound.clientId })).status).toBe(409)
			expect((await f.call('externalApps.put', { ...OPS, app: 'other-tool', resource: 'https://other.example.net' })).status).toBe(409)
			expect((await f.call('externalApps.get', { app: OPS.app })).result).toMatchObject({ clients: [{ clientId: bound.clientId }] })

			const grant = await f.oauthGrant(CLAUDE.clientId, 'vozka')
			expect((await f.provisioning('oauthClients.delete', { clientId: CLAUDE.clientId })).result).toEqual({ ok: true })
			expect(await f.revoked(grant)).toBe(true)
			expect((await f.provisioning('oauthClients.delete', { clientId: CLAUDE.clientId })).status).toBe(404)
		})
	})
}

describe('OAUTH_CONFIG.hosts', () => {
	const resources = [{ app: 'vozka', resource: 'https://console.example.com/mcp', scopeGrants: [{ scope: 's', permissions: [{ action: 'a' }] }] }]
	const parse = (hosts: unknown) => parseOAuthConfig(JSON.stringify({ clients: [], resources, hosts }), DEFAULT_PLATFORM_AUDIENCES)

	test('is optional, and lists hostnames', () => {
		expect(parseOAuthConfig(JSON.stringify({ clients: [], resources }), DEFAULT_PLATFORM_AUDIENCES)?.hosts).toEqual([])
		expect(parse(['console.example.com', 'iam.example.com'])?.hosts).toEqual(['console.example.com', 'iam.example.com'])
	})

	test('refuses anything but a hostname', () => {
		for (const hosts of ['console.example.com', ['https://console.example.com'], ['console.example.com:443'], ['Console.example.com'], [''], [1]]) {
			expect(() => parse(hosts)).toThrow('OAUTH_CONFIG.hosts')
		}
	})
})
