import type { AppSchema } from '@fabrika/auth-core'
import type { JsonValue, RuntimeProviderRun } from '@fabrika/provider-contract'
import { beforeEach, describe, expect, test } from 'bun:test'
import { type ZeropsApi, ZeropsApiError, type ZeropsAppVersion, type ZeropsLogAccess, type ZeropsProcess } from '../api'
import { zeropsTargetCodec } from '../codec'
import type { ZeropsCollaborators } from '../collaborators'
import { assertZeropsInvariants, compileImportYaml, compileProvisioningYaml } from '../compile'
import { compileFabrikaManifest, type ZeropsArtifactSourceDescriptor } from '../manifest'
import { CANCELLED, createZeropsProvider, type ZeropsSourceTransportBinding, type ZeropsSourceTransportRouting } from '../provider'
import type { ZeropsServiceType } from '../schema.generated'
import type { ZeropsAppConfig, ZeropsRuntimeTarget, ZeropsServiceSpec } from '../types'

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
		},
		getAppVersion: async ({ appVersionId }) => {
			recorded.calls.push('getAppVersion')
			if (versionErrors > 0) {
				versionErrors--
				throw new Error('status observation unavailable')
			}
			const statuses = overrides.statuses ?? ['ACTIVE']
			const status = statuses[Math.min(poll, statuses.length - 1)]
			poll++
			return { id: appVersionId, status }
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
		listServiceEnv: async () => [],
		createServiceEnv: async () => {
			recorded.calls.push('createServiceEnv')
		},
		putServiceEnv: async () => {
			recorded.calls.push('putServiceEnv')
		},
		deleteServiceEnv: async () => {},
		getProjectEnv: async ({ projectEnvId }) => ({ id: projectEnvId, key: 'KEY', content: 'value' }),
		getLogAccess: async () => LOG_ACCESS,
		readBuildLog: async () => [{ message: 'building' }],
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
const SOURCE_DESCRIPTOR: ZeropsArtifactSourceDescriptor = {
	path: 'zerops.yaml',
	contents: 'zerops:\n  - setup: test\n',
	sha256: '560802d669a116e27e5ce76af3312048e3e9e7743a4fb7d6e73f14d800dc46d1',
}

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

const runtimeRun = (
	recorded: Recorded,
	provider: ReturnType<typeof createZeropsProvider>,
	targetValue: ZeropsRuntimeTarget = target(),
	dryRun = false,
	signal: AbortSignal = new AbortController().signal,
): RuntimeProviderRun => ({
	appId: 'demo',
	env: 'prod',
	cwd: '/repo',
	secrets: {},
	vars: { IMAGE: 'registry.test/demo:v2' },
	managedEnvironment: {},
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
	target: provider.encodeTarget(targetValue),
	artifact: provider.encodeArtifact(compileFabrikaManifest(app([DB, API]), 'prod', SOURCE_DESCRIPTOR)),
})

const execute = async (run: RuntimeProviderRun, provider: ReturnType<typeof createZeropsProvider>): Promise<void> => {
	const session = await provider.runtime.open(run)
	for (const step of session.plan.steps) {
		await session.execute(step.id)
	}
}

let recorded: Recorded
beforeEach(() => {
	recorded = fresh()
})

describe('Zerops provider', () => {
	test('routes an upload through v2 only when a keyed binding names the connection', async () => {
		let binding: ZeropsSourceTransportBinding | undefined
		const routing: ZeropsSourceTransportRouting = {
			bindingForRun: () => binding,
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
		const provider = createZeropsProvider(() => makeCollaborators(recorded), routing)
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
				githubInstallationId: 42,
			},
		})

		// No binding is the anonymous public-repository path, and it is the only remaining v1 upload.
		await execute(runtimeRun(recorded, provider, publicTarget), provider)
		expect(recorded.uploads).toHaveLength(1)
		expect(recorded.v2Uploads).toHaveLength(0)

		binding = { connectionId: 'keyed-connection', installationId: 42, transportKind: 'keyed-v2' }
		await execute(runtimeRun(recorded, provider, privateTarget), provider)
		expect(recorded.uploads).toHaveLength(1)
		expect(recorded.v2Uploads).toEqual([{ connectionId: 'keyed-connection', installationId: 42 }])
	})

	test('rejects a routed binding whose installation differs from the runtime source', async () => {
		const provider = createZeropsProvider(() => makeCollaborators(recorded), {
			bindingForRun: () => ({ connectionId: 'keyed-connection', installationId: 84, transportKind: 'keyed-v2' }),
			uploadV2: () => Promise.reject(new Error('must not upload')),
		})
		const privateTarget = target({
			source: {
				runId: 'run-1',
				repository: { owner: 'acme', name: 'demo' },
				commitSha: '0123456789abcdef0123456789abcdef01234567',
				githubInstallationId: 42,
			},
		})
		const session = await provider.runtime.open(runtimeRun(recorded, provider, privateTarget))
		await session.execute('apply-import')
		await expect(session.execute('trigger-deploy')).rejects.toThrow('different installation coordinates')
		expect(recorded.v2Uploads).toHaveLength(0)
	})

	test('waits for the import processes before triggering, because an import answers before its services exist', async () => {
		const provider = createZeropsProvider(() =>
			makeCollaborators(recorded, {
				importProcesses: [{ id: 'import-1', status: 'RUNNING' }],
				processStatuses: ['RUNNING', 'FINISHED', 'FINISHED'],
				triggerVersionId: 'version-1',
			})
		)
		const session = await provider.runtime.open(runtimeRun(recorded, provider, target()))
		await session.execute('apply-import')

		// Triggering a pipeline on a service Zerops is still creating answers 400
		// `projectImportInvalidParameter`; the first deploy into a fresh namespace hit exactly that.
		expect(recorded.calls).toEqual(['importServices', 'getProcess', 'getProcess'])
	})

	test('owns a distinct plan and executes it through the typed provider contract', async () => {
		const controller = new AbortController()
		const provider = createZeropsProvider(() =>
			makeCollaborators(recorded, { statuses: ['BUILDING', 'ACTIVE'], processStatuses: ['RUNNING', 'FINISHED'], triggerVersionId: 'version-1' })
		)
		const session = await provider.runtime.open(runtimeRun(recorded, provider, target(), false, controller.signal))
		expect(session.plan.steps.map((step) => step.kind)).toEqual(['apply-import', 'trigger-deploy', 'await-deploy', 'reconcile-schema'])
		await execute(runtimeRun(recorded, provider, target(), false, controller.signal), provider)
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
		expect(recorded.externalStates).toEqual([{ appVersionId: 'version-1', phase: 'version_created' }])
		expect(recorded.checkpoints).toEqual([
			{ appVersionId: 'version-1', phase: 'source_uploaded' },
			{ appVersionId: 'version-1', phase: 'build_trigger_requested' },
			{ appVersionId: 'version-1', phase: 'build_triggered', processId: 'process-1' },
		])
		expect(recorded.timeline).toEqual([
			'create',
			'external-id',
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
			zeropsYaml: SOURCE_DESCRIPTOR.contents,
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
		const provider = createZeropsProvider(() =>
			makeCollaborators(recorded, { statuses: ['WAITING_TO_BUILD'], processStatuses: ['FAILED'], triggerVersionId: 'version-waiting' })
		)
		const session = await provider.runtime.open(runtimeRun(recorded, provider))
		await session.execute('trigger-deploy')

		const error = await session.execute('await-deploy').catch((reason: unknown) => reason)

		expect(error).toEqual(
			new Error('zerops: pipeline process process-1 is FAILED while app-version version-waiting is WAITING_TO_BUILD'),
		)
		expect(recorded.calls).toEqual([
			'createAppVersion:service-1',
			'sourceUpload:version-waiting',
			'buildAndDeployAppVersion:version-waiting',
			'getProcess',
			'getAppVersion',
		])
		expect(recorded.sleeps).toEqual([])
	})

	test('does not accept an active app version when its trigger process failed', async () => {
		const provider = createZeropsProvider(() =>
			makeCollaborators(recorded, { statuses: ['ACTIVE'], processStatuses: ['FAILED'], triggerVersionId: 'version-active' })
		)
		const session = await provider.runtime.open(runtimeRun(recorded, provider))
		await session.execute('trigger-deploy')

		const error = await session.execute('await-deploy').catch((reason: unknown) => reason)

		expect(error).toEqual(
			new Error('zerops: pipeline process process-1 is FAILED while app-version version-active is ACTIVE'),
		)
		expect(recorded.calls).toEqual([
			'createAppVersion:service-1',
			'sourceUpload:version-active',
			'buildAndDeployAppVersion:version-active',
			'getProcess',
			'getAppVersion',
		])
		expect(recorded.sleeps).toEqual([])
	})

	test('uses the process returned by upload-backed build-and-deploy', async () => {
		const provider = createZeropsProvider(() => makeCollaborators(recorded, { statuses: ['ACTIVE'] }))
		const session = await provider.runtime.open(runtimeRun(recorded, provider))
		await session.execute('trigger-deploy')
		await session.execute('await-deploy')

		expect(recorded.calls).toEqual([
			'createAppVersion:service-1',
			'sourceUpload:version-1',
			'buildAndDeployAppVersion:version-1',
			'getProcess',
			'getAppVersion',
		])
		expect(recorded.externalIds).toEqual(['version-1'])
	})

	test('deletes a reserved version when source upload fails without exposing its destination', async () => {
		const provider = createZeropsProvider(() =>
			makeCollaborators(recorded, { uploadError: new Error('source upload failed'), statuses: ['UPLOADING'] })
		)
		const session = await provider.runtime.open(runtimeRun(recorded, provider))

		await expect(session.execute('trigger-deploy')).rejects.toThrow('source upload failed')

		expect(recorded.calls).toEqual([
			'createAppVersion:service-1',
			'sourceUpload:version-1',
			'sourceCancel:version-1',
			'deleteAppVersion:version-1',
		])
		expect(recorded.timeline).toEqual(['create', 'external-id', 'upload'])
		expect(recorded.logs.join('\n')).not.toContain('signature=test')
	})

	test('deletes a pre-trigger version when Zerops rejects build-and-deploy', async () => {
		const provider = createZeropsProvider(() =>
			makeCollaborators(recorded, { buildError: new ZeropsApiError('zerops: build rejected', 400, 'invalidBuild') })
		)
		const session = await provider.runtime.open(runtimeRun(recorded, provider))

		await expect(session.execute('trigger-deploy')).rejects.toThrow('zerops: build rejected')

		expect(recorded.calls).toEqual([
			'createAppVersion:service-1',
			'sourceUpload:version-1',
			'buildAndDeployAppVersion:version-1',
			'sourceCancel:version-1',
			'deleteAppVersion:version-1',
		])
		expect(recorded.checkpoints).toContainEqual({ appVersionId: 'version-1', phase: 'build_trigger_requested' })
	})

	test('keeps the build refusal when the cleanup delete fails too', async () => {
		// Live, a real `trigger-deploy` failure surfaced as `delete app-version failed (400)`: the cleanup
		// threw over the cause and the reason the deploy failed was gone.
		const provider = createZeropsProvider(() =>
			makeCollaborators(recorded, {
				buildError: new ZeropsApiError('zerops: build and deploy app-version failed (400) — userDataSyncRunning', 400, 'userDataSyncRunning'),
				deleteError: new ZeropsApiError('zerops: delete app-version failed (400)', 400, ''),
			})
		)
		const session = await provider.runtime.open(runtimeRun(recorded, provider))

		await expect(session.execute('trigger-deploy')).rejects.toThrow('userDataSyncRunning')

		expect(recorded.calls).toContain('deleteAppVersion:version-1')
		expect(recorded.logs.join('\n')).toContain('app-version version-1 was left behind')
	})

	test('keeps an ambiguous build trigger observable when its first status read fails', async () => {
		const provider = createZeropsProvider(() =>
			makeCollaborators(recorded, {
				buildError: new Error('build response lost'),
				versionErrors: 1,
				statuses: ['ACTIVE'],
			})
		)
		const session = await provider.runtime.open(runtimeRun(recorded, provider))

		await session.execute('trigger-deploy')
		await session.execute('await-deploy')

		expect(recorded.calls).toEqual([
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
		const provider = createZeropsProvider(() =>
			makeCollaborators(recorded, {
				buildError: new Error('build response lost'),
				statuses: [undefined, 'ACTIVE'],
			})
		)
		const session = await provider.runtime.open(runtimeRun(recorded, provider))

		await session.execute('trigger-deploy')
		await session.execute('await-deploy')

		expect(recorded.calls).not.toContain('deleteAppVersion:version-1')
		expect(recorded.checkpoints).not.toContainEqual({ appVersionId: 'version-1', phase: 'build_triggered' })
	})

	test('continues observing an accepted build when the result checkpoint fails', async () => {
		const provider = createZeropsProvider(() => makeCollaborators(recorded, { statuses: ['ACTIVE'] }))
		const run = runtimeRun(recorded, provider)
		const session = await provider.runtime.open({
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

		await session.execute('trigger-deploy')
		await session.execute('await-deploy')

		expect(recorded.calls).toContain('getAppVersion')
		expect(recorded.calls).not.toContain('deleteAppVersion:version-1')
		expect(recorded.checkpoints).toContainEqual({ appVersionId: 'version-1', phase: 'build_trigger_requested' })
	})

	test('bounds a hanging source cancellation before deleting the version', async () => {
		const provider = createZeropsProvider(() => makeCollaborators(recorded, { uploadError: new Error('source upload failed'), cancelMode: 'hang' }))
		const session = await provider.runtime.open(runtimeRun(recorded, provider))

		await expect(session.execute('trigger-deploy')).rejects.toThrow('source upload failed')
		expect(recorded.calls).toEqual([
			'createAppVersion:service-1',
			'sourceUpload:version-1',
			'sourceCancel:version-1',
			'sourceCancelTimeout',
			'deleteAppVersion:version-1',
		])
		expect(recorded.sourceCancelSignals[0]?.aborted).toBe(true)
		expect(recorded.deleteSignals[0]?.aborted).toBe(false)
		expect(recorded.deleteSignals[0]).not.toBe(recorded.sourceCancelSignals[0])
	})

	test('rejects a changed registered descriptor before reserving an app version', async () => {
		const provider = createZeropsProvider(() => makeCollaborators(recorded))
		const run = runtimeRun(recorded, provider)
		const driftedArtifact = provider.encodeArtifact(compileFabrikaManifest(app([DB, API]), 'prod', {
			...SOURCE_DESCRIPTOR,
			contents: `${SOURCE_DESCRIPTOR.contents}# changed after registration\n`,
		}))
		const session = await provider.runtime.open({ ...run, artifact: driftedArtifact })

		await expect(session.execute('trigger-deploy')).rejects.toThrow('source descriptor digest')
		expect(recorded.calls).toEqual([])
	})

	test('cancels the build after an observed process and version when the run is aborted', async () => {
		const controller = new AbortController()
		const provider = createZeropsProvider(() => ({
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
		const session = await provider.runtime.open(runtimeRun(recorded, provider, target(), false, controller.signal))
		await session.execute('trigger-deploy')

		await expect(session.execute('await-deploy')).rejects.toThrow(CANCELLED)
		expect(recorded.calls).toEqual([
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
		const provider = createZeropsProvider(() => ({
			...makeCollaborators(recorded),
			reconcileSchema: (input) => {
				recorded.schemaSignals.push(input.signal)
				return new Promise<void>((_resolve, reject) => {
					const abort = (): void => {
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
		const session = await provider.runtime.open(runtimeRun(recorded, provider, target(), false, controller.signal))

		const reconciliation = session.execute('reconcile-schema')
		await started.promise
		controller.abort()

		const error = await reconciliation.catch((reason: unknown) => reason)
		expect(error).toBe(controller.signal.reason)
		expect(recorded.schemaSignals).toEqual([controller.signal])
	})

	test('dry-run skips every platform and IAM mutation', async () => {
		const provider = createZeropsProvider(() => makeCollaborators(recorded))
		await execute(runtimeRun(recorded, provider, target(), true), provider)
		expect(recorded.calls).toEqual([])
		expect(recorded.externalIds).toEqual([])
		expect(recorded.logs.join('\n')).toContain('[dry-run]')
	})

	test('rejects wrong-provider envelopes before opening', async () => {
		const provider = createZeropsProvider(() => makeCollaborators(recorded))
		const run = runtimeRun(recorded, provider)
		expect(provider.runtime.open({ ...run, target: { provider: 'other', version: 1, payload: {} } }))
			.rejects.toThrow('belongs to provider')
	})

	test('rejects artifact identity drift', async () => {
		const provider = createZeropsProvider(() => makeCollaborators(recorded))
		const run = runtimeRun(recorded, provider)
		expect(provider.runtime.open({ ...run, appId: 'other' })).rejects.toThrow('artifact app drift')
	})

	test('rejects unknown runtime target fields and mutable source refs', () => {
		expect(() =>
			zeropsTargetCodec.decode({
				projectId: 'project-1',
				serviceId: 'service-1',
				accessToken: 'zt-secret',
				unknown: 'value',
			})
		).toThrow('unknown field')
		expect(() =>
			zeropsTargetCodec.decode({
				projectId: 'project-1',
				serviceId: 'service-1',
				accessToken: 'zt-secret',
				source: {
					runId: 'run-1',
					repository: { owner: 'acme', name: 'demo' },
					commitSha: 'refs/heads/main',
				},
			})
		).toThrow('exact lowercase Git object id')
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
