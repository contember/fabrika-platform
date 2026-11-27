// `apps.environments.suspend` and `resume`, through the RPC router against the real schema: behind a namespace proxy the
// member reaches the provider's republish flagged, and is refused where the pinned proxy cannot read the flag; without
// one the environment's object goes into maintenance `closed` and returns to the mode it was in.

import type { AuthContext, DomainEvent } from '@fabrika/auth'
import type { OpsMaintenance, OpsPublishedState, OpsStateAck, OpsStateRequest, OpsView } from '@fabrika/auth-core'
import { CONTROL_ACTIONS, STRICT_POLICY } from '@fabrika/control-contract'
import { type ControlProvider, ProviderNamespaceError, type ProviderNamespaceMember } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { republishNamespace } from '../api/namespaces'
import { storedPolicy } from '../approval/categories'
import { type OpsAnswer, type OpsDataAnswer, type OpsFencedAnswer, type OpsInspection, type OpsTransport, startMaintenance } from '../data-operations'
import { runLeaseKey } from '../lease'
import type { ControlRpcDeps } from '../services'
import { createHarness } from './helpers/harness'
import { authWithPermissions } from './helpers/iam'
import { fixtureProtect, makeFakeLock } from './helpers/lock'
import { fakeControlProvider, providerEnvironment, TEST_PROVIDER_ID } from './helpers/provider'
import { rpcRequest, rpcResult } from './helpers/rpc'

const APP = 'notes'
const ENV = 'prod'
const TARGET = { appId: APP, env: ENV }

/** Every principal action allowed, every audit event kept. */
function auditingAuth(audits: DomainEvent[]): AuthContext {
	return {
		ok: true,
		principal: { id: 'operator', type: 'user', label: 'operator@test' },
		can: () => true,
		scopedTo: () => null,
		audit: (event) => {
			audits.push(event)
			return Promise.resolve()
		},
	}
}

/** The object as the ops channel reaches it: it applies every transition it is sent and acknowledges it. */
class FakeObject implements OpsTransport {
	published: OpsPublishedState | null = null
	readonly modes: string[] = []

	inspect(): Promise<OpsAnswer<OpsInspection>> {
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
		this.modes.push(request.mode)
		this.published = { generation: request.generation, mode: request.mode }
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

interface ProxyRecording {
	/** The members each republish was handed. */
	readonly republished: ProviderNamespaceMember[][]
	/** Whether the namespace's pinned proxy reads the flag. */
	pinReadsSuspension: boolean
}

function proxyProvider(recording: ProxyRecording): ControlProvider {
	return {
		...fakeControlProvider,
		namespaces: {
			normalize: (namespace) => namespace,
			namespaceResourceClaims: (namespace) => [`service:proxy:${namespace.id}`],
			registrationResourceClaims: () => [],
			provision: (input) => Promise.resolve(input.namespace),
			reconcile: (input) => Promise.resolve(input.namespace),
			republish: (input) => {
				recording.republished.push([...input.members])
				return Promise.resolve({ namespace: input.namespace, settled: true })
			},
			assertSuspendable: (namespace) => {
				if (recording.pinReadsSuspension) return
				throw new ProviderNamespaceError(
					`the proxy of deployment namespace \`${namespace.id}\` is pinned to a source that cannot take an environment offline; re-pin it with \`fabrika control namespaces update --namespace=${namespace.id} --proxy-source=current\``,
					'proxySuspensionUnsupported',
					false,
				)
			},
		},
	}
}

async function proxyHarness(recording: ProxyRecording) {
	const { db } = createHarness()
	const audits: DomainEvent[] = []
	const provider = proxyProvider(recording)
	const queue = { send: () => Promise.resolve() }
	const deps: ControlRpcDeps = {
		repositories: db,
		auth: auditingAuth(audits),
		queue,
		logs: { get: () => Promise.resolve(null) },
		provider,
		cancelRun: () => Promise.resolve(),
		// What `buildControlRpcDeps` wires for a provider that republishes: the real republish, waiting until it starts.
		namespaceProxyChanged: (namespaceId) =>
			republishNamespace({ repositories: db, provider, lock: makeFakeLock(db), queue }, namespaceId, { wait: 'started' }),
	}
	for (const id of ['apps-prod', 'apps-other']) {
		await db.registry.createDeploymentNamespaceWithResourceClaims({
			id,
			env: ENV,
			provider: TEST_PROVIDER_ID,
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify({ provider: TEST_PROVIDER_ID, version: 1, payload: {} }),
			state: 'ready',
		}, [`service:proxy:${id}`])
	}
	await db.registry.createApp({ id: APP, repoUrl: 'github.com/acme/notes' })
	await db.registry.upsertAppEnv({ ...providerEnvironment(APP, ENV, { domain: 'notes.example.com' }), namespaceId: 'apps-prod' })
	return { deps, audits }
}

async function objectHarness() {
	const { db } = createHarness()
	const audits: DomainEvent[] = []
	const object = new FakeObject()
	const lock = makeFakeLock(db)
	const deps: ControlRpcDeps = {
		repositories: db,
		auth: auditingAuth(audits),
		queue: { send: () => Promise.resolve() },
		logs: { get: () => Promise.resolve(null) },
		provider: fakeControlProvider,
		cancelRun: () => Promise.resolve(),
		lock,
		opsTransport: object,
	}
	await db.registry.createApp({ id: APP, repoUrl: 'github.com/acme/notes' })
	await db.registry.upsertAppEnv(providerEnvironment(APP, ENV, { domain: 'notes.example.com' }))
	return { deps, audits, object, lock }
}

/** What the tests read of an answer: an `AppEnvDto`'s suspension, or a refusal's message. */
const answerSchema = z.object({
	appId: z.string().optional(),
	env: z.string().optional(),
	suspendedAt: z.number().optional(),
	error: z.string().optional(),
})

const call = async (deps: ControlRpcDeps, verb: 'suspend' | 'resume') => {
	const response = await rpcResult(rpcRequest(`apps.environments.${verb}`, TARGET), deps, { consoleOrigin: 'https://control.test' })
	return { status: response.status, body: answerSchema.parse(await response.json()) }
}

/** A builder key: every action allowed, but a service principal, which no gate mode makes a person. */
function keyOf(deps: ControlRpcDeps, audits: DomainEvent[]): ControlRpcDeps {
	return { ...deps, auth: { ...auditingAuth(audits), principal: { id: 'svc', type: 'service', label: 'builder' } } }
}

/** `data: off` lets a key's suspend and resume of the protected environment through the gate (ADR-0083 §3). */
async function dataOff(deps: ControlRpcDeps): Promise<void> {
	const row = await fixtureProtect(
		deps.repositories.registry,
		makeFakeLock(deps.repositories),
		TARGET,
		true,
		Date.now,
		storedPolicy({ ...STRICT_POLICY, data: 'off' }),
	)
	expect(row?.protected).toBe(1)
}

const RESUME_REFUSAL = 'environment `prod` is protected: only a person in the console resumes it'

const parsedJson = (text: string): unknown => JSON.parse(text)

const suspendedOf = (members: readonly ProviderNamespaceMember[] | undefined) =>
	members?.map((member) => [`${member.appId}@${member.env}`, member.suspended])

describe('behind a namespace proxy', () => {
	test('suspend hands the republish the member flagged, resume hands it back unflagged, and both are audited', async () => {
		const recording: ProxyRecording = { republished: [], pinReadsSuspension: true }
		const { deps, audits } = await proxyHarness(recording)

		const suspended = await call(deps, 'suspend')
		expect(suspended.status).toBe(200)
		expect(suspended.body).toMatchObject({ appId: APP, env: ENV, suspendedAt: expect.any(Number) })
		expect(suspendedOf(recording.republished.at(-1))).toEqual([['notes@prod', true]])

		const resumed = await call(deps, 'resume')
		expect(resumed.status).toBe(200)
		expect(resumed.body.suspendedAt).toBeUndefined()
		expect(suspendedOf(recording.republished.at(-1))).toEqual([['notes@prod', undefined]])
		const stored = await deps.repositories.registry.getAppEnv(APP, ENV)
		expect(stored).toMatchObject({ suspended_at: null, suspended_from_mode: null })

		expect(audits.map((event) => [event.action, event.resourceType, event.resourceId, event.metadata])).toEqual([
			['app.env.suspend', 'app_env', 'notes/prod', { namespaceId: 'apps-prod' }],
			['app.env.resume', 'app_env', 'notes/prod', { namespaceId: 'apps-prod' }],
		])
	})

	test('a repeated suspend republishes again and keeps the time it was first suspended', async () => {
		const recording: ProxyRecording = { republished: [], pinReadsSuspension: true }
		const { deps } = await proxyHarness(recording)
		const first = await call(deps, 'suspend')
		const again = await call(deps, 'suspend')
		expect(again.body.suspendedAt).toBe(first.body.suspendedAt)
		expect(recording.republished).toHaveLength(2)
	})

	test('a namespace pinned to an older proxy is refused with the re-pin, before anything is written, republished or audited', async () => {
		const recording: ProxyRecording = { republished: [], pinReadsSuspension: false }
		const { deps, audits } = await proxyHarness(recording)

		const refused = await call(deps, 'suspend')
		expect(refused.status).toBe(409)
		expect(refused.body.error).toContain('fabrika control namespaces update --namespace=apps-prod --proxy-source=current')
		expect(await deps.repositories.registry.getAppEnv(APP, ENV)).toMatchObject({ suspended_at: null })
		expect(recording.republished).toEqual([])
		expect(audits).toEqual([])
	})

	test('a suspended environment cannot move to another namespace, whose pinned proxy may not read the flag', async () => {
		const recording: ProxyRecording = { republished: [], pinReadsSuspension: true }
		const { deps } = await proxyHarness(recording)
		const stored = await deps.repositories.registry.getAppEnv(APP, ENV)
		if (stored === null) throw new Error('the environment is missing')
		const move = rpcRequest('apps.environments.put', {
			...TARGET,
			environment: {
				namespaceId: 'apps-other',
				domain: stored.domain,
				target: parsedJson(stored.provider_target_json),
				artifact: parsedJson(stored.provider_artifact_json),
			},
		})
		expect((await call(deps, 'suspend')).status).toBe(200)

		const refused = await rpcResult(move, deps)
		expect(refused.status).toBe(409)
		expect(answerSchema.parse(await refused.json()).error).toContain('is suspended; resume it before it changes deployment namespace')
		expect(await deps.repositories.registry.getAppEnv(APP, ENV)).toMatchObject({ namespace_id: 'apps-prod' })
	})

	test('app.manage on another app cannot suspend this one', async () => {
		const recording: ProxyRecording = { republished: [], pinReadsSuspension: true }
		const { deps } = await proxyHarness(recording)
		const scoped = { ...deps, auth: authWithPermissions([{ action: CONTROL_ACTIONS.APP_MANAGE, scope: { type: 'app', value: 'other' } }]) }

		expect((await call(scoped, 'suspend')).status).toBe(403)
		expect(recording.republished).toEqual([])
	})
})

describe("through the environment's object", () => {
	test('suspend closes an open object and resume opens it again, both audited with their operation', async () => {
		const { deps, audits, object } = await objectHarness()

		const suspended = await call(deps, 'suspend')
		expect(suspended.status).toBe(200)
		expect(suspended.body).toMatchObject({ suspendedAt: expect.any(Number) })
		expect(object.modes).toEqual(['closed'])
		expect(await deps.repositories.registry.getAppEnv(APP, ENV)).toMatchObject({ suspended_from_mode: 'open' })

		const resumed = await call(deps, 'resume')
		expect(resumed.status).toBe(200)
		expect(resumed.body.suspendedAt).toBeUndefined()
		expect(object.modes).toEqual(['closed', 'open'])

		expect(audits.map((event) => [event.action, event.metadata])).toEqual([
			['app.env.suspend', { mode: 'closed', operationId: expect.any(String), state: 'succeeded' }],
			['app.env.resume', { mode: 'open', operationId: expect.any(String), state: 'succeeded' }],
		])
	})

	test('resume returns a read-only object to read-only, not to open', async () => {
		const { deps, object, lock } = await objectHarness()
		await startMaintenance({ repositories: deps.repositories, lock, ops: object }, { ...TARGET, mode: 'read-only', actor: 'user:test' })

		expect((await call(deps, 'suspend')).status).toBe(200)
		expect((await call(deps, 'resume')).status).toBe(200)
		expect(object.modes).toEqual(['read-only', 'closed', 'read-only'])
	})

	test('an object already closed by maintenance is refused, and nothing is recorded', async () => {
		const { deps, audits, object, lock } = await objectHarness()
		await startMaintenance({ repositories: deps.repositories, lock, ops: object }, { ...TARGET, mode: 'closed', actor: 'user:test' })

		const refused = await call(deps, 'suspend')
		expect(refused.status).toBe(409)
		expect(refused.body.error).toContain('already in maintenance `closed`')
		expect(await deps.repositories.registry.getAppEnv(APP, ENV)).toMatchObject({ suspended_at: null })
		expect(audits).toEqual([])
	})

	test('a suspend the deploy lease refuses leaves no record behind', async () => {
		const { deps, object, lock } = await objectHarness()
		expect(await lock.acquire(runLeaseKey(APP, ENV), 'a-running-deploy', 60_000)).toBe(true)

		expect((await call(deps, 'suspend')).status).toBe(409)
		expect(await deps.repositories.registry.getAppEnv(APP, ENV)).toMatchObject({ suspended_at: null, suspended_from_mode: null })
		expect(object.modes).toEqual([])
	})

	test('resume of an environment that is not suspended is refused', async () => {
		const { deps, object } = await objectHarness()
		expect((await call(deps, 'resume')).status).toBe(409)
		expect(object.modes).toEqual([])
	})
})

describe('resuming a protected environment', () => {
	test('behind a namespace proxy a key suspends but cannot resume, and a person resumes, audited', async () => {
		const recording: ProxyRecording = { republished: [], pinReadsSuspension: true }
		const { deps, audits } = await proxyHarness(recording)
		await dataOff(deps)
		const key = keyOf(deps, audits)

		expect((await call(key, 'suspend')).status).toBe(200)
		const refused = await call(key, 'resume')
		expect(refused.status).toBe(403)
		expect(refused.body.error).toContain(RESUME_REFUSAL)
		expect(await deps.repositories.registry.getAppEnv(APP, ENV)).toMatchObject({ suspended_at: expect.any(Number) })
		expect(recording.republished).toHaveLength(1)

		expect((await call(deps, 'resume')).status).toBe(200)
		expect(await deps.repositories.registry.getAppEnv(APP, ENV)).toMatchObject({ suspended_at: null })
		expect(audits.map((event) => [event.action, event.metadata])).toEqual([
			['app.env.suspend', { namespaceId: 'apps-prod' }],
			['app.env.resume', { namespaceId: 'apps-prod' }],
		])
	})

	test("through the environment's object a key cannot resume and the object stays closed; a person resumes, audited", async () => {
		const { deps, audits, object } = await objectHarness()
		await dataOff(deps)
		const key = keyOf(deps, audits)

		expect((await call(key, 'suspend')).status).toBe(200)
		const refused = await call(key, 'resume')
		expect(refused.status).toBe(403)
		expect(refused.body.error).toContain(RESUME_REFUSAL)
		expect(object.modes).toEqual(['closed'])

		expect((await call(deps, 'resume')).status).toBe(200)
		expect(object.modes).toEqual(['closed', 'open'])
		expect(audits.map((event) => [event.action, event.metadata])).toEqual([
			['app.env.suspend', { mode: 'closed', operationId: expect.any(String), state: 'succeeded' }],
			['app.env.resume', { mode: 'open', operationId: expect.any(String), state: 'succeeded' }],
		])
	})

	test("a key cannot open a suspended protected environment's object through a data operation; it may keep it closed", async () => {
		const { deps, audits, object } = await objectHarness()
		await dataOff(deps)
		const key = keyOf(deps, audits)
		const asked = async (auth: ControlRpcDeps, procedure: string, input: Record<string, unknown>) => {
			const response = await rpcResult(rpcRequest(procedure, { ...TARGET, ...input }), auth, { consoleOrigin: 'https://control.test' })
			return { status: response.status, body: answerSchema.parse(await response.json()) }
		}
		const refusal = 'environment `prod` is protected and suspended: only a person in the console starts a data operation'

		expect((await call(key, 'suspend')).status).toBe(200)
		for (const mode of ['open', 'read-only', 'inspect']) {
			const opened = await asked(key, 'data.start', { kind: 'maintenance', mode })
			expect(opened.status).toBe(403)
			expect(opened.body.error).toContain(refusal)
		}
		const restored = await asked(key, 'data.start', { kind: 'restore', at: '2026-11-01T00:00:00Z' })
		expect(restored.status).toBe(403)
		const recovered = await asked(key, 'data.recover', { operationId: 'any', resolution: 'open' })
		expect(recovered.status).toBe(403)
		expect(recovered.body.error).toContain(refusal)
		expect(object.modes).toEqual(['closed'])

		expect((await asked(key, 'data.start', { kind: 'maintenance', mode: 'closed' })).status).toBe(200)
		expect((await asked(deps, 'data.start', { kind: 'maintenance', mode: 'open' })).status).toBe(200)
		expect(object.modes).toEqual(['closed', 'closed', 'open'])
	})

	test("a person's own key is a key: with a bearer, the person cannot resume a protected environment", async () => {
		const { deps, object } = await objectHarness()
		expect((await call(deps, 'suspend')).status).toBe(200)
		const request = rpcRequest('apps.environments.resume', TARGET)
		const headers = new Headers(request.headers)
		headers.set('Authorization', 'Bearer px_test')
		// Under the default `data: person` the bearer's resume waits for a person as a request; nothing resumes.
		const response = await rpcResult(new Request(request, { headers }), deps, { consoleOrigin: 'https://control.test' })
		expect(response.status).toBe(409)
		expect(await deps.repositories.registry.getAppEnv(APP, ENV)).toMatchObject({ suspended_at: expect.any(Number) })
		await dataOff(deps)
		const refused = await rpcResult(new Request(request, { headers }), deps, { consoleOrigin: 'https://control.test' })
		expect(refused.status).toBe(403)
		expect(object.modes).toEqual(['closed'])
	})

	test('a key resumes an unprotected environment', async () => {
		const { deps, audits, object } = await objectHarness()
		expect((await fixtureProtect(deps.repositories.registry, makeFakeLock(deps.repositories), TARGET, false))?.protected).toBe(0)
		const key = keyOf(deps, audits)

		expect((await call(key, 'suspend')).status).toBe(200)
		expect((await call(key, 'resume')).status).toBe(200)
		expect(object.modes).toEqual(['closed', 'open'])
	})
})

describe('the suspension record', () => {
	test('of two concurrent writers only the first records it, and a clear holding a stale record changes nothing', async () => {
		const { db } = createHarness()
		await db.registry.createApp({ id: APP, repoUrl: 'github.com/acme/notes' })
		await db.registry.upsertAppEnv(providerEnvironment(APP, ENV, { domain: 'notes.example.com' }))

		expect(await db.registry.setAppEnvSuspension(APP, ENV, { at: 100, fromMode: 'read-only' }, null)).toMatchObject({ suspended_at: 100 })
		expect(await db.registry.setAppEnvSuspension(APP, ENV, { at: 100, fromMode: 'open' }, null)).toBeNull()
		expect(await db.registry.setAppEnvSuspension(APP, ENV, null, 99)).toBeNull()
		expect(await db.registry.getAppEnv(APP, ENV)).toMatchObject({ suspended_at: 100, suspended_from_mode: 'read-only' })

		expect(await db.registry.setAppEnvSuspension(APP, ENV, null, 100)).toMatchObject({ suspended_at: null, suspended_from_mode: null })
	})
})
