import { PROXY_TOKEN_HEADER } from '@fabrika/auth'
import { GITHUB_SOURCE_CONNECTION_MAX_PAGE_SIZE, type GitHubSourceConnectionStatusDto } from '@fabrika/control-contract'
import { describe, expect, test } from 'bun:test'
import { ACTIONS } from '../actions'
import { controlApp } from '../app'
import { projectSingletonSourceConnectionPage } from '../control-rpc'
import type { Env } from '../env'
import { githubWebhookSecretLabel } from '../github-connection-store'
import { FakeRepoSource } from '../repo-source'
import { unavailableSourceConnection } from '../source-connection-port'
import { Vault } from '../vault'
import { createHarness, type Harness, pushWebhookRequest } from './helpers/harness'
import { fakeControlProvider } from './helpers/provider'
import { adminToken, operatorToken, testIamEnv, testToken, viewerToken } from './helpers/tokens'

function application(overrides: Partial<Env> = {}, harness: Harness = createHarness()) {
	const { REPO_EVENTS = new FakeRepoSource(), ...rest } = overrides
	const env: Env = {
		DB: harness.d1,
		REPOSITORIES: harness.repositories,
		ASSETS: { fetch: () => Promise.resolve(new Response('dashboard')) },
		RUN_LOGS: {
			put: () => Promise.resolve(),
			get: () => Promise.resolve(null),
			delete: () => Promise.resolve(),
		},
		DEPLOY_QUEUE: { send: () => Promise.resolve() },
		WAIT_UNTIL: () => {},
		REPO_EVENTS,
		ENVIRONMENT: 'local',
		...testIamEnv,
		...rest,
	}
	return (request: Request) =>
		controlApp.fetch(request, { env, provider: fakeControlProvider, sourceConnection: unavailableSourceConnection('harbor') }, {
			waitUntil() {},
		})
}

describe('controlApp', () => {
	test('keeps liveness public and serves the SPA fallback', async () => {
		const fetch = application()

		expect((await fetch(new Request('https://control.test/healthz'))).status).toBe(200)
		expect((await fetch(new Request('https://control.test/healthz', { method: 'HEAD' }))).status).toBe(200)
		expect((await fetch(new Request('https://control.test/api/health', { method: 'POST' }))).status).toBe(200)
		expect(await (await fetch(new Request('https://control.test/apps/example'))).text()).toBe('dashboard')
	})

	test('authorizes /api/* from the proxy-injected token, and refuses a request that carries none', async () => {
		const fetch = application()
		const viewer = await fetch(apiRequest('https://control.test/api/apps', viewerToken))
		const admin = await fetch(apiRequest('https://control.test/api/apps', adminToken))
		const anonymous = await fetch(new Request('https://control.test/api/apps'))

		expect(viewer.status).toBe(403)
		expect(admin.status).toBe(200)
		expect(anonymous.status).toBe(401)
	})

	test('mounts the typed control RPC before REST and preserves authorization and errors', async () => {
		const fetch = application()
		const viewer = await fetch(rpcRequest('apps.list', null, viewerToken))
		expect(viewer.status).toBe(403)
		const viewerBody: unknown = await viewer.json()
		expect(viewerBody).toEqual({ error: { type: 'forbidden', message: 'Forbidden: app.manage' } })

		const created = await fetch(rpcRequest('apps.create', { id: 'rpc-app', repoUrl: 'https://github.com/acme/rpc-app' }))
		expect(created.status).toBe(200)
		expect(await created.json()).toMatchObject({ result: { id: 'rpc-app', repoUrl: 'github.com/acme/rpc-app' } })

		const rest = await fetch(apiRequest('https://control.test/api/apps', adminToken))
		expect(await rest.json()).toMatchObject({ items: [{ id: 'rpc-app' }] })

		const missing = await fetch(rpcRequest('apps.get', { appId: 'missing' }))
		expect(missing.status).toBe(404)
		const missingBody: unknown = await missing.json()
		expect(missingBody).toEqual({ error: { type: 'not_found', message: 'app not found' } })

		const unknown = await fetch(rpcRequest('apps.nope', null))
		expect(unknown.status).toBe(404)
		const unknownBody: unknown = await unknown.json()
		expect(unknownBody).toEqual({ error: { type: 'method_not_found', message: 'Unknown method: apps.nope' } })
	})

	test('shares registry, secret, provider, and run behavior across RPC and REST', async () => {
		const fetch = application({ FABRIKA_CONTROL_VAULT_KEY: testVaultKey() })
		const invalid = await fetch(rpcRequest('apps.create', { repoUrl: 'github.com/acme/missing-id' }))
		expect(invalid.status).toBe(400)

		await fetch(rpcRequest('apps.create', { id: 'flow', repoUrl: 'github.com/acme/flow' }))
		const target = { provider: 'harbor', version: 1, payload: { kind: 'target' } }
		const artifact = { provider: 'harbor', version: 1, payload: { kind: 'artifact' } }
		expect(
			(await fetch(rpcRequest('apps.environments.put', {
				appId: 'flow',
				env: 'prod',
				environment: { target, artifact },
			}))).status,
		).toBe(200)
		expect(
			(await fetch(rpcRequest('apps.variables.put', {
				appId: 'flow',
				variable: { name: 'PUBLIC_MODE', value: 'safe' },
			}))).status,
		).toBe(200)

		const secretValue = 'must-never-be-returned'
		const setSecret = await fetch(rpcRequest('vault.set', { appId: 'flow', name: 'TOKEN', value: secretValue }))
		expect(setSecret.status).toBe(200)
		expect(await setSecret.text()).not.toContain(secretValue)
		const listedSecrets = await fetch(rpcRequest('apps.secrets.list', { appId: 'flow' }))
		expect(await listedSecrets.text()).not.toContain(secretValue)

		const restVars = await fetch(apiRequest('https://control.test/api/apps/flow/vars', adminToken))
		expect(await restVars.text()).toContain('PUBLIC_MODE')

		const deployed = await fetch(rpcRequest('deploy', { appId: 'flow', env: 'prod' }))
		const runId = resultString(await deployed.json(), 'id')
		expect((await fetch(rpcRequest('runs.get', { runId }))).status).toBe(200)
		const tail = await fetch(rpcRequest('runs.tail', { runId, after: 0 }))
		expect(tail.status).toBe(200)
		expect(await tail.text()).toContain('"cursor":0')
		expect((await fetch(rpcRequest('runs.cancel', { runId }))).status).toBe(200)

		const unsupportedNamespace = await fetch(rpcRequest('namespaces.create', {
			id: 'unsupported',
			env: 'prod',
			target,
		}))
		expect(unsupportedNamespace.status).toBe(409)
	})

	test('elevates only listed authenticated users through the bootstrap-admin middleware', async () => {
		const fetch = application({ FABRIKA_CONTROL_BOOTSTRAP_ADMINS: '["viewer@vozka.test"]' })
		const listed = await fetch(apiRequest('https://control.test/api/apps', viewerToken))
		const notListed = await fetch(apiRequest('https://control.test/api/apps', operatorToken))

		expect(listed.status).toBe(200)
		expect(notListed.status).toBe(403)
	})

	test('the IAM provisioning key is not a control-plane credential', async () => {
		// The hatch is DELETED, not disabled. It could never work behind the proxy: `/api/*` is gated
		// `service`, the proxy resolves a `px_` bearer by asking IAM to mint from it, and the provisioning
		// key has no `credentials` row — so the proxy answered `invalid_key` before control saw anything.
		// Machine access is an IAM-issued service key, which is a real credential the proxy can exchange.
		const key = 'px_provision_secret_key_value'
		const fetch = application({})
		const bearer = await fetch(
			new Request('https://control.test/api/apps', { headers: { Authorization: `Bearer ${key}` } }),
		)
		const absent = await fetch(new Request('https://control.test/api/apps'))

		expect(bearer.status).toBe(401)
		expect(absent.status).toBe(401)
	})

	test('keeps manifest and callback paths human-only and returns a browser-safe unavailable status', async () => {
		const fetch = application({ FABRIKA_CONTROL_DOMAIN: 'https://control.test' })
		const service = await testToken({ label: 'automation', type: 'service', actions: [ACTIONS.SOURCE_CONNECTION_MANAGE] })
		const status = await fetch(rpcRequest('sourceConnection.status', null, adminToken))
		expect(status.status).toBe(200)
		const statusBody: unknown = await status.json()
		expect(statusBody).toEqual({ result: { provider: 'harbor', kind: 'github-app', state: 'unavailable' } })
		const list = await fetch(rpcRequest('sourceConnection.list', {}, adminToken))
		expect(list.status).toBe(200)
		const listBody: unknown = await list.json()
		expect(listBody).toEqual({
			result: {
				items: [],
				nextCursor: null,
				workflow: { provider: 'harbor', kind: 'github-app', state: 'unavailable' },
			},
		})
		expect((await fetch(rpcRequest('sourceConnection.list', { limit: GITHUB_SOURCE_CONNECTION_MAX_PAGE_SIZE + 1 }, adminToken))).status).toBe(400)
		expect((await fetch(rpcRequest('sourceConnection.list', { credential: 'must-not-be-accepted' }, adminToken))).status).toBe(400)

		const anonymous = await fetch(new Request('https://control.test/api/source/github/callback?code=a&state=b'))
		expect(anonymous.status).toBe(401)
		expect(anonymous.headers.get('cache-control')).toBe('no-store')
		expect(anonymous.headers.get('referrer-policy')).toBe('no-referrer')
		expect(anonymous.headers.get('x-content-type-options')).toBe('nosniff')
		expect(await anonymous.text()).not.toContain('code=a')
		const replay = await fetch(apiRequest('https://control.test/api/source/github/callback?code=secret-code&state=secret-state', adminToken))
		expect(replay.status).toBe(409)
		expect(replay.headers.get('cache-control')).toBe('no-store')
		expect(replay.headers.get('referrer-policy')).toBe('no-referrer')
		expect(replay.headers.get('x-content-type-options')).toBe('nosniff')
		const replayBody = await replay.text()
		expect(replayBody).not.toContain('secret-code')
		expect(replayBody).not.toContain('secret-state')
		const machine = await fetch(apiRequest('https://control.test/api/source/github/manifest/connection', service))
		expect(machine.status).toBe(403)
		expect(machine.headers.get('cache-control')).toBe('no-store')
	})

	test('projects the singleton connected state only on the first compatibility page', () => {
		const connected = {
			provider: 'zerops',
			kind: 'github-app',
			state: 'connected',
			connectionId: 'connection-1',
			app: {
				id: 123,
				slug: 'fabrika-test',
				htmlUrl: 'https://github.com/apps/fabrika-test',
				public: false,
				owner: { login: 'Contember', type: 'Organization' },
				permissions: { contents: 'read' },
				events: ['push'],
			},
			installation: { id: 456, accountLogin: 'Contember', repositorySelection: 'all', verifiedRepositories: [] },
		} satisfies GitHubSourceConnectionStatusDto

		expect(projectSingletonSourceConnectionPage(connected, {})).toEqual({ items: [connected], nextCursor: null, workflow: null })
		expect(projectSingletonSourceConnectionPage(connected, { cursor: 'later-page' })).toEqual({ items: [], nextCursor: null, workflow: null })
	})

	test('mounts scoped Zerops webhooks with their exact vault secret and no static fallback', async () => {
		const harness = createHarness()
		const vaultKey = testVaultKey()
		const vault = await Vault.create(harness.d1, vaultKey)
		const secretRefA = await vault.putSecret('platform', githubWebhookSecretLabel('connection-a'), 'secret-a')
		const secretRefB = await vault.putSecret('platform', githubWebhookSecretLabel('connection-b'), 'secret-b')
		insertConnection(harness, {
			connectionId: 'connection-a',
			transportKind: 'keyed-v2',
			owner: 'acme',
			installationId: 42,
			webhookSecretRef: secretRefA,
		})
		insertConnection(harness, {
			connectionId: 'connection-b',
			transportKind: 'keyed-v2',
			owner: 'beta',
			installationId: 43,
			webhookSecretRef: secretRefB,
		})
		for (
			const app of [
				{ id: 'scoped-app-a', repoUrl: 'github.com/acme/app', connectionId: 'connection-a', installationId: 42 },
				{ id: 'scoped-app-b', repoUrl: 'github.com/beta/app', connectionId: 'connection-b', installationId: 43 },
			]
		) {
			await harness.repositories.registry.createApp({
				id: app.id,
				repoUrl: app.repoUrl,
				githubConnectionId: app.connectionId,
				githubInstallationId: app.installationId,
			})
			await seedZeropsTrigger(harness, app.id)
		}
		const fetch = application({ FABRIKA_CONTROL_VAULT_KEY: vaultKey, GITHUB_CONNECTION_WEBHOOKS: true }, harness)
		const exactA = await webhookRequest('/webhooks/github/connection-a', 'secret-a', 'github.com/acme/app', 42)
		const exactB = await webhookRequest('/webhooks/github/connection-b', 'secret-b', 'github.com/beta/app', 43)
		const crossConnection = await webhookRequest('/webhooks/github/connection-b', 'secret-a', 'github.com/acme/app', 42)
		const swappedInstallation = await webhookRequest('/webhooks/github/connection-a', 'secret-a', 'github.com/acme/app', 43)
		// A real connection's secret on the wrong route: no route but its own may resolve it.
		const unknownConnection = await webhookRequest('/webhooks/github/unknown', 'secret-a', 'github.com/acme/app', 42)
		const unscoped = await webhookRequest('/webhooks/github', 'secret-a', 'github.com/acme/app', 42)

		expect((await fetch(exactA)).status).toBe(200)
		expect((await fetch(exactB)).status).toBe(200)
		expect((await fetch(crossConnection)).status).toBe(401)
		expect((await fetch(swappedInstallation)).status).toBe(204)
		expect((await fetch(unknownConnection)).status).toBe(401)
		expect((await fetch(unscoped)).status).toBe(401)
		expect(await harness.repositories.runs.listRuns({ limit: 10 })).toHaveLength(2)
	})

	test('refuses the unscoped route in a Zerops composition, which has no connection to resolve', async () => {
		const harness = createHarness()
		const vaultKey = testVaultKey()
		const vault = await Vault.create(harness.d1, vaultKey)
		const keyedRef = await vault.putSecret('platform', githubWebhookSecretLabel('keyed'), 'keyed-secret')
		insertConnection(harness, {
			connectionId: 'keyed',
			transportKind: 'keyed-v2',
			owner: 'beta',
			installationId: 43,
			webhookSecretRef: keyedRef,
		})
		await harness.repositories.registry.createApp({
			id: 'keyed-app',
			repoUrl: 'github.com/beta/app',
			githubConnectionId: 'keyed',
			githubInstallationId: 43,
		})
		await seedZeropsTrigger(harness, 'keyed-app')
		const fetch = application({ FABRIKA_CONTROL_VAULT_KEY: vaultKey, GITHUB_CONNECTION_WEBHOOKS: true }, harness)

		// Since ADR-0039 nothing keyed can be selected without a connection id, so the unscoped path is
		// refused rather than trying a stored secret — even the one that would verify on its own route.
		expect((await fetch(await webhookRequest('/webhooks/github', 'keyed-secret', 'github.com/beta/app', 43))).status).toBe(401)
		expect(await harness.repositories.runs.listRuns({ limit: 10 })).toHaveLength(0)
		// The scoped route still triggers its bound app.
		expect((await fetch(await webhookRequest('/webhooks/github/keyed', 'keyed-secret', 'github.com/beta/app', 43))).status).toBe(200)
		const runs = await harness.repositories.runs.listRuns({ limit: 10 })
		expect(runs).toHaveLength(1)
		expect(runs[0]?.app_id).toBe('keyed-app')
	})

	test('keeps the Cloudflare generic route static-secret and installation-only', async () => {
		const harness = createHarness()
		await harness.repositories.registry.createApp({
			id: 'cloudflare-app',
			repoUrl: 'github.com/acme/app',
			githubInstallationId: 42,
		})
		await harness.repositories.registry.upsertAppEnv({
			appId: 'cloudflare-app',
			env: 'prod',
			namespaceId: null,
			provider: 'cloudflare',
			providerTargetJson: '{}',
			providerArtifactJson: '{}',
			triggerRef: 'refs/heads/deploy/prod',
		})
		const fetch = application({ REPO_EVENTS: new FakeRepoSource({ webhookSecret: 'cloudflare-secret' }) }, harness)

		expect((await fetch(await webhookRequest('/webhooks/github', 'cloudflare-secret', 'github.com/acme/app', 43))).status).toBe(204)
		expect((await fetch(await webhookRequest('/webhooks/github', 'cloudflare-secret', 'github.com/acme/app', 42))).status).toBe(200)
		const runs = await harness.repositories.runs.listRuns({ limit: 10 })
		expect(runs).toHaveLength(1)
		expect(runs[0]?.app_id).toBe('cloudflare-app')
	})
})

function insertConnection(harness: Harness, input: {
	connectionId: string
	transportKind: 'keyed-v2'
	owner: string
	installationId: number
	webhookSecretRef: string
}): void {
	harness.sqlite.query(`INSERT INTO github_source_connections_keyed (
		connection_id, transport_kind, app_id, app_slug, app_html_url, app_owner, app_name, app_public,
		credential_sha256, webhook_url, webhook_secret_ref, installation_id,
		installation_account_login, installation_selection, verified_repositories_json,
		requested_repositories_json, connected_by, connected_at, verified_at, version
	) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'all', '[]', '[]', 'test', 1, 1, 1)`)
		.run(
			input.connectionId,
			input.transportKind,
			`${input.connectionId}-app-id`,
			`${input.connectionId}-app`,
			`https://github.com/apps/${input.connectionId}-app`,
			input.owner,
			`${input.connectionId}-app`,
			'a'.repeat(64),
			`https://control.test/webhooks/github/${input.connectionId}`,
			input.webhookSecretRef,
			input.installationId,
			input.owner,
		)
}

async function seedZeropsTrigger(harness: Harness, appId: string): Promise<void> {
	await harness.repositories.registry.upsertAppEnv({
		appId,
		env: 'prod',
		namespaceId: null,
		provider: 'zerops',
		providerTargetJson: '{}',
		providerArtifactJson: '{}',
		triggerRef: 'refs/heads/deploy/prod',
	})
}

async function webhookRequest(path: string, secret: string, cloneUrl: string, installationId: number): Promise<Request> {
	const signed = await pushWebhookRequest({ ref: 'refs/heads/deploy/prod', cloneUrl, installationId, secret })
	return new Request(`https://control.test${path}`, { method: 'POST', headers: signed.headers, body: await signed.text() })
}

/** A control REST request carrying the token the proxy would have injected. */
function apiRequest(url: string, token: string): Request {
	return new Request(url, { headers: { [PROXY_TOKEN_HEADER]: token } })
}

function rpcRequest(method: string, input: unknown, token = adminToken): Request {
	return new Request('https://control.test/api/rpc', {
		method: 'POST',
		headers: { 'content-type': 'application/json', [PROXY_TOKEN_HEADER]: token },
		body: JSON.stringify({ method, input }),
	})
}

function testVaultKey(): string {
	let binary = ''
	for (const byte of new Uint8Array(32).fill(7)) binary += String.fromCharCode(byte)
	return btoa(binary)
}

function resultString(body: unknown, field: string): string {
	if (typeof body !== 'object' || body === null) throw new Error('RPC body must be an object')
	const result = Reflect.get(body, 'result')
	if (typeof result !== 'object' || result === null) throw new Error('RPC result must be an object')
	const value = Reflect.get(result, field)
	if (typeof value !== 'string') throw new Error(`RPC result ${field} must be a string`)
	return value
}
