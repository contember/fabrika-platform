import { describe, expect, test } from 'bun:test'
import { controlApp } from '../app'
import type { Env } from '../env'
import { createHarness } from './helpers/harness'
import { fakeControlProvider } from './helpers/provider'

function application(overrides: Partial<Env> = {}) {
	const harness = createHarness()
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
		ENVIRONMENT: 'local',
		DEV: 'true',
		...overrides,
	}
	return (request: Request) =>
		controlApp.fetch(request, { env, provider: fakeControlProvider }, {
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

	test('uses the IAM SDK middleware and its dev persona header', async () => {
		const fetch = application()
		const viewer = await fetch(
			new Request('https://control.test/api/apps', {
				headers: { 'X-Dev-Principal': 'viewer@vozka.test' },
			}),
		)
		const admin = await fetch(
			new Request('https://control.test/api/apps', {
				headers: { 'X-Dev-Principal': 'admin@vozka.test' },
			}),
		)
		const unknown = await fetch(
			new Request('https://control.test/api/apps', {
				headers: { 'X-Dev-Principal': 'missing@vozka.test' },
			}),
		)

		expect(viewer.status).toBe(403)
		expect(admin.status).toBe(200)
		expect(unknown.status).toBe(403)
	})

	test('mounts the typed control RPC before REST and preserves authorization and errors', async () => {
		const fetch = application()
		const viewer = await fetch(rpcRequest('apps.list', null, 'viewer@vozka.test'))
		expect(viewer.status).toBe(403)
		const viewerBody: unknown = await viewer.json()
		expect(viewerBody).toEqual({ error: { type: 'forbidden', message: 'Forbidden: app.manage' } })

		const created = await fetch(rpcRequest('apps.create', { id: 'rpc-app', repoUrl: 'https://github.com/acme/rpc-app' }))
		expect(created.status).toBe(200)
		expect(await created.json()).toMatchObject({ result: { id: 'rpc-app', repoUrl: 'github.com/acme/rpc-app' } })

		const rest = await fetch(new Request('https://control.test/api/apps', { headers: { 'X-Dev-Principal': 'admin@vozka.test' } }))
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
		const fetch = application({ VOZKA_VAULT_KEY: testVaultKey() })
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

		const restVars = await fetch(
			new Request('https://control.test/api/apps/flow/vars', {
				headers: { 'X-Dev-Principal': 'admin@vozka.test' },
			}),
		)
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
		const fetch = application({ VOZKA_BOOTSTRAP_ADMINS: '["viewer@vozka.test"]' })
		const listed = await fetch(
			new Request('https://control.test/api/apps', {
				headers: { 'X-Dev-Principal': 'viewer@vozka.test' },
			}),
		)
		const notListed = await fetch(
			new Request('https://control.test/api/apps', {
				headers: { 'X-Dev-Principal': 'operator@vozka.test' },
			}),
		)
		const unknown = await fetch(
			new Request('https://control.test/api/apps', {
				headers: { 'X-Dev-Principal': 'missing@vozka.test' },
			}),
		)

		expect(listed.status).toBe(200)
		expect(notListed.status).toBe(403)
		expect(unknown.status).toBe(403)
	})

	test('admits only the configured provisioning bearer as a machine bootstrap admin', async () => {
		const key = 'px_provision_secret_key_value'
		const fetch = application({ PROPUSTKA_PROVISIONING_KEY: key })
		const admitted = await fetch(
			new Request('https://control.test/api/apps', {
				headers: { Authorization: `Bearer ${key}`, 'X-Dev-Principal': 'missing@vozka.test' },
			}),
		)
		const wrong = await fetch(
			new Request('https://control.test/api/apps', {
				headers: { Authorization: 'Bearer px_wrong_key', 'X-Dev-Principal': 'missing@vozka.test' },
			}),
		)
		const absent = await fetch(
			new Request('https://control.test/api/apps', {
				headers: { 'X-Dev-Principal': 'missing@vozka.test' },
			}),
		)

		expect(admitted.status).toBe(200)
		expect(wrong.status).toBe(403)
		expect(absent.status).toBe(403)
	})
})

function rpcRequest(method: string, input: unknown, persona = 'admin@vozka.test'): Request {
	return new Request('https://control.test/api/rpc', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'X-Dev-Principal': persona },
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
