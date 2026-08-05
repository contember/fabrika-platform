import type { AuthContext } from '@fabrika/auth'
import type { ControlProvider, ProviderEnvelope } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import type { ApiDeps } from '../api/router'
import { handleApi } from '../api/router'
import { FakeRepoSource } from '../repo-source'
import type { DeployJobMessage } from '../run-lifecycle'
import { parseVaultRef, Vault } from '../vault'
import { createHarness } from './helpers/harness'
import { authWithActions } from './helpers/iam'

// The vault MANAGEMENT API (M4): write-only set/rotate/delete of secret VALUES, gated by `secret.manage`
// and audited. These assert: the value is stored in the vault + the ref written back to the row; the
// value is NEVER returned in any API response; the ACL is enforced (allow + 403); and a value the API
// stored decrypts back through the vault (so the JobSpec path will resolve it).

function testKey(): string {
	const raw = new Uint8Array(32).fill(3)
	let binary = ''
	for (const b of raw) binary += String.fromCharCode(b)
	return btoa(binary)
}

const envelope = (provider: string, payload: string): ProviderEnvelope => ({
	provider,
	version: 1,
	payload,
})

const vaultProvider: ControlProvider = {
	id: 'memory',
	normalizeRegistration: (input) => input,
	deploy: async () => ({ state: 'succeeded' }),
}

const storedEnvironment = (provider = 'memory') => ({
	appId: 'app',
	env: 'prod',
	namespaceId: null,
	provider,
	providerTargetJson: JSON.stringify(envelope(provider, 'target')),
	providerArtifactJson: JSON.stringify(envelope(provider, 'artifact')),
})

/** Router deps over a real sqlite D1, a recording queue, and a vault factory bound to the SAME db. */
function makeDeps(auth: AuthContext): { deps: ApiDeps; vault: Promise<Vault>; queue: DeployJobMessage[] } {
	const { db, d1 } = createHarness()
	const queue: DeployJobMessage[] = []
	const vault = Vault.create(d1, testKey())
	const deps: ApiDeps = {
		repositories: db,
		auth,
		queue: {
			send(m) {
				queue.push(m)
				return Promise.resolve()
			},
		},
		logs: { get: () => Promise.resolve(null) },
		repoSource: new FakeRepoSource(),
		provider: vaultProvider,
		cancelRun: () => Promise.resolve(),
		vault: () => vault,
	}
	return { deps, vault, queue }
}

function req(method: string, path: string, body?: unknown): Request {
	return new Request(`https://vozka.example${path}`, {
		method,
		...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
	})
}

/** A caller granted exactly `secret.manage` + `app.manage` globally (covers the app-secret values). */
function secretManager(): AuthContext {
	return authWithActions(['secret.manage', 'app.manage'], 'sm@vozka.test')
}

/** A caller that holds neither `secret.manage` nor `app.manage` (only `deploy.read`) → denied. */
function noSecretManager(): AuthContext {
	return authWithActions(['deploy.read'], 'ro@vozka.test')
}

describe('app secret value endpoints (secret.manage, app-scoped)', () => {
	async function seedApp(deps: ApiDeps): Promise<void> {
		await deps.repositories.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		await deps.repositories.registry.upsertAppEnv(storedEnvironment())
	}

	test('PUT .../secrets/:name/value stores in the vault + upserts the ref; value not returned', async () => {
		const { deps, vault } = makeDeps(secretManager())
		await seedApp(deps)

		const response = await handleApi(req('PUT', '/api/apps/app/secrets/API_KEY/value', { value: 'the-real-key', env: 'prod' }), deps)
		expect(response.status).toBe(200)
		expect(await response.text()).not.toContain('the-real-key')

		const secrets = await deps.repositories.registry.listAppSecrets('app')
		const prod = secrets.find((s) => s.name === 'API_KEY' && s.env === 'prod')
		expect(prod).toBeDefined()
		expect(parseVaultRef(prod!.value_ref)).not.toBeNull()
		expect(await (await vault).getSecret(prod!.value_ref)).toBe('the-real-key')
	})

	test('all-env layer (no env) and PATCH rotate', async () => {
		const { deps, vault } = makeDeps(secretManager())
		await seedApp(deps)
		await handleApi(req('PUT', '/api/apps/app/secrets/SHARED/value', { value: 'shared-v1' }), deps)
		const allEnv = (await deps.repositories.registry.listAppSecrets('app')).find((s) => s.name === 'SHARED' && s.env === null)
		expect(allEnv).toBeDefined()

		const rotate = await handleApi(req('PATCH', '/api/apps/app/secrets/SHARED/value', { value: 'shared-v2' }), deps)
		expect(rotate.status).toBe(200)
		expect(await (await vault).getSecret(allEnv!.value_ref)).toBe('shared-v2')
	})

	test('DELETE drops the vault entry', async () => {
		const { deps, vault } = makeDeps(secretManager())
		await seedApp(deps)
		await handleApi(req('PUT', '/api/apps/app/secrets/GONE/value', { value: 'bye' }), deps)
		const ref = (await deps.repositories.registry.listAppSecrets('app')).find((s) => s.name === 'GONE')!.value_ref
		const del = await handleApi(req('DELETE', '/api/apps/app/secrets/GONE/value'), deps)
		expect(del.status).toBe(200)
		await expect((await vault).getSecret(ref)).rejects.toThrow()
	})

	test('a caller denied secret.manage gets 403 (app secret value)', async () => {
		const { deps } = makeDeps(noSecretManager())
		await seedApp(deps)
		const response = await handleApi(req('PUT', '/api/apps/app/secrets/API_KEY/value', { value: 'x' }), deps)
		expect(response.status).toBe(403)
	})

	test('missing value → 400', async () => {
		const { deps } = makeDeps(secretManager())
		await seedApp(deps)
		const response = await handleApi(req('PUT', '/api/apps/app/secrets/API_KEY/value', { env: 'prod' }), deps)
		expect(response.status).toBe(400)
	})

	test('provider-managed set, rotate, and delete bypass the vault', async () => {
		const { db } = createHarness()
		const calls: string[] = []
		const provider: ControlProvider = {
			id: 'harbor',
			normalizeRegistration: (input) => input,
			deploy: async () => ({ state: 'succeeded' }),
			secrets: {
				put: async ({ environment, name, value }) => {
					calls.push(`put:${environment.namespace?.id ?? 'none'}:${environment.env}:${name}:${value}`)
					return { valueRef: `harbor:${environment.env}/${name}` }
				},
				delete: async ({ environment, name }) => {
					calls.push(`delete:${environment.namespace?.id ?? 'none'}:${environment.env}:${name}`)
				},
			},
		}
		const deps: ApiDeps = {
			repositories: db,
			auth: secretManager(),
			queue: { send: () => Promise.resolve() },
			logs: { get: () => Promise.resolve(null) },
			repoSource: new FakeRepoSource(),
			provider,
			cancelRun: () => Promise.resolve(),
		}
		await db.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		await db.registry.createDeploymentNamespace({
			id: 'apps-prod',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify(envelope('harbor', 'namespace')),
			state: 'failed',
		})
		await db.registry.upsertAppEnv({
			...storedEnvironment('harbor'),
			namespaceId: 'apps-prod',
		})

		expect((await handleApi(req('PUT', '/api/apps/app/secrets/API_KEY/value', { value: 'v1', env: 'prod' }), deps)).status).toBe(200)
		const stored = (await db.registry.listAppSecrets('app')).find((secret) => secret.name === 'API_KEY')
		expect(stored?.value_ref).toBe('harbor:prod/API_KEY')
		expect(parseVaultRef(stored?.value_ref ?? '')).toBeNull()
		expect((await handleApi(req('PATCH', '/api/apps/app/secrets/API_KEY/value', { value: 'v2', env: 'prod' }), deps)).status).toBe(200)
		expect((await handleApi(req('DELETE', '/api/apps/app/secrets/API_KEY/value?env=prod'), deps)).status).toBe(200)
		expect(calls).toEqual([
			'put:apps-prod:prod:API_KEY:v1',
			'put:apps-prod:prod:API_KEY:v2',
			'delete:apps-prod:prod:API_KEY',
		])
	})

	test('provider-managed storage rejects an all-env secret instead of guessing replication', async () => {
		const { deps } = makeDeps(secretManager())
		deps.provider = {
			id: 'harbor',
			normalizeRegistration: (input) => input,
			deploy: async () => ({ state: 'succeeded' }),
			secrets: {
				put: async () => ({ valueRef: 'harbor:secret' }),
				delete: async () => {},
			},
		}
		await deps.repositories.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		await deps.repositories.registry.upsertAppEnv({
			...storedEnvironment('harbor'),
		})
		const response = await handleApi(req('PUT', '/api/apps/app/secrets/API_KEY/value', { value: 'v1' }), deps)
		expect(response.status).toBe(400)
	})
})

describe('vault not configured', () => {
	test('vault routes 500 cleanly when no vault factory is wired', async () => {
		const { db } = createHarness()
		const deps: ApiDeps = {
			repositories: db,
			auth: secretManager(),
			queue: { send: () => Promise.resolve() },
			logs: { get: () => Promise.resolve(null) },
			repoSource: new FakeRepoSource(),
			provider: vaultProvider,
			cancelRun: () => Promise.resolve(),
			// no `vault` factory
		}
		await db.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		const response = await handleApi(req('PUT', '/api/apps/app/secrets/API_KEY/value', { value: 'x' }), deps)
		expect(response.status).toBe(500)
	})
})
