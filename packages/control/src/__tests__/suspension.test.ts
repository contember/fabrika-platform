// `apps.environments.suspend` and `resume`, through the RPC router against the real schema: behind a namespace proxy the
// member reaches the provider's republish flagged, and is refused where the pinned proxy cannot read the flag; without
// one the environment's object goes into maintenance `closed` and returns to the mode it was in.

import type { AuthContext, DomainEvent } from '@fabrika/auth'
import type { OpsMaintenance, OpsPublishedState, OpsStateAck, OpsStateRequest, OpsView } from '@fabrika/auth-core'
import { CONTROL_ACTIONS } from '@fabrika/control-contract'
import { type ControlProvider, ProviderNamespaceError, type ProviderNamespaceMember } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { republishNamespace } from '../api/namespaces'
import { type OpsAnswer, type OpsDataAnswer, type OpsFencedAnswer, type OpsInspection, type OpsTransport, startMaintenance } from '../data-operations'
import type { ControlRpcDeps } from '../services'
import { createHarness } from './helpers/harness'
import { authWithPermissions } from './helpers/iam'
import { makeFakeLock } from './helpers/lock'
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
			namespaceResourceClaims: () => ['service:proxy'],
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
	await db.registry.createDeploymentNamespaceWithResourceClaims({
		id: 'apps-prod',
		env: ENV,
		provider: TEST_PROVIDER_ID,
		exclusiveAppId: null,
		providerTargetJson: JSON.stringify({ provider: TEST_PROVIDER_ID, version: 1, payload: {} }),
		state: 'ready',
	}, ['service:proxy'])
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
	const response = await rpcResult(rpcRequest(`apps.environments.${verb}`, TARGET), deps)
	return { status: response.status, body: answerSchema.parse(await response.json()) }
}

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
			['app.env.resume', { mode: 'open', operationId: expect.any(String) }],
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

	test('resume of an environment that is not suspended is refused', async () => {
		const { deps, object } = await objectHarness()
		expect((await call(deps, 'resume')).status).toBe(409)
		expect(object.modes).toEqual([])
	})
})
