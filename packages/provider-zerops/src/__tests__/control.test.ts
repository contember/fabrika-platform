import type { ProviderApp, ProviderDeployInput, ProviderEnvironment, ProviderReconcileOutcome, RuntimeProviderRun } from '@fabrika/provider-contract'
import { beforeEach, describe, expect, test } from 'bun:test'
import type { ZeropsApi, ZeropsAppVersionStatus } from '../api'
import { zeropsTargetCodec } from '../codec'
import { createZeropsControlProvider, zeropsStoredTargetCodec } from '../control'
import { compileFabrikaManifest, zeropsArtifactCodec } from '../manifest'
import type { ZeropsAppConfig } from '../types'

interface Recorded {
	calls: string[]
	externalIds: string[]
	logs: string[]
	envWrites: Array<{ serviceId: string; key: string; value: string }>
	envDeletes: string[]
	beforeDeploy: string[]
}

const fresh = (): Recorded => ({
	calls: [],
	externalIds: [],
	logs: [],
	envWrites: [],
	envDeletes: [],
	beforeDeploy: [],
})

const config: ZeropsAppConfig = {
	id: 'notes',
	target: {
		platform: 'zerops',
		services: () => [{ hostname: 'notes', type: 'alpine/bun@1.3' }],
	},
}

const app: ProviderApp = {
	id: 'notes',
	source: {
		repoUrl: 'https://github.com/acme/notes',
		ref: 'refs/heads/main',
		workerDir: 'apps/notes',
	},
}

const environment = (overrides: Partial<ProviderEnvironment> = {}): ProviderEnvironment => ({
	appId: 'notes',
	env: 'prod',
	domain: 'notes.example.test',
	target: {
		provider: 'zerops',
		version: zeropsStoredTargetCodec.version,
		payload: zeropsStoredTargetCodec.encode({ projectId: 'project-1', serviceId: 'service-1' }),
	},
	artifact: {
		provider: 'zerops',
		version: zeropsArtifactCodec.version,
		payload: zeropsArtifactCodec.encode(compileFabrikaManifest(config, 'prod')),
	},
	...overrides,
})

const deployInput = (recorded: Recorded): ProviderDeployInput => ({
	runId: 'run-1',
	app,
	environment: environment(),
	secrets: {},
	vars: {},
	dryRun: false,
	signal: new AbortController().signal,
	events: {
		log: (line) => {
			recorded.logs.push(line)
		},
		externalId: async (id) => {
			recorded.externalIds.push(id)
		},
	},
})

const makeApi = (recorded: Recorded, status: () => ZeropsAppVersionStatus = () => 'ACTIVE'): ZeropsApi => ({
	importServices: async ({ projectId }) => {
		recorded.calls.push('importServices')
		return { projectId, services: [{ id: 'service-1', name: 'notes', processes: [] }] }
	},
	importProject: async ({ clientId }) => ({ projectId: clientId, services: [] }),
	triggerPipeline: async () => {
		recorded.calls.push('triggerPipeline')
		return { id: 'process-1', appVersionId: 'version-1' }
	},
	getAppVersion: async ({ appVersionId }) => {
		recorded.calls.push(`getAppVersion:${appVersionId}`)
		return { id: appVersionId, status: status() }
	},
	latestAppVersion: async () => ({ id: 'version-1', status: status(), sequence: 1 }),
	cancelBuild: async ({ appVersionId }) => {
		recorded.calls.push(`cancelBuild:${appVersionId}`)
	},
	getService: async ({ serviceId }) => ({ id: serviceId, name: 'notes' }),
	findService: async ({ hostname }) => ({ id: 'service-1', name: hostname }),
	getProject: async ({ projectId }) => ({ id: projectId, name: 'project' }),
	listProjects: async () => [],
	findProjects: async () => [],
	listProjectServices: async () => [],
	listServiceEnv: async () => [{ id: 'env-1', key: 'TOKEN', content: 'blurred' }],
	putServiceEnv: async ({ serviceId, key, value }) => {
		recorded.envWrites.push({ serviceId, key, value })
	},
	deleteServiceEnv: async ({ envId }) => {
		recorded.envDeletes.push(envId)
	},
	getProjectEnv: async ({ projectEnvId }) => ({ id: projectEnvId, key: 'KEY', content: 'value' }),
	getLogAccess: async () => {
		throw new Error('logs unavailable')
	},
	readBuildLog: async () => [],
})

let recorded: Recorded
beforeEach(() => {
	recorded = fresh()
})

describe('Zerops ControlProvider registration', () => {
	test('normalizes a stored target and static artifact without persisting credentials', () => {
		const control = createZeropsControlProvider({ accessToken: 'zt-secret', api: makeApi(recorded) })
		const normalized = control.normalizeRegistration({ app, environment: environment() })
		expect(normalized.environment.target.payload).toEqual({ projectId: 'project-1', serviceId: 'service-1' })
		expect(JSON.stringify(normalized.environment)).not.toContain('zt-secret')
	})

	test('rejects foreign, unsupported, and identity-drifted envelopes', () => {
		const control = createZeropsControlProvider({ accessToken: 'zt-secret', api: makeApi(recorded) })
		expect(() =>
			control.normalizeRegistration({
				app,
				environment: environment({ target: { provider: 'other', version: 1, payload: {} } }),
			})
		).toThrow('belongs to provider')
		expect(() =>
			control.normalizeRegistration({
				app,
				environment: environment({ target: { provider: 'zerops', version: 2, payload: {} } }),
			})
		).toThrow('schema version')
		expect(() => control.normalizeRegistration({ app: { ...app, id: 'other' }, environment: environment() })).toThrow('belongs to app')
		expect(() =>
			control.normalizeRegistration({
				app,
				environment: environment({
					env: 'stage',
				}),
			})
		).toThrow('environment drift')
	})
})

describe('Zerops ControlProvider lifecycle', () => {
	test('composes ephemeral credentials, runs beforeDeploy, and routes run events', async () => {
		let observedRun: RuntimeProviderRun | undefined
		const control = createZeropsControlProvider({
			accessToken: 'zt-secret',
			apiBaseUrl: 'https://api.test',
			propustkaUrl: 'https://iam.test',
			adminKey: 'px-secret',
			api: makeApi(recorded),
			beforeDeploy: async ({ appId, target }) => {
				recorded.beforeDeploy.push(`${appId}:${target.projectId}`)
			},
			execute: async (provider, run) => {
				observedRun = run
				const session = await provider.open(run)
				for (const step of session.plan.steps) {
					await session.execute(step.id)
				}
				return { state: 'succeeded' }
			},
		})
		const outcome = await control.deploy(deployInput(recorded))
		if (observedRun === undefined) {
			throw new Error('expected execute to observe a runtime run')
		}
		const runtimeTarget = zeropsTargetCodec.decode(observedRun.target.payload)
		expect(runtimeTarget).toEqual({
			projectId: 'project-1',
			serviceId: 'service-1',
			accessToken: 'zt-secret',
			apiBaseUrl: 'https://api.test',
			propustkaUrl: 'https://iam.test',
			adminKey: 'px-secret',
		})
		expect(outcome).toEqual({ state: 'succeeded' })
		expect(recorded.beforeDeploy).toEqual(['notes:project-1'])
		expect(recorded.externalIds).toEqual(['version-1'])
		expect(recorded.calls).toContain('importServices')
		expect(recorded.logs.join('\n')).not.toContain('zt-secret')
		expect(JSON.stringify(deployInput(recorded).environment)).not.toContain('zt-secret')
	})

	test('cancels by external id and maps active, terminal, and pending statuses', async () => {
		let current: ZeropsAppVersionStatus = 'BUILDING'
		const control = createZeropsControlProvider({
			accessToken: 'zt-secret',
			api: makeApi(recorded, () => current),
		})
		if (control.cancel === undefined || control.reconcile === undefined) {
			throw new Error('expected Zerops lifecycle capabilities')
		}
		const reference = { runId: 'run-1', externalId: 'version-1', environment: environment() }
		expect(await control.reconcile(reference)).toEqual<ProviderReconcileOutcome>({ state: 'running' })
		current = 'ACTIVE'
		expect(await control.reconcile(reference)).toEqual<ProviderReconcileOutcome>({ state: 'succeeded' })
		current = 'BUILD_FAILED'
		expect(await control.reconcile(reference)).toEqual<ProviderReconcileOutcome>({ state: 'failed' })
		await control.cancel(reference)
		expect(recorded.calls).toContain('cancelBuild:version-1')
	})

	test('writes and deletes one service-level secret and returns an opaque reference', async () => {
		const control = createZeropsControlProvider({ accessToken: 'zt-secret', api: makeApi(recorded) })
		if (control.secrets === undefined) {
			throw new Error('expected Zerops managed secrets')
		}
		const stored = await control.secrets.put({ environment: environment(), name: 'TOKEN', value: 'secret-value' })
		await control.secrets.delete({ environment: environment(), name: 'TOKEN' })
		expect(stored).toEqual({ valueRef: 'zerops:service-1/TOKEN' })
		expect(recorded.envWrites).toEqual([{ serviceId: 'service-1', key: 'TOKEN', value: 'secret-value' }])
		expect(recorded.envDeletes).toEqual(['env-1'])
	})
})
