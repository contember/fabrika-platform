import type { AppSchema } from '@fabrika/auth-core'
import type { RuntimeProviderRun } from '@fabrika/provider-contract'
import { beforeEach, describe, expect, test } from 'bun:test'
import type { ZeropsApi, ZeropsAppVersion, ZeropsLogAccess } from '../api'
import type { ZeropsCollaborators } from '../collaborators'
import { assertZeropsInvariants, compileImportYaml, compileProvisioningYaml } from '../compile'
import { compileFabrikaManifest } from '../manifest'
import { createZeropsProvider } from '../provider'
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
}

const fresh = (): Recorded => ({ calls: [], imports: [], triggers: [], externalIds: [], logs: [], schemas: [], schemaSignals: [], sleeps: [] })

interface Overrides {
	statuses?: Array<ZeropsAppVersion['status']>
	triggerVersionId?: string
	latestVersion?: ZeropsAppVersion | null
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
	return {
		importServices: async ({ projectId, yaml }) => {
			recorded.calls.push('importServices')
			recorded.imports.push({ projectId, yaml })
			return { projectId, services: [{ id: 'service-1', name: 'api', processes: [] }] }
		},
		importProject: async ({ clientId }) => ({ projectId: clientId, services: [] }),
		triggerPipeline: async ({ serviceId, buildFromGit, zeropsSetup }) => {
			recorded.calls.push('triggerPipeline')
			recorded.triggers.push({ serviceId, buildFromGit, zeropsSetup })
			return overrides.triggerVersionId === undefined ? null : { id: 'process-1', appVersionId: overrides.triggerVersionId }
		},
		getAppVersion: async ({ appVersionId }) => {
			recorded.calls.push('getAppVersion')
			const statuses = overrides.statuses ?? ['ACTIVE']
			const status = statuses[Math.min(poll, statuses.length - 1)]
			poll++
			return { id: appVersionId, status }
		},
		latestAppVersion: async () => overrides.latestVersion ?? { id: 'version-1', sequence: 1 },
		cancelBuild: async () => {
			recorded.calls.push('cancelBuild')
		},
		getService: async ({ serviceId }) => ({ id: serviceId, name: 'api' }),
		findService: async ({ hostname }) => ({ id: 'service-1', name: hostname }),
		getProject: async ({ projectId }) => ({ id: projectId, name: 'project' }),
		listProjects: async () => [],
		findProjects: async () => [],
		listProjectServices: async () => [],
		listServiceEnv: async () => [],
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
	buildFromGit: 'https://github.com/acme/demo',
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
		externalId: async (id) => {
			recorded.externalIds.push(id)
		},
	},
	target: provider.encodeTarget(targetValue),
	artifact: provider.encodeArtifact(compileFabrikaManifest(app([DB, API]), 'prod')),
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
	test('owns a distinct plan and executes it through the typed provider contract', async () => {
		const controller = new AbortController()
		const provider = createZeropsProvider(() => makeCollaborators(recorded, { statuses: ['BUILDING', 'ACTIVE'] }))
		const session = await provider.runtime.open(runtimeRun(recorded, provider, target(), false, controller.signal))
		expect(session.plan.steps.map((step) => step.kind)).toEqual(['apply-import', 'trigger-deploy', 'await-deploy', 'reconcile-schema'])
		await execute(runtimeRun(recorded, provider, target(), false, controller.signal), provider)
		expect(recorded.calls).toEqual(['importServices', 'triggerPipeline', 'getAppVersion', 'getAppVersion', 'reconcileSchema'])
		expect(recorded.externalIds).toEqual(['version-1'])
		expect(recorded.sleeps).toEqual([3000])
		expect(recorded.imports[0]?.yaml).toContain('registry.test/demo:v2')
		expect(recorded.triggers).toEqual([{
			serviceId: 'service-1',
			buildFromGit: 'https://github.com/acme/demo',
			zeropsSetup: 'api',
		}])
		expect(recorded.schemas).toEqual(['demo'])
		expect(recorded.schemaSignals).toEqual([controller.signal])
		expect(recorded.logs.join('\n')).not.toContain('zt-secret')
		expect(recorded.logs.join('\n')).not.toContain('px-secret')
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

	test('the API surface has no project-level environment writer', () => {
		const api = makeApi(recorded)
		expect(Reflect.has(api, 'putProjectEnv')).toBe(false)
	})
})
