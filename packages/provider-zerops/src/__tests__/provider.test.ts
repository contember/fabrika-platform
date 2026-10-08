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
import { parseZeropsCheckpoint } from '../control'
import type { ManagedValues } from '../managed-env'
import { compileFabrikaManifest } from '../manifest'
import { CANCELLED, createZeropsDeployer, type ZeropsDeployResult, type ZeropsDeployRun } from '../provider'
import type { ZeropsServiceType } from '../schema.generated'
import type { ZeropsSourceArchive } from '../source/port'
import type { ZeropsAppConfig, ZeropsRuntimeTarget, ZeropsServiceSpec } from '../types'
import { CANONICAL_DESCRIPTOR, SOURCE_DESCRIPTOR } from './fixtures/descriptor'

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
	uploads: Array<{ uploadUrl: string; commitSha: string; descriptorSha256: string; archive: ZeropsSourceArchive }>
	timeline: string[]
	envWrites: Array<{ key: string; value: string }>
	envDeletes: string[]
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
	timeline: [],
	envWrites: [],
	envDeletes: [],
})

const UPLOAD_URL = 'https://proxy.app-prg1.zerops.io/api/rest/object-storage/upload?signature=test'

interface Overrides {
	uploadUrl?: string
	statuses?: Array<ZeropsAppVersion['status']>
	processStatuses?: Array<ZeropsProcess['status']>
	triggerVersionId?: string
	latestVersion?: ZeropsAppVersion | null
	buildError?: Error
	deleteError?: Error
	uploadError?: Error
	versionErrors?: number
	importProcesses?: { id: string; status: ZeropsProcess['status'] }[]
	pipelineStart?: string
	serviceEnv?: ZeropsServiceEnv[]
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
	const records: ZeropsServiceEnv[] = (overrides.serviceEnv ?? []).map((record) => ({ ...record }))
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
			return { id: overrides.triggerVersionId ?? 'version-1', uploadUrl: overrides.uploadUrl ?? UPLOAD_URL }
		},
		buildAndDeployAppVersion: async ({ appVersionId, zeropsYaml, zeropsYamlSetup }) => {
			recorded.calls.push(`buildAndDeployAppVersion:${appVersionId}`)
			recorded.timeline.push('build-call')
			recorded.builds.push({ appVersionId, zeropsYaml, ...(zeropsYamlSetup === undefined ? {} : { zeropsYamlSetup }) })
			if (overrides.buildError !== undefined) throw overrides.buildError
			return { id: 'process-1', appVersionId }
		},
		deleteAppVersion: async ({ appVersionId }) => {
			recorded.calls.push(`deleteAppVersion:${appVersionId}`)
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
		configureAutoscaling: () => Promise.reject(new Error('the deploy driver must not change autoscaling')),
		getService: async ({ serviceId }) => ({ id: serviceId, name: 'api' }),
		findService: async ({ hostname }) => ({ id: 'service-1', name: hostname }),
		getProject: async ({ projectId }) => ({ id: projectId, name: 'project' }),
		listProjects: async () => [],
		findProjects: async () => [],
		listProjectServices: async () => [],
		listServiceEnv: async () => {
			recorded.calls.push('listServiceEnv')
			return records.map((record) => ({ ...record }))
		},
		createServiceEnv: async () => {
			throw new Error('the deploy driver writes service variables only through putServiceEnv')
		},
		putServiceEnv: async ({ key, value }) => {
			recorded.calls.push(`putServiceEnv:${key}`)
			recorded.timeline.push(`put:${key}`)
			recorded.envWrites.push({ key, value })
		},
		deleteServiceEnv: async ({ envId }) => {
			recorded.calls.push(`deleteServiceEnv:${envId}`)
			recorded.timeline.push(`delete:${envId}`)
			recorded.envDeletes.push(envId)
		},
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
			commitSha: input.expectedCommitSha ?? input.requestedRef,
			descriptorSha256: input.descriptorSha256,
		}),
		upload: async (input) => {
			recorded.calls.push('sourceUpload')
			recorded.timeline.push('upload')
			if (overrides.uploadError !== undefined) throw overrides.uploadError
			recorded.uploads.push({
				uploadUrl: input.uploadUrl,
				commitSha: input.commitSha,
				descriptorSha256: input.descriptorSha256,
				archive: input.archive,
			})
			return { commitSha: input.commitSha, descriptorSha256: input.descriptorSha256, entryCount: 1, expandedBytes: 1 }
		},
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

const NO_MANAGED_VALUES: ManagedValues = {
	FABRIKA_RELEASE: null,
	FABRIKA_OPERATIONS_DSN: null,
	FABRIKA_IAM_ISSUER: null,
	FABRIKA_APP_ID: null,
	FABRIKA_ENVIRONMENT: null,
	FABRIKA_SERVICE_KEY: null,
}

const checkpointLabel = (state: JsonValue): string => {
	const parsed = parseZeropsCheckpoint(state)
	return parsed === null ? 'invalid' : `triggered=${String(parsed.triggered)}`
}

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
	managedEnvironment: NO_MANAGED_VALUES,
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
			recorded.timeline.push(`checkpoint:${checkpointLabel(state)}`)
		},
		boundary: async () => {},
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

const RELEASE = 'fabrika/demo/prod/default/0123456789abcdef0123456789abcdef01234567'

let recorded: Recorded
beforeEach(() => {
	recorded = fresh()
})

describe('Zerops provider', () => {
	test('owns a distinct plan and runs it in order, recording the version before upload and the trigger before the build', async () => {
		const controller = new AbortController()
		const provider = createZeropsDeployer(() =>
			makeCollaborators(recorded, { statuses: ['BUILDING', 'ACTIVE'], processStatuses: ['RUNNING', 'FINISHED'], triggerVersionId: 'version-1' })
		)
		const result = await provider(deployRun(recorded, target(), false, controller.signal))
		expect(result.status).toBe('succeeded')
		expect(result.steps.map((step) => step.id)).toEqual([
			'apply-import',
			'write-service-env',
			'reserve-version',
			'upload-source',
			'trigger-build',
			'await-version',
			'reconcile-schema',
		])
		expect(recorded.calls).toEqual([
			'importServices',
			'listServiceEnv',
			'createAppVersion:service-1',
			'sourceUpload',
			'buildAndDeployAppVersion:version-1',
			'getProcess',
			'getAppVersion',
			'getProcess',
			'getAppVersion',
			'reconcileSchema',
		])
		expect(recorded.externalIds).toEqual(['version-1'])
		expect(recorded.externalStates).toEqual([{ appVersionId: 'version-1', triggered: false }])
		expect(recorded.checkpoints).toEqual([{ appVersionId: 'version-1', triggered: true }])
		expect(recorded.timeline).toEqual(['create', 'external-id', 'upload', 'checkpoint:triggered=true', 'build-call'])
		expect(recorded.creates).toEqual([{ serviceId: 'service-1', name: 'run-1' }])
		expect(recorded.uploads).toEqual([{
			uploadUrl: UPLOAD_URL,
			commitSha: '0123456789abcdef0123456789abcdef01234567',
			descriptorSha256: SOURCE_DESCRIPTOR.sha256,
			archive: { kind: 'application' },
		}])
		expect(recorded.builds).toEqual([{ appVersionId: 'version-1', zeropsYaml: CANONICAL_DESCRIPTOR, zeropsYamlSetup: 'api' }])
		expect(recorded.sleeps).toEqual([3000])
		expect(recorded.imports[0]?.yaml).toContain('registry.test/demo:v2')
		expect(recorded.triggers).toEqual([])
		expect(recorded.schemas).toEqual(['demo'])
		expect(recorded.schemaSignals).toEqual([controller.signal])
		const log = recorded.logs.join('\n')
		expect(log).toContain('reserved app-version version-1')
		expect(log).toContain('uploaded 0123456789abcdef0123456789abcdef01234567 to version-1')
		expect(log).toContain('triggered app-version version-1')
		expect(log).not.toContain('zt-secret')
		expect(log).not.toContain('px-secret')
		expect(log).not.toContain('signature=test')
	})

	test('writes FABRIKA_RELEASE only as a literal in the selected setup and the other keys only as service variables', async () => {
		const provider = createZeropsDeployer(() =>
			makeCollaborators(recorded, {
				serviceEnv: [
					{ id: 'env-dsn', key: 'FABRIKA_OPERATIONS_DSN', content: 'private-old-dsn', type: 'USER', sensitive: true },
					{ id: 'env-app', key: 'FABRIKA_APP_ID', content: 'demo', type: 'USER', sensitive: true },
					{ id: 'env-issuer', key: 'FABRIKA_IAM_ISSUER', content: 'https://old-issuer.test', type: 'USER', sensitive: true },
					{ id: 'env-release', key: 'FABRIKA_RELEASE', content: 'stray', type: 'USER', sensitive: true },
					{ id: 'env-own', key: 'TOKEN', content: 'blurred', type: 'USER', sensitive: true },
				],
			})
		)
		await execute({
			...deployRun(recorded),
			managedEnvironment: {
				FABRIKA_RELEASE: RELEASE,
				FABRIKA_OPERATIONS_DSN: 'private-new-dsn',
				FABRIKA_IAM_ISSUER: null,
				FABRIKA_APP_ID: 'demo',
				FABRIKA_ENVIRONMENT: 'prod',
				FABRIKA_SERVICE_KEY: 'private-service-key',
			},
		}, provider)

		expect(recorded.envWrites).toEqual([
			{ key: 'FABRIKA_OPERATIONS_DSN', value: 'private-new-dsn' },
			{ key: 'FABRIKA_ENVIRONMENT', value: 'prod' },
			{ key: 'FABRIKA_SERVICE_KEY', value: 'private-service-key' },
		])
		expect(recorded.envDeletes).toEqual(['env-issuer', 'env-release'])
		// Every service-variable write settles before the build request (`userDataSyncRunning`).
		expect(recorded.timeline.indexOf('delete:env-release')).toBeLessThan(recorded.timeline.indexOf('build-call'))
		expect(Bun.YAML.parse(recorded.builds[0]?.zeropsYaml ?? '')).toEqual({
			zerops: [{ setup: 'api', run: { envVariables: { FABRIKA_RELEASE: RELEASE } } }],
		})
		const yaml = recorded.builds[0]?.zeropsYaml ?? ''
		for (const key of ['FABRIKA_OPERATIONS_DSN', 'FABRIKA_IAM_ISSUER', 'FABRIKA_APP_ID', 'FABRIKA_ENVIRONMENT', 'FABRIKA_SERVICE_KEY']) {
			expect(yaml).not.toContain(key)
		}
		const log = recorded.logs.join('\n')
		expect(log).toContain('FABRIKA_OPERATIONS_DSN: updated')
		expect(log).toContain('FABRIKA_APP_ID: unchanged')
		expect(log).toContain('FABRIKA_IAM_ISSUER: removed')
		expect(log).toContain('FABRIKA_RELEASE: removed')
		expect(log).not.toContain('private-')
		expect(JSON.stringify([recorded.externalStates, recorded.checkpoints])).not.toContain('private-')
	})

	test('omits FABRIKA_RELEASE from the execution descriptor when there is no release', async () => {
		const provider = createZeropsDeployer(() => makeCollaborators(recorded))
		await execute(deployRun(recorded), provider)
		expect(recorded.builds[0]?.zeropsYaml).toBe(CANONICAL_DESCRIPTOR)
		expect(recorded.envWrites).toEqual([])
		expect(recorded.envDeletes).toEqual([])
	})

	test('deletes the reserved version when the source upload fails, without exposing its destination', async () => {
		const provider = createZeropsDeployer(() => makeCollaborators(recorded, { uploadError: new Error('source upload failed') }))
		const result = await provider(deployRun(recorded))

		expect(result.status).toBe('failed')
		expect(stepError(result, 'upload-source')).toBe('source upload failed')
		expect(recorded.calls).toEqual([
			'importServices',
			'listServiceEnv',
			'createAppVersion:service-1',
			'sourceUpload',
			'deleteAppVersion:version-1',
		])
		expect(recorded.checkpoints).toEqual([])
		expect(recorded.builds).toEqual([])
		expect(recorded.logs.join('\n')).toContain('deleted app-version version-1')
		expect(recorded.logs.join('\n')).not.toContain('signature=test')
	})

	test('keeps the upload failure as the reason when the deletion itself fails', async () => {
		const provider = createZeropsDeployer(() =>
			makeCollaborators(recorded, {
				uploadError: new Error('source upload failed'),
				deleteError: new ZeropsApiError('zerops: delete app-version failed (500)', 500, ''),
			})
		)
		const result = await provider(deployRun(recorded))

		expect(result.status).toBe('failed')
		expect(stepError(result, 'upload-source')).toBe('source upload failed')
		expect(recorded.logs.join('\n')).toContain('[warn] app-version version-1 could not be deleted')
	})

	test('a lost lease during upload deletes nothing and submits nothing', async () => {
		const controller = new AbortController()
		const collaborators = makeCollaborators(recorded)
		const source = collaborators.source
		if (source === undefined) throw new Error('missing source')
		const provider = createZeropsDeployer(() => ({
			...collaborators,
			source: {
				...source,
				upload: async () => {
					controller.abort(new ProviderInvocationAbort('lease_lost'))
					throw new ProviderInvocationAbort('lease_lost')
				},
			},
		}))
		const result = await provider(deployRun(recorded, target(), false, controller.signal))
		await settled()

		expect(result.status).toBe('failed')
		expect(recorded.calls).not.toContain('deleteAppVersion:version-1')
		expect(recorded.builds).toEqual([])
		expect(recorded.checkpoints).toEqual([])
	})

	test('does not send the build request when the triggered checkpoint cannot be written', async () => {
		const provider = createZeropsDeployer(() => makeCollaborators(recorded))
		const run = deployRun(recorded)
		const result = await provider({
			...run,
			events: {
				...run.events,
				checkpoint: async () => {
					throw new Error('checkpoint unavailable')
				},
			},
		})

		expect(stepError(result, 'trigger-build')).toBe('checkpoint unavailable')
		expect(recorded.builds).toEqual([])
		expect(recorded.calls.at(-1)).toBe('deleteAppVersion:version-1')
	})

	test('a refused build request fails the run without polling or deleting the version', async () => {
		const provider = createZeropsDeployer(() =>
			makeCollaborators(recorded, { buildError: new ZeropsApiError('zerops: build rejected', 400, 'invalidBuild') })
		)
		const result = await provider(deployRun(recorded))

		expect(result.status).toBe('failed')
		expect(stepError(result, 'trigger-build')).toBe('zerops: build refused (invalidBuild)')
		expect(recorded.calls).not.toContain('getAppVersion')
		expect(recorded.calls).not.toContain('deleteAppVersion:version-1')
	})

	test('a request timeout (408) on the build request is an unknown outcome, so the version is polled', async () => {
		const provider = createZeropsDeployer(() =>
			makeCollaborators(recorded, { buildError: new ZeropsApiError('zerops: build and deploy app-version failed (408)', 408, ''), statuses: ['ACTIVE'] })
		)
		const result = await provider(deployRun(recorded))

		expect(result.status).toBe('succeeded')
		expect(recorded.logs.join('\n')).toContain('build request outcome unknown')
		expect(recorded.calls).not.toContain('deleteAppVersion:version-1')
	})

	test('a cancel arriving after the triggered checkpoint still sends the build, which cancel() can then stop', async () => {
		const controller = new AbortController()
		const provider = createZeropsDeployer(() => makeCollaborators(recorded, { statuses: ['BUILDING'] }))
		const run = deployRun(recorded, target(), false, controller.signal)
		const result = await provider({
			...run,
			events: {
				...run.events,
				checkpoint: async (state) => {
					await run.events.checkpoint(state)
					controller.abort(new ProviderInvocationAbort('cancel_requested'))
				},
			},
		})
		await settled()

		expect(result.status).toBe('failed')
		expect(recorded.checkpoints).toEqual([{ appVersionId: 'version-1', triggered: true }])
		expect(recorded.builds.map((build) => build.appVersionId)).toEqual(['version-1'])
		expect(recorded.calls).not.toContain('deleteAppVersion:version-1')
	})

	test('a lost lease after the triggered checkpoint sends no build request', async () => {
		const controller = new AbortController()
		const provider = createZeropsDeployer(() => makeCollaborators(recorded))
		const run = deployRun(recorded, target(), false, controller.signal)
		const result = await provider({
			...run,
			events: {
				...run.events,
				checkpoint: async (state) => {
					await run.events.checkpoint(state)
					controller.abort(new ProviderInvocationAbort('lease_lost'))
				},
			},
		})
		await settled()

		expect(result.status).toBe('failed')
		expect(recorded.builds).toEqual([])
		expect(recorded.calls).not.toContain('deleteAppVersion:version-1')
		expect(recorded.calls).not.toContain('cancelBuild')
	})

	test('an ambiguous build request keeps polling the version and never deletes it', async () => {
		const provider = createZeropsDeployer(() =>
			makeCollaborators(recorded, { buildError: new Error('build response lost'), versionErrors: 1, statuses: ['BUILDING', 'ACTIVE'] })
		)
		const result = await provider(deployRun(recorded))

		expect(result.status).toBe('succeeded')
		expect(recorded.logs.join('\n')).toContain('build request outcome unknown')
		expect(recorded.calls.filter((call) => call === 'getAppVersion')).toHaveLength(3)
		expect(recorded.calls).not.toContain('deleteAppVersion:version-1')
		expect(recorded.calls).not.toContain('getProcess')
	})

	test('a cancel during the wait cancels the build and leaves the version to cancel()', async () => {
		const controller = new AbortController()
		const provider = createZeropsDeployer(() => ({
			...makeCollaborators(recorded, { statuses: ['BUILDING'], processStatuses: ['RUNNING'], triggerVersionId: 'version-1' }),
			sleep: async (ms) => {
				recorded.sleeps.push(ms)
				controller.abort(new ProviderInvocationAbort('cancel_requested'))
			},
		}))
		const result = await provider(deployRun(recorded, target(), false, controller.signal))
		await settled()

		expect(result.status).toBe('failed')
		expect(recorded.calls).toEqual([
			'importServices',
			'listServiceEnv',
			'createAppVersion:service-1',
			'sourceUpload',
			'buildAndDeployAppVersion:version-1',
			'getProcess',
			'getAppVersion',
			'cancelBuild',
		])
		expect(recorded.sleeps).toEqual([3000])
	})

	test('a lost lease during the wait stops without cancelling the build', async () => {
		const controller = new AbortController()
		const provider = createZeropsDeployer(() => ({
			...makeCollaborators(recorded, { statuses: ['BUILDING'], processStatuses: ['RUNNING'], triggerVersionId: 'version-1' }),
			sleep: async () => {
				controller.abort(new ProviderInvocationAbort('lease_lost'))
			},
		}))
		const result = await provider(deployRun(recorded, target(), false, controller.signal))
		await settled()

		expect(result.status).toBe('failed')
		expect(recorded.calls).not.toContain('cancelBuild')
		expect(recorded.calls).not.toContain('deleteAppVersion:version-1')
	})

	test('a cancel before the build request leaves the reserved version to cancel()', async () => {
		const provider = createZeropsDeployer(() => makeCollaborators(recorded))
		const result = await deployUntil(provider, deployRun(recorded), 'trigger-build')
		await settled()

		expect(result.status).toBe('failed')
		expect(recorded.calls).not.toContain('deleteAppVersion:version-1')
		expect(recorded.builds).toEqual([])
	})

	test('names the runtime binding in an application archive, and none for a public repository', async () => {
		const provider = createZeropsDeployer(() => makeCollaborators(recorded))
		const privateTarget = target({
			source: {
				runId: 'run-1',
				repository: { owner: 'acme', name: 'demo' },
				commitSha: '0123456789abcdef0123456789abcdef01234567',
				privateBinding: { connectionId: 'keyed-connection', installationId: 42 },
			},
		})

		await execute(deployRun(recorded, target()), provider)
		await execute(deployRun(recorded, privateTarget), provider)
		expect(recorded.uploads.map((upload) => upload.archive)).toEqual([
			{ kind: 'application' },
			{ kind: 'application', privateBinding: { connectionId: 'keyed-connection', installationId: 42 } },
		])
	})

	test('refuses an upload destination outside the Zerops object-storage endpoint without naming it', async () => {
		const provider = createZeropsDeployer(() => makeCollaborators(recorded, { uploadUrl: 'https://attacker.test/upload?signature=test' }))
		const result = await provider(deployRun(recorded))

		expect(result.status).toBe('failed')
		expect(stepError(result, 'upload-source')).toBe('zerops: the reserved app version has an unexpected upload destination')
		expect(recorded.uploads).toEqual([])
		expect(recorded.calls).toContain('deleteAppVersion:version-1')
		expect(recorded.logs.join('\n')).not.toContain('signature=test')
	})

	test('waits for the import processes before anything else, because an import answers before its services exist', async () => {
		const provider = createZeropsDeployer(() =>
			makeCollaborators(recorded, {
				importProcesses: [{ id: 'import-1', status: 'RUNNING' }],
				processStatuses: ['RUNNING', 'FINISHED', 'FINISHED'],
				triggerVersionId: 'version-1',
			})
		)
		await deployUntil(provider, deployRun(recorded, target()), 'write-service-env')

		// Triggering a pipeline on a service Zerops is still creating answers 400
		// `projectImportInvalidParameter`; the first deploy into a fresh namespace hit exactly that.
		expect(recorded.calls).toEqual(['importServices', 'getProcess', 'getProcess'])
	})

	test('fails on the trigger process after one poll when the app version remains waiting', async () => {
		const provider = createZeropsDeployer(() =>
			makeCollaborators(recorded, { statuses: ['WAITING_TO_BUILD'], processStatuses: ['FAILED'], triggerVersionId: 'version-waiting' })
		)
		const result = await provider(deployRun(recorded))

		expect(stepError(result, 'await-version')).toBe(
			'zerops: pipeline process process-1 is FAILED while app-version version-waiting is WAITING_TO_BUILD',
		)
		expect(result.steps.map((step) => step.status)).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded', 'failed', 'skipped'])
		expect(recorded.calls.slice(-3)).toEqual(['buildAndDeployAppVersion:version-waiting', 'getProcess', 'getAppVersion'])
		expect(recorded.sleeps).toEqual([])
	})

	test('does not accept an active app version when its trigger process failed', async () => {
		const provider = createZeropsDeployer(() =>
			makeCollaborators(recorded, { statuses: ['ACTIVE'], processStatuses: ['FAILED'], triggerVersionId: 'version-active' })
		)
		const result = await provider(deployRun(recorded))

		expect(stepError(result, 'await-version')).toBe('zerops: pipeline process process-1 is FAILED while app-version version-active is ACTIVE')
		expect(recorded.calls).not.toContain('deleteAppVersion:version-active')
		expect(recorded.sleeps).toEqual([])
	})

	test('rejects a changed registered descriptor before reserving an app version', async () => {
		const provider = createZeropsDeployer(() => makeCollaborators(recorded))
		const run = deployRun(recorded)
		const driftedArtifact = compileFabrikaManifest(app([DB, API]), 'prod', {
			...SOURCE_DESCRIPTOR,
			contents: `${SOURCE_DESCRIPTOR.contents}# changed after registration\n`,
		})
		const result = await provider({ ...run, artifact: driftedArtifact })

		expect(stepError(result, 'reserve-version')).toContain('source descriptor digest')
		expect(recorded.calls).toEqual(['importServices', 'listServiceEnv'])
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

	test('dry-run skips every platform and IAM mutation and names only the keys it would write', async () => {
		const provider = createZeropsDeployer(() => makeCollaborators(recorded))
		await execute({
			...deployRun(recorded, target(), true),
			managedEnvironment: { ...NO_MANAGED_VALUES, FABRIKA_RELEASE: RELEASE, FABRIKA_SERVICE_KEY: 'private-service-key' },
		}, provider)
		expect(recorded.calls).toEqual([])
		expect(recorded.externalIds).toEqual([])
		const log = recorded.logs.join('\n')
		expect(log).toContain('[dry-run] would write service variables on service-1: FABRIKA_SERVICE_KEY')
		expect(log).toContain('[dry-run] would reserve an app version')
		expect(log).not.toContain('private-service-key')
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
