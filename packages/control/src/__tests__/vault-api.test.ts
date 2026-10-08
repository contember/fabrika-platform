import type { AuthContext } from '@fabrika/auth'
import { type ControlProvider, type ProviderEnvelope, ProviderSecretError } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { FakeRepoSource } from '../repo-source'
import type { ControlJobMessage } from '../run-lifecycle'
import type { ControlRpcDeps } from '../services'
import { parseVaultRef, Vault } from '../vault'
import { createHarness } from './helpers/harness'
import { authWithActions } from './helpers/iam'
import { rpcRequest, rpcResult } from './helpers/rpc'

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
function makeDeps(auth: AuthContext): { deps: ControlRpcDeps; vault: Promise<Vault>; queue: ControlJobMessage[] } {
	const { db, d1 } = createHarness()
	const queue: ControlJobMessage[] = []
	const vault = Vault.create(d1, testKey())
	const deps: ControlRpcDeps = {
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

/** A caller granted exactly `secret.manage` + `app.manage` globally (covers the app-secret values). */
function secretManager(): AuthContext {
	return authWithActions(['secret.manage', 'app.manage'], 'sm@vozka.test')
}

/** A caller that holds neither `secret.manage` nor `app.manage` (only `deploy.read`) → denied. */
function noSecretManager(): AuthContext {
	return authWithActions(['deploy.read'], 'ro@vozka.test')
}

describe('app secret value endpoints (secret.manage, app-scoped)', () => {
	async function seedApp(deps: ControlRpcDeps): Promise<void> {
		await deps.repositories.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		await deps.repositories.registry.upsertAppEnv(storedEnvironment())
	}

	test('vault.set stores in the vault + upserts the ref; value not returned', async () => {
		const { deps, vault } = makeDeps(secretManager())
		await seedApp(deps)

		const response = await rpcResult(rpcRequest('vault.set', { appId: 'app', name: 'API_KEY', value: 'the-real-key', env: 'prod' }), deps)
		expect(response.status).toBe(200)
		expect(await response.text()).not.toContain('the-real-key')

		const secrets = await deps.repositories.registry.listAppSecrets('app')
		const prod = secrets.find((s) => s.name === 'API_KEY' && s.env === 'prod')
		expect(prod).toBeDefined()
		expect(parseVaultRef(prod!.value_ref)).not.toBeNull()
		expect(await (await vault).getSecret(prod!.value_ref)).toBe('the-real-key')
	})

	test('all-env layer (no env) and vault.rotate', async () => {
		const { deps, vault } = makeDeps(secretManager())
		await seedApp(deps)
		await rpcResult(rpcRequest('vault.set', { appId: 'app', name: 'SHARED', value: 'shared-v1' }), deps)
		const allEnv = (await deps.repositories.registry.listAppSecrets('app')).find((s) => s.name === 'SHARED' && s.env === null)
		expect(allEnv).toBeDefined()

		const rotate = await rpcResult(rpcRequest('vault.rotate', { appId: 'app', name: 'SHARED', value: 'shared-v2' }), deps)
		expect(rotate.status).toBe(200)
		expect(await (await vault).getSecret(allEnv!.value_ref)).toBe('shared-v2')
	})

	test('vault.delete drops the vault entry', async () => {
		const { deps, vault } = makeDeps(secretManager())
		await seedApp(deps)
		await rpcResult(rpcRequest('vault.set', { appId: 'app', name: 'GONE', value: 'bye' }), deps)
		const ref = (await deps.repositories.registry.listAppSecrets('app')).find((s) => s.name === 'GONE')!.value_ref
		const del = await rpcResult(rpcRequest('vault.delete', { appId: 'app', name: 'GONE' }), deps)
		expect(del.status).toBe(200)
		await expect((await vault).getSecret(ref)).rejects.toThrow()
	})

	test('a caller denied secret.manage gets 403 (app secret value)', async () => {
		const { deps } = makeDeps(noSecretManager())
		await seedApp(deps)
		const response = await rpcResult(rpcRequest('vault.set', { appId: 'app', name: 'API_KEY', value: 'x' }), deps)
		expect(response.status).toBe(403)
	})

	test('missing value → 400', async () => {
		const { deps } = makeDeps(secretManager())
		await seedApp(deps)
		const response = await rpcResult(rpcRequest('vault.set', { appId: 'app', name: 'API_KEY', env: 'prod' }), deps)
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
		const deps: ControlRpcDeps = {
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

		expect((await rpcResult(rpcRequest('vault.set', { appId: 'app', name: 'API_KEY', value: 'v1', env: 'prod' }), deps)).status).toBe(200)
		const stored = (await db.registry.listAppSecrets('app')).find((secret) => secret.name === 'API_KEY')
		expect(stored?.value_ref).toBe('harbor:prod/API_KEY')
		expect(parseVaultRef(stored?.value_ref ?? '')).toBeNull()
		expect((await rpcResult(rpcRequest('vault.rotate', { appId: 'app', name: 'API_KEY', value: 'v2', env: 'prod' }), deps)).status).toBe(200)
		expect((await rpcResult(rpcRequest('vault.delete', { appId: 'app', name: 'API_KEY', env: 'prod' }), deps)).status).toBe(200)
		expect(calls).toEqual([
			'put:apps-prod:prod:API_KEY:v1',
			'put:apps-prod:prod:API_KEY:v2',
			'delete:apps-prod:prod:API_KEY',
		])
	})

	test('apps.secrets.put on a provider-managed installation hands the value to the provider; an all-env write is 400', async () => {
		const { deps } = makeDeps(secretManager())
		const puts: string[] = []
		deps.provider = {
			id: 'harbor',
			normalizeRegistration: (input) => input,
			deploy: async () => ({ state: 'succeeded' }),
			secrets: {
				put: async ({ environment, name, value }) => {
					puts.push(`${environment.env}:${name}:${value}`)
					return { valueRef: `harbor:${environment.env}/${name}` }
				},
				delete: async () => {},
			},
		}
		await deps.repositories.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		await deps.repositories.registry.upsertAppEnv(storedEnvironment('harbor'))

		const put = await rpcResult(rpcRequest('apps.secrets.put', { appId: 'app', secret: { name: 'API_KEY', value: 'v1', env: 'prod' } }), deps)
		expect(put.status).toBe(200)
		expect(await put.json()).toMatchObject({ name: 'API_KEY', env: 'prod', storage: 'provider', valueRef: null })
		expect(puts).toEqual(['prod:API_KEY:v1'])
		expect((await deps.repositories.registry.listAppSecrets('app'))[0]?.value_ref).toBe('harbor:prod/API_KEY')

		const allEnv = await rpcResult(rpcRequest('apps.secrets.put', { appId: 'app', secret: { name: 'SHARED', value: 'v1', env: null } }), deps)
		expect(allEnv.status).toBe(400)
		expect(puts).toHaveLength(1)
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
		const response = await rpcResult(rpcRequest('vault.set', { appId: 'app', name: 'API_KEY', value: 'v1' }), deps)
		expect(response.status).toBe(400)
	})

	test('a provider-typed refusal of the value surfaces as 422 on set and rotate, naming the host and never the value', async () => {
		const { deps } = makeDeps(secretManager())
		deps.provider = {
			id: 'harbor',
			normalizeRegistration: (input) => input,
			deploy: async () => ({ state: 'succeeded' }),
			secrets: {
				put: async ({ name }) => {
					throw new ProviderSecretError(`harbor: secret \`${name}\` references service \`proxy\`, which this app does not own`, 'foreignReference')
				},
				delete: async () => {},
			},
		}
		await deps.repositories.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		await deps.repositories.registry.upsertAppEnv({ ...storedEnvironment('harbor') })
		const value = 'sk-live-leak${proxy_FABRIKA_IAM_KEY}'
		const set = await rpcResult(rpcRequest('vault.set', { appId: 'app', name: 'API_KEY', value, env: 'prod' }), deps)
		expect(set.status).toBe(422)
		const setBody = await set.text()
		expect(setBody).toContain('proxy')
		expect(setBody).not.toContain('sk-live-leak')
		expect((await deps.repositories.registry.listAppSecrets('app')).find((secret) => secret.name === 'API_KEY')).toBeUndefined()

		await deps.repositories.registry.upsertAppSecret({ appId: 'app', env: 'prod', name: 'API_KEY', valueRef: 'harbor:prod/API_KEY' })
		const rotate = await rpcResult(rpcRequest('vault.rotate', { appId: 'app', name: 'API_KEY', value, env: 'prod' }), deps)
		expect(rotate.status).toBe(422)
		expect(await rotate.text()).not.toContain('sk-live-leak')
	})
})

describe('vault not configured', () => {
	test('vault routes 500 cleanly when no vault factory is wired', async () => {
		const { db } = createHarness()
		const deps: ControlRpcDeps = {
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
		const response = await rpcResult(rpcRequest('vault.set', { appId: 'app', name: 'API_KEY', value: 'x' }), deps)
		expect(response.status).toBe(500)
	})
})

describe('a vault ref is owned by the app secret that created it', () => {
	async function seedTwoApps(deps: ControlRpcDeps): Promise<void> {
		for (const id of ['a', 'b']) {
			await deps.repositories.registry.createApp({ id, repoUrl: `github.com/acme/${id}` })
			await deps.repositories.registry.upsertAppEnv({ ...storedEnvironment(), appId: id })
		}
	}

	test('app A cannot point a secret at app B’s vault ref — the ref is sealed as A’s own value', async () => {
		const { deps, vault } = makeDeps(secretManager())
		await seedTwoApps(deps)
		await rpcResult(rpcRequest('vault.set', { appId: 'b', name: 'API_KEY', value: 'b-secret', env: 'prod' }), deps)
		const victim = (await deps.repositories.registry.listAppSecrets('b'))[0]!.value_ref

		const put = await rpcResult(rpcRequest('apps.secrets.put', { appId: 'a', secret: { name: 'STOLEN', value: victim } }), deps)

		expect(put.status).toBe(200)
		const stolen = (await deps.repositories.registry.listAppSecrets('a'))[0]?.value_ref ?? ''
		expect(parseVaultRef(stolen)).not.toBeNull()
		expect(stolen).not.toBe(victim)
		expect(await (await vault).getSecret(stolen)).toBe(victim)
		expect(await (await vault).getSecret(victim)).toBe('b-secret')
	})

	test('a stored ref that names another purpose is refused on rotate, delete, set and resolve', async () => {
		const { deps, vault } = makeDeps(secretManager())
		await seedTwoApps(deps)
		// A ref planted before this rule existed: a `platform`-scoped row addressed by an app secret.
		const platformRef = await (await vault).putSecret('platform', 'github-app:recovery', 'platform-secret')
		await deps.repositories.registry.upsertAppSecret({ appId: 'a', env: 'prod', name: 'API_KEY', valueRef: platformRef })

		const rotate = await rpcResult(rpcRequest('vault.rotate', { appId: 'a', name: 'API_KEY', value: 'attacker', env: 'prod' }), deps)
		expect(rotate.status).toBe(403)
		const removed = await rpcResult(rpcRequest('vault.delete', { appId: 'a', name: 'API_KEY', env: 'prod' }), deps)
		expect(removed.status).toBe(403)
		const overwritten = await rpcResult(rpcRequest('vault.set', { appId: 'a', name: 'API_KEY', value: 'attacker', env: 'prod' }), deps)
		expect(overwritten.status).toBe(403)

		// Neither the refusal text nor the row gives anything away.
		expect(await (await vault).getSecret(platformRef)).toBe('platform-secret')
		expect((await deps.repositories.registry.listAppSecrets('a'))[0]?.value_ref).toBe(platformRef)
		const body = await overwritten.text()
		expect(body).not.toContain('platform')
		expect(body).not.toContain('github-app')
	})

	test('a reserved name is refused on set and rotate, whichever target holds the value', async () => {
		const { deps } = makeDeps(secretManager())
		await seedTwoApps(deps)
		for (const name of ['FABRIKA_IAM_ISSUER']) {
			const set = await rpcResult(rpcRequest('vault.set', { appId: 'a', name, value: 'https://iam.attacker.example', env: 'prod' }), deps)
			expect(set.status).toBe(400)
			expect(await set.text()).toContain('managed by Fabrika')
			expect((await rpcResult(rpcRequest('vault.rotate', { appId: 'a', name, value: 'x', env: 'prod' }), deps)).status).toBe(400)
		}
		expect(await deps.repositories.registry.listAppSecrets('a')).toEqual([])
	})

	test('a vault that cannot answer is a 500, not a refusal — an outage must not read as “not yours”', async () => {
		const { deps } = makeDeps(secretManager())
		await seedTwoApps(deps)
		await rpcResult(rpcRequest('vault.set', { appId: 'a', name: 'API_KEY', value: 'v1', env: 'prod' }), deps)
		// A real vault over a database that is down — the honest shape of "the vault cannot answer".
		const broken = await Vault.create({
			prepare: () => {
				throw new Error('vault database is unavailable')
			},
		}, testKey())
		deps.vault = () => Promise.resolve(broken)

		const rotate = await rpcResult(rpcRequest('vault.rotate', { appId: 'a', name: 'API_KEY', value: 'v2', env: 'prod' }), deps)

		expect(rotate.status).toBe(500)
		expect(await rotate.text()).not.toContain('does not belong')
	})

	test('the app’s own ref still rotates and deletes', async () => {
		const { deps, vault } = makeDeps(secretManager())
		await seedTwoApps(deps)
		await rpcResult(rpcRequest('vault.set', { appId: 'a', name: 'API_KEY', value: 'v1', env: 'prod' }), deps)
		expect((await rpcResult(rpcRequest('vault.rotate', { appId: 'a', name: 'API_KEY', value: 'v2', env: 'prod' }), deps)).status).toBe(200)
		const ref = (await deps.repositories.registry.listAppSecrets('a'))[0]!.value_ref
		expect(await (await vault).getSecret(ref)).toBe('v2')
		expect((await rpcResult(rpcRequest('vault.delete', { appId: 'a', name: 'API_KEY', env: 'prod' }), deps)).status).toBe(200)
	})
})
