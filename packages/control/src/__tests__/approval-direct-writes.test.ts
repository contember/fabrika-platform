// D8 (ADR-0083 §1, §3): a non-person's direct secret, variable, data or registry write on a protected environment meets
// the gate before it applies. Under `person` it is stored as an approval request and answered 409 `approval_requested`
// with the link, never as applied; `refuse` is a 403 naming the category; `off` applies at once. A person in the console
// and an unprotected environment apply directly. Through the real RPC router, on SQLite always and on Postgres when
// FABRIKA_TEST_POSTGRES_URL is set.

import { dispatchRpcRequest } from '@fabrika/app/service'
import type { AuthContext } from '@fabrika/auth'
import { permits, sha256Hex } from '@fabrika/auth-core'
import {
	ALL_ENVIRONMENTS,
	type ApprovalPolicy,
	approvalRequestedSchema,
	PERMISSIVE_POLICY,
	STRICT_POLICY,
	STRICT_SETTINGS,
} from '@fabrika/control-contract'
import { type DeployLocks, type SqlDatabase, SqlDeployLocks } from '@fabrika/platform'
import type { JsonValue } from '@fabrika/provider-contract'
import { afterEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { storedPolicy, storedSettings } from '../approval/categories'
import { createControlRpcRouter } from '../control-rpc'
import { type ControlRepositories, createControlRepositories } from '../db'
import type { Env } from '../env'
import { appSecretPurpose } from '../secret-resolver'
import type { ControlRpcDeps } from '../services'
import { Vault } from '../vault'
import { createHarness, harnessDatabase } from './helpers/harness'
import { fixtureProtect } from './helpers/lock'
import { createPostgres, hasPostgres, skipReason } from './helpers/postgres'
import { fakeControlProvider, providerEnvironment } from './helpers/provider'
import { unusedSourceConnection } from './helpers/source-connection'
import { testVaultKey } from './helpers/vault'

if (!hasPostgres) console.warn(`approval-direct-writes.test.ts Postgres half ${skipReason}`)

const ORIGIN = 'https://control.test'
const SECRET = 'sk_live_direct-write-value-1234567890'

interface Opened {
	readonly db: SqlDatabase
	readonly repositories: ControlRepositories
	readonly locks: DeployLocks
	readonly vault: Vault
	close(): Promise<void>
}

const backends: readonly { readonly name: string; readonly skip: boolean; open(): Promise<Opened> }[] = [
	{
		name: 'sqlite',
		skip: false,
		open: async () => {
			const harness = createHarness()
			const db = harnessDatabase(harness.repositories)
			return {
				db,
				repositories: harness.repositories,
				locks: new SqlDeployLocks(db),
				vault: await Vault.create(db, testVaultKey()),
				close: () => Promise.resolve(harness.sqlite.close()),
			}
		},
	},
	{
		name: 'postgres',
		skip: !hasPostgres,
		open: async () => {
			const fixture = await createPostgres('control_direct_writes')
			return {
				db: fixture.db,
				repositories: createControlRepositories(fixture.db),
				locks: new SqlDeployLocks(fixture.db),
				vault: await Vault.create(fixture.db, testVaultKey()),
				close: () => fixture.close(),
			}
		},
	},
]

type Caller = 'agent' | 'key' | 'person'

function authOf(caller: Caller): AuthContext {
	const grants = [{ action: '*', scope: null, source: 'grant' as const }]
	return {
		ok: true,
		principal: caller === 'key' ? { id: 'svc', type: 'service', label: 'builder' } : { id: 'p-ada', type: 'user', label: 'ada@example.test' },
		...(caller === 'agent'
			? { oauth: { app: 'vozka', clientId: 'https://agent.example.test/client.json', scopes: ['operate'], grantId: 'g', tokenId: 't' } }
			: {}),
		can: (action, scope) => permits(grants, action, scope),
		scopedTo: () => null,
		audit: () => Promise.resolve(),
	}
}

const envelope = z.object({
	result: z.unknown().optional(),
	error: z.object({ type: z.string(), message: z.string(), data: z.unknown().optional() }).optional(),
})

for (const backend of backends) {
	describe.skipIf(backend.skip)(`a non-person's direct write on a protected environment (${backend.name})`, () => {
		let opened: Opened | null = null
		afterEach(async () => {
			await opened?.close()
			opened = null
		})

		async function world(): Promise<Opened> {
			opened = await backend.open()
			const { registry } = opened.repositories
			await registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes', defaultBranch: 'main' })
			await registry.upsertAppEnv(providerEnvironment('notes', 'prod', { triggerRef: 'refs/heads/main' }))
			await registry.upsertAppEnv(providerEnvironment('notes', 'stage', { triggerRef: 'refs/heads/develop' }))
			return opened
		}

		async function policy(w: Opened, env: string, chosen: ApprovalPolicy): Promise<void> {
			await fixtureProtect(
				w.repositories.registry,
				w.locks,
				{ appId: 'notes', env },
				true,
				Date.now,
				storedPolicy(chosen),
				storedSettings(STRICT_SETTINGS),
			)
		}

		async function call(w: Opened, caller: Caller, method: string, input: JsonValue) {
			const auth = authOf(caller)
			const deps: ControlRpcDeps = {
				repositories: w.repositories,
				auth,
				queue: { send: () => Promise.resolve() },
				logs: { get: () => Promise.resolve(null) },
				provider: fakeControlProvider,
				cancelRun: () => Promise.resolve(),
				lock: w.locks,
				vault: () => Promise.resolve(w.vault),
			}
			const env: Env = {
				DB: w.db,
				REPOSITORIES: w.repositories,
				ASSETS: { fetch: () => Promise.reject(new Error('no assets')) },
				RUN_LOGS: { get: () => Promise.resolve(null), put: () => Promise.resolve(), delete: () => Promise.resolve() },
				DEPLOY_QUEUE: deps.queue,
				WAIT_UNTIL: () => {},
				ENVIRONMENT: 'local',
				FABRIKA_CONTROL_DOMAIN: ORIGIN,
			}
			const headers: Record<string, string> = { 'content-type': 'application/json' }
			if (caller !== 'person') headers.Authorization = 'Bearer px_test'
			const request = new Request(`${ORIGIN}/api/rpc`, { method: 'POST', headers, body: JSON.stringify({ method, input }) })
			const response = await dispatchRpcRequest({
				router: createControlRpcRouter(() => deps),
				ctx: { auth, request, env, provider: fakeControlProvider, sourceConnection: unusedSourceConnection('harbor') },
				request,
			})
			return { status: response.status, ...envelope.parse(await response.json()) }
		}

		const putSecret = (env: string | null) => ({ appId: 'notes', secret: { name: 'API_KEY', value: SECRET, env } })

		async function secretValue(w: Opened, env: string | null): Promise<string | null> {
			const found = (await w.repositories.registry.listAppSecrets('notes')).find((secret) => secret.env === env && secret.name === 'API_KEY')
			return found === undefined ? null : w.vault.getSecretForPurpose(found.value_ref, appSecretPurpose('notes', env, 'API_KEY'))
		}

		test('a secret write is stored as a request and answered with its link and fingerprint, not applied', async () => {
			const w = await world()
			const answer = await call(w, 'agent', 'apps.secrets.put', putSecret('prod'))
			expect(answer.status).toBe(409)
			expect(answer.error?.type).toBe('approval_requested')
			const created = approvalRequestedSchema.parse(answer.error?.data)
			const fingerprint = sha256Hex(SECRET).slice(0, 8)
			expect(created).toEqual({ id: created.id, url: `${ORIGIN}/approvals/requests/${created.id}`, state: 'pending', fingerprint })
			expect(answer.error?.message).toContain(created.url)
			expect(answer.error?.message).toContain(fingerprint)
			expect(JSON.stringify(answer)).not.toContain(SECRET)
			expect(await secretValue(w, 'prod')).toBeNull()
			expect(await w.repositories.approvalRequests.get(created.id)).toMatchObject({
				kind: 'apps.secrets.put',
				category: 'secrets',
				app_id: 'notes',
				env: 'prod',
				state: 'pending',
				requester_id: 'p-ada',
				requester_client_id: 'https://agent.example.test/client.json',
			})
		})

		test("a person's own key is a non-person too, and the all-environments layer is a write to every protected environment", async () => {
			const w = await world()
			const answer = await call(w, 'key', 'apps.variables.put', { appId: 'notes', variable: { name: 'REGION', value: 'eu', env: null } })
			expect(answer.status).toBe(409)
			const created = approvalRequestedSchema.parse(answer.error?.data)
			expect(created.fingerprint).toBeUndefined()
			expect(await w.repositories.approvalRequests.get(created.id)).toMatchObject({ kind: 'apps.variables.put', env: ALL_ENVIRONMENTS })
			expect(await w.repositories.registry.listAppVars('notes')).toEqual([])

			// With `variables: off` on the one protected environment, the layer applies at once.
			await policy(w, 'prod', { ...STRICT_POLICY, variables: 'off' })
			expect((await call(w, 'key', 'apps.variables.put', { appId: 'notes', variable: { name: 'REGION', value: 'eu', env: null } })).status).toBe(
				200,
			)
			expect((await w.repositories.registry.listAppVars('notes')).map((row) => row.value)).toEqual(['eu'])
		})

		test("an application's patch is asked for without its nulls, which keep the stored value", async () => {
			const w = await world()
			const answer = await call(w, 'agent', 'apps.update', { appId: 'notes', app: { buildCmd: 'bun run build', workerDir: null } })
			expect(answer.status).toBe(409)
			const created = approvalRequestedSchema.parse(answer.error?.data)
			const row = await w.repositories.approvalRequests.get(created.id)
			expect(row).toMatchObject({ kind: 'apps.update', category: 'registry', env: ALL_ENVIRONMENTS })
			expect(JSON.parse(row?.input_json ?? 'null')).toEqual({ appId: 'notes', app: { buildCmd: 'bun run build' } })
			expect((await w.repositories.registry.getApp('notes'))?.build_cmd).toBeNull()
		})

		test("removing an application's GitHub binding is asked for with its null, which removes it", async () => {
			const w = await world()
			const answer = await call(w, 'agent', 'apps.update', { appId: 'notes', app: { githubInstallationId: null, workerDir: null } })
			expect(answer.status).toBe(409)
			const created = approvalRequestedSchema.parse(answer.error?.data)
			const row = await w.repositories.approvalRequests.get(created.id)
			expect(JSON.parse(row?.input_json ?? 'null')).toEqual({ appId: 'notes', app: { githubInstallationId: null } })
		})

		test('a write that reaches the provider or the environment itself waits as a request too', async () => {
			const w = await world()
			const registration = {
				target: { provider: 'harbor', version: 1, payload: { kind: 'target' } },
				artifact: { provider: 'harbor', version: 1, payload: { kind: 'artifact' } },
			}
			const writes: readonly [string, JsonValue][] = [
				['apps.environments.suspend', { appId: 'notes', env: 'prod' }],
				['apps.environments.put', { appId: 'notes', env: 'prod', environment: { ...registration, triggerRef: 'refs/heads/other' } }],
			]
			for (const [method, input] of writes) {
				const answer = await call(w, 'agent', method, input)
				expect({ method, status: answer.status, type: answer.error?.type }).toEqual({ method, status: 409, type: 'approval_requested' })
			}
			expect((await w.repositories.registry.getAppEnv('notes', 'prod'))?.suspended_at).toBeNull()
		})

		test('an environment that starts protected but does not exist takes a person: a deleted protected prod and an unregistered one', async () => {
			const w = await world()
			await policy(w, 'prod', STRICT_POLICY)
			const prod = await w.repositories.registry.getAppEnv('notes', 'prod')
			if (prod === null) throw new Error('the world has no prod')
			expect(await w.repositories.registry.deleteAppEnv('notes', 'prod', prod.generation)).toBe(true)
			await w.repositories.registry.createApp({ id: 'memo', repoUrl: 'github.com/acme/memo', defaultBranch: 'main' })
			const registration = {
				target: { provider: 'harbor', version: 1, payload: {} },
				artifact: { provider: 'harbor', version: 1, payload: {} },
			}
			for (const appId of ['notes', 'memo']) {
				const writes: readonly [string, JsonValue][] = [
					['apps.variables.put', { appId, variable: { name: 'REGION', value: 'eu', env: 'prod' } }],
					['apps.variables.delete', { appId, name: 'REGION', env: 'prod' }],
					['apps.secrets.put', { appId, secret: { name: 'API_KEY', value: SECRET, env: 'prod' } }],
					['vault.set', { appId, name: 'API_KEY', value: SECRET, env: 'prod' }],
					['vault.rotate', { appId, name: 'API_KEY', value: SECRET, env: 'prod' }],
					['apps.environments.put', { appId, env: 'prod', environment: registration }],
				]
				for (const caller of ['agent', 'key'] as const) {
					for (const [method, input] of writes) {
						const answer = await call(w, caller, method, input)
						expect({ appId, caller, method, status: answer.status }).toEqual({ appId, caller, method, status: 403 })
						expect(answer.error?.message).toContain('environment `prod` starts protected')
						expect(JSON.stringify(answer)).not.toContain(SECRET)
					}
				}
				expect(await w.repositories.registry.listAppVars(appId)).toEqual([])
				expect(await w.repositories.registry.listAppSecrets(appId)).toEqual([])
				expect(await w.repositories.registry.getAppEnv(appId, 'prod')).toBeNull()
			}
			expect(await w.repositories.approvalRequests.listPending(10)).toEqual([])

			// An absent environment that does not start protected stays open to a key, and a person in the console writes either.
			const qa = { appId: 'memo', variable: { name: 'REGION', value: 'eu', env: 'qa' } }
			expect((await call(w, 'key', 'apps.variables.put', qa)).status).toBe(200)
			const prodVariable = { appId: 'memo', variable: { name: 'REGION', value: 'eu', env: 'prod' } }
			expect((await call(w, 'person', 'apps.variables.put', prodVariable)).status).toBe(200)
			expect((await w.repositories.registry.listAppVars('memo')).map((row) => row.env).sort()).toEqual(['prod', 'qa'])
		})

		test('refuse is a 403 naming the category, and nothing is asked or written', async () => {
			const w = await world()
			await policy(w, 'prod', { ...STRICT_POLICY, data: 'refuse' })
			const answer = await call(w, 'agent', 'data.backups.setSchedule', { appId: 'notes', env: 'prod', daily: false })
			expect(answer.status).toBe(403)
			expect(answer.error?.message).toContain('(data: refuse)')
			expect(await w.repositories.backups.getSchedule('notes', 'prod')).toBeNull()
			expect(await w.repositories.approvalRequests.listPending(10)).toEqual([])
		})

		test("off applies a secret, a trigger ref and the application's build at once, with the caller's own authority", async () => {
			const w = await world()
			await policy(w, 'prod', { ...STRICT_POLICY, secrets: 'off', registry: 'off' })
			expect((await call(w, 'agent', 'apps.secrets.put', putSecret('prod'))).status).toBe(200)
			expect(await secretValue(w, 'prod')).toBe(SECRET)
			const environment = {
				triggerRef: 'refs/heads/release',
				target: { provider: 'harbor', version: 1, payload: {} },
				artifact: { provider: 'harbor', version: 1, payload: {} },
			}
			expect((await call(w, 'key', 'apps.environments.put', { appId: 'notes', env: 'prod', environment })).status).toBe(200)
			expect((await w.repositories.registry.getAppEnv('notes', 'prod'))?.trigger_ref).toBe('refs/heads/release')
			expect((await call(w, 'key', 'apps.update', { appId: 'notes', app: { buildCmd: 'bun run build' } })).status).toBe(200)
			expect((await w.repositories.registry.getApp('notes'))?.build_cmd).toBe('bun run build')
			expect(await w.repositories.approvalRequests.listPending(10)).toEqual([])
		})

		test('a person in the console, and any caller on an unprotected environment, write directly', async () => {
			const w = await world()
			expect((await call(w, 'person', 'apps.secrets.put', putSecret('prod'))).status).toBe(200)
			expect(await secretValue(w, 'prod')).toBe(SECRET)
			expect((await call(w, 'agent', 'apps.secrets.put', putSecret('stage'))).status).toBe(200)
			expect(await secretValue(w, 'stage')).toBe(SECRET)
			await policy(w, 'prod', PERMISSIVE_POLICY)
			expect((await call(w, 'agent', 'apps.environments.rotateTokenKey', { appId: 'notes', env: 'prod' })).status).toBe(200)
			expect(await w.repositories.approvalRequests.listPending(10)).toEqual([])
		})
	})
}
