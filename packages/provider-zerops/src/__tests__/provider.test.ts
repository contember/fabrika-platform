import type { AppSchema } from '@fabrika/auth-core'
import type { JsonValue } from '@fabrika/provider-contract'
import { ProviderInvocationAbort } from '@fabrika/provider-contract'
import { beforeEach, describe, expect, test } from 'bun:test'
import {
	createZeropsApi,
	type FetchLike,
	type ZeropsApi,
	ZeropsApiError,
	type ZeropsAppVersion,
	type ZeropsLogAccess,
	type ZeropsProcess,
	type ZeropsServiceEnv,
} from '../api'
import type { ZeropsCollaborators } from '../collaborators'
import { assertZeropsInvariants, compileImportYaml, compileProvisioningYaml } from '../compile'
import { type ManagedOwner, mapManagedKeys, serializeManagedMarker, verifyManagedCheckpoint } from '../managed-environment/protocol'
import { compileFabrikaManifest, hashFabrikaManifest } from '../manifest'
import { CANCELLED, createZeropsDeployer, type ZeropsDeployResult, type ZeropsDeployRun, type ZeropsSourceTransportRouting } from '../provider'
import type { ZeropsServiceType } from '../schema.generated'
import type { ZeropsAppConfig, ZeropsRuntimeTarget, ZeropsServiceSpec } from '../types'
import { CANONICAL_DESCRIPTOR, SOURCE_DESCRIPTOR } from './fixtures/descriptor'

const managedOwner: ManagedOwner = {
	protocol: 1,
	appId: 'demo',
	environment: 'prod',
	namespaceId: 'apps-prod',
	projectId: 'project-1',
	serviceId: 'service-1',
	hostname: 'api',
}

interface Recorded {
	calls: string[]
	imports: Array<{ projectId: string; yaml: string }>
	triggers: Array<{ serviceId: string; buildFromGit?: string; zeropsSetup?: string }>
	externalIds: string[]
	logs: string[]
	schemas: string[]
	schemaSignals: AbortSignal[]
	sleeps: number[]
	externalStates: Array<JsonValue | undefined>
	checkpoints: JsonValue[]
	creates: Array<{ serviceId: string; name?: string }>
	builds: Array<{ appVersionId: string; zeropsYaml: string; zeropsYamlSetup?: string }>
	uploads: Array<{ runId: string; appVersionId: string; commitSha: string; descriptorSha256: string; githubInstallationId?: number }>
	v2Uploads: Array<{ connectionId: string; installationId: number }>
	timeline: string[]
	sourceCancelSignals: AbortSignal[]
	deleteSignals: AbortSignal[]
}

const fresh = (): Recorded => ({
	calls: [],
	imports: [],
	triggers: [],
	externalIds: [],
	logs: [],
	schemas: [],
	schemaSignals: [],
	sleeps: [],
	externalStates: [],
	checkpoints: [],
	creates: [],
	builds: [],
	uploads: [],
	v2Uploads: [],
	timeline: [],
	sourceCancelSignals: [],
	deleteSignals: [],
})

interface Overrides {
	statuses?: Array<ZeropsAppVersion['status']>
	processStatuses?: Array<ZeropsProcess['status']>
	triggerVersionId?: string
	latestVersion?: ZeropsAppVersion | null
	buildError?: Error
	deleteError?: Error
	uploadError?: Error
	versionErrors?: number
	cancelMode?: 'throw' | 'hang'
	importProcesses?: { id: string; status: ZeropsProcess['status'] }[]
	pipelineStart?: string
	/** Wire the REAL log reader to a canned window, so the relay's version scoping is exercised end to end. */
	logFetch?: FetchLike
}

const LOG_ACCESS: ZeropsLogAccess = {
	url: 'https://logs.test/all',
	urlPlain: 'https://logs.test/plain',
	urlInfo: 'https://logs.test/info',
	urlUi: 'https://logs.test/ui',
	accessToken: 'log-token',
	expiration: '2099-01-01T00:00:00Z',
}

const makeApi = (recorded: Recorded, overrides: Overrides = {}): ZeropsApi => {
	let poll = 0
	let processPoll = 0
	let versionErrors = overrides.versionErrors ?? 0
	const deleted = new Set<string>()
	const records: ZeropsServiceEnv[] = [{
		id: 'marker-1',
		key: 'FABRIKA_MENV_PROTOCOL',
		content: serializeManagedMarker({ ...managedOwner, creationProcessId: 'creation-1', initialCodelessAppVersionId: 'bootstrap-1' }),
		sensitive: true,
	}]
	return {
		importServices: async ({ projectId, yaml }) => {
			recorded.calls.push('importServices')
			recorded.imports.push({ projectId, yaml })
			return { projectId, services: [{ id: 'service-1', name: 'api', processes: overrides.importProcesses ?? [] }] }
		},
		importProject: async ({ clientId }) => ({ projectId: clientId, services: [] }),
		triggerPipeline: async ({ serviceId, buildFromGit, zeropsSetup }) => {
			recorded.calls.push('triggerPipeline')
			recorded.triggers.push({ serviceId, buildFromGit, zeropsSetup })
			return overrides.triggerVersionId === undefined ? null : { id: 'process-1', appVersionId: overrides.triggerVersionId }
		},
		createAppVersion: async ({ serviceId, name }) => {
			recorded.calls.push(`createAppVersion:${serviceId}`)
			recorded.timeline.push('create')
			recorded.creates.push({ serviceId, ...(name === undefined ? {} : { name }) })
			return { id: overrides.triggerVersionId ?? 'version-1', uploadUrl: 'https://upload.test/archive?signature=test' }
		},
		buildAndDeployAppVersion: async ({ appVersionId, zeropsYaml, zeropsYamlSetup }) => {
			recorded.calls.push(`buildAndDeployAppVersion:${appVersionId}`)
			recorded.timeline.push('build-call')
			recorded.builds.push({ appVersionId, zeropsYaml, ...(zeropsYamlSetup === undefined ? {} : { zeropsYamlSetup }) })
			if (overrides.buildError !== undefined) throw overrides.buildError
			return { id: 'process-1', appVersionId }
		},
		deleteAppVersion: async ({ appVersionId, signal }) => {
			recorded.calls.push(`deleteAppVersion:${appVersionId}`)
			recorded.deleteSignals.push(signal)
			if (overrides.deleteError !== undefined) throw overrides.deleteError
			deleted.add(appVersionId)
		},
		getAppVersion: async ({ appVersionId }) => {
			recorded.calls.push('getAppVersion')
			if (deleted.has(appVersionId)) throw new ZeropsApiError('absent', 400, 'appVersionNotFound')
			if (versionErrors > 0) {
				versionErrors--
				throw new Error('status observation unavailable')
			}
			const statuses = overrides.statuses ?? ['ACTIVE']
			const status = statuses[Math.min(poll, statuses.length - 1)]
			poll++
			return { id: appVersionId, status, ...(overrides.pipelineStart === undefined ? {} : { build: { pipelineStart: overrides.pipelineStart } }) }
		},
		latestAppVersion: async () => overrides.latestVersion ?? { id: 'version-1', sequence: 1 },
		cancelBuild: async () => {
			recorded.calls.push('cancelBuild')
		},
		getProcess: async ({ processId }) => {
			recorded.calls.push('getProcess')
			const statuses = overrides.processStatuses ?? ['FINISHED']
			const status = statuses[Math.min(processPoll, statuses.length - 1)]
			processPoll++
			return { id: processId, status }
		},
		createIntegrationToken: async () => {
			throw new Error('the deploy driver must not mint a Zerops token')
		},
		enableSubdomainAccess: async () => {
			recorded.calls.push('enableSubdomainAccess')
		},
		getService: async ({ serviceId }) => ({ id: serviceId, name: 'api' }),
		findService: async ({ hostname }) => ({ id: 'service-1', name: hostname }),
		getProject: async ({ projectId }) => ({ id: projectId, name: 'project' }),
		listProjects: async () => [],
		findProjects: async () => [],
		listProjectServices: async () => [],
		listServiceEnv: async () => records.map((record) => ({ ...record })),
		createServiceEnv: async ({ key, value }) => {
			if (records.some((record) => record.key === key)) throw new ZeropsApiError('duplicate', 400, 'userDataDuplicateKey')
			records.push({ id: `backing-${records.length}`, key, content: value, sensitive: true, type: 'USER' })
			recorded.calls.push('createServiceEnv')
		},
		putServiceEnv: async () => {
			recorded.calls.push('putServiceEnv')
		},
		deleteServiceEnv: async () => {},
		getProjectEnv: async ({ projectEnvId }) => ({ id: projectEnvId, key: 'KEY', content: 'value' }),
		getLogAccess: async () => LOG_ACCESS,
		readBuildLog: overrides.logFetch === undefined
			? async () => [{ message: 'building' }]
			: createZeropsApi({ token: 'unused', baseUrl: 'https://zerops.test', fetchImpl: overrides.logFetch }).readBuildLog,
	}
}

const makeCollaborators = (recorded: Recorded, overrides: Overrides = {}): ZeropsCollaborators => ({
	api: makeApi(recorded, overrides),
	source: {
		resolve: async (input) => ({
			runId: input.runId,
			commitSha: input.expectedCommitSha ?? input.requestedRef,
			descriptorSha256: input.descriptorSha256,
		}),
		upload: async (input) => {
			recorded.calls.push(`sourceUpload:${input.appVersionId}`)
			recorded.timeline.push('upload')
			if (overrides.uploadError !== undefined) throw overrides.uploadError
			recorded.uploads.push({
				runId: input.runId,
				appVersionId: input.appVersionId,
				commitSha: input.commitSha,
				descriptorSha256: input.descriptor.sha256,
				...(input.githubInstallationId === undefined ? {} : { githubInstallationId: input.githubInstallationId }),
			})
			return {
				runId: input.runId,
				appVersionId: input.appVersionId,
				commitSha: input.commitSha,
				descriptorSha256: input.descriptor.sha256,
			}
		},
		cancel: async ({ appVersionId, signal }) => {
			recorded.calls.push(`sourceCancel:${appVersionId}`)
			recorded.sourceCancelSignals.push(signal)
			if (overrides.cancelMode === 'throw') throw new Error('source cancellation unavailable')
			if (overrides.cancelMode === 'hang') return new Promise<void>(() => {})
		},
	},
	sourceCancelSleep: async () => {
		if (overrides.cancelMode === 'hang') recorded.calls.push('sourceCancelTimeout')
	},
	reconcileSchema: async ({ app, signal }) => {
		recorded.calls.push('reconcileSchema')
		recorded.schemas.push(app)
		recorded.schemaSignals.push(signal)
	},
	sleep: async (ms) => {
		recorded.sleeps.push(ms)
	},
})

const SCHEMA: AppSchema = { scopes: [], actions: [], roles: {} }
const API: ZeropsServiceSpec = { hostname: 'api', type: 'alpine/bun@1.3' }
const DB: ZeropsServiceSpec = { hostname: 'db', type: 'postgresql:single@18', priority: 10 }

const app = (services: ZeropsServiceSpec[] = [API]): ZeropsAppConfig => ({
	id: 'demo',
	schema: SCHEMA,
	pipeline: { secrets: ['TOKEN'], vars: ['IMAGE'] },
	target: {
		platform: 'zerops',
		services: () => services.map((service) => service.hostname === 'api' ? { ...service, buildFromGit: process.env['IMAGE'] } : service),
		deployService: 'api',
		zeropsSetup: 'api',
	},
})

const target = (overrides: Partial<ZeropsRuntimeTarget> = {}): ZeropsRuntimeTarget => ({
	projectId: 'project-1',
	serviceId: 'service-1',
	accessToken: 'zt-secret',
	managedAdmission: { owner: managedOwner, markerRecordId: 'marker-1' },
	source: {
		runId: 'run-1',
		repository: { owner: 'acme', name: 'demo' },
		commitSha: '0123456789abcdef0123456789abcdef01234567',
	},
	propustkaUrl: 'https://iam.test',
	adminKey: 'px-secret',
	...overrides,
})

type ZeropsDeployer = ReturnType<typeof createZeropsDeployer>

const deployRun = (
	recorded: Recorded,
	targetValue: ZeropsRuntimeTarget = target(),
	dryRun = false,
	signal: AbortSignal = new AbortController().signal,
): ZeropsDeployRun => ({
	appId: 'demo',
	env: 'prod',
	secrets: {},
	vars: { IMAGE: 'registry.test/demo:v2' },
	managedEnvironment: mapManagedKeys(() => null),
	dryRun,
	signal,
	events: {
		log: (line) => {
			recorded.logs.push(line)
		},
		externalId: async (id, state) => {
			recorded.externalIds.push(id)
			recorded.externalStates.push(state)
			recorded.timeline.push('external-id')
		},
		checkpoint: async (state) => {
			recorded.checkpoints.push(state)
			const phase = typeof state === 'object' && state !== null && !Array.isArray(state) ? state['phase'] : undefined
			recorded.timeline.push(`checkpoint:${typeof phase === 'string' ? phase : 'invalid'}`)
		},
	},
	target: targetValue,
	artifact: compileFabrikaManifest(app([DB, API]), 'prod', SOURCE_DESCRIPTOR),
})

/** Run the whole deploy and surface the first failed step as a rejection. */
const execute = async (run: ZeropsDeployRun, deployer: ZeropsDeployer): Promise<void> => {
	const result = await deployer(run)
	const failed = result.steps.find((step) => step.status === 'failed')
	if (failed !== undefined) throw new Error(failed.error)
}

/** Run the whole deploy, cancelling it as `stepId` starts, so the steps before it are observed alone. */
const deployUntil = (deployer: ZeropsDeployer, run: ZeropsDeployRun, stepId: string): Promise<ZeropsDeployResult> => {
	const controller = new AbortController()
	return deployer({
		...run,
		signal: controller.signal,
		events: {
			...run.events,
			log: (line) => {
				if (line === `→ ${stepId}`) controller.abort()
				run.events.log(line)
			},
		},
	})
}

const stepError = (result: ZeropsDeployResult, id: string): string | undefined => result.steps.find((step) => step.id === id)?.error

/** A step abandoned on cancellation keeps running until it notices; let it finish before asserting its effects. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

let recorded: Recorded
beforeEach(() => {
	recorded = fresh()
})

describe('Zerops provider', () => {
	test('stages immutable records with durable per-key progress and overlays references without values', async () => {
		const collaborators = makeCollaborators(recorded)
		const provider = createZeropsDeployer(() => collaborators)
		const values = mapManagedKeys((key) => key === 'FABRIKA_IAM_ISSUER' ? null : key === 'FABRIKA_SERVICE_KEY' ? '' : `private-${key}`)
		await execute({ ...deployRun(recorded), managedEnvironment: values }, provider)
		const initial = await verifyManagedCheckpoint(recorded.externalStates[0])
		expect(initial.phase).toBe('managed_env_staging')
		expect(Object.values(initial.binding).filter((entry) => entry.state === 'pending')).toHaveLength(5)
		const checkpoints = await Promise.all(recorded.checkpoints.map(verifyManagedCheckpoint))
		expect(checkpoints.map((state) => state.phase)).toEqual([
			'managed_env_staging',
			'managed_env_staging',
			'managed_env_staging',
			'managed_env_staging',
			'managed_env_staging',
			'managed_env_staged',
			'source_uploaded',
			'build_trigger_requested',
			'build_triggered',
		])
		for (let index = 0; index < 5; index++) {
			const state = checkpoints[index]
			if (state === undefined) throw new Error('missing checkpoint')
			expect(Object.values(state.binding).filter((entry) => entry.state === 'confirmed')).toHaveLength(index + 1)
		}
		const final = checkpoints.at(-1)
		if (final === undefined) throw new Error('missing final binding')
		const records = await collaborators.api.listServiceEnv({ serviceId: 'service-1', signal: new AbortController().signal })
		for (const [key, entry] of Object.entries(final.binding)) {
			if (entry.state === 'absent') {
				expect(recorded.builds[0]?.zeropsYaml).not.toContain(key)
				continue
			}
			if (entry.state !== 'confirmed') throw new Error('unconfirmed final binding')
			expect(records.find((record) => record.id === entry.backingRecordId)?.key).toBe(entry.referenceName)
			expect(recorded.builds[0]?.zeropsYaml).toContain(`\${${entry.referenceName}}`)
		}
		expect(JSON.stringify(recorded.checkpoints)).not.toContain('private-')
		expect(recorded.builds[0]?.zeropsYaml).not.toContain('private-')
		expect(recorded.logs.join('\n')).not.toContain('private-')
		expect(recorded.calls).not.toContain('putServiceEnv')
		expect(recorded.uploads[0]?.descriptorSha256).toBe(SOURCE_DESCRIPTOR.sha256)
	})

	for (const failure of ['checkpoint', 'lease']) {
		test(`interrupted staging at ${failure} never uploads or submits and retains created backing records`, async () => {
			const controller = new AbortController()
			const collaborators = makeCollaborators(recorded)
			const provider = createZeropsDeployer(() => collaborators)
			const run = deployRun(recorded, target(), false, controller.signal)
			const reason = new ProviderInvocationAbort('lease_lost')
			const result = await provider({
				...run,
				managedEnvironment: mapManagedKeys(() => 'private-value'),
				events: {
					...run.events,
					checkpoint: async () => {
						if (failure === 'lease') controller.abort(reason)
						throw reason
					},
				},
			})
			await settled()
			expect(stepError(result, 'trigger-deploy')).toBe(failure === 'lease' ? CANCELLED : reason.message)
			expect(recorded.uploads).toEqual([])
			expect(recorded.builds).toEqual([])
			const entries = await collaborators.api.listServiceEnv({ serviceId: 'service-1', signal: new AbortController().signal })
			expect(entries.filter((entry) => entry.key !== 'FABRIKA_MENV_PROTOCOL')).toHaveLength(1)
			if (failure === 'lease') {
				expect(recorded.calls).not.toContain('sourceCancel:version-1')
				expect(recorded.calls).not.toContain('deleteAppVersion:version-1')
			}
		})
	}

	test('recovers a lost create response by exact readback and never uses mutable writes', async () => {
		const collaborators = makeCollaborators(recorded)
		const create = collaborators.api.createServiceEnv
		collaborators.api.createServiceEnv = async (input) => {
			await create(input)
			throw new Error('response lost')
		}
		const provider = createZeropsDeployer(() => collaborators)
		await execute(
			{ ...deployRun(recorded), managedEnvironment: { ...mapManagedKeys(() => null), FABRIKA_RELEASE: 'private-release' } },
			provider,
		)
		expect(recorded.builds).toHaveLength(1)
		expect(recorded.calls.filter((call) => call === 'createServiceEnv')).toHaveLength(1)
		expect(recorded.calls).not.toContain('putServiceEnv')
	})

	test('routes an upload through v2 only when the runtime source carries a keyed binding', async () => {
		const routing: ZeropsSourceTransportRouting = {
			uploadV2: async (input) => {
				const privateBinding = input.privateBinding
				if (privateBinding === undefined) throw new Error('missing private binding')
				recorded.v2Uploads.push(privateBinding)
				return {
					runId: input.runId,
					appVersionId: input.appVersionId,
					commitSha: input.commitSha,
					descriptorSha256: input.descriptor.sha256,
				}
			},
		}
		const provider = createZeropsDeployer(() => makeCollaborators(recorded), routing)
		const publicTarget = target({
			source: {
				runId: 'run-1',
				repository: { owner: 'acme', name: 'demo' },
				commitSha: '0123456789abcdef0123456789abcdef01234567',
			},
		})
		const privateTarget = target({
			source: {
				runId: 'run-1',
				repository: { owner: 'acme', name: 'demo' },
				commitSha: '0123456789abcdef0123456789abcdef01234567',
				privateBinding: { connectionId: 'keyed-connection', installationId: 42 },
			},
		})

		// No binding is the anonymous public-repository path, and it is the only remaining v1 upload.
		await execute(deployRun(recorded, publicTarget), provider)
		expect(recorded.uploads).toHaveLength(1)
		expect(recorded.v2Uploads).toHaveLength(0)

		await execute(deployRun(recorded, privateTarget), provider)
		expect(recorded.uploads).toHaveLength(1)
		expect(recorded.v2Uploads).toEqual([{ connectionId: 'keyed-connection', installationId: 42 }])
	})

	test('waits for the import processes before triggering, because an import answers before its services exist', async () => {
		const provider = createZeropsDeployer(() =>
			makeCollaborators(recorded, {
				importProcesses: [{ id: 'import-1', status: 'RUNNING' }],
				processStatuses: ['RUNNING', 'FINISHED', 'FINISHED'],
				triggerVersionId: 'version-1',
			})
		)
		await deployUntil(provider, deployRun(recorded, target()), 'trigger-deploy')

		// Triggering a pipeline on a service Zerops is still creating answers 400
		// `projectImportInvalidParameter`; the first deploy into a fresh namespace hit exactly that.
		expect(recorded.calls).toEqual(['importServices', 'getProcess', 'getProcess'])
	})

	test('owns a distinct plan and runs it in order', async () => {
		const controller = new AbortController()
		const provider = createZeropsDeployer(() =>
			makeCollaborators(recorded, { statuses: ['BUILDING', 'ACTIVE'], processStatuses: ['RUNNING', 'FINISHED'], triggerVersionId: 'version-1' })
		)
		const result = await provider(deployRun(recorded, target(), false, controller.signal))
		expect(result.status).toBe('succeeded')
		expect(result.steps.map((step) => step.id)).toEqual(['apply-import', 'trigger-deploy', 'await-deploy', 'reconcile-schema'])
		expect(recorded.calls).toEqual([
			'importServices',
			'createAppVersion:service-1',
			'sourceUpload:version-1',
			'buildAndDeployAppVersion:version-1',
			'getProcess',
			'getAppVersion',
			'getProcess',
			'getAppVersion',
			'reconcileSchema',
		])
		expect(recorded.externalIds).toEqual(['version-1'])
		const frozen = {
			...managedOwner,
			runId: 'run-1',
			appVersionId: 'version-1',
			markerRecordId: 'marker-1',
			originalArtifactSha256: await hashFabrikaManifest(compileFabrikaManifest(app([DB, API]), 'prod', SOURCE_DESCRIPTOR)),
			descriptorSha256: SOURCE_DESCRIPTOR.sha256,
			setup: 'api',
			sourceCommitSha: '0123456789abcdef0123456789abcdef01234567',
			binding: mapManagedKeys(() => ({ state: 'absent' })),
		}
		expect(recorded.externalStates).toEqual([{ ...frozen, phase: 'managed_env_staging' }])
		expect(recorded.checkpoints).toEqual([
			{ ...frozen, phase: 'managed_env_staged' },
			{ ...frozen, phase: 'source_uploaded' },
			{ ...frozen, phase: 'build_trigger_requested' },
			{ ...frozen, phase: 'build_triggered', processId: 'process-1' },
		])
		expect(recorded.timeline).toEqual([
			'create',
			'external-id',
			'checkpoint:managed_env_staged',
			'upload',
			'checkpoint:source_uploaded',
			'checkpoint:build_trigger_requested',
			'build-call',
			'checkpoint:build_triggered',
		])
		expect(recorded.creates).toEqual([{ serviceId: 'service-1', name: 'run-1' }])
		expect(recorded.uploads).toEqual([{
			runId: 'run-1',
			appVersionId: 'version-1',
			commitSha: '0123456789abcdef0123456789abcdef01234567',
			descriptorSha256: SOURCE_DESCRIPTOR.sha256,
		}])
		expect(recorded.builds).toEqual([{
			appVersionId: 'version-1',
			zeropsYaml: 'zerops:\n  - setup: api\n    run:\n      envVariables: {}\n',
			zeropsYamlSetup: 'api',
		}])
		expect(recorded.sleeps).toEqual([3000])
		expect(recorded.imports[0]?.yaml).toContain('registry.test/demo:v2')
		expect(recorded.triggers).toEqual([])
		expect(recorded.schemas).toEqual(['demo'])
		expect(recorded.schemaSignals).toEqual([controller.signal])
		expect(recorded.logs.join('\n')).not.toContain('zt-secret')
		expect(recorded.logs.join('\n')).not.toContain('px-secret')
		expect(recorded.logs.join('\n')).not.toContain('signature=test')
	})

	test('fails on the trigger process after one poll when the app version remains waiting', async () => {
		const provider = createZeropsDeployer(() =>
			makeCollaborators(recorded, { statuses: ['WAITING_TO_BUILD'], processStatuses: ['FAILED'], triggerVersionId: 'version-waiting' })
		)
		const result = await provider(deployRun(recorded))

		expect(stepError(result, 'await-deploy')).toBe('zerops: pipeline process process-1 is FAILED while app-version version-waiting is WAITING_TO_BUILD')
		expect(result.steps.map((step) => step.status)).toEqual(['succeeded', 'succeeded', 'failed', 'skipped'])
		expect(recorded.calls).toEqual([
			'importServices',
			'createAppVersion:service-1',
			'sourceUpload:version-waiting',
			'buildAndDeployAppVersion:version-waiting',
			'getProcess',
			'getAppVersion',
		])
		expect(recorded.sleeps).toEqual([])
	})

	test('does not accept an active app version when its trigger process failed', async () => {
		const provider = createZeropsDeployer(() =>
			makeCollaborators(recorded, { statuses: ['ACTIVE'], processStatuses: ['FAILED'], triggerVersionId: 'version-active' })
		)
		const result = await provider(deployRun(recorded))

		expect(stepError(result, 'await-deploy')).toBe('zerops: pipeline process process-1 is FAILED while app-version version-active is ACTIVE')
		expect(result.steps.map((step) => step.status)).toEqual(['succeeded', 'succeeded', 'failed', 'skipped'])
		expect(recorded.calls).toEqual([
			'importServices',
			'createAppVersion:service-1',
			'sourceUpload:version-active',
			'buildAndDeployAppVersion:version-active',
			'getProcess',
			'getAppVersion',
		])
		expect(recorded.sleeps).toEqual([])
	})

	test('uses the process returned by upload-backed build-and-deploy', async () => {
		const provider = createZeropsDeployer(() => makeCollaborators(recorded, { statuses: ['ACTIVE'] }))
		await deployUntil(provider, deployRun(recorded), 'reconcile-schema')

		expect(recorded.calls).toEqual([
			'importServices',
			'createAppVersion:service-1',
			'sourceUpload:version-1',
			'buildAndDeployAppVersion:version-1',
			'getProcess',
			'getAppVersion',
		])
		expect(recorded.externalIds).toEqual(['version-1'])
	})

	test('deletes a reserved version when source upload fails without exposing its destination', async () => {
		const provider = createZeropsDeployer(() =>
			makeCollaborators(recorded, { uploadError: new Error('source upload failed'), statuses: ['UPLOADING'] })
		)
		const result = await provider(deployRun(recorded))

		expect(stepError(result, 'trigger-deploy')).toBe('source upload failed')
		expect(recorded.calls).toEqual([
			'importServices',
			'createAppVersion:service-1',
			'sourceUpload:version-1',
			'sourceCancel:version-1',
			'deleteAppVersion:version-1',
			'getAppVersion',
		])
		expect(recorded.timeline).toEqual(['create', 'external-id', 'checkpoint:managed_env_staged', 'upload'])
		expect(recorded.logs.join('\n')).not.toContain('signature=test')
	})

	test('observes the frozen version after a build refusal without deleting or resubmitting', async () => {
		const provider = createZeropsDeployer(() =>
			makeCollaborators(recorded, { buildError: new ZeropsApiError('zerops: build rejected', 400, 'invalidBuild'), statuses: ['UPLOADING'] })
		)
		await deployUntil(provider, deployRun(recorded), 'await-deploy')

		expect(recorded.calls).toEqual([
			'importServices',
			'createAppVersion:service-1',
			'sourceUpload:version-1',
			'buildAndDeployAppVersion:version-1',
			'getAppVersion',
		])
		expect((await verifyManagedCheckpoint(recorded.checkpoints.at(-1))).phase).toBe('build_trigger_requested')
	})

	test('does not attempt cleanup after a synchronization refusal at the submission boundary', async () => {
		const provider = createZeropsDeployer(() =>
			makeCollaborators(recorded, {
				buildError: new ZeropsApiError('zerops: build and deploy app-version failed (400) — userDataSyncRunning', 400, 'userDataSyncRunning'),
				deleteError: new ZeropsApiError('zerops: delete app-version failed (400)', 400, ''),
				statuses: ['UPLOADING'],
			})
		)
		await deployUntil(provider, deployRun(recorded), 'await-deploy')

		expect(recorded.calls).not.toContain('deleteAppVersion:version-1')
		expect(recorded.calls).not.toContain('sourceCancel:version-1')
		expect((await verifyManagedCheckpoint(recorded.checkpoints.at(-1))).phase).toBe('build_trigger_requested')
	})

	test('keeps an ambiguous build trigger observable when its first status read fails', async () => {
		const provider = createZeropsDeployer(() =>
			makeCollaborators(recorded, {
				buildError: new Error('build response lost'),
				versionErrors: 1,
				statuses: ['ACTIVE'],
			})
		)
		await deployUntil(provider, deployRun(recorded), 'reconcile-schema')

		expect(recorded.calls).toEqual([
			'importServices',
			'createAppVersion:service-1',
			'sourceUpload:version-1',
			'buildAndDeployAppVersion:version-1',
			'getAppVersion',
			'getAppVersion',
		])
		expect(recorded.calls).not.toContain('deleteAppVersion:version-1')
		expect(recorded.sleeps).toEqual([10000])
	})

	test('does not delete an ambiguous build while Zerops omits its status', async () => {
		const provider = createZeropsDeployer(() =>
			makeCollaborators(recorded, {
				buildError: new Error('build response lost'),
				statuses: [undefined, 'ACTIVE'],
			})
		)
		await deployUntil(provider, deployRun(recorded), 'reconcile-schema')

		expect(recorded.calls).not.toContain('deleteAppVersion:version-1')
		expect((await verifyManagedCheckpoint(recorded.checkpoints.at(-1))).phase).toBe('build_trigger_requested')
	})

	test('propagates a rejected result checkpoint while preserving accepted work for recovery', async () => {
		const provider = createZeropsDeployer(() => makeCollaborators(recorded, { statuses: ['ACTIVE'] }))
		const run = deployRun(recorded)
		const result = await provider({
			...run,
			events: {
				...run.events,
				checkpoint: async (state) => {
					recorded.checkpoints.push(state)
					const phase = typeof state === 'object' && state !== null && !Array.isArray(state) ? state['phase'] : undefined
					if (phase === 'build_triggered') throw new Error('checkpoint unavailable')
				},
			},
		})

		expect(stepError(result, 'trigger-deploy')).toBe('checkpoint unavailable')

		expect(recorded.calls).not.toContain('getAppVersion')
		expect(recorded.calls).not.toContain('deleteAppVersion:version-1')
		expect((await verifyManagedCheckpoint(recorded.checkpoints.at(-2))).phase).toBe('build_trigger_requested')
	})

	test('bounds a hanging source cancellation before deleting the version', async () => {
		const provider = createZeropsDeployer(() => makeCollaborators(recorded, { uploadError: new Error('source upload failed'), cancelMode: 'hang' }))
		const result = await provider(deployRun(recorded))

		expect(stepError(result, 'trigger-deploy')).toBe('source upload failed')
		expect(recorded.calls).toEqual([
			'importServices',
			'createAppVersion:service-1',
			'sourceUpload:version-1',
			'sourceCancel:version-1',
			'sourceCancelTimeout',
			'deleteAppVersion:version-1',
			'getAppVersion',
		])
		expect(recorded.sourceCancelSignals[0]?.aborted).toBe(true)
		expect(recorded.deleteSignals[0]?.aborted).toBe(false)
		expect(recorded.deleteSignals[0]).not.toBe(recorded.sourceCancelSignals[0])
	})

	test('rejects a changed registered descriptor before reserving an app version', async () => {
		const provider = createZeropsDeployer(() => makeCollaborators(recorded))
		const run = deployRun(recorded)
		const driftedArtifact = compileFabrikaManifest(app([DB, API]), 'prod', {
			...SOURCE_DESCRIPTOR,
			contents: `${SOURCE_DESCRIPTOR.contents}# changed after registration\n`,
		})
		const result = await provider({ ...run, artifact: driftedArtifact })

		expect(stepError(result, 'trigger-deploy')).toContain('source descriptor digest')
		expect(recorded.calls).toEqual(['importServices'])
	})

	test('cancels the build after an observed process and version when the run is aborted', async () => {
		const controller = new AbortController()
		const provider = createZeropsDeployer(() => ({
			...makeCollaborators(recorded, {
				statuses: ['BUILDING'],
				processStatuses: ['RUNNING'],
				triggerVersionId: 'version-1',
			}),
			sleep: async (ms) => {
				recorded.sleeps.push(ms)
				controller.abort()
			},
		}))
		const result = await provider(deployRun(recorded, target(), false, controller.signal))
		await settled()

		expect(stepError(result, 'await-deploy')).toBe(CANCELLED)
		expect(recorded.calls).toEqual([
			'importServices',
			'createAppVersion:service-1',
			'sourceUpload:version-1',
			'buildAndDeployAppVersion:version-1',
			'getProcess',
			'getAppVersion',
			'cancelBuild',
		])
		expect(recorded.sleeps).toEqual([3000])
	})

	test('propagates cancellation into an active schema reconciliation', async () => {
		const controller = new AbortController()
		const started = Promise.withResolvers<void>()
		const provider = createZeropsDeployer(() => ({
			...makeCollaborators(recorded),
			reconcileSchema: (input) => {
				recorded.schemaSignals.push(input.signal)
				return new Promise<void>((_resolve, reject) => {
					const abort = (): void => {
						recorded.calls.push('reconcileSchemaAborted')
						reject(input.signal.reason)
					}
					if (input.signal.aborted) {
						abort()
						return
					}
					input.signal.addEventListener('abort', abort, { once: true })
					started.resolve()
				})
			},
		}))
		const deploying = provider(deployRun(recorded, target(), false, controller.signal))
		await started.promise
		controller.abort()

		const result = await deploying
		expect(stepError(result, 'reconcile-schema')).toBe(CANCELLED)
		expect(recorded.calls.at(-1)).toBe('reconcileSchemaAborted')
		expect(recorded.schemaSignals).toEqual([controller.signal])
	})

	test('dry-run skips every platform and IAM mutation', async () => {
		const provider = createZeropsDeployer(() => makeCollaborators(recorded))
		await execute(deployRun(recorded, target(), true), provider)
		expect(recorded.calls).toEqual([])
		expect(recorded.externalIds).toEqual([])
		expect(recorded.logs.join('\n')).toContain('[dry-run]')
	})

	test('rejects artifact identity drift', async () => {
		const provider = createZeropsDeployer(() => makeCollaborators(recorded))
		const run = deployRun(recorded)
		await expect(provider({ ...run, appId: 'other' })).rejects.toThrow('artifact app drift')
	})

	test('relays only the deployed version, never a line an earlier release left in the runtime window', async () => {
		const PIPELINE_START = '2026-08-21T10:00:00.000000000Z'
		const windows: string[] = []
		const logFetch: FetchLike = async (url) => {
			windows.push(new URL(url).searchParams.get('tags') ?? `serviceStackId=${new URL(url).searchParams.get('serviceStackId')}`)
			if (url.includes('zbuilder%40version-1')) return new Response('2026-08-21T09:20:00.000000000Z zbuilder@version-1 stale build line\n')
			if (url.includes('zbuilder%40version-2')) return new Response('2026-08-21T10:00:02.000000000Z zbuilder@version-2 bun install\n')
			return new Response(
				[
					'2026-08-21T09:21:00.000000000Z zerops@zerops stale boot line',
					'2026-08-21T09:59:59.000000000Z init stale supervisor line',
					'2026-08-21T10:00:12.000000000Z zerops@zerops notes-api listening',
					'',
				].join('\n'),
			)
		}
		const provider = createZeropsDeployer(() => makeCollaborators(recorded, { triggerVersionId: 'version-2', pipelineStart: PIPELINE_START, logFetch }))

		await execute(deployRun(recorded), provider)

		expect(windows).toEqual(['zbuilder@version-2', 'serviceStackId=service-1'])
		expect(recorded.logs.filter((line) => line.startsWith('  │ '))).toEqual([
			'  │ 2026-08-21T10:00:02.000000000Z zbuilder@version-2 bun install',
			'  │ 2026-08-21T10:00:12.000000000Z zerops@zerops notes-api listening',
		])
		expect(recorded.logs.some((line) => line.includes('stale'))).toBe(false)
	})
})

describe('Zerops compiler invariants', () => {
	test('writes service isolation and provisioning without secrets', () => {
		const input = { target: app([DB, API]).target, ctx: { env: 'prod' } }
		const steady = compileImportYaml(input)
		const provision = compileProvisioningYaml(input)
		expect(steady.document.services.every((service) => service.envIsolation === 'service' && service.override === true)).toBe(true)
		expect(provision.document.services.every((service) => service.startWithoutCode === true)).toBe(true)
		expect(provision.yaml).not.toContain('TOKEN')
	})

	test('rejects unsafe finished documents', () => {
		expect(() =>
			assertZeropsInvariants({
				project: { name: 'bad', envIsolation: 'none' },
				services: [{ hostname: 'api', type: 'alpine/bun@1.3', envIsolation: 'service' }],
			})
		).toThrow('envIsolation')
	})

	test('rejects a setup name the platform cannot accept without a repository', () => {
		// Verified against a real account: the platform reads `zeropsSetup` as pipeline configuration and
		// rejects the ENTIRE import with `{"iam.buildFromGit": ["parameter is required for use of
		// pipelineConfig"]}` when no repository accompanies it. That failed the first step of the
		// documented bring-up for every runtime service at once, so it fails at compile time now.
		expect(() =>
			assertZeropsInvariants({
				services: [{ hostname: 'api', type: 'alpine/bun@1.3', envIsolation: 'service', override: true, zeropsSetup: 'api' }],
			})
		).toThrow('names `zeropsSetup` without `buildFromGit`')
	})

	test('and accepts the same setup name once a repository is named', () => {
		expect(() =>
			assertZeropsInvariants({
				services: [{
					hostname: 'api',
					type: 'alpine/bun@1.3',
					envIsolation: 'service',
					override: true,
					zeropsSetup: 'api',
					buildFromGit: 'https://github.com/contember/fabrika-platform',
				}],
			})
		).not.toThrow()
	})

	test('refuses a document whose service omits `override`, whatever class of service it is', () => {
		// Verified against a real account, and it contradicts the published documentation twice over.
		// `override: true` does NOT update or replace an existing service — a changed `profile`,
		// `maxContainers` or `objectStorageSize` is accepted by the API and silently ignored. What it does
		// is stop the hostname collision from failing the import: WITHOUT it the platform answers
		// `400 serviceStackNameUnavailable` and rejects the whole document. And it is not
		// runtime-services-only: the rejection happened on a managed `postgresql:single@18`, before any
		// runtime service in the same document was reached.
		const types: ZeropsServiceType[] = ['alpine/bun@1.3', 'postgresql:ha@18', 'object-storage']
		for (const type of types) {
			expect(() => assertZeropsInvariants({ services: [{ hostname: 'data', type, envIsolation: 'service' }] })).toThrow(
				'must carry `override: true`',
			)
			expect(() => assertZeropsInvariants({ services: [{ hostname: 'data', type, envIsolation: 'service', override: true }] })).not.toThrow()
		}
	})

	test('the API surface has no project-level environment writer', () => {
		const api = makeApi(recorded)
		expect(Reflect.has(api, 'putProjectEnv')).toBe(false)
	})
})
