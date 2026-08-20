import type { AppSchema } from '@fabrika/auth-core'
import type {
	JsonValue,
	ProviderApp,
	ProviderDeployInput,
	ProviderDeploymentNamespace,
	ProviderEnvironment,
	ProviderReconcileOutcome,
	RuntimeProviderRun,
} from '@fabrika/provider-contract'
import { beforeEach, describe, expect, test } from 'bun:test'
import { type ZeropsApi, ZeropsApiError, type ZeropsAppVersionStatus } from '../api'
import { useSharedPostgres } from '../authoring'
import { zeropsTargetCodec } from '../codec'
import { createZeropsControlProvider, type ZeropsControlProviderOptions, type ZeropsProviderExecutor, zeropsStoredTargetCodec } from '../control'
import { compileFabrikaManifest, zeropsArtifactCodec, type ZeropsArtifactSourceDescriptor } from '../manifest'
import { ZEROPS_SHARED_POSTGRES_CONNECTION_STRING, zeropsNamespacePreset, zeropsNamespaceTargetCodec } from '../namespace'
import type { ZeropsSourceTransportBinding } from '../provider'
import { zeropsSharedServiceHostname } from '../service-names'
import type { ZeropsSourceClient, ZeropsSourceClientV2 } from '../source'
import type { ZeropsAppConfig, ZeropsRuntimeTarget } from '../types'

interface Recorded {
	calls: string[]
	externalIds: string[]
	logs: string[]
	triggers: Array<{ serviceId: string; buildFromGit?: string; zeropsSetup?: string }>
	envWrites: Array<{ serviceId: string; key: string; value: string }>
	envDeletes: string[]
	beforeDeploy: string[]
	imports: Array<{ projectId: string; yaml: string }>
}

const fresh = (): Recorded => ({
	calls: [],
	externalIds: [],
	logs: [],
	triggers: [],
	envWrites: [],
	envDeletes: [],
	beforeDeploy: [],
	imports: [],
})

const config: ZeropsAppConfig = {
	id: 'notes',
	target: {
		platform: 'zerops',
		services: () => [{ hostname: 'notes', type: 'alpine/bun@1.3' }],
	},
}

const SCHEMA: AppSchema = { scopes: [], actions: [], roles: {} }
const SOURCE_DESCRIPTOR: ZeropsArtifactSourceDescriptor = {
	path: 'zerops.yaml',
	contents: 'zerops:\n  - setup: test\n',
	sha256: '560802d669a116e27e5ce76af3312048e3e9e7743a4fb7d6e73f14d800dc46d1',
}
const COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567'

const app: ProviderApp = {
	id: 'notes',
	source: {
		repoUrl: 'https://github.com/acme/notes',
		ref: COMMIT_SHA,
		workerDir: 'apps/notes',
	},
}

const readyNamespace = (): ProviderDeploymentNamespace => ({
	id: 'apps-prod',
	env: 'prod',
	target: {
		provider: 'zerops',
		version: zeropsNamespaceTargetCodec.version,
		payload: zeropsNamespaceTargetCodec.encode({
			projectId: 'project-1',
			proxyServiceId: 'proxy-service-1',
			proxyBuildFromGit: 'https://github.com/contember/fabrika-platform',
			ready: true,
		}),
	},
})

const environment = (overrides: Partial<ProviderEnvironment> = {}): ProviderEnvironment => ({
	appId: 'notes',
	env: 'prod',
	domain: 'notes.example.test',
	publicOrigin: 'https://public.notes.example.test',
	namespace: readyNamespace(),
	target: {
		provider: 'zerops',
		version: zeropsStoredTargetCodec.version,
		payload: zeropsStoredTargetCodec.encode({ serviceId: 'service-1' }),
	},
	artifact: {
		provider: 'zerops',
		version: zeropsArtifactCodec.version,
		payload: zeropsArtifactCodec.encode(compileFabrikaManifest(config, 'prod', SOURCE_DESCRIPTOR)),
	},
	...overrides,
})

const deployInput = (recorded: Recorded): ProviderDeployInput => ({
	runId: 'run-1',
	app,
	environment: environment(),
	secrets: {},
	vars: {},
	managedEnvironment: {},
	dryRun: false,
	signal: new AbortController().signal,
	events: {
		log: (line) => {
			recorded.logs.push(line)
		},
		externalId: async (id) => {
			recorded.externalIds.push(id)
		},
		checkpoint: async () => {},
	},
})

const makeApi = (recorded: Recorded, status: () => ZeropsAppVersionStatus | undefined = () => 'ACTIVE'): ZeropsApi => ({
	importServices: async ({ projectId, yaml }) => {
		recorded.calls.push('importServices')
		recorded.imports.push({ projectId, yaml })
		return { projectId, services: [{ id: 'service-1', name: 'notes', processes: [] }] }
	},
	importProject: async ({ clientId }) => ({ projectId: clientId, services: [] }),
	triggerPipeline: async ({ serviceId, buildFromGit, zeropsSetup }) => {
		recorded.calls.push('triggerPipeline')
		recorded.triggers.push({ serviceId, buildFromGit, zeropsSetup })
		return { id: 'process-1', appVersionId: 'version-1' }
	},
	createAppVersion: async ({ serviceId }) => {
		recorded.calls.push(`createAppVersion:${serviceId}`)
		return { id: 'version-1', uploadUrl: 'https://upload.test/archive?signature=test' }
	},
	buildAndDeployAppVersion: async ({ appVersionId }) => {
		recorded.calls.push(`buildAndDeployAppVersion:${appVersionId}`)
		return { id: 'process-1', appVersionId }
	},
	deleteAppVersion: async ({ appVersionId }) => {
		recorded.calls.push(`deleteAppVersion:${appVersionId}`)
	},
	getAppVersion: async ({ appVersionId }) => {
		recorded.calls.push(`getAppVersion:${appVersionId}`)
		return { id: appVersionId, status: status() }
	},
	latestAppVersion: async () => ({ id: 'version-1', status: status(), sequence: 1 }),
	cancelBuild: async ({ appVersionId }) => {
		recorded.calls.push(`cancelBuild:${appVersionId}`)
	},
	getProcess: async ({ processId }) => ({ id: processId, status: 'FINISHED' }),
	createIntegrationToken: async () => {
		throw new Error('the control provider must not mint a Zerops token')
	},
	enableSubdomainAccess: async ({ serviceId }) => {
		recorded.calls.push(`enableSubdomainAccess:${serviceId}`)
	},
	getService: async ({ serviceId }) => ({ id: serviceId, name: 'notes' }),
	findService: async ({ hostname }) => ({ id: 'service-1', name: hostname }),
	getProject: async ({ projectId }) => ({ id: projectId, name: 'project' }),
	listProjects: async () => [],
	findProjects: async () => [],
	listProjectServices: async () => [],
	listServiceEnv: async () => [{ id: 'env-1', key: 'TOKEN', content: 'blurred' }],
	createServiceEnv: async ({ serviceId, key, value }) => {
		recorded.envWrites.push({ serviceId, key, value })
	},
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

const executeProvider: ZeropsProviderExecutor = async (provider, run) => {
	const session = await provider.open(run)
	try {
		for (const step of session.plan.steps) {
			await session.execute(step.id)
		}
		return { state: 'succeeded' }
	} catch {
		return { state: 'failed' }
	}
}

const makeSource = (calls: string[] = []): ZeropsSourceClient => ({
	resolveInstallationId: async () => null,
	resolve: async (input) => {
		calls.push(`resolve:${input.repository.owner}/${input.repository.name}:${input.requestedRef}`)
		return {
			runId: input.runId,
			commitSha: input.expectedCommitSha ?? COMMIT_SHA,
			descriptorSha256: input.descriptorSha256,
		}
	},
	upload: async (input) => {
		calls.push(`upload:${input.runId}:${input.appVersionId}:${input.commitSha}`)
		return {
			runId: input.runId,
			appVersionId: input.appVersionId,
			commitSha: input.commitSha,
			descriptorSha256: input.descriptor.sha256,
		}
	},
	cancel: async (input) => {
		calls.push(`sourceCancel:${input.runId}:${input.appVersionId}`)
	},
})

type TestControlProviderOptions = Omit<ZeropsControlProviderOptions, 'execute' | 'source'> & {
	readonly execute?: ZeropsProviderExecutor
	readonly source?: ZeropsSourceClient & Partial<ZeropsSourceClientV2>
}

const createTestControlProvider = (options: TestControlProviderOptions) =>
	createZeropsControlProvider({ ...options, source: options.source ?? makeSource(), execute: options.execute ?? executeProvider })

let recorded: Recorded
beforeEach(() => {
	recorded = fresh()
})

describe('Zerops ControlProvider registration', () => {
	test('normalizes a stored target and static artifact without persisting credentials', () => {
		const control = createTestControlProvider({ accessToken: 'zt-secret', api: makeApi(recorded) })
		const normalized = control.normalizeRegistration({ app, environment: environment() })
		expect(normalized.environment.target.payload).toEqual({ serviceId: 'service-1' })
		expect(JSON.stringify(normalized.environment.target)).not.toContain('buildFromGit')
		expect(JSON.stringify(normalized.environment.target)).not.toContain(app.source.repoUrl)
		expect(normalized.environment.publicOrigin).toBe('https://public.notes.example.test')
		expect(JSON.stringify(normalized.environment)).not.toContain('zt-secret')
	})

	test('rejects foreign, unsupported, and identity-drifted envelopes', () => {
		const control = createTestControlProvider({ accessToken: 'zt-secret', api: makeApi(recorded) })
		expect(() =>
			control.normalizeRegistration({
				app,
				environment: environment({ target: { provider: 'other', version: 1, payload: {} } }),
			})
		).toThrow('belongs to provider')
		expect(() =>
			control.normalizeRegistration({
				app,
				environment: environment({ target: { provider: 'zerops', version: 1, payload: {} } }),
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
		).toThrow('different environment coordinates')
		expect(() => control.normalizeRegistration({ app, environment: environment({ namespace: undefined }) })).toThrow(
			'requires a deployment namespace',
		)
		expect(() =>
			control.normalizeRegistration({
				app,
				environment: environment({ namespace: { ...readyNamespace(), exclusiveAppId: 'other' } }),
			})
		).toThrow('exclusive')
	})

	test('exposes namespace lifecycle only when its installation configuration is composed', () => {
		const withoutNamespaces = createTestControlProvider({ accessToken: 'zt-secret', api: makeApi(recorded) })
		const withNamespaces = createTestControlProvider({
			accessToken: 'zt-secret',
			api: makeApi(recorded),
			namespaces: {
				clientId: 'client-1',
				proxyBuildFromGit: 'https://github.com/contember/fabrika-platform',
				iamUrl: 'https://iam.example.test',
				iamKey: 'proxy-key',
			},
		})
		const value: ProviderDeploymentNamespace = {
			id: 'apps-prod',
			env: 'prod',
			target: {
				provider: 'zerops',
				version: zeropsNamespaceTargetCodec.version,
				payload: {},
			},
		}
		if (withNamespaces.namespaces === undefined) {
			throw new Error('expected namespace capabilities')
		}

		expect(withoutNamespaces.namespaces).toBeUndefined()
		expect(zeropsNamespaceTargetCodec.decode(withNamespaces.namespaces.normalize(value).target.payload)).toMatchObject({
			projectName: 'apps-prod',
			corePackage: 'SERIOUS',
			managed: true,
			ready: false,
		})
	})

	test('prepares codeless services and discovers the deploy-service id', async () => {
		const api = makeApi(recorded)
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			api: { ...api, findService: async () => null },
			namespaces: {
				clientId: 'client-1',
				proxyBuildFromGit: 'https://github.com/contember/fabrika-platform',
				iamUrl: 'https://iam.example.test',
				iamKey: 'proxy-key',
			},
		})
		const prepare = control.namespaces?.prepareRegistration
		if (prepare === undefined) {
			throw new Error('expected registration preparation')
		}
		const prepared = await prepare({
			registration: {
				app,
				environment: environment({
					target: { provider: 'zerops', version: zeropsStoredTargetCodec.version, payload: {} },
				}),
			},
			signal: new AbortController().signal,
		})

		expect(prepared.environment.target.payload).toEqual({ serviceId: 'service-1' })
		expect(recorded.imports).toHaveLength(1)
		expect(recorded.imports[0]?.projectId).toBe('project-1')
		expect(recorded.imports[0]?.yaml).toContain('startWithoutCode: true')
	})

	test('uses the steady-state import when every declared service already exists', async () => {
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			api: makeApi(recorded),
			namespaces: {
				clientId: 'client-1',
				proxyBuildFromGit: 'https://github.com/contember/fabrika-platform',
				iamUrl: 'https://iam.example.test',
				iamKey: 'proxy-key',
			},
		})
		const prepare = control.namespaces?.prepareRegistration
		if (prepare === undefined) throw new Error('expected registration preparation')

		const prepared = await prepare({
			registration: {
				app,
				environment: environment({ target: { provider: 'zerops', version: zeropsStoredTargetCodec.version, payload: {} } }),
			},
			signal: new AbortController().signal,
		})

		expect(prepared.environment.target.payload).toEqual({ serviceId: 'service-1' })
		expect(recorded.imports).toHaveLength(1)
		expect(recorded.imports[0]?.yaml).not.toContain('startWithoutCode')
	})

	test('refuses a partial declared-service set without importing anything', async () => {
		const partialConfig: ZeropsAppConfig = {
			id: 'notes',
			target: {
				platform: 'zerops',
				services: () => [
					{ hostname: 'notes', type: 'alpine/bun@1.3' },
					{ hostname: 'notesdb', type: 'postgresql:single@18' },
				],
				deployService: 'notes',
			},
		}
		const partialManifest = compileFabrikaManifest(partialConfig, 'prod', SOURCE_DESCRIPTOR)
		const api = makeApi(recorded)
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			api: { ...api, findService: async ({ hostname }) => hostname === 'notes' ? { id: 'service-1', name: hostname } : null },
			namespaces: {
				clientId: 'client-1',
				proxyBuildFromGit: 'https://github.com/contember/fabrika-platform',
				iamUrl: 'https://iam.example.test',
				iamKey: 'proxy-key',
			},
		})
		const prepare = control.namespaces?.prepareRegistration
		if (prepare === undefined) throw new Error('expected registration preparation')

		await expect(prepare({
			registration: {
				app,
				environment: environment({
					target: { provider: 'zerops', version: zeropsStoredTargetCodec.version, payload: {} },
					artifact: {
						provider: 'zerops',
						version: zeropsArtifactCodec.version,
						payload: zeropsArtifactCodec.encode(partialManifest),
					},
				}),
			},
			signal: new AbortController().signal,
		})).rejects.toThrow('only 1 of 2 declared services')
		expect(recorded.imports).toEqual([])
	})

	test('derives reserved and app-owned claims from the canonical structured import', () => {
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			api: makeApi(recorded),
			namespaces: {
				clientId: 'client-1',
				proxyBuildFromGit: 'https://github.com/contember/fabrika-platform',
				iamUrl: 'https://iam.example.test',
				iamKey: 'proxy-key',
			},
		})
		if (control.namespaces === undefined) throw new Error('expected namespace capabilities')
		const namespace = control.namespaces.normalize({
			id: 'apps-prod',
			env: 'prod',
			target: {
				provider: 'zerops',
				version: zeropsNamespaceTargetCodec.version,
				payload: zeropsNamespaceTargetCodec.encode(zeropsNamespacePreset({
					preset: 'cheap',
					env: 'prod',
					projectName: 'apps-prod',
					proxyBuildFromGit: 'https://github.com/contember/fabrika-platform',
				})),
			},
		})
		const namespacedConfig: ZeropsAppConfig = {
			id: 'notes',
			target: {
				platform: 'zerops',
				services: () => [
					{ hostname: zeropsSharedServiceHostname('notes', 'api'), type: 'alpine/bun@1.3' },
					{ hostname: zeropsSharedServiceHostname('notes', 'db'), type: 'postgresql:single@18' },
				],
				deployService: 'notesapi',
				proxy: { upstream: 'notesapi:3000', gates: { rules: [] } },
			},
		}
		const registration = control.normalizeRegistration({
			app,
			environment: environment({
				namespace,
				artifact: {
					provider: 'zerops',
					version: zeropsArtifactCodec.version,
					payload: zeropsArtifactCodec.encode(compileFabrikaManifest(namespacedConfig, 'prod', SOURCE_DESCRIPTOR)),
				},
			}),
		})

		expect(control.namespaces.namespaceResourceClaims(namespace)).toEqual(['service:proxy', 'service:postgres'])
		expect(control.namespaces.registrationResourceClaims(registration)).toEqual(['service:notesapi', 'service:notesdb'])
	})

	test('rejects shared prefix, reserved service, and missing namespace resource requirements', () => {
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			api: makeApi(recorded),
			namespaces: {
				clientId: 'client-1',
				proxyBuildFromGit: 'https://github.com/contember/fabrika-platform',
				iamUrl: 'https://iam.example.test',
				iamKey: 'proxy-key',
			},
		})
		if (control.namespaces === undefined) throw new Error('expected namespace capabilities')
		const namespace = control.namespaces.normalize({
			id: 'apps-prod',
			env: 'prod',
			target: {
				provider: 'zerops',
				version: zeropsNamespaceTargetCodec.version,
				payload: zeropsNamespaceTargetCodec.encode(zeropsNamespacePreset({
					preset: 'mid',
					env: 'prod',
					projectName: 'apps-prod',
					proxyBuildFromGit: 'https://github.com/contember/fabrika-platform',
				})),
			},
		})
		const claimsFor = (candidate: ZeropsAppConfig, selectedNamespace = namespace): readonly string[] => {
			const registration = control.normalizeRegistration({
				app,
				environment: environment({
					namespace: selectedNamespace,
					artifact: {
						provider: 'zerops',
						version: zeropsArtifactCodec.version,
						payload: zeropsArtifactCodec.encode(compileFabrikaManifest(candidate, 'prod', SOURCE_DESCRIPTOR)),
					},
				}),
			})
			return control.namespaces?.registrationResourceClaims(registration) ?? []
		}
		const target = (hostname: string): ZeropsAppConfig => ({
			id: 'notes',
			target: { platform: 'zerops', services: () => [{ hostname, type: 'alpine/bun@1.3' }] },
		})

		expect(() => claimsFor(target('otherapi'))).toThrow('app prefix')
		const exclusive = { ...namespace, exclusiveAppId: 'notes' }
		expect(() => claimsFor(target('proxy'), exclusive)).toThrow('reserved')
		expect(() =>
			claimsFor({
				...target('notesapi'),
				target: {
					...target('notesapi').target,
					namespaceResources: [{
						resourceKey: 'service:postgres',
						hostname: 'postgres',
						connectionString: ZEROPS_SHARED_POSTGRES_CONNECTION_STRING,
					}],
				},
			})
		).toThrow('does not provide')
		expect(claimsFor(target('api'), exclusive)).toEqual(['service:api'])
	})
})

describe('Zerops ControlProvider lifecycle', () => {
	test('uses v1 immediately after a source restart when the durable row explicitly says legacy-v1', async () => {
		const sourceCalls: string[] = []
		const resolutions: Array<{
			runId: string
			repository: { owner: string; name: string }
			requestedRef: string
			expectedCommitSha?: string
			githubInstallationId?: number
			descriptorSha256: string
			signal: AbortSignal
		}> = []
		const source: ZeropsSourceClient = {
			...makeSource(sourceCalls),
			resolve: async (input) => {
				resolutions.push(input)
				return { runId: input.runId, commitSha: COMMIT_SHA, descriptorSha256: input.descriptorSha256 }
			},
		}
		const control = createTestControlProvider({ accessToken: 'zt-secret', api: makeApi(recorded), source })
		const signal = new AbortController().signal
		const privateApp = { ...app, source: { ...app.source, githubConnectionId: 'legacy-connection', githubInstallationId: 42 } }

		expect(
			await control.resolveSourceWithBinding({
				runId: 'run-1',
				app: privateApp,
				environment: environment(),
				expectedCommitSha: COMMIT_SHA,
				signal,
				sourceBinding: { connectionId: 'legacy-connection', installationId: 42, transportKind: 'legacy-v1' },
			}),
		).toEqual({ commitSha: COMMIT_SHA })
		expect(resolutions).toEqual([{
			runId: 'run-1',
			repository: { owner: 'acme', name: 'notes' },
			requestedRef: COMMIT_SHA,
			expectedCommitSha: COMMIT_SHA,
			githubInstallationId: 42,
			descriptorSha256: SOURCE_DESCRIPTOR.sha256,
			signal,
		}])
		expect(recorded.calls).toEqual([])
		await expect(control.deployWithBinding({
			...deployInput(recorded),
			app: privateApp,
			sourceBinding: { connectionId: 'legacy-connection', installationId: 42, transportKind: 'legacy-v1' },
		})).resolves.toMatchObject({ state: 'succeeded' })
		expect(sourceCalls).toContain(`upload:run-1:version-1:${COMMIT_SHA}`)

		const drifted = compileFabrikaManifest(config, 'prod', {
			...SOURCE_DESCRIPTOR,
			contents: `${SOURCE_DESCRIPTOR.contents}# changed after registration\n`,
		})
		const resolveSource = control.resolveSource
		if (resolveSource === undefined) throw new Error('expected source resolution')
		await expect(resolveSource({
			runId: 'run-2',
			app,
			environment: environment({
				artifact: {
					provider: 'zerops',
					version: zeropsArtifactCodec.version,
					payload: zeropsArtifactCodec.encode(drifted),
				},
			}),
			signal,
		})).rejects.toThrow('source descriptor digest')
		expect(resolutions).toHaveLength(1)
	})

	test('routes two keyed connections through exact v2 resolve and upload bindings', async () => {
		const calls: string[] = []
		const source: ZeropsSourceClient & ZeropsSourceClientV2 = {
			...makeSource(calls),
			resolveV2: async (input) => {
				const binding = input.privateBinding
				if (binding === undefined) throw new Error('missing private binding')
				calls.push(`resolve-v2:${input.runId}:${binding.connectionId}:${binding.installationId}`)
				return { runId: input.runId, commitSha: input.expectedCommitSha ?? COMMIT_SHA, descriptorSha256: input.descriptorSha256 }
			},
			uploadV2: async (input) => {
				const binding = input.privateBinding
				if (binding === undefined) throw new Error('missing private binding')
				calls.push(`upload-v2:${input.runId}:${binding.connectionId}:${binding.installationId}`)
				return {
					runId: input.runId,
					appVersionId: input.appVersionId,
					commitSha: input.commitSha,
					descriptorSha256: input.descriptor.sha256,
				}
			},
		}
		const control = createTestControlProvider({ accessToken: 'zt-secret', api: makeApi(recorded), source })
		const binding1: ZeropsSourceTransportBinding = { connectionId: 'connection-1', installationId: 41, transportKind: 'keyed-v2' }
		const binding2: ZeropsSourceTransportBinding = { connectionId: 'connection-2', installationId: 42, transportKind: 'keyed-v2' }
		const app1 = { ...app, source: { ...app.source, githubConnectionId: binding1.connectionId, githubInstallationId: binding1.installationId } }
		const app2 = { ...app, source: { ...app.source, githubConnectionId: binding2.connectionId, githubInstallationId: binding2.installationId } }
		const signal = new AbortController().signal

		await Promise.all([
			control.resolveSourceWithBinding({ runId: 'run-1', app: app1, environment: environment(), signal, sourceBinding: binding1 }),
			control.resolveSourceWithBinding({ runId: 'run-2', app: app2, environment: environment(), signal, sourceBinding: binding2 }),
		])
		await Promise.all([
			control.deployWithBinding({ ...deployInput(recorded), runId: 'run-1', app: app1, sourceBinding: binding1 }),
			control.deployWithBinding({ ...deployInput(recorded), runId: 'run-2', app: app2, sourceBinding: binding2 }),
		])

		expect(calls).toContain('resolve-v2:run-1:connection-1:41')
		expect(calls).toContain('resolve-v2:run-2:connection-2:42')
		expect(calls).toContain('upload-v2:run-1:connection-1:41')
		expect(calls).toContain('upload-v2:run-2:connection-2:42')
		expect(calls.some((call) => call.startsWith('resolve:') || call.startsWith('upload:'))).toBe(false)
	})

	test('rejects partial, unbound, and swapped private source coordinates before source calls', async () => {
		const calls: string[] = []
		const control = createTestControlProvider({ accessToken: 'zt-secret', api: makeApi(recorded), source: makeSource(calls) })
		const signal = new AbortController().signal
		const partial = { ...app, source: { ...app.source, githubInstallationId: 42 } }
		expect(() => control.normalizeRegistration({ app: partial, environment: environment() })).toThrow('both connection and installation')
		const privateApp = { ...app, source: { ...app.source, githubConnectionId: 'connection-1', githubInstallationId: 42 } }
		if (control.resolveSource === undefined) throw new Error('expected source resolution')
		await expect(control.resolveSource({ runId: 'run-1', app: privateApp, environment: environment(), signal })).rejects.toThrow(
			'explicit transport binding',
		)
		await expect(control.resolveSourceWithBinding({
			runId: 'run-1',
			app: privateApp,
			environment: environment(),
			signal,
			sourceBinding: { connectionId: 'connection-2', installationId: 42, transportKind: 'legacy-v1' },
		})).rejects.toThrow('different application coordinates')
		expect(calls).toEqual([])
	})

	test('rejects structured manifest drift before beforeDeploy or the Zerops API', async () => {
		const manifest = compileFabrikaManifest(config, 'prod', SOURCE_DESCRIPTOR)
		const service = manifest.target.importDocument.services[0]
		if (service === undefined) throw new Error('expected a service')
		const drifted = {
			...manifest,
			target: {
				...manifest.target,
				importDocument: { services: [{ ...service, override: false }] },
			},
		}
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			api: makeApi(recorded),
			beforeDeploy: async () => {
				recorded.beforeDeploy.push('called')
			},
		})

		await expect(control.deploy({
			...deployInput(recorded),
			environment: environment({
				artifact: {
					provider: 'zerops',
					version: zeropsArtifactCodec.version,
					payload: zeropsArtifactCodec.encode(drifted),
				},
			}),
		})).rejects.toThrow('invariants')
		expect(recorded.beforeDeploy).toEqual([])
		expect(recorded.calls).toEqual([])
	})

	test('composes ephemeral credentials, runs beforeDeploy, and routes run events', async () => {
		let observedRun: RuntimeProviderRun | undefined
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			apiBaseUrl: 'https://api.test',
			propustkaUrl: 'https://iam.test',
			adminKey: 'px-secret',
			api: makeApi(recorded),
			beforeDeploy: async ({ appId, namespaceId, target }) => {
				recorded.beforeDeploy.push(`${appId}:${namespaceId}:${target.projectId}:${target.proxyServiceId}`)
				recorded.calls.push('beforeDeploy')
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
			source: {
				runId: 'run-1',
				repository: { owner: 'acme', name: 'notes' },
				commitSha: COMMIT_SHA,
			},
			apiBaseUrl: 'https://api.test',
			propustkaUrl: 'https://iam.test',
			adminKey: 'px-secret',
		})
		expect(outcome).toEqual({ state: 'succeeded' })
		expect(recorded.beforeDeploy).toEqual(['notes:apps-prod:project-1:proxy-service-1'])
		expect(recorded.externalIds).toEqual(['version-1'])
		expect(recorded.triggers).toEqual([])
		expect(recorded.calls).toContain('createAppVersion:service-1')
		expect(recorded.calls).toContain('buildAndDeployAppVersion:version-1')
		expect(recorded.calls.indexOf('beforeDeploy')).toBeLessThan(recorded.calls.indexOf('importServices'))
		expect(observedRun.cwd).toBe('apps/notes')
		expect(recorded.logs.join('\n')).not.toContain('zt-secret')
		expect(JSON.stringify(deployInput(recorded).environment)).not.toContain('zt-secret')
	})

	test('uses the same credential-free runtime coordinates for public and explicitly bound legacy repositories', async () => {
		const observed: Array<ZeropsRuntimeTarget['source']> = []
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			api: makeApi(recorded),
			execute: async (_provider, run) => {
				const target = zeropsTargetCodec.decode(run.target.payload)
				observed.push(target.source)
				return { state: 'succeeded' }
			},
		})

		await control.deploy({
			...deployInput(recorded),
			app: { ...app, source: { ...app.source, repoUrl: 'github.com/acme/notes', ref: COMMIT_SHA } },
		})
		await control.deployWithBinding({
			...deployInput(recorded),
			app: {
				...app,
				source: {
					...app.source,
					repoUrl: 'https://github.com/acme/notes',
					ref: COMMIT_SHA,
					githubConnectionId: 'legacy-connection',
					githubInstallationId: 42,
				},
			},
			sourceBinding: { connectionId: 'legacy-connection', installationId: 42, transportKind: 'legacy-v1' },
		})

		expect(observed).toEqual([
			{ runId: 'run-1', repository: { owner: 'acme', name: 'notes' }, commitSha: COMMIT_SHA },
			{ runId: 'run-1', repository: { owner: 'acme', name: 'notes' }, commitSha: COMMIT_SHA, githubInstallationId: 42 },
		])
		expect(environment().target.payload).toEqual({ serviceId: 'service-1' })
	})

	test('rejects credential-bearing and stateful repository URLs before platform mutation', async () => {
		const unsafe = [
			'https://git@github.com/acme/notes',
			'https://x-access-token:credential-must-not-leak@github.com/acme/notes',
			'https://github.com/acme/notes?token=credential-must-not-leak',
			'https://github.com/acme/notes#credential-must-not-leak',
			'file:/tmp/repo',
			'https:\\\\x-access-token:credential-must-not-leak@github.com/acme/notes',
			'https:////x-access-token:credential-must-not-leak@github.com/acme/notes',
			'http://github.com/acme/notes',
			' github.com/acme/notes',
			'github.com/acme/not es',
			'github.com/acme/notes\n',
			'github.com/acme/\u0000notes',
		]
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			api: makeApi(recorded),
			beforeDeploy: async () => {
				recorded.beforeDeploy.push('called')
			},
		})

		for (const repoUrl of unsafe) {
			await expect(control.deploy({
				...deployInput(recorded),
				app: { ...app, source: { ...app.source, repoUrl } },
			})).rejects.toThrow('source repository URL')
		}

		expect(recorded.beforeDeploy).toEqual([])
		expect(recorded.calls).toEqual([])
		expect(recorded.envWrites).toEqual([])
		expect(recorded.logs.join('\n')).not.toContain('credential-must-not-leak')
	})

	test('writes managed environment only to the app service and never to YAML or logs', async () => {
		const dsn = 'https://operations-public-key@errors.test/1'
		const control = createTestControlProvider({ accessToken: 'zt-secret', api: makeApi(recorded) })
		await control.deploy({
			...deployInput(recorded),
			managedEnvironment: {
				FABRIKA_OPERATIONS_DSN: dsn,
				FABRIKA_RELEASE: 'fabrika/notes/prod/default/commit',
			},
		})
		expect(recorded.envWrites).toEqual([
			{ serviceId: 'service-1', key: 'FABRIKA_OPERATIONS_DSN', value: dsn },
			{ serviceId: 'service-1', key: 'FABRIKA_RELEASE', value: 'fabrika/notes/prod/default/commit' },
		])
		expect(recorded.imports[0]?.yaml).not.toContain('FABRIKA_OPERATIONS_DSN')
		expect(recorded.imports[0]?.yaml).not.toContain(dsn)
		expect(recorded.logs.join('\n')).not.toContain(dsn)
	})

	test('removes stale managed values when Operations and release state become unavailable', async () => {
		const dsn = 'https://operations-public-key@errors.test/1'
		const release = 'fabrika/notes/prod/default/commit'
		const managed = {
			FABRIKA_OPERATIONS_DSN: dsn,
			FABRIKA_APP_ID: 'notes',
			FABRIKA_ENVIRONMENT: 'prod',
			FABRIKA_SERVICE_KEY: 'default',
			FABRIKA_RELEASE: release,
		}
		const api: ZeropsApi = {
			...makeApi(recorded),
			listServiceEnv: async () =>
				Object.entries(managed).map(([key, content], index) => ({
					id: `managed-${index}`,
					key,
					content,
				})),
		}
		const control = createTestControlProvider({ accessToken: 'zt-secret', api })
		await control.deploy({ ...deployInput(recorded), managedEnvironment: managed })
		await control.deploy({
			...deployInput(recorded),
			runId: 'run-2',
			managedEnvironment: {
				FABRIKA_OPERATIONS_DSN: null,
				FABRIKA_APP_ID: null,
				FABRIKA_ENVIRONMENT: null,
				FABRIKA_SERVICE_KEY: null,
				FABRIKA_RELEASE: null,
			},
		})

		expect(recorded.envWrites).toHaveLength(5)
		expect(recorded.envDeletes.sort()).toEqual(['managed-0', 'managed-1', 'managed-2', 'managed-3', 'managed-4'])
		expect(recorded.logs.join('\n')).not.toContain(dsn)
		expect(recorded.logs.join('\n')).not.toContain(release)
	})

	test('dry-run names managed service values without mutating Zerops or exposing values', async () => {
		const dsn = 'https://operations-public-key@errors.test/1'
		const sourceCalls: string[] = []
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			api: makeApi(recorded),
			source: makeSource(sourceCalls),
			beforeDeploy: async () => {
				recorded.beforeDeploy.push('called')
			},
		})
		await control.deploy({
			...deployInput(recorded),
			dryRun: true,
			managedEnvironment: { FABRIKA_OPERATIONS_DSN: dsn },
		})
		expect(recorded.envWrites).toEqual([])
		expect(recorded.calls).toEqual([])
		expect(recorded.beforeDeploy).toEqual([])
		expect(sourceCalls).toEqual([])
		expect(recorded.logs.join('\n')).toContain('FABRIKA_OPERATIONS_DSN')
		expect(recorded.logs.join('\n')).not.toContain(dsn)
	})

	test('places an app that consumes shared PostgreSQL into its namespace project', async () => {
		const sharedConfig: ZeropsAppConfig = {
			id: 'notes',
			target: {
				platform: 'zerops',
				services: () => [{ hostname: 'notesapi', type: 'alpine/bun@1.3' }],
				deployService: 'notesapi',
				namespaceResources: [useSharedPostgres()],
			},
		}
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			api: makeApi(recorded),
			sleep: () => Promise.resolve(),
		})
		const manifest = compileFabrikaManifest(sharedConfig, 'prod', SOURCE_DESCRIPTOR)
		const input = deployInput(recorded)
		await control.deploy({
			...input,
			environment: environment({
				namespace: {
					...readyNamespace(),
					target: {
						provider: 'zerops',
						version: zeropsNamespaceTargetCodec.version,
						payload: zeropsNamespaceTargetCodec.encode({
							projectId: 'project-1',
							proxyServiceId: 'proxy-service-1',
							proxyBuildFromGit: 'https://github.com/contember/fabrika-platform',
							postgres: { type: 'postgresql:ha@18' },
							postgresServiceId: 'postgres-service-1',
							ready: true,
						}),
					},
				},
				artifact: {
					provider: 'zerops',
					version: zeropsArtifactCodec.version,
					payload: zeropsArtifactCodec.encode(manifest),
				},
			}),
		})

		expect(recorded.imports).toHaveLength(1)
		expect(recorded.imports[0]?.projectId).toBe('project-1')
		expect(recorded.imports[0]?.yaml).not.toContain('hostname: postgres')
		expect(manifest.target.namespaceResources).toEqual([{
			resourceKey: 'service:postgres',
			hostname: 'postgres',
			connectionString: ZEROPS_SHARED_POSTGRES_CONNECTION_STRING,
		}])
	})

	test('carries the control plane return origins through the deploy into the schema reconciler', async () => {
		const reconciled: Array<{ app: string; returnOrigins?: readonly string[] }> = []
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			propustkaUrl: 'https://iam.test',
			api: makeApi(recorded),
			reconcileSchema: async ({ app, returnOrigins }) => {
				reconciled.push({ app, ...(returnOrigins === undefined ? {} : { returnOrigins }) })
			},
		})
		const withSchema = environment({
			artifact: {
				provider: 'zerops',
				version: zeropsArtifactCodec.version,
				payload: zeropsArtifactCodec.encode(compileFabrikaManifest({ ...config, schema: SCHEMA }, 'prod', SOURCE_DESCRIPTOR)),
			},
		})

		// Every step really runs, so this proves the whole in-process hop chain: deploy input → run →
		// `reconcile-schema` step → the IAM port. The set is app-wide, not this environment's origin.
		await control.deploy({
			...deployInput(recorded),
			environment: withSchema,
			returnOrigins: ['https://notes.example.test', 'https://stage.notes.example.test'],
		})
		expect(reconciled).toEqual([{
			app: 'notes',
			returnOrigins: ['https://notes.example.test', 'https://stage.notes.example.test'],
		}])

		// Nothing projected → the registry is left alone rather than cleared.
		await control.deploy({ ...deployInput(recorded), runId: 'run-2', environment: withSchema })
		expect(reconciled[1]).toEqual({ app: 'notes' })
	})

	test('fails before proxy or app mutation when namespace placement is not ready', async () => {
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			api: makeApi(recorded),
			beforeDeploy: async () => {
				recorded.beforeDeploy.push('called')
			},
		})
		await expect(control.deploy({
			...deployInput(recorded),
			environment: environment({
				namespace: {
					...readyNamespace(),
					target: {
						provider: 'zerops',
						version: zeropsNamespaceTargetCodec.version,
						payload: zeropsNamespaceTargetCodec.encode({
							projectId: 'project-1',
							proxyServiceId: 'proxy-service-1',
							proxyBuildFromGit: 'https://github.com/contember/fabrika-platform',
							ready: false,
						}),
					},
				},
			}),
		})).rejects.toThrow('is not ready')
		expect(recorded.beforeDeploy).toEqual([])
		expect(recorded.calls).toEqual([])
	})

	test('finishes schema reconciliation after an active external run without starting another deploy', async () => {
		let current: ZeropsAppVersionStatus = 'BUILDING'
		const reconcileSignals: AbortSignal[] = []
		const reconciledOrigins: Array<readonly string[] | undefined> = []
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			propustkaUrl: 'https://iam.test',
			api: makeApi(recorded, () => current),
			reconcileSchema: async ({ app, signal, returnOrigins }) => {
				recorded.calls.push(`reconcileSchema:${app}`)
				reconcileSignals.push(signal)
				reconciledOrigins.push(returnOrigins)
			},
		})
		if (control.cancel === undefined || control.reconcile === undefined) {
			throw new Error('expected Zerops lifecycle capabilities')
		}
		const reference = {
			runId: 'run-1',
			externalId: 'version-1',
			providerState: { appVersionId: 'version-1', phase: 'build_triggered' },
			checkpoint: () => Promise.resolve(),
			// A resumed deploy finishes the same IAM touchpoint, so it projects the same set.
			returnOrigins: ['https://notes.example.test'],
			environment: environment({
				artifact: {
					provider: 'zerops',
					version: zeropsArtifactCodec.version,
					payload: zeropsArtifactCodec.encode(compileFabrikaManifest({ ...config, schema: SCHEMA }, 'prod', SOURCE_DESCRIPTOR)),
				},
			}),
		}
		expect(await control.reconcile(reference)).toEqual<ProviderReconcileOutcome>({ state: 'running' })
		expect(recorded.calls).toEqual(['getAppVersion:version-1'])
		current = 'ACTIVE'
		expect(await control.reconcile(reference)).toEqual<ProviderReconcileOutcome>({ state: 'succeeded' })
		expect(recorded.calls).toEqual([
			'getAppVersion:version-1',
			'getAppVersion:version-1',
			'reconcileSchema:notes',
		])
		expect(reconcileSignals).toHaveLength(1)
		expect(reconcileSignals[0]?.aborted).toBe(false)
		expect(reconciledOrigins).toEqual([['https://notes.example.test']])
		current = 'BUILD_FAILED'
		expect(await control.reconcile(reference)).toEqual<ProviderReconcileOutcome>({ state: 'failed' })
		await control.cancel(reference)
		expect(recorded.calls).toContain('cancelBuild:version-1')
		expect(recorded.calls).not.toContain('importServices')
		expect(recorded.calls).not.toContain('triggerPipeline')
	})

	test('checkpoints recovered upload before the one build trigger and then records its process', async () => {
		const timeline: string[] = []
		const checkpoints: unknown[] = []
		const api: ZeropsApi = {
			...makeApi(recorded),
			buildAndDeployAppVersion: async ({ appVersionId, zeropsYaml, zeropsYamlSetup }) => {
				timeline.push(`build:${appVersionId}`)
				expect(zeropsYaml).toBe(SOURCE_DESCRIPTOR.contents)
				expect(zeropsYamlSetup).toBeUndefined()
				return { id: 'process-1', appVersionId }
			},
		}
		const control = createTestControlProvider({ accessToken: 'zt-secret', api })
		if (control.reconcile === undefined) throw new Error('expected Zerops reconciliation')

		const outcome = await control.reconcile({
			runId: 'run-1',
			externalId: 'version-1',
			providerState: { appVersionId: 'version-1', phase: 'source_uploaded' },
			environment: environment(),
			checkpoint: (state) => {
				checkpoints.push(state)
				const phase = typeof state === 'object' && state !== null && !Array.isArray(state) ? state['phase'] : undefined
				timeline.push(`checkpoint:${typeof phase === 'string' ? phase : 'invalid'}`)
				return Promise.resolve()
			},
		})

		expect(outcome).toEqual({ state: 'succeeded' })
		expect(timeline).toEqual([
			'checkpoint:build_trigger_requested',
			'build:version-1',
			'checkpoint:build_triggered',
		])
		expect(checkpoints).toEqual([
			{ appVersionId: 'version-1', phase: 'build_trigger_requested' },
			{ appVersionId: 'version-1', phase: 'build_triggered', processId: 'process-1' },
		])
	})

	test('never triggers twice from the ambiguous build-requested checkpoint', async () => {
		const checkpoints: unknown[] = []
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			api: makeApi(recorded, () => 'BUILDING'),
			sleep: async (ms) => {
				recorded.calls.push(`sleep:${ms}`)
			},
		})
		if (control.reconcile === undefined) throw new Error('expected Zerops reconciliation')

		expect(
			await control.reconcile({
				runId: 'run-1',
				externalId: 'version-1',
				providerState: { appVersionId: 'version-1', phase: 'build_trigger_requested' },
				environment: environment(),
				checkpoint: (state) => {
					checkpoints.push(state)
					return Promise.resolve()
				},
			}),
		).toEqual({ state: 'running' })
		expect(checkpoints).toEqual([{ appVersionId: 'version-1', phase: 'build_triggered' }])
		expect(recorded.calls).toEqual(['sleep:10000', 'getAppVersion:version-1', 'getAppVersion:version-1'])
		expect(recorded.calls).not.toContain('buildAndDeployAppVersion:version-1')
	})

	test('keeps unknown and unavailable build-request observations retryable', async () => {
		const checkpoints: unknown[] = []
		const reference = {
			runId: 'run-1',
			externalId: 'version-1',
			providerState: { appVersionId: 'version-1', phase: 'build_trigger_requested' },
			environment: environment(),
			checkpoint: (state: JsonValue) => {
				checkpoints.push(state)
				return Promise.resolve()
			},
		}
		const unknown = createTestControlProvider({
			accessToken: 'zt-secret',
			api: makeApi(recorded, () => undefined),
			sleep: () => Promise.resolve(),
		})
		if (unknown.reconcile === undefined || unknown.cancel === undefined) throw new Error('expected Zerops lifecycle capabilities')

		expect(await unknown.reconcile(reference)).toEqual({ state: 'running' })
		await expect(unknown.cancel(reference)).rejects.toThrow('status is not observable')
		expect(recorded.calls).toEqual(['getAppVersion:version-1', 'getAppVersion:version-1'])
		expect(checkpoints).toEqual([])

		const unavailableApi: ZeropsApi = {
			...makeApi(recorded),
			getAppVersion: async () => {
				recorded.calls.push('getAppVersion:unavailable')
				throw new Error('temporary observation failure')
			},
		}
		const unavailable = createTestControlProvider({
			accessToken: 'zt-secret',
			api: unavailableApi,
			sleep: () => Promise.resolve(),
		})
		if (unavailable.reconcile === undefined) throw new Error('expected Zerops reconciliation')
		expect(await unavailable.reconcile(reference)).toEqual({ state: 'running' })
		expect(recorded.calls).not.toContain('deleteAppVersion:version-1')
	})

	test('keeps an accepted build retryable when its result checkpoint fails', async () => {
		let checkpoint = 0
		const control = createTestControlProvider({ accessToken: 'zt-secret', api: makeApi(recorded) })
		if (control.reconcile === undefined) throw new Error('expected Zerops reconciliation')

		expect(
			await control.reconcile({
				runId: 'run-1',
				externalId: 'version-1',
				providerState: { appVersionId: 'version-1', phase: 'source_uploaded' },
				environment: environment(),
				checkpoint: () => {
					checkpoint++
					return checkpoint === 1 ? Promise.resolve() : Promise.reject(new Error('checkpoint unavailable'))
				},
			}),
		).toEqual({ state: 'running' })
		expect(recorded.calls).toEqual(['buildAndDeployAppVersion:version-1'])
		expect(recorded.calls).not.toContain('deleteAppVersion:version-1')
	})

	test('keeps a lost build response retryable when follow-up observation fails', async () => {
		const api: ZeropsApi = {
			...makeApi(recorded),
			buildAndDeployAppVersion: async () => {
				recorded.calls.push('buildAndDeployAppVersion:version-1')
				throw new Error('build response lost')
			},
			getAppVersion: async () => {
				recorded.calls.push('getAppVersion:unavailable')
				throw new Error('temporary observation failure')
			},
		}
		const control = createTestControlProvider({ accessToken: 'zt-secret', api, sleep: () => Promise.resolve() })
		if (control.reconcile === undefined) throw new Error('expected Zerops reconciliation')

		expect(
			await control.reconcile({
				runId: 'run-1',
				externalId: 'version-1',
				providerState: { appVersionId: 'version-1', phase: 'source_uploaded' },
				environment: environment(),
				checkpoint: () => Promise.resolve(),
			}),
		).toEqual({ state: 'running' })
		expect(recorded.calls).toEqual(['buildAndDeployAppVersion:version-1', 'getAppVersion:unavailable'])
		expect(recorded.calls).not.toContain('deleteAppVersion:version-1')
	})

	test('bounds failed and hanging source cancellation before every Zerops cleanup', async () => {
		let cancellations = 0
		const sourceSignals: AbortSignal[] = []
		const deleteSignals: AbortSignal[] = []
		const source: ZeropsSourceClient = {
			...makeSource(),
			cancel: async ({ signal }) => {
				cancellations++
				sourceSignals.push(signal)
				if (cancellations % 2 === 1) throw new Error('source cancellation unavailable')
				return new Promise<void>(() => {})
			},
		}
		const api: ZeropsApi = {
			...makeApi(recorded, () => 'UPLOADING'),
			buildAndDeployAppVersion: async ({ appVersionId }) => {
				recorded.calls.push(`buildAndDeployAppVersion:${appVersionId}`)
				throw new ZeropsApiError('zerops: build rejected', 400, 'invalidBuild')
			},
			deleteAppVersion: async ({ appVersionId, signal }) => {
				recorded.calls.push(`deleteAppVersion:${appVersionId}`)
				deleteSignals.push(signal)
			},
		}
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			api,
			source,
			sourceCancelSleep: () => Promise.resolve(),
			sleep: () => Promise.resolve(),
		})
		if (control.reconcile === undefined || control.cancel === undefined) throw new Error('expected Zerops lifecycle capabilities')
		const reference = {
			runId: 'run-1',
			externalId: 'version-1',
			environment: environment(),
			checkpoint: () => Promise.resolve(),
		}

		expect(
			await control.reconcile({
				...reference,
				providerState: { appVersionId: 'version-1', phase: 'version_created' },
			}),
		).toEqual({ state: 'failed' })
		await control.cancel({
			runId: 'run-1',
			externalId: 'version-1',
			environment: environment(),
			providerState: { appVersionId: 'version-1', phase: 'source_uploaded' },
		})
		expect(
			await control.reconcile({
				...reference,
				providerState: { appVersionId: 'version-1', phase: 'build_trigger_requested' },
			}),
		).toEqual({ state: 'failed' })
		expect(
			await control.reconcile({
				...reference,
				providerState: { appVersionId: 'version-1', phase: 'source_uploaded' },
			}),
		).toEqual({ state: 'failed' })
		expect(cancellations).toBe(4)
		expect(sourceSignals.every((signal) => signal.aborted)).toBe(true)
		expect(deleteSignals.every((signal) => !signal.aborted)).toBe(true)
		expect(deleteSignals.some((signal) => sourceSignals.includes(signal))).toBe(false)
		expect(recorded.calls).toEqual([
			'deleteAppVersion:version-1',
			'deleteAppVersion:version-1',
			'getAppVersion:version-1',
			'deleteAppVersion:version-1',
			'buildAndDeployAppVersion:version-1',
			'deleteAppVersion:version-1',
		])
	})

	test('deletes known pre-trigger crash phases and fails closed', async () => {
		const sourceCalls: string[] = []
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			api: makeApi(recorded, () => 'UPLOADING'),
			source: makeSource(sourceCalls),
			sleep: () => Promise.resolve(),
		})
		if (control.reconcile === undefined) throw new Error('expected Zerops reconciliation')
		const reference = {
			runId: 'run-1',
			externalId: 'version-1',
			environment: environment(),
			checkpoint: () => Promise.resolve(),
		}

		expect(
			await control.reconcile({
				...reference,
				providerState: { appVersionId: 'version-1', phase: 'version_created' },
			}),
		).toEqual({ state: 'failed' })
		expect(
			await control.reconcile({
				...reference,
				providerState: { appVersionId: 'version-1', phase: 'build_trigger_requested' },
			}),
		).toEqual({ state: 'failed' })
		const driftedArtifact = compileFabrikaManifest(config, 'prod', {
			...SOURCE_DESCRIPTOR,
			contents: `${SOURCE_DESCRIPTOR.contents}# changed after upload\n`,
		})
		expect(
			await control.reconcile({
				...reference,
				providerState: { appVersionId: 'version-1', phase: 'source_uploaded' },
				environment: environment({
					artifact: {
						provider: 'zerops',
						version: zeropsArtifactCodec.version,
						payload: zeropsArtifactCodec.encode(driftedArtifact),
					},
				}),
			}),
		).toEqual({ state: 'failed' })
		expect(sourceCalls).toEqual([
			'sourceCancel:run-1:version-1',
			'sourceCancel:run-1:version-1',
			'sourceCancel:run-1:version-1',
		])
		expect(recorded.calls).toEqual([
			'deleteAppVersion:version-1',
			'getAppVersion:version-1',
			'deleteAppVersion:version-1',
			'deleteAppVersion:version-1',
		])
	})

	test('validates durable state and uses its latest phase for cancellation', async () => {
		const sourceCalls: string[] = []
		const control = createTestControlProvider({ accessToken: 'zt-secret', api: makeApi(recorded), source: makeSource(sourceCalls) })
		if (control.reconcile === undefined || control.cancel === undefined) throw new Error('expected Zerops lifecycle capabilities')
		const reference = {
			runId: 'run-1',
			externalId: 'version-1',
			environment: environment(),
			checkpoint: () => Promise.resolve(),
		}
		const invalidStates: Array<JsonValue | undefined> = [
			undefined,
			{ appVersionId: 'different', phase: 'build_triggered' },
			{ appVersionId: 'version-1', phase: 'unknown' },
			{ appVersionId: 'version-1', phase: 'source_uploaded', uploadUrl: 'must-not-persist' },
		]
		for (const providerState of invalidStates) {
			await expect(control.reconcile({ ...reference, providerState })).rejects.toThrow('Zerops run state')
		}
		expect(recorded.calls).toEqual([])

		await control.cancel({
			runId: 'run-1',
			externalId: 'version-1',
			environment: environment(),
			providerState: { appVersionId: 'version-1', phase: 'source_uploaded' },
		})
		await control.cancel({
			runId: 'run-1',
			externalId: 'version-1',
			environment: environment(),
			providerState: { appVersionId: 'version-1', phase: 'build_triggered', processId: 'process-1' },
		})
		expect(sourceCalls).toEqual([
			'sourceCancel:run-1:version-1',
			'sourceCancel:run-1:version-1',
		])
		expect(recorded.calls).toEqual(['deleteAppVersion:version-1', 'cancelBuild:version-1'])
	})

	test('writes and deletes one service-level secret and returns an opaque reference', async () => {
		const control = createTestControlProvider({ accessToken: 'zt-secret', api: makeApi(recorded) })
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
