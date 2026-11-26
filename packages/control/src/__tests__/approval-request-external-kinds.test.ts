// ADR-0083 §8, step 5b: the request kinds whose write reaches outside Control's own rows, through the production registry,
// against SQLite always and Postgres when FABRIKA_TEST_POSTGRES_URL is set. Two provider shapes stand in for the shipped
// ones: one whose environments run behind their own object and keep secrets in Control's vault (Cloudflare's), and one
// that keeps secrets itself, prepares every registration and takes an environment offline at its namespace proxy
// (Zerops'). Each kind is asked for, approved and executed with its effect visible, closed stale when what it binds
// changed, rejected and expired with nothing applied, and an execution interrupted after its operation id was recorded
// lands in `unknown`, which the sweep settles both when the effect happened and when it did not.

import type { AuthContext } from '@fabrika/auth'
import {
	type DomainEvent,
	type OpsMaintenance,
	type OpsPublishedState,
	type OpsStateAck,
	type OpsStateRequest,
	type OpsView,
	permits,
	sha256Hex,
} from '@fabrika/auth-core'
import { CONTROL_ACTIONS } from '@fabrika/control-contract'
import { type DeployLocks, SqlDeployLocks, uuidv7 } from '@fabrika/platform'
import type { ControlProvider, JsonValue, ProviderManagedSecrets } from '@fabrika/provider-contract'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { ControlApiError } from '../api/domain'
import {
	type ApprovalRequestContext,
	createApprovalRequestUseCase,
	decideApprovalRequestUseCase,
	getApprovalRequestUseCase,
} from '../approval/requests/api'
import { sweepApprovalRequests } from '../approval/requests/execute'
import { requestSecretPurpose } from '../approval/requests/kinds/secrets'
import {
	advanceDataOperation,
	type OperationDeploys,
	type OpsAnswer,
	type OpsDataAnswer,
	type OpsFencedAnswer,
	type OpsInspection,
	type OpsTransport,
} from '../data-operations'
import { type ControlRepositories, createControlRepositories } from '../db'
import { appScope } from '../iam'
import { LEASE_TTL_MS, runLeaseKey } from '../lease'
import { Vault } from '../vault'
import { createHarness, harnessDatabase } from './helpers/harness'
import { createPostgres, hasPostgres, skipReason } from './helpers/postgres'
import { fakeControlProvider, TEST_PROVIDER_ID } from './helpers/provider'
import { testVaultKey } from './helpers/vault'

if (!hasPostgres) console.warn(`approval-request-external-kinds.test.ts Postgres half ${skipReason}`)

const ORIGIN = 'https://console.example.test'
/** A provider envelope as plain JSON, so it goes into a request's input as it is. */
type Envelope = { readonly provider: string; readonly version: number; readonly payload: { readonly [key: string]: JsonValue } }
const envelope = (payload: { readonly [key: string]: JsonValue }): Envelope => ({ provider: TEST_PROVIDER_ID, version: 1, payload })
function preparedPayload(payload: JsonValue): JsonValue {
	return typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? { ...payload, prepared: true } : payload
}
const TARGET = envelope({ service: 'notes-prod' })
const ARTIFACT = envelope({ build: 1 })
const T0 = 1_800_000_000
const HOUR = 3600
const SECRET = 'sk_live_very-secret-value-1234567890'
const OTHER = 'a-different-secret-value-0987654321'
const NAMESPACE = 'apps-prod'

interface Backend {
	readonly name: string
	readonly skip: boolean
	open(now: () => number): Promise<{ repositories: ControlRepositories; locks: DeployLocks; vault: Vault; close(): Promise<void> }>
}

const backends: readonly Backend[] = [
	{
		name: 'sqlite',
		skip: false,
		open: async (now) => {
			const harness = createHarness(now)
			const db = harnessDatabase(harness.repositories)
			return {
				repositories: harness.repositories,
				locks: new SqlDeployLocks(db),
				vault: await Vault.create(db, testVaultKey()),
				close: () => {
					harness.sqlite.close()
					return Promise.resolve()
				},
			}
		},
	},
	{
		name: 'postgres',
		skip: !hasPostgres,
		open: async (now) => {
			const fixture = await createPostgres('control_request_external_kinds')
			return {
				repositories: createControlRepositories(fixture.db, { now }),
				locks: new SqlDeployLocks(fixture.db),
				vault: await Vault.create(fixture.db, testVaultKey()),
				close: () => fixture.close(),
			}
		},
	},
]

interface Who {
	readonly console: boolean
	readonly id: string
	readonly label: string
	readonly actions: readonly string[]
	/** Where the actions hold; everywhere when absent. */
	readonly global?: boolean
}

const ACTIONS = [CONTROL_ACTIONS.SECRET_MANAGE, CONTROL_ACTIONS.APP_MANAGE, CONTROL_ACTIONS.DATA_MANAGE]
const BOB: Who = { console: true, id: 'p-bob', label: 'bob@example.test', actions: [CONTROL_ACTIONS.ACCESS_APPROVE, ...ACTIONS], global: true }
const AGENT: Who = { console: false, id: 'p-ada', label: 'ada@example.test', actions: ACTIONS, global: true }

/** Where an interrupted effect stops: before the provider or the object applied it, or after, its answer lost. */
type Interruption = 'before' | 'after' | null

/** The environment's object as the ops channel reaches it: it applies every transition, unless an interruption is set. */
class FakeObject implements OpsTransport {
	published: OpsPublishedState | null = null
	readonly modes: string[] = []
	/** The next `state` request throws, before or after the object applied it. */
	interruptState: Interruption = null
	/** The next `inspect` throws: no operation is recorded. */
	interruptInspect = false

	inspect(): Promise<OpsAnswer<OpsInspection>> {
		if (this.interruptInspect) {
			this.interruptInspect = false
			return Promise.reject(new Error('the channel dropped the inspection'))
		}
		const maintenance: OpsMaintenance = this.published === null
			? { mode: 'open', generation: null, published: false }
			: { ...this.published, published: true }
		const view: OpsView = {
			release: '0.9.0',
			maintenance,
			database: { sizeBytes: 4096, tables: [] },
			migrations: [],
			scheduler: { alarm: null },
			jobs: [],
			files: [],
			webhooks: [],
			bootFailure: null,
		}
		return Promise.resolve({ kind: 'ok', value: { content: false, view } })
	}

	state(_target: unknown, request: OpsStateRequest): Promise<OpsFencedAnswer<OpsStateAck>> {
		const interruption = this.interruptState
		this.interruptState = null
		if (interruption === 'before') return Promise.reject(new Error('the channel dropped the request'))
		this.modes.push(request.mode)
		this.published = { generation: request.generation, mode: request.mode }
		if (interruption === 'after') return Promise.reject(new Error('the channel dropped the answer'))
		return Promise.resolve({ kind: 'ok', value: { generation: request.generation, mode: request.mode, stillRunning: 0 } })
	}

	migrate(): Promise<OpsFencedAnswer<never>> {
		return Promise.resolve({ kind: 'unavailable', reason: 'invalid_answer' })
	}

	export(): Promise<OpsDataAnswer<never>> {
		return Promise.resolve({ kind: 'unavailable', reason: 'invalid_answer' })
	}

	import(): Promise<OpsDataAnswer<never>> {
		return Promise.resolve({ kind: 'unavailable', reason: 'invalid_answer' })
	}

	restore(): Promise<OpsDataAnswer<never>> {
		return Promise.resolve({ kind: 'unavailable', reason: 'invalid_answer' })
	}
}

/** A provider's secret store: values by environment and name, each with a version that moves on every write. */
interface SecretStore {
	readonly values: Map<string, { value: string; version: number }>
	interrupt: Interruption
	secrets: ProviderManagedSecrets
}

function secretStore(): SecretStore {
	const values = new Map<string, { value: string; version: number }>()
	let writes = 0
	const keyOf = (input: { environment: { appId: string; env: string }; name: string }) =>
		`${input.environment.appId}/${input.environment.env}/${input.name}`
	const store: SecretStore = {
		values,
		interrupt: null,
		secrets: {
			put: (input) => {
				const interruption = store.interrupt
				store.interrupt = null
				if (interruption === 'before') return Promise.reject(new Error('the provider dropped the request'))
				values.set(keyOf(input), { value: input.value, version: ++writes })
				if (interruption === 'after') return Promise.reject(new Error('the provider dropped the answer'))
				return Promise.resolve({ valueRef: `harbor:${keyOf(input)}` })
			},
			delete: (input) => {
				const interruption = store.interrupt
				store.interrupt = null
				if (interruption === 'before') return Promise.reject(new Error('the provider dropped the request'))
				values.delete(keyOf(input))
				if (interruption === 'after') return Promise.reject(new Error('the provider dropped the answer'))
				return Promise.resolve()
			},
			version: (input) => {
				const found = values.get(keyOf(input))
				return Promise.resolve(found === undefined ? null : `v${found.version}`)
			},
		},
	}
	return store
}

/** The provider that keeps secrets, prepares registrations and takes an environment offline at its namespace proxy. */
function keepingProvider(store: SecretStore, prepared: { count: number; interrupt: boolean }): ControlProvider {
	return {
		...fakeControlProvider,
		secrets: store.secrets,
		namespaces: {
			normalize: (namespace) => namespace,
			namespaceResourceClaims: (namespace) => [`service:proxy:${namespace.id}`],
			registrationResourceClaims: () => [],
			provision: (input) => Promise.resolve(input.namespace),
			reconcile: (input) => Promise.resolve(input.namespace),
			republish: (input) => Promise.resolve({ namespace: input.namespace, settled: true }),
			assertSuspendable: () => {},
			prepareRegistration: (input) => {
				if (prepared.interrupt) {
					prepared.interrupt = false
					return Promise.reject(new Error('the provider dropped the preparation'))
				}
				prepared.count++
				const environment = input.registration.environment
				return Promise.resolve({
					...input.registration,
					environment: { ...environment, target: { ...environment.target, payload: preparedPayload(environment.target.payload) } },
				})
			},
		},
	}
}

type Shape = 'object' | 'keeping'

for (const backend of backends) {
	describe.skipIf(backend.skip)(`writes with an external effect as approval requests (${backend.name})`, () => {
		let closing: (() => Promise<void>) | null = null
		afterEach(async () => {
			const close = closing
			closing = null
			await close?.()
		})

		interface World {
			readonly shape: Shape
			readonly db: ControlRepositories
			readonly locks: DeployLocks
			readonly vault: Vault
			readonly audits: DomainEvent[]
			readonly object: FakeObject
			readonly store: SecretStore
			readonly prepared: { count: number; interrupt: boolean }
			/** The namespaces the proxy was asked to republish; set `interruptRepublish` to fail the next one. */
			readonly republished: string[]
			interruptRepublish: boolean
			readonly provider: ControlProvider
			readonly deploys: OperationDeploys
			now: number
		}

		async function world(shape: Shape): Promise<World> {
			const clock = { now: T0 }
			const opened = await backend.open(() => clock.now)
			closing = opened.close
			const store = secretStore()
			const prepared = { count: 0, interrupt: false }
			const w: World = {
				shape,
				db: opened.repositories,
				locks: opened.locks,
				vault: opened.vault,
				audits: [],
				object: new FakeObject(),
				store,
				prepared,
				republished: [],
				interruptRepublish: false,
				provider: shape === 'object' ? fakeControlProvider : keepingProvider(store, prepared),
				deploys: { servesDataOperations: () => Promise.resolve(true), run: () => Promise.resolve(), finishRun: () => Promise.resolve() },
				get now() {
					return clock.now
				},
				set now(value) {
					clock.now = value
				},
			}
			await w.db.registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes', defaultBranch: 'main' })
			if (shape === 'keeping') {
				await w.db.registry.createDeploymentNamespaceWithResourceClaims({
					id: NAMESPACE,
					env: 'prod',
					provider: TEST_PROVIDER_ID,
					exclusiveAppId: null,
					providerTargetJson: JSON.stringify(envelope({})),
					state: 'ready',
				}, [`service:proxy:${NAMESPACE}`])
			}
			await w.db.registry.upsertAppEnv({
				appId: 'notes',
				env: 'prod',
				domain: 'notes.example.com',
				namespaceId: shape === 'keeping' ? NAMESPACE : null,
				provider: TEST_PROVIDER_ID,
				providerTargetJson: JSON.stringify(TARGET),
				providerArtifactJson: JSON.stringify(ARTIFACT),
			})
			return w
		}

		function auth(w: World, who: Who): AuthContext {
			const grants = who.actions.map((action) => ({ action, scope: who.global === true ? null : appScope('notes'), source: 'grant' as const }))
			return {
				ok: true,
				principal: { id: who.id, type: 'user', label: who.label },
				...(who.console ? {} : {
					oauth: { app: 'vozka', clientId: 'https://agent.example.test/client.json', scopes: ['operate'], grantId: 'grant-1', tokenId: 't' },
				}),
				can: (action, scope) => permits(grants, action, scope),
				scopedTo: () => null,
				audit: (event) => {
					w.audits.push(event)
					return Promise.resolve()
				},
			}
		}

		function context(w: World, who: Who): ApprovalRequestContext {
			const headers: Record<string, string> = { 'Sec-Fetch-Site': 'same-origin' }
			if (who.console) headers['X-Fabrika-Token'] = 'console'
			else headers.Authorization = 'Bearer px_test'
			const request = new Request(`${ORIGIN}/api/rpc`, { method: 'POST', headers })
			return {
				repositories: w.db,
				reservedHosts: [],
				provider: w.provider,
				vault: () => Promise.resolve(w.vault),
				auth: auth(w, who),
				admission: { request },
				lock: w.locks,
				maintenance: { lock: w.locks, ops: w.object },
				deploys: () => Promise.resolve(w.deploys),
				namespaceProxyChanged: (namespaceId) => {
					if (w.interruptRepublish) {
						w.interruptRepublish = false
						return Promise.reject(new Error('the proxy build did not start'))
					}
					w.republished.push(namespaceId)
					return Promise.resolve()
				},
				consoleOrigin: ORIGIN,
				now: () => w.now,
			}
		}

		const ask = (w: World, kind: string, input: JsonValue, who: Who = AGENT) => createApprovalRequestUseCase(context(w, who), { kind, input })

		async function decide(w: World, id: string, decision: 'approve' | 'reject', who: Who = BOB) {
			const request = await getApprovalRequestUseCase(context(w, who), id)
			return decideApprovalRequestUseCase(context(w, who), { id, decision, inputDigest: request.inputDigest })
		}

		const sweep = (w: World, withProvider = true) =>
			sweepApprovalRequests({
				repositories: w.db,
				lock: w.locks,
				vault: () => Promise.resolve(w.vault),
				...(withProvider ? { provider: w.provider } : {}),
			})

		const status = async (promise: Promise<unknown>): Promise<{ status: number; message: string }> => {
			try {
				await promise
				return { status: 200, message: '' }
			} catch (error) {
				if (error instanceof ControlApiError) return { status: error.httpStatus, message: error.message }
				throw error
			}
		}

		const row = async (w: World, id: string) => {
			const found = await w.db.approvalRequests.get(id)
			if (found === null) throw new Error(`no request ${id}`)
			return found
		}

		const appEnv = async (w: World) => {
			const found = await w.db.registry.getAppEnv('notes', 'prod')
			if (found === null) throw new Error('the environment is missing')
			return found
		}

		const operations = async (w: World) => [...(await w.db.dataOperations.listForEnvironment('notes', 'prod', { limit: 10 }))]

		async function sealedExists(w: World, id: string): Promise<boolean> {
			const sealed: unknown = JSON.parse((await row(w, id)).input_json)
			const ref = typeof sealed === 'object' && sealed !== null ? Reflect.get(Reflect.get(sealed, 'sealed'), 'ref') : null
			if (typeof ref !== 'string') throw new Error('the request holds no sealed reference')
			return (await w.vault.sealedVersion(ref, requestSecretPurpose(id))) !== null
		}

		const putSecret = (value = SECRET) => ({ appId: 'notes', secret: { name: 'API_KEY', value, env: 'prod' } })
		const held = (w: World) => w.store.values.get('notes/prod/API_KEY')?.value ?? null

		describe('a secret the provider keeps', () => {
			test('is sealed while it waits and put to the provider on approval; the value reaches no row, page, log or audit', async () => {
				const w = await world('keeping')
				const logged: string[] = []
				const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
					spyOn(console, level).mockImplementation((...args: unknown[]) => {
						logged.push(args.map(String).join(' '))
					})
				)
				try {
					const created = await ask(w, 'apps.secrets.put', putSecret())
					expect(created.fingerprint).toBe(sha256Hex(SECRET).slice(0, 8))
					expect((await row(w, created.id)).input_json).not.toContain(SECRET)
					expect(held(w)).toBeNull()
					expect(JSON.stringify(await getApprovalRequestUseCase(context(w, BOB), created.id))).not.toContain(SECRET)

					expect(await decide(w, created.id, 'approve')).toMatchObject({ state: 'executed', result: { name: 'API_KEY', env: 'prod' } })
					expect(held(w)).toBe(SECRET)
					expect((await w.db.registry.listAppSecrets('notes')).map((secret) => [secret.env, secret.name, secret.value_ref])).toEqual([
						['prod', 'API_KEY', 'harbor:notes/prod/API_KEY'],
					])
					expect(await sealedExists(w, created.id)).toBe(false)
				} finally {
					for (const spy of spies) spy.mockRestore()
				}
				expect(JSON.stringify(w.audits)).not.toContain(SECRET)
				expect(logged.join('\n')).not.toContain(SECRET)
			})

			test("a write at the provider since the request moves the provider's version, which closes it stale", async () => {
				const w = await world('keeping')
				await decide(w, (await ask(w, 'apps.secrets.put', putSecret(OTHER))).id, 'approve')
				const { id } = await ask(w, 'vault.rotate', { appId: 'notes', name: 'API_KEY', env: 'prod', value: SECRET })
				await w.store.secrets.put({ environment: { appId: 'notes', env: 'prod', target: TARGET, artifact: ARTIFACT }, name: 'API_KEY', value: OTHER })
				expect((await decide(w, id, 'approve')).state).toBe('stale')
				expect(held(w)).toBe(OTHER)
				expect(await sealedExists(w, id)).toBe(false)
			})

			test('a refusal and an expiry delete the sealed copy and put nothing', async () => {
				const w = await world('keeping')
				const refused = await ask(w, 'apps.secrets.put', putSecret())
				const expiring = await ask(w, 'vault.set', { appId: 'notes', name: 'OTHER_KEY', env: 'prod', value: SECRET })
				expect((await decide(w, refused.id, 'reject')).state).toBe('rejected')
				w.now += 24 * HOUR
				expect((await sweep(w)).expired).toBe(1)
				expect((await row(w, expiring.id)).state).toBe('expired')
				expect(await sealedExists(w, refused.id)).toBe(false)
				expect(await sealedExists(w, expiring.id)).toBe(false)
				expect(w.store.values.size).toBe(0)
			})

			test('a delete removes the value at the provider, then the row', async () => {
				const w = await world('keeping')
				const put = await ask(w, 'apps.secrets.put', putSecret())
				await decide(w, put.id, 'approve')
				const removed = await ask(w, 'vault.delete', { appId: 'notes', name: 'API_KEY', env: 'prod' })
				expect((await decide(w, removed.id, 'approve')).state).toBe('executed')
				expect(held(w)).toBeNull()
				expect(await w.db.registry.listAppSecrets('notes')).toEqual([])
			})

			test('the all-environments layer is refused when it is asked for, since the provider keeps values per environment', async () => {
				const w = await world('keeping')
				const refused = await status(ask(w, 'apps.secrets.put', { appId: 'notes', secret: { name: 'API_KEY', value: SECRET, env: null } }))
				expect(refused).toEqual({ status: 400, message: expect.stringContaining('explicit env') })
			})

			test('a provider that cannot report a version refuses the request, since an interrupted put could not be followed', async () => {
				const w = await world('keeping')
				const { version: _version, ...withoutVersion } = w.store.secrets
				const refused = await status(createApprovalRequestUseCase({ ...context(w, AGENT), provider: { ...w.provider, secrets: withoutVersion } }, {
					kind: 'apps.secrets.put',
					input: putSecret(),
				}))
				expect(refused.status).toBe(400)
				expect(refused.message).toContain('version')
			})

			test('an interrupted put lands in unknown; the sweep settles it by the provider version, both when it landed and when it did not', async () => {
				const w = await world('keeping')
				await decide(w, (await ask(w, 'apps.secrets.put', putSecret(OTHER))).id, 'approve')
				const landed = await ask(w, 'vault.rotate', { appId: 'notes', name: 'API_KEY', env: 'prod', value: SECRET })
				w.store.interrupt = 'after'
				expect(await decide(w, landed.id, 'approve')).toMatchObject({ state: 'unknown', operationId: expect.any(String) })
				expect(held(w)).toBe(SECRET)

				const lost = await ask(w, 'vault.set', { appId: 'notes', name: 'LOST_KEY', env: 'prod', value: OTHER })
				w.store.interrupt = 'before'
				expect((await decide(w, lost.id, 'approve')).state).toBe('unknown')

				// Without the provider the sweep cannot read the version back, so both stay unknown, their copies kept.
				expect((await sweep(w, false)).settled).toBe(0)
				expect(await sealedExists(w, landed.id)).toBe(true)

				expect((await sweep(w)).settled).toBe(2)
				expect(await row(w, landed.id)).toMatchObject({ state: 'executed' })
				expect(await row(w, lost.id)).toMatchObject({ state: 'failed', error: expect.stringContaining('did not land') })
				expect(w.store.values.has('notes/prod/LOST_KEY')).toBe(false)
				expect(await sealedExists(w, landed.id)).toBe(false)
				expect(await sealedExists(w, lost.id)).toBe(false)
			})

			test('a put that landed at the provider and not in Control is settled failed, saying so', async () => {
				const w = await world('keeping')
				const { id } = await ask(w, 'apps.secrets.put', putSecret())
				w.store.interrupt = 'after'
				await decide(w, id, 'approve')
				// The provider took it; Control never recorded the row (its write after the provider's is what was lost).
				expect(await w.db.registry.listAppSecrets('notes')).toEqual([])
				expect((await sweep(w)).settled).toBe(1)
				expect(await row(w, id)).toMatchObject({ state: 'failed', error: expect.stringContaining('did not record') })
			})

			test('an interrupted delete is settled by the row and the provider version', async () => {
				const w = await world('keeping')
				await decide(w, (await ask(w, 'apps.secrets.put', putSecret())).id, 'approve')
				const gone = await ask(w, 'apps.secrets.delete', { appId: 'notes', name: 'API_KEY', env: 'prod' })
				w.store.interrupt = 'after'
				expect((await decide(w, gone.id, 'approve')).state).toBe('unknown')
				expect((await sweep(w)).settled).toBe(1)
				expect(await row(w, gone.id)).toMatchObject({ state: 'failed', error: expect.stringContaining('still lists') })

				await w.store.secrets.put({ environment: { appId: 'notes', env: 'prod', target: TARGET, artifact: ARTIFACT }, name: 'API_KEY', value: SECRET })
				const kept = await ask(w, 'apps.secrets.delete', { appId: 'notes', name: 'API_KEY', env: 'prod' })
				w.store.interrupt = 'before'
				expect((await decide(w, kept.id, 'approve')).state).toBe('unknown')
				expect((await sweep(w)).settled).toBe(1)
				expect(await row(w, kept.id)).toMatchObject({ state: 'failed', error: expect.stringContaining('did not apply') })
				expect(held(w)).toBe(SECRET)
			})
		})

		describe('apps.environments.put', () => {
			const put = (environment: Record<string, JsonValue>) => ({
				appId: 'notes',
				env: 'prod',
				environment: { target: TARGET, artifact: ARTIFACT, namespaceId: NAMESPACE, ...environment },
			})

			test('takes the whole body and runs it through the provider preparation as the approver, shown before → after', async () => {
				const w = await world('keeping')
				const next = envelope({ service: 'notes-prod-2' })
				const { id } = await ask(w, 'apps.environments.put', put({ domain: 'notes.example.com', target: next, triggerRef: 'main' }))
				expect(w.prepared.count).toBe(0)
				const facts = (await getApprovalRequestUseCase(context(w, BOB), id)).description.facts
				expect(facts).toContainEqual({ label: 'Trigger ref', value: { text: 'none → refs/heads/main', agent: true } })
				expect(facts.find((fact) => fact.label === 'Target')?.value.text).toContain('→')
				expect(facts.find((fact) => fact.label === 'Domain')).toBeUndefined()
				const moved = await ask(w, 'apps.environments.put', put({ domain: 'docs.example.com' }))

				expect((await decide(w, id, 'approve')).state).toBe('executed')
				expect(w.prepared.count).toBe(1)
				const stored = await appEnv(w)
				expect(stored.trigger_ref).toBe('refs/heads/main')
				expect(JSON.parse(stored.provider_target_json)).toEqual({ ...next, payload: { service: 'notes-prod-2', prepared: true } })
				// The trigger ref and the target are not in the namespace proxy's manifest; the domain is.
				expect(w.republished).toEqual([])
				expect((await decide(w, moved.id, 'approve')).state).toBe('stale')
				const domain = await ask(w, 'apps.environments.put', put({ domain: 'docs.example.com', target: next, triggerRef: 'main' }))
				expect((await decide(w, domain.id, 'approve')).state).toBe('executed')
				expect(w.republished).toEqual([NAMESPACE])
			})

			test('an absent domain or trigger ref clears it, as the put does, and the page says so', async () => {
				const w = await world('object')
				const environment = { target: TARGET, artifact: ARTIFACT }
				const { id } = await ask(w, 'apps.environments.put', { appId: 'notes', env: 'prod', environment })
				expect((await getApprovalRequestUseCase(context(w, BOB), id)).description.facts).toContainEqual({
					label: 'Domain',
					value: { text: 'notes.example.com → none', agent: true },
				})
				expect((await decide(w, id, 'approve')).state).toBe('executed')
				expect((await appEnv(w)).domain).toBeNull()
			})

			test('a write of the environment since the request closes it stale; a refusal and an expiry change nothing', async () => {
				const w = await world('object')
				const environment = { target: TARGET, artifact: ARTIFACT, domain: 'notes.example.com' }
				const stale = await ask(w, 'apps.environments.put', { appId: 'notes', env: 'prod', environment: { ...environment, triggerRef: 'main' } })
				const refused = await ask(w, 'apps.environments.put', { appId: 'notes', env: 'prod', environment: { ...environment, triggerRef: 'next' } })
				const expiring = await ask(w, 'apps.environments.put', { appId: 'notes', env: 'prod', environment: { ...environment, triggerRef: 'late' } })
				await w.db.registry.upsertAppEnv({
					appId: 'notes',
					env: 'prod',
					domain: 'notes.example.com',
					namespaceId: null,
					provider: TEST_PROVIDER_ID,
					providerTargetJson: JSON.stringify(envelope({ service: 'moved' })),
					providerArtifactJson: JSON.stringify(ARTIFACT),
				})
				expect((await decide(w, stale.id, 'approve')).state).toBe('stale')
				expect((await decide(w, refused.id, 'reject')).state).toBe('rejected')
				w.now += 24 * HOUR
				expect((await sweep(w)).expired).toBe(1)
				expect((await row(w, expiring.id)).state).toBe('expired')
				expect((await appEnv(w)).trigger_ref).toBeNull()
			})

			test('a new environment is never requested: it has nowhere to wait', async () => {
				const w = await world('object')
				const refused = await status(ask(w, 'apps.environments.put', { appId: 'notes', env: 'qa', environment: { target: TARGET, artifact: ARTIFACT } }))
				expect(refused.status).toBe(404)
			})

			test('an interrupted put is settled by the generation and the fields it writes', async () => {
				const w = await world('keeping')
				const lost = await ask(w, 'apps.environments.put', put({ domain: 'notes.example.com', triggerRef: 'main' }))
				w.prepared.interrupt = true
				expect((await decide(w, lost.id, 'approve')).state).toBe('unknown')
				expect((await sweep(w)).settled).toBe(1)
				expect(await row(w, lost.id)).toMatchObject({ state: 'failed' })

				const landed = await ask(w, 'apps.environments.put', put({ domain: 'docs.example.com', triggerRef: 'main' }))
				w.interruptRepublish = true
				expect((await decide(w, landed.id, 'approve')).state).toBe('unknown')
				expect((await sweep(w)).settled).toBe(1)
				expect(await row(w, landed.id)).toMatchObject({ state: 'executed' })
				expect((await appEnv(w)).trigger_ref).toBe('refs/heads/main')
			})
		})

		describe('apps.update of the repository and its GitHub binding', () => {
			test('needs global app.manage of the requester and of the approver, and is shown before → after', async () => {
				const w = await world('object')
				const atApp: Who = { ...AGENT, global: false }
				const refused = await status(ask(w, 'apps.update', { appId: 'notes', app: { repoUrl: 'github.com/acme/notes-next' } }, atApp))
				expect(refused).toEqual({ status: 403, message: expect.stringContaining('global app.manage') })
				// The build fields alone keep the route's scope.
				expect((await ask(w, 'apps.update', { appId: 'notes', app: { buildCmd: 'make' } }, atApp)).state).toBe('pending')

				const { id } = await ask(w, 'apps.update', { appId: 'notes', app: { repoUrl: 'github.com/acme/notes-next', githubInstallationId: null } })
				expect((await getApprovalRequestUseCase(context(w, BOB), id)).description.facts).toContainEqual({
					label: 'Repository',
					value: { text: 'github.com/acme/notes → github.com/acme/notes-next', agent: true },
				})
				const approverAtApp: Who = { ...BOB, id: 'p-cy', global: false }
				expect((await status(decide(w, id, 'approve', approverAtApp))).status).toBe(403)
				expect((await decide(w, id, 'approve')).state).toBe('executed')
				expect((await w.db.registry.getApp('notes'))?.repo_url).toBe('github.com/acme/notes-next')
			})

			test('a repository moved since the request closes it stale', async () => {
				const w = await world('object')
				const { id } = await ask(w, 'apps.update', { appId: 'notes', app: { repoUrl: 'github.com/acme/notes-next' } })
				await w.db.registry.updateApp('notes', { repoUrl: 'github.com/acme/elsewhere' })
				expect((await decide(w, id, 'approve')).state).toBe('stale')
				expect((await w.db.registry.getApp('notes'))?.repo_url).toBe('github.com/acme/elsewhere')
			})
		})

		describe('suspend and resume', () => {
			test("behind its own object: the request's operation takes the object to closed, and resume returns it", async () => {
				const w = await world('object')
				const suspended = await ask(w, 'apps.environments.suspend', { appId: 'notes', env: 'prod' })
				const decided = await decide(w, suspended.id, 'approve')
				expect(decided).toMatchObject({ state: 'executed', operationId: expect.any(String) })
				expect(w.object.modes).toEqual(['closed'])
				expect(await operations(w)).toMatchObject([{ id: decided.operationId, kind: 'maintenance', target_mode: 'closed', state: 'succeeded' }])
				expect((await appEnv(w)).suspended_at).toEqual(expect.any(Number))

				const resumed = await ask(w, 'apps.environments.resume', { appId: 'notes', env: 'prod' })
				expect((await decide(w, resumed.id, 'approve')).state).toBe('executed')
				expect(w.object.modes).toEqual(['closed', 'open'])
				expect((await appEnv(w)).suspended_at).toBeNull()
			})

			test('behind a namespace proxy: the registry records it and the proxy is republished', async () => {
				const w = await world('keeping')
				const { id } = await ask(w, 'apps.environments.suspend', { appId: 'notes', env: 'prod' })
				expect((await decide(w, id, 'approve')).state).toBe('executed')
				expect((await appEnv(w)).suspended_at).toEqual(expect.any(Number))
				expect(w.republished).toEqual([NAMESPACE])
			})

			test('a suspension since the request closes a resume stale; a refusal and an expiry change nothing', async () => {
				const w = await world('keeping')
				await decide(w, (await ask(w, 'apps.environments.suspend', { appId: 'notes', env: 'prod' })).id, 'approve')
				const stale = await ask(w, 'apps.environments.resume', { appId: 'notes', env: 'prod' })
				const refused = await ask(w, 'apps.environments.resume', { appId: 'notes', env: 'prod' })
				const expiring = await ask(w, 'apps.environments.resume', { appId: 'notes', env: 'prod' })
				await w.db.registry.setAppEnvSuspension('notes', 'prod', null, (await appEnv(w)).suspended_at)
				await w.db.registry.setAppEnvSuspension('notes', 'prod', { at: T0 + 5, fromMode: null }, null)
				expect((await decide(w, stale.id, 'approve')).state).toBe('stale')
				expect((await decide(w, refused.id, 'reject')).state).toBe('rejected')
				w.now += 24 * HOUR
				expect((await sweep(w)).expired).toBe(1)
				expect((await row(w, expiring.id)).state).toBe('expired')
				expect((await appEnv(w)).suspended_at).toBe(T0 + 5)
			})

			test("an interrupted suspend follows the object's operation; one that never reached the object is settled failed", async () => {
				const w = await world('object')
				const landed = await ask(w, 'apps.environments.suspend', { appId: 'notes', env: 'prod' })
				w.object.interruptState = 'after'
				const decided = await decide(w, landed.id, 'approve')
				expect(decided.state).toBe('unknown')
				// The operation is still running at its step: the request waits for it.
				expect((await sweep(w)).settled).toBe(0)
				expect((await row(w, landed.id)).state).toBe('unknown')
				// The maintenance pass carries the operation on, and the next sweep settles the request by it.
				await advanceDataOperation({ repositories: w.db, lock: w.locks, ops: w.object }, decided.operationId ?? '')
				expect((await sweep(w)).settled).toBe(1)
				expect((await row(w, landed.id)).state).toBe('executed')
				expect(w.object.published?.mode).toBe('closed')

				const resumed = await ask(w, 'apps.environments.resume', { appId: 'notes', env: 'prod' })
				w.object.interruptInspect = true
				expect((await decide(w, resumed.id, 'approve')).state).toBe('unknown')
				expect((await sweep(w)).settled).toBe(1)
				expect(await row(w, resumed.id)).toMatchObject({ state: 'failed', error: expect.stringContaining('no operation') })
				expect(w.object.published?.mode).toBe('closed')
			})
			test('an interrupted suspend behind a namespace proxy is settled by the suspension the registry recorded', async () => {
				const w = await world('keeping')
				const landed = await ask(w, 'apps.environments.suspend', { appId: 'notes', env: 'prod' })
				w.interruptRepublish = true
				expect((await decide(w, landed.id, 'approve')).state).toBe('unknown')
				// Without the provider the sweep cannot tell a proxy from an object, so the request waits.
				expect((await sweep(w, false)).settled).toBe(0)
				expect((await sweep(w)).settled).toBe(1)
				expect((await row(w, landed.id)).state).toBe('executed')
				expect((await appEnv(w)).suspended_at).toEqual(expect.any(Number))
			})
		})

		describe('data operations', () => {
			async function succeededRun(w: World): Promise<void> {
				const id = uuidv7()
				await w.db.runs.createRun({ id, appId: 'notes', env: 'prod', ref: 'refs/heads/main', trigger: 'manual', actor: 'user:test' })
				const holder = uuidv7()
				expect(await w.locks.acquire(runLeaseKey('notes', 'prod'), holder, LEASE_TTL_MS)).toBe(true)
				const fence = () => ({ holder, nowMs: Date.now() })
				expect(await w.db.runs.markRunStarted(id, `logs/${id}`, fence())).toBe(true)
				expect(await w.db.runs.setRunCommit(id, 'a'.repeat(40), fence())).toBe(true)
				// A deploy records whether its version holds the barrier; a dry run records nothing, and is never redeployed.
				expect(await w.db.runs.recordRunMigrationBarrier(id, true, fence())).toBe(true)
				expect(await w.db.runs.markRunFinished(id, 'succeeded', 0, fence())).toBe(true)
				await w.locks.release(runLeaseKey('notes', 'prod'), holder)
			}

			test('a maintenance mode runs as the operation the request recorded', async () => {
				const w = await world('object')
				const { id } = await ask(w, 'data.start', { appId: 'notes', env: 'prod', kind: 'maintenance', mode: 'read-only' })
				const decided = await decide(w, id, 'approve')
				expect(decided).toMatchObject({ state: 'executed', result: { id: decided.operationId, state: 'succeeded', targetMode: 'read-only' } })
				expect(w.object.modes).toEqual(['read-only'])
			})

			test('a restore is recorded for the maintenance pass under the request operation, bound to the object list', async () => {
				const w = await world('object')
				await succeededRun(w)
				const { id } = await ask(w, 'data.start', { appId: 'notes', env: 'prod', kind: 'restore', at: '2026-01-01T00:00:00.000Z' })
				const page = await getApprovalRequestUseCase(context(w, BOB), id)
				expect(page.description.facts).toContainEqual({ label: 'Serving object', value: { text: 'application', agent: false } })
				const decided = await decide(w, id, 'approve')
				expect(decided).toMatchObject({ state: 'executed', result: { id: decided.operationId, kind: 'restore', state: 'running' } })
			})

			test('a change of the serving object since the request closes a restore stale', async () => {
				const w = await world('object')
				await succeededRun(w)
				const { id } = await ask(w, 'data.start', { appId: 'notes', env: 'prod', kind: 'restore', at: '2026-01-01T00:00:00.000Z' })
				const holder = uuidv7()
				expect(await w.locks.acquire(runLeaseKey('notes', 'prod'), holder, LEASE_TTL_MS)).toBe(true)
				expect(
					await w.db.applicationObjects.set('notes', 'prod', { serving: 'application-x', listed: ['application', 'application-x', 'rehearsal'] }, {
						holder,
						nowMs: Date.now(),
					}),
				).toBe(true)
				await w.locks.release(runLeaseKey('notes', 'prod'), holder)
				expect((await decide(w, id, 'approve')).state).toBe('stale')
				expect(await operations(w)).toEqual([])
			})

			test('a recovery of a stuck operation, bound to its state; a backup is refused when it is asked for', async () => {
				const w = await world('object')
				w.object.interruptState = 'before'
				const stuck = await decide(w, (await ask(w, 'data.start', { appId: 'notes', env: 'prod', kind: 'maintenance', mode: 'closed' })).id, 'approve')
				expect(stuck.state).toBe('unknown')
				// The operation never reached the object and stays running; the sweep settles the request by it.
				expect((await sweep(w)).settled).toBe(1)
				const [running] = await operations(w)
				expect(running).toMatchObject({ id: stuck.operationId, state: 'running' })

				const { id } = await ask(w, 'data.recover', { appId: 'notes', env: 'prod', operationId: running?.id ?? '', resolution: 'open' })
				const decided = await decide(w, id, 'approve')
				expect(decided).toMatchObject({ state: 'executed', result: { id: decided.operationId, kind: 'recovery', state: 'succeeded' } })
				expect(w.object.published?.mode).toBe('open')

				const backup = await status(ask(w, 'data.start', { appId: 'notes', env: 'prod', kind: 'backup' }))
				expect(backup.status).toBe(501)
			})

			test('a refusal and an expiry start nothing', async () => {
				const w = await world('object')
				const refused = await ask(w, 'data.start', { appId: 'notes', env: 'prod', kind: 'maintenance', mode: 'closed' })
				const expiring = await ask(w, 'data.start', { appId: 'notes', env: 'prod', kind: 'maintenance', mode: 'read-only' })
				expect((await decide(w, refused.id, 'reject')).state).toBe('rejected')
				w.now += 24 * HOUR
				expect((await sweep(w)).expired).toBe(1)
				expect((await row(w, expiring.id)).state).toBe('expired')
				expect(await operations(w)).toEqual([])
				expect(w.object.modes).toEqual([])
			})

			test('an interrupted start is settled by whether its operation was recorded', async () => {
				const w = await world('object')
				const lost = await ask(w, 'data.start', { appId: 'notes', env: 'prod', kind: 'maintenance', mode: 'read-only' })
				w.object.interruptInspect = true
				expect((await decide(w, lost.id, 'approve')).state).toBe('unknown')
				expect((await sweep(w)).settled).toBe(1)
				expect(await row(w, lost.id)).toMatchObject({ state: 'failed', error: expect.stringContaining('no operation') })
				expect(await operations(w)).toEqual([])
			})
		})
	})
}
