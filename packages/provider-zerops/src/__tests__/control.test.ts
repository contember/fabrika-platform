import type {
	ProviderApp,
	ProviderDeployInput,
	ProviderDeploymentNamespace,
	ProviderEnvironment,
	ProviderReconcileOutcome,
	RuntimeProviderRun,
} from '@fabrika/provider-contract'
import { beforeEach, describe, expect, test } from 'bun:test'
import type { ZeropsApi, ZeropsAppVersionStatus } from '../api'
import { useSharedPostgres } from '../authoring'
import { zeropsTargetCodec } from '../codec'
import { createZeropsControlProvider, zeropsStoredTargetCodec } from '../control'
import { compileFabrikaManifest, zeropsArtifactCodec } from '../manifest'
import { zeropsNamespacePreset, zeropsNamespaceTargetCodec } from '../namespace'
import { zeropsSharedServiceHostname } from '../service-names'
import type { ZeropsAppConfig } from '../types'

interface Recorded {
	calls: string[]
	externalIds: string[]
	logs: string[]
	envWrites: Array<{ serviceId: string; key: string; value: string }>
	envDeletes: string[]
	beforeDeploy: string[]
	imports: Array<{ projectId: string; yaml: string }>
}

const fresh = (): Recorded => ({
	calls: [],
	externalIds: [],
	logs: [],
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

const app: ProviderApp = {
	id: 'notes',
	source: {
		repoUrl: 'https://github.com/acme/notes',
		ref: 'refs/heads/main',
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
			ready: true,
		}),
	},
})

const environment = (overrides: Partial<ProviderEnvironment> = {}): ProviderEnvironment => ({
	appId: 'notes',
	env: 'prod',
	domain: 'notes.example.test',
	namespace: readyNamespace(),
	target: {
		provider: 'zerops',
		version: zeropsStoredTargetCodec.version,
		payload: zeropsStoredTargetCodec.encode({ serviceId: 'service-1' }),
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
	importServices: async ({ projectId, yaml }) => {
		recorded.calls.push('importServices')
		recorded.imports.push({ projectId, yaml })
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
		expect(normalized.environment.target.payload).toEqual({ serviceId: 'service-1' })
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
		const withoutNamespaces = createZeropsControlProvider({ accessToken: 'zt-secret', api: makeApi(recorded) })
		const withNamespaces = createZeropsControlProvider({
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

	test('derives reserved and app-owned claims from the canonical structured import', () => {
		const control = createZeropsControlProvider({
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
					payload: zeropsArtifactCodec.encode(compileFabrikaManifest(namespacedConfig, 'prod')),
				},
			}),
		})

		expect(control.namespaces.namespaceResourceClaims(namespace)).toEqual(['service:proxy', 'service:postgres'])
		expect(control.namespaces.registrationResourceClaims(registration)).toEqual(['service:notesapi', 'service:notesdb'])
	})

	test('rejects shared prefix, reserved service, and missing namespace resource requirements', () => {
		const control = createZeropsControlProvider({
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
						payload: zeropsArtifactCodec.encode(compileFabrikaManifest(candidate, 'prod')),
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
						connectionString: '${postgres_connectionString}',
					}],
				},
			})
		).toThrow('does not provide')
		expect(claimsFor(target('api'), exclusive)).toEqual(['service:api'])
	})
})

describe('Zerops ControlProvider lifecycle', () => {
	test('rejects structured manifest drift before beforeDeploy or the Zerops API', async () => {
		const manifest = compileFabrikaManifest(config, 'prod')
		const service = manifest.target.importDocument.services[0]
		if (service === undefined) throw new Error('expected a service')
		const drifted = {
			...manifest,
			target: {
				...manifest.target,
				importDocument: { services: [{ ...service, override: false }] },
			},
		}
		const control = createZeropsControlProvider({
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
		const control = createZeropsControlProvider({
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
			apiBaseUrl: 'https://api.test',
			propustkaUrl: 'https://iam.test',
			adminKey: 'px-secret',
		})
		expect(outcome).toEqual({ state: 'succeeded' })
		expect(recorded.beforeDeploy).toEqual(['notes:apps-prod:project-1:proxy-service-1'])
		expect(recorded.externalIds).toEqual(['version-1'])
		expect(recorded.calls.indexOf('beforeDeploy')).toBeLessThan(recorded.calls.indexOf('importServices'))
		expect(recorded.logs.join('\n')).not.toContain('zt-secret')
		expect(JSON.stringify(deployInput(recorded).environment)).not.toContain('zt-secret')
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
		const control = createZeropsControlProvider({
			accessToken: 'zt-secret',
			api: makeApi(recorded),
			sleep: () => Promise.resolve(),
		})
		const manifest = compileFabrikaManifest(sharedConfig, 'prod')
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
			connectionString: '${postgres_connectionString}',
		}])
	})

	test('fails before proxy or app mutation when namespace placement is not ready', async () => {
		const control = createZeropsControlProvider({
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
							ready: false,
						}),
					},
				},
			}),
		})).rejects.toThrow('is not ready')
		expect(recorded.beforeDeploy).toEqual([])
		expect(recorded.calls).toEqual([])
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
