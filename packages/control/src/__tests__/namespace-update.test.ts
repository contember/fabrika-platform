import type { AuthContext } from '@fabrika/auth'
import type { ControlProvider, JsonValue, ProviderEnvelope, ProviderNamespaceUpdates } from '@fabrika/provider-contract'
import {
	createZeropsArtifactSourceDescriptor,
	createZeropsNamespaceCapabilities,
	type ZeropsApi,
	ZeropsApiError,
	type ZeropsAppVersion,
	type ZeropsNamespaceOptions,
	type ZeropsProject,
	type ZeropsService,
	type ZeropsServiceEnv,
} from '@fabrika/provider-zerops'
import { describe, expect, spyOn, test } from 'bun:test'
import { type NamespaceJobResult, republishNamespace, runNamespaceJob } from '../api/namespaces'
import type { DeploymentNamespaceRow } from '../db'
import { acquireLease, LEASE_TTL_MS, namespaceLeaseKey } from '../lease'
import { type ControlJobMessage, executeDeploy } from '../run-lifecycle'
import { VaultSecretResolver } from '../secret-resolver'
import type { ControlRpcDeps } from '../services'
import { createHarness, harnessDatabase } from './helpers/harness'
import { makeFakeLock } from './helpers/lock'
import { rpcRequest, rpcResult } from './helpers/rpc'

const PIN: ZeropsNamespaceOptions['proxySource'] = {
	repository: { owner: 'example', name: 'platform' },
	commitSha: 'a'.repeat(40),
	descriptor: { ...await createZeropsArtifactSourceDescriptor('zerops:\n  - setup: proxy\n') },
}

/**
 * A Zerops double for what the namespace lifecycle touches, with one platform fact on purpose: a
 * re-import with `override` creates what is missing and CHANGES NOTHING that exists, so a changed
 * `profile` lands only through the autoscaling endpoint.
 */
interface FakeZerops {
	readonly api: ZeropsApi
	readonly calls: string[]
	readonly services: ZeropsService[]
	readonly faults: {
		/** Awaited inside the autoscaling PUT, so a test can act while an update is in flight. */
		hold: Promise<void> | null
		/** The PUT applies, then the connection drops while its process is polled. */
		processLost: boolean
		/** The connection drops during the PUT, before the platform applied anything. */
		putLost: boolean
		/** The platform refuses the PUT outright. */
		refused: boolean
	}
}

const never = (name: string) => (): never => {
	throw new Error(`the namespace lifecycle must not call ${name}`)
}

const objectField = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined)

function fakeZerops(): FakeZerops {
	const calls: string[] = []
	const projects: ZeropsProject[] = []
	const services: ZeropsService[] = []
	const env = new Map<string, ZeropsServiceEnv[]>()
	const versions: ZeropsAppVersion[] = []
	const faults: FakeZerops['faults'] = { hold: null, processLost: false, putLost: false, refused: false }

	const importDocument = (projectId: string, yaml: string): void => {
		const declared = objectField(Bun.YAML.parse(yaml), 'services')
		if (!Array.isArray(declared)) throw new Error('import document has no services')
		for (const entry of declared) {
			const hostname = objectField(entry, 'hostname')
			const type = objectField(entry, 'type')
			const profile = objectField(entry, 'profile')
			if (typeof hostname !== 'string' || typeof type !== 'string') throw new Error('import service needs hostname and type')
			if (services.some((service) => service.projectId === projectId && service.name === hostname)) continue
			services.push({
				id: `${hostname}-${projectId}`,
				name: hostname,
				projectId,
				base: type,
				status: 'ACTIVE',
				...(typeof profile === 'string' ? { autoscalingProfileId: profile } : {}),
			})
		}
	}

	const service = (serviceId: string): ZeropsService => {
		const found = services.find((candidate) => candidate.id === serviceId)
		if (found === undefined) throw new Error(`missing service ${serviceId}`)
		return found
	}

	const api: ZeropsApi = {
		importProject: async ({ yaml }) => {
			calls.push('importProject')
			const project = objectField(Bun.YAML.parse(yaml), 'project')
			const name = objectField(project, 'name')
			const description = objectField(project, 'description')
			if (typeof name !== 'string' || typeof description !== 'string') throw new Error('import project needs a name and description')
			const mode = objectField(project, 'corePackage') === 'SERIOUS' ? 'SERIOUS' : 'LIGHT'
			const id = `project-${projects.length + 1}`
			projects.push({ id, name, description, mode, status: 'ACTIVE' })
			importDocument(id, yaml)
			return { projectId: id, services: [] }
		},
		importServices: async ({ projectId, yaml }) => {
			calls.push('importServices')
			importDocument(projectId, yaml)
			return { projectId, services: [] }
		},
		findProjects: async ({ name }) => projects.filter((project) => project.name === name),
		getProject: async ({ projectId }) => {
			const found = projects.find((project) => project.id === projectId)
			if (found === undefined) throw new Error(`missing project ${projectId}`)
			return found
		},
		listProjectServices: async ({ projectId }) => services.filter((candidate) => candidate.projectId === projectId),
		listServiceEnv: async ({ serviceId }) => [...(env.get(serviceId) ?? [])],
		putServiceEnv: async ({ serviceId, key, value, sensitive }) => {
			const variables = (env.get(serviceId) ?? []).filter((variable) => variable.key !== key)
			const id = `${serviceId}:${key}`
			// Zerops withholds a sensitive value on read.
			const written: ZeropsServiceEnv = sensitive ? { id, key, sensitive: true } : { id, key, sensitive: false, content: value }
			env.set(serviceId, [...variables, written])
		},
		createAppVersion: async ({ serviceId }) => {
			calls.push(`createAppVersion:${serviceId}`)
			const version: ZeropsAppVersion = {
				id: `version-${versions.length + 1}`,
				status: 'UPLOADING',
				sequence: versions.length + 1,
				serviceStackId: serviceId,
			}
			versions.push(version)
			return { id: version.id, uploadUrl: `https://proxy.app-prg1.zerops.io/api/rest/object-storage/upload?version=${version.id}&signature=test` }
		},
		buildAndDeployAppVersion: async ({ appVersionId }) => {
			const version = versions.find((candidate) => candidate.id === appVersionId)
			if (version === undefined) throw new Error(`missing version ${appVersionId}`)
			version.status = 'ACTIVE'
			return { id: `process-${appVersionId}`, appVersionId }
		},
		getAppVersion: async ({ appVersionId }) => {
			const found = versions.find((version) => version.id === appVersionId)
			if (found === undefined) throw new ZeropsApiError('App version not found', 400, 'appVersionNotFound')
			return found
		},
		getService: async ({ serviceId }) => ({ ...service(serviceId) }),
		configureAutoscaling: async ({ serviceId, autoscalingProfileId }) => {
			calls.push(`configureAutoscaling:${serviceId}:${autoscalingProfileId}`)
			if (faults.hold !== null) await faults.hold
			if (faults.refused) throw new ZeropsApiError('zerops: configure autoscaling failed (400) — invalidUserInput: no', 400, 'invalidUserInput')
			if (faults.putLost) {
				faults.putLost = false
				throw new Error('socket hang up')
			}
			service(serviceId).autoscalingProfileId = autoscalingProfileId
			return { id: `autoscaling-${serviceId}`, status: 'PENDING', actionName: 'stack.autoscaling' }
		},
		getProcess: async ({ processId }) => {
			if (faults.processLost && processId.startsWith('autoscaling-')) {
				faults.processLost = false
				throw new Error('socket hang up')
			}
			return { id: processId, status: 'FINISHED' }
		},
		latestAppVersion: never('latestAppVersion'),
		triggerPipeline: never('triggerPipeline'),
		deleteAppVersion: never('deleteAppVersion'),
		cancelBuild: never('cancelBuild'),
		enableSubdomainAccess: never('enableSubdomainAccess'),
		findService: never('findService'),
		listProjects: never('listProjects'),
		createServiceEnv: never('createServiceEnv'),
		deleteServiceEnv: never('deleteServiceEnv'),
		getProjectEnv: never('getProjectEnv'),
		getUserInfo: never('getUserInfo'),
		createIntegrationToken: never('createIntegrationToken'),
		getLogAccess: never('getLogAccess'),
		readBuildLog: never('readBuildLog'),
	}
	return { api, calls, services, faults }
}

function zeropsProvider(zerops: FakeZerops): ControlProvider {
	return {
		id: 'zerops',
		normalizeRegistration: (input) => input,
		deploy: () => Promise.resolve({ state: 'succeeded' }),
		namespaces: createZeropsNamespaceCapabilities({
			proxySource: PIN,
			source: {
				resolve: async (input) => ({ commitSha: input.requestedRef, descriptorSha256: input.descriptorSha256 }),
				// Control's source reports the digest of the manifest the proxy archive carries (ADR-0045).
				upload: async (input) => ({
					commitSha: input.commitSha,
					descriptorSha256: input.descriptorSha256,
					...(input.archive.kind === 'platform' && input.archive.dataFile !== undefined
						? { dataFileSha256: new Bun.CryptoHasher('sha256').update(input.archive.dataFile.contents).digest('hex') }
						: {}),
					entryCount: 1,
					expandedBytes: 1,
				}),
			},
			clientId: 'client-1',
			iamUrl: 'https://iam.example.test',
			iamKey: 'proxy-key-that-must-never-be-persisted',
			api: zerops.api,
			sleep: async () => {},
		}),
	}
}

interface AuditRecord {
	action: string
	metadata?: unknown
}

interface Harness {
	deps: ControlRpcDeps
	audits: AuditRecord[]
	drain(): Promise<NamespaceJobResult[]>
}

function makeHarness(provider: ControlProvider, actions: readonly string[] = ['*']): Harness {
	const { db } = createHarness()
	const audits: AuditRecord[] = []
	const sent: ControlJobMessage[] = []
	const lock = makeFakeLock(db)
	const auth: AuthContext = {
		ok: true,
		principal: { id: 'operator', type: 'user', label: 'operator@test' },
		can: (action) => actions.includes('*') || actions.includes(action),
		scopedTo: () => null,
		audit: (event) => {
			audits.push(event)
			return Promise.resolve()
		},
	}
	return {
		deps: {
			repositories: db,
			auth,
			queue: {
				send(message) {
					sent.push(message)
					return Promise.resolve()
				},
			},
			logs: { get: () => Promise.resolve(null) },
			provider,
			cancelRun: () => Promise.resolve(),
		},
		audits,
		async drain() {
			const results: NamespaceJobResult[] = []
			for (const message of sent.splice(0)) {
				if (message.kind !== 'namespace') continue
				results.push(await runNamespaceJob({ repositories: db, provider, lock }, message))
			}
			return results
		},
	}
}

interface NamespaceBody {
	id: string
	state: string
	target: ProviderEnvelope
	lastError: string | null
	lastErrorCode: string | null
	unconfirmedTarget?: ProviderEnvelope
}

async function readNamespace(response: Response): Promise<NamespaceBody> {
	return response.json()
}

async function errorOf(response: Response): Promise<string> {
	const body: { error: string } = await response.json()
	return body.error
}

function payloadOf(target: ProviderEnvelope): { [key: string]: JsonValue } {
	const payload = target.payload
	if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new Error('expected an object payload')
	return payload
}

/** Plan and create on the ADR-0038 defaults through the public RPC, then let the worker provision it. */
async function createDefaultNamespace(harness: Harness): Promise<NamespaceBody> {
	const planned = await rpcResult(rpcRequest('namespaces.plan', { id: 'apps-prod', env: 'prod', preset: 'cheap' }), harness.deps)
	const plan: { namespace: { id: string; env: string; target: ProviderEnvelope } } = await planned.json()
	expect(payloadOf(plan.namespace.target)['postgres']).toEqual({ type: 'postgresql:single@18', profile: 'oltp-hobby' })
	const created = await rpcResult(rpcRequest('namespaces.create', plan.namespace), harness.deps)
	expect(created.status).toBe(200)
	expect(await harness.drain()).toEqual([{ namespaceId: 'apps-prod', status: 'ready' }])
	return readNamespace(await rpcResult(rpcRequest('namespaces.get', { namespaceId: 'apps-prod' }), harness.deps))
}

const toProduction = { postgres: { type: 'postgresql:single@18', profile: 'oltp-production' } }

/** Only what changes — the provider merges it over the stored target. */
const updateRequest = (payload: JsonValue = toProduction) =>
	rpcRequest('namespaces.update', { namespaceId: 'apps-prod', namespace: { target: { provider: 'zerops', version: 1, payload } } })

const livePostgres = (zerops: FakeZerops, projectId = 'project-1'): ZeropsService => {
	const found = zerops.services.find((service) => service.name === 'postgres' && service.projectId === projectId)
	if (found === undefined) throw new Error('missing postgres service')
	return found
}

const autoscalingCalls = (zerops: FakeZerops): string[] => zerops.calls.filter((call) => call.startsWith('configureAutoscaling'))

async function storedRow(harness: Harness): Promise<DeploymentNamespaceRow> {
	const row = await harness.deps.repositories.registry.getDeploymentNamespace('apps-prod')
	if (row === null) throw new Error('missing namespace row')
	return row
}

describe('namespaces.update against the Zerops namespace capability', () => {
	test('moves a namespace created on the defaults to oltp-production from a payload naming only postgres', async () => {
		const zerops = fakeZerops()
		const harness = makeHarness(zeropsProvider(zerops))
		const ready = await createDefaultNamespace(harness)
		expect(livePostgres(zerops).autoscalingProfileId).toBe('oltp-hobby')

		const updated = await rpcResult(updateRequest(), harness.deps)

		expect(updated.status).toBe(200)
		const body = await readNamespace(updated)
		expect(body.state).toBe('ready')
		expect(body.target).toEqual({ ...ready.target, payload: { ...payloadOf(ready.target), ...toProduction } })
		expect(autoscalingCalls(zerops)).toEqual(['configureAutoscaling:postgres-project-1:oltp-production'])
		expect(livePostgres(zerops).autoscalingProfileId).toBe('oltp-production')
		expect(payloadOf(JSON.parse((await storedRow(harness)).provider_target_json))['postgres']).toEqual(toProduction.postgres)
		expect(harness.audits.at(-1)).toEqual(expect.objectContaining({
			action: 'namespace.update',
			metadata: expect.objectContaining({ field: 'postgres.profile', from: 'oltp-hobby', to: 'oltp-production' }),
		}))

		// The stored target and the live service now agree, so the operator's repair verb still passes.
		expect((await rpcResult(rpcRequest('namespaces.reconcile', { namespaceId: 'apps-prod' }), harness.deps)).status).toBe(200)
		expect(await harness.drain()).toEqual([{ namespaceId: 'apps-prod', status: 'ready' }])
	})

	test('refuses a PostgreSQL type change and names the supported path, touching nothing', async () => {
		const zerops = fakeZerops()
		const harness = makeHarness(zeropsProvider(zerops))
		await createDefaultNamespace(harness)
		const before = await storedRow(harness)

		const refused = await rpcResult(updateRequest({ postgres: { type: 'postgresql:ha@18', profile: 'oltp-production' } }), harness.deps)

		expect(refused.status).toBe(409)
		const message = await errorOf(refused)
		expect(message).toContain('from postgresql:single@18 to postgresql:ha@18')
		expect(message).toContain('namespaces.remove keeps the provider project and its database')
		expect(message).toContain('namespaces.create under a new id with the new target')
		expect(autoscalingCalls(zerops)).toEqual([])
		expect(await storedRow(harness)).toEqual(before)
	})

	test('refuses a namespace that is not ready', async () => {
		const zerops = fakeZerops()
		const harness = makeHarness(zeropsProvider(zerops))
		const planned = await rpcResult(rpcRequest('namespaces.plan', { id: 'apps-prod', env: 'prod', preset: 'cheap' }), harness.deps)
		const plan: { namespace: { id: string; env: string; target: ProviderEnvelope } } = await planned.json()
		await rpcResult(rpcRequest('namespaces.create', plan.namespace), harness.deps)

		const refused = await rpcResult(updateRequest(), harness.deps)

		expect(refused.status).toBe(409)
		expect(await errorOf(refused)).toContain('only a ready namespace, or one whose last update is unconfirmed, can be updated')
	})

	test('while an update is in flight, reconcile, remove and a second update are refused', async () => {
		const zerops = fakeZerops()
		const harness = makeHarness(zeropsProvider(zerops))
		await createDefaultNamespace(harness)
		const hold = Promise.withResolvers<void>()
		zerops.faults.hold = hold.promise

		const inFlight = rpcResult(updateRequest(), harness.deps)
		while (autoscalingCalls(zerops).length === 0) await Bun.sleep(1)

		const reconcile = await rpcResult(rpcRequest('namespaces.reconcile', { namespaceId: 'apps-prod' }), harness.deps)
		expect(reconcile.status).toBe(409)
		expect(await errorOf(reconcile)).toContain('retry namespaces.update with the planned target in unconfirmedTarget')
		const second = await rpcResult(updateRequest({ postgres: { type: 'postgresql:single@18', profile: 'oltp-staging' } }), harness.deps)
		expect(second.status).toBe(409)
		expect(await errorOf(second)).toContain('being changed by another operation')
		const removal = await rpcResult(rpcRequest('namespaces.remove', { namespaceId: 'apps-prod' }), harness.deps)
		expect(removal.status).toBe(409)
		expect(await errorOf(removal)).toContain('has an unconfirmed update')
		// A reconcile or removal that read the row BEFORE the mark reaches these statements anyway; the SQL
		// guards refuse the marked row on their own.
		const marker = (await storedRow(harness)).last_error
		expect(marker).toContain('namespaceUpdateUnconfirmed')
		expect(await harness.deps.repositories.registry.deleteDeploymentNamespaceWithResourceClaims('apps-prod')).toBeNull()
		expect((await storedRow(harness)).last_error).toBe(marker)

		hold.resolve()
		const finished = await inFlight
		expect(finished.status).toBe(200)
		expect((await readNamespace(finished)).state).toBe('ready')
		expect(harness.audits.map((event) => event.action)).not.toContain('namespace.reconcile')
	})

	test('an unconfirmed outcome after the PUT applied is marked, blocks reconcile and removal, and a retry converges', async () => {
		const zerops = fakeZerops()
		const harness = makeHarness(zeropsProvider(zerops))
		const ready = await createDefaultNamespace(harness)
		zerops.faults.processLost = true

		const failed = await rpcResult(updateRequest(), harness.deps)

		expect(failed.status).toBe(502)
		expect(await errorOf(failed)).toContain('retry namespaces.update with the planned target in unconfirmedTarget')
		expect(livePostgres(zerops).autoscalingProfileId).toBe('oltp-production')
		const marked = await readNamespace(await rpcResult(rpcRequest('namespaces.get', { namespaceId: 'apps-prod' }), harness.deps))
		expect(marked.state).toBe('failed')
		expect(marked.lastErrorCode).toBe('namespaceUpdateUnconfirmed')
		// The stored target is NOT moved on an unconfirmed outcome; the planned one is kept beside it.
		expect(marked.target).toEqual(ready.target)
		expect(payloadOf(marked.unconfirmedTarget ?? ready.target)['postgres']).toEqual(toProduction.postgres)
		expect((await rpcResult(rpcRequest('namespaces.reconcile', { namespaceId: 'apps-prod' }), harness.deps)).status).toBe(409)
		expect((await rpcResult(rpcRequest('namespaces.remove', { namespaceId: 'apps-prod' }), harness.deps)).status).toBe(409)

		// A client that never saw the first request finishes it from what the namespace reports.
		const retried = await rpcResult(
			rpcRequest('namespaces.update', { namespaceId: 'apps-prod', namespace: { target: marked.unconfirmedTarget } }),
			harness.deps,
		)

		expect(retried.status).toBe(200)
		const body = await readNamespace(retried)
		expect(body.unconfirmedTarget).toBeUndefined()
		expect(body.state).toBe('ready')
		expect(body.lastError).toBeNull()
		expect(payloadOf(body.target)['postgres']).toEqual(toProduction.postgres)
		// The live service was already the change in progress, so the retry only confirmed it.
		expect(autoscalingCalls(zerops)).toHaveLength(1)
	})

	test('an unconfirmed outcome where nothing applied converges on retry by applying it', async () => {
		const zerops = fakeZerops()
		const harness = makeHarness(zeropsProvider(zerops))
		await createDefaultNamespace(harness)
		zerops.faults.putLost = true

		expect((await rpcResult(updateRequest(), harness.deps)).status).toBe(502)
		expect(livePostgres(zerops).autoscalingProfileId).toBe('oltp-hobby')
		expect((await storedRow(harness)).state).toBe('failed')

		const retried = await rpcResult(updateRequest(), harness.deps)

		expect(retried.status).toBe(200)
		expect(livePostgres(zerops).autoscalingProfileId).toBe('oltp-production')
		expect(payloadOf((await readNamespace(retried)).target)['postgres']).toEqual(toProduction.postgres)
	})

	test('a definite refusal restores the namespace exactly as it was', async () => {
		const zerops = fakeZerops()
		const harness = makeHarness(zeropsProvider(zerops))
		await createDefaultNamespace(harness)
		const before = await storedRow(harness)
		zerops.faults.refused = true

		const failed = await rpcResult(updateRequest(), harness.deps)

		expect(failed.status).toBe(502)
		expect(await errorOf(failed)).toContain('invalidUserInput')
		expect(await storedRow(harness)).toEqual(before)
	})
})

describe('namespaces.update core guards', () => {
	const harborTarget = (phase: string): ProviderEnvelope => ({ provider: 'harbor', version: 1, payload: { phase } })

	function harbor(apply?: ProviderNamespaceUpdates['apply']): ControlProvider {
		return {
			id: 'harbor',
			normalizeRegistration: (input) => input,
			deploy: () => Promise.resolve({ state: 'succeeded' }),
			namespaces: {
				normalize: (namespace) => namespace,
				namespaceResourceClaims: () => [],
				registrationResourceClaims: () => [],
				provision: (input) => Promise.resolve(input.namespace),
				reconcile: (input) => Promise.resolve(input.namespace),
				...(apply === undefined ? {} : {
					updates: {
						plan: (namespace, requested) => ({ namespace: { ...namespace, target: requested }, change: { field: 'phase', from: 'small', to: 'large' } }),
						apply,
					},
				}),
			},
		}
	}

	async function seedReady(harness: Harness): Promise<void> {
		await harness.deps.repositories.registry.createDeploymentNamespace({
			id: 'apps-prod',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify(harborTarget('small')),
			state: 'ready',
		})
	}

	const request = () => rpcRequest('namespaces.update', { namespaceId: 'apps-prod', namespace: { target: harborTarget('large') } })

	test('requires namespace.manage', async () => {
		const denied = makeHarness(harbor(async (input) => input.next), ['app.manage'])
		await seedReady(denied)

		expect((await rpcResult(request(), denied.deps)).status).toBe(403)
	})

	test('a provider without updates is refused by name', async () => {
		const harness = makeHarness(harbor())
		await seedReady(harness)

		const refused = await rpcResult(request(), harness.deps)

		expect(refused.status).toBe(409)
		expect(await errorOf(refused)).toBe('provider harbor does not support namespace updates')
	})

	test('refuses an update while another holder has the namespace lease', async () => {
		let applied = false
		const harness = makeHarness(harbor(async (input) => {
			applied = true
			return input.next
		}))
		await seedReady(harness)
		const held = await acquireLease(makeFakeLock(harness.deps.repositories), namespaceLeaseKey('apps-prod'))
		if (held === null) throw new Error('the fixture lease is taken')

		try {
			const refused = await rpcResult(request(), harness.deps)

			expect(refused.status).toBe(409)
			expect(await errorOf(refused)).toContain('being changed by another operation')
			expect(applied).toBe(false)
		} finally {
			await held.release()
		}
	})

	test('a lease taken over during the provider call leaves the mark, and nothing without the lease moves it', async () => {
		let harness: Harness | undefined
		harness = makeHarness(harbor(async (input) => {
			if (harness === undefined) throw new Error('harness missing')
			const registry = harness.deps.repositories.registry
			const marked = await storedRow(harness)
			await harnessDatabase(harness.deps.repositories).prepare('DELETE FROM deploy_locks WHERE lock_key = ?').bind(namespaceLeaseKey('apps-prod')).run()
			expect(await makeFakeLock(harness.deps.repositories).acquire(namespaceLeaseKey('apps-prod'), 'takeover', 60_000)).toBe(true)
			expect(
				await registry.transitionDeploymentNamespace({
					id: 'apps-prod',
					createdAt: marked.created_at,
					fence: { holder: 'nobody', nowMs: Date.now() },
					from: { state: marked.state, lastError: marked.last_error },
					to: { state: 'ready', providerTargetJson: JSON.stringify(harborTarget('stale')), lastError: null, updateTargetJson: null },
				}),
			).toBeNull()
			expect(await registry.deleteDeploymentNamespaceWithResourceClaims('apps-prod')).toBeNull()
			return input.next
		}))
		await seedReady(harness)

		const refused = await rpcResult(request(), harness.deps)

		expect(refused.status).toBe(409)
		expect(await errorOf(refused)).toContain('retry namespaces.update with the planned target')
		const row = await storedRow(harness)
		expect(row.state).toBe('failed')
		expect(row.last_error).toStartWith('namespaceUpdateUnconfirmed: ')
		expect(JSON.parse(row.update_target_json ?? 'null')).toEqual(harborTarget('large'))
		expect(JSON.parse(row.provider_target_json)).toEqual(harborTarget('small'))
	})

	test('a definite provider failure is a redacted 502 and restores the row', async () => {
		const harness = makeHarness(harbor(() => Promise.reject(new Error('upstream exploded with token ghp_secretvalue'))))
		await seedReady(harness)
		const before = await storedRow(harness)

		const failed = await rpcResult(request(), harness.deps)

		expect(failed.status).toBe(502)
		expect(await errorOf(failed)).not.toContain('ghp_secretvalue')
		expect(await storedRow(harness)).toEqual(before)
	})
})

describe('a namespace whose update is unconfirmed', () => {
	const republishDeps = (harness: Harness) => ({
		repositories: harness.deps.repositories,
		provider: harness.deps.provider,
		lock: makeFakeLock(harness.deps.repositories),
		queue: harness.deps.queue,
	})

	const proxyBuilds = (zerops: FakeZerops): number => zerops.calls.filter((call) => call.startsWith('createAppVersion')).length

	const getNamespace = async (harness: Harness): Promise<NamespaceBody> =>
		readNamespace(await rpcResult(rpcRequest('namespaces.get', { namespaceId: 'apps-prod' }), harness.deps))

	const retryWith = (target: ProviderEnvelope | undefined) => rpcRequest('namespaces.update', { namespaceId: 'apps-prod', namespace: { target } })

	test('a proxy repair requested during a held update is replayed as a reconcile once the update completes', async () => {
		const zerops = fakeZerops()
		const harness = makeHarness(zeropsProvider(zerops))
		await createDefaultNamespace(harness)
		const buildsBefore = proxyBuilds(zerops)
		const hold = Promise.withResolvers<void>()
		zerops.faults.hold = hold.promise

		const inFlight = rpcResult(updateRequest(), harness.deps)
		while (autoscalingCalls(zerops).length === 0) await Bun.sleep(1)
		// What `namespaceProxyChanged` runs after a domain or artifact change persisted.
		await expect(republishNamespace(republishDeps(harness), 'apps-prod', { wait: 'started' })).rejects.toThrow('busy')
		expect((await storedRow(harness)).repair_requested).toBe(1)
		hold.resolve()

		const finished = await inFlight
		expect(finished.status).toBe(200)
		expect((await readNamespace(finished)).state).toBe('pending')
		expect(await harness.drain()).toEqual([{ namespaceId: 'apps-prod', status: 'ready' }, { namespaceId: 'apps-prod', status: 'skipped' }])
		expect(proxyBuilds(zerops)).toBe(buildsBefore + 1)
		expect(await storedRow(harness)).toMatchObject({ state: 'ready', repair_requested: 0, update_target_json: null })
	})

	test('a republish is refused naming the retry, and runs once the retry completes', async () => {
		const zerops = fakeZerops()
		const harness = makeHarness(zeropsProvider(zerops))
		await createDefaultNamespace(harness)
		zerops.faults.processLost = true
		expect((await rpcResult(updateRequest(), harness.deps)).status).toBe(502)
		const marked = await storedRow(harness)
		const buildsBefore = proxyBuilds(zerops)

		await expect(republishNamespace(republishDeps(harness), 'apps-prod', { wait: 'started' })).rejects.toThrow(
			'has an unconfirmed update — retry namespaces.update with the planned target in unconfirmedTarget',
		)
		expect(await storedRow(harness)).toEqual({ ...marked, repair_requested: 1 })
		expect(proxyBuilds(zerops)).toBe(buildsBefore)

		const retried = await rpcResult(retryWith((await getNamespace(harness)).unconfirmedTarget), harness.deps)

		expect(retried.status).toBe(200)
		expect((await readNamespace(retried)).state).toBe('pending')
		expect(await harness.drain()).toEqual([{ namespaceId: 'apps-prod', status: 'ready' }])
		expect(proxyBuilds(zerops)).toBe(buildsBefore + 1)
	})

	test('a deploy is refused naming the retry, before the provider deploys', async () => {
		const zerops = fakeZerops()
		let deployed = false
		const provider: ControlProvider = {
			...zeropsProvider(zerops),
			deploy: () => {
				deployed = true
				return Promise.resolve({ state: 'succeeded' })
			},
		}
		const harness = makeHarness(provider)
		await createDefaultNamespace(harness)
		zerops.faults.processLost = true
		expect((await rpcResult(updateRequest(), harness.deps)).status).toBe(502)
		const registry = harness.deps.repositories.registry
		const opaque = JSON.stringify({ provider: 'zerops', version: 1, payload: {} })
		await registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes' })
		await registry.upsertAppEnv({
			appId: 'notes',
			env: 'prod',
			namespaceId: 'apps-prod',
			provider: 'zerops',
			providerTargetJson: opaque,
			providerArtifactJson: opaque,
		})
		await harness.deps.repositories.runs.createRun({ id: 'run-notes', appId: 'notes', env: 'prod', ref: 'main', trigger: 'manual', actor: 'user:test' })
		const logged = spyOn(console, 'error')

		try {
			const result = await executeDeploy(
				{ ...republishDeps(harness), secrets: new VaultSecretResolver({}), logs: { put: () => Promise.resolve() } },
				{ runId: 'run-notes' },
			)

			expect(result).toEqual({ runId: 'run-notes', status: 'failed' })
			expect(deployed).toBe(false)
			expect(logged.mock.calls.map((call) => call.join(' ')).join('\n')).toContain(
				'deployment namespace apps-prod has an unconfirmed update — retry namespaces.update with the planned target in unconfirmedTarget',
			)
		} finally {
			logged.mockRestore()
		}
	})

	test('a crash after the platform accepted the change is finished by a fresh client from unconfirmedTarget', async () => {
		const zerops = fakeZerops()
		const harness = makeHarness(zeropsProvider(zerops))
		const ready = await createDefaultNamespace(harness)
		const row = await storedRow(harness)
		const planned: ProviderEnvelope = { ...ready.target, payload: { ...payloadOf(ready.target), ...toProduction } }
		// The update's own claim, then the platform applied the PUT, then the process died holding the lease.
		const locks = makeFakeLock(harness.deps.repositories)
		expect(await locks.acquire(namespaceLeaseKey('apps-prod'), 'crashed', LEASE_TTL_MS)).toBe(true)
		const claimed = await harness.deps.repositories.registry.transitionDeploymentNamespace({
			id: 'apps-prod',
			createdAt: row.created_at,
			fence: { holder: 'crashed', nowMs: Date.now() },
			from: { state: 'ready', lastError: null },
			to: {
				state: 'failed',
				providerTargetJson: row.provider_target_json,
				lastError: 'namespaceUpdateUnconfirmed: an update started and is not confirmed',
				updateTargetJson: JSON.stringify(planned),
			},
		})
		expect(claimed).not.toBeNull()
		livePostgres(zerops).autoscalingProfileId = 'oltp-production'
		await locks.release(namespaceLeaseKey('apps-prod'), 'crashed')

		const seen = await getNamespace(harness)
		expect(seen.unconfirmedTarget).toEqual(planned)
		const finished = await rpcResult(retryWith(seen.unconfirmedTarget), harness.deps)

		expect(finished.status).toBe(200)
		expect(await readNamespace(finished)).toMatchObject({ state: 'ready', target: planned, lastError: null })
		expect(autoscalingCalls(zerops)).toEqual([])
	})

	test('a retry with the previous target moves the live service back instead of reading it as drift', async () => {
		const zerops = fakeZerops()
		const harness = makeHarness(zeropsProvider(zerops))
		const ready = await createDefaultNamespace(harness)
		zerops.faults.processLost = true
		expect((await rpcResult(updateRequest(), harness.deps)).status).toBe(502)
		expect(livePostgres(zerops).autoscalingProfileId).toBe('oltp-production')

		const abandoned = await rpcResult(retryWith(ready.target), harness.deps)

		expect(abandoned.status).toBe(200)
		expect(await readNamespace(abandoned)).toMatchObject({ state: 'ready', target: ready.target })
		expect(livePostgres(zerops).autoscalingProfileId).toBe('oltp-hobby')
	})
})

describe('a PostgreSQL type change', () => {
	const planHa = (harness: Harness, id: string) =>
		rpcResult(
			rpcRequest('namespaces.plan', { id, env: 'prod', preset: 'cheap', options: { postgres: { type: 'postgresql:ha@18', profile: 'oltp-staging' } } }),
			harness.deps,
		)

	test('goes through a new namespace id, because recreating the removed id adopts the retained database', async () => {
		const zerops = fakeZerops()
		const harness = makeHarness(zeropsProvider(zerops))
		await createDefaultNamespace(harness)

		const plannedHa: { namespace: { id: string; env: string; target: ProviderEnvelope } } = await (await planHa(harness, 'apps-prod-ha')).json()
		expect((await rpcResult(rpcRequest('namespaces.create', plannedHa.namespace), harness.deps)).status).toBe(200)
		expect(await harness.drain()).toEqual([{ namespaceId: 'apps-prod-ha', status: 'ready' }])
		expect(livePostgres(zerops, 'project-2')).toMatchObject({ base: 'postgresql:ha@18', autoscalingProfileId: 'oltp-staging' })

		// The advertised refusal is right not to offer remove-then-create under the same id.
		expect((await rpcResult(rpcRequest('namespaces.remove', { namespaceId: 'apps-prod' }), harness.deps)).status).toBe(200)
		const sameId: { namespace: { id: string; env: string; target: ProviderEnvelope } } = await (await planHa(harness, 'apps-prod')).json()
		expect((await rpcResult(rpcRequest('namespaces.create', sameId.namespace), harness.deps)).status).toBe(200)
		expect(await harness.drain()).toEqual([{ namespaceId: 'apps-prod', status: 'failed' }])
		expect((await storedRow(harness)).last_error).toContain('uses postgresql:single@18, expected postgresql:ha@18')
	})
})

describe('an update payload is checked strictly', () => {
	test('refuses a misspelt or unsupported field before any provider effect', async () => {
		const zerops = fakeZerops()
		const harness = makeHarness(zeropsProvider(zerops))
		await createDefaultNamespace(harness)
		const before = await storedRow(harness)

		const misspelt = await rpcResult(updateRequest({ corePakage: 'SERIOUS' }), harness.deps)
		const nested = await rpcResult(
			updateRequest({ postgres: { type: 'postgresql:single@18', profile: 'oltp-production', maxContainers: 3 } }),
			harness.deps,
		)

		expect(misspelt.status).toBe(400)
		expect(await errorOf(misspelt)).toContain('field corePakage is not a namespace target field')
		expect(nested.status).toBe(400)
		expect(await errorOf(nested)).toContain('field postgres.maxContainers is not a namespace target field')
		expect(autoscalingCalls(zerops)).toEqual([])
		expect(await storedRow(harness)).toEqual(before)
	})
})
