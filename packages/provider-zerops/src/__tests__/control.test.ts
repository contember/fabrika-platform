import type { AppSchema } from '@fabrika/auth-core'
import type {
	JsonValue,
	ProviderApp,
	ProviderDeployInput,
	ProviderDeploymentNamespace,
	ProviderEnvironment,
	ProviderReconcileOutcome,
	ProviderRegistrationInput,
	ProviderSourceBinding,
} from '@fabrika/provider-contract'
import { ProviderInvocationAbort, ProviderSecretError } from '@fabrika/provider-contract'
import { contractProxyTable } from '@fabrika/proxy-core/manifest'
import { beforeEach, describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { createZeropsApi, type ZeropsApi, ZeropsApiError, type ZeropsAppVersionStatus, type ZeropsServiceEnv } from '../api'
import { useSharedPostgres } from '../authoring'
import { createZeropsControlProvider, type ZeropsControlProviderOptions, zeropsStoredTargetCodec } from '../control'
import type { ManagedValues } from '../managed-env'
import { compileFabrikaManifest, createZeropsArtifactSourceDescriptor, zeropsArtifactCodec } from '../manifest'
import { ZEROPS_SHARED_POSTGRES_CONNECTION_STRING, zeropsNamespacePreset, zeropsNamespaceTargetCodec } from '../namespace'
import type { OlderProxyReaders } from '../namespace/proxy-reads'
import { zeropsSharedServiceHostname } from '../service-names'
import type { ZeropsSourcePort, ZeropsSourceUploadInput } from '../source/port'
import type { ZeropsAppConfig } from '../types'
import { approvedContract } from './fixtures/access'
import { SOURCE_DESCRIPTOR } from './fixtures/descriptor'
import { rejectedDescriptorCorpus } from './fixtures/descriptor-corpus'

interface Recorded {
	calls: string[]
	externalIds: string[]
	logs: string[]
	triggers: Array<{ serviceId: string; buildFromGit?: string; zeropsSetup?: string }>
	envWrites: Array<{ serviceId: string; key: string; value: string; sensitive: boolean }>
	envDeletes: string[]
	imports: Array<{ projectId: string; yaml: string }>
}

const fresh = (): Recorded => ({
	calls: [],
	externalIds: [],
	logs: [],
	triggers: [],
	envWrites: [],
	envDeletes: [],
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
const COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567'
/** Every managed value removed, but the proxy secret a contract application is never deployed without. */
const MANAGED_DEFAULTS: ManagedValues = {
	FABRIKA_RELEASE: null,
	FABRIKA_OPERATIONS_DSN: null,
	FABRIKA_IAM_ISSUER: null,
	FABRIKA_IAM_APP_ID: null,
	FABRIKA_APP_ID: null,
	FABRIKA_ENVIRONMENT: null,
	FABRIKA_SERVICE_KEY: null,
	FABRIKA_PROXY_SECRET: 'private-proxy-secret',
	FABRIKA_IAM_RPC_URL: null,
	FABRIKA_IAM_RPC_KEY: null,
	FABRIKA_APP_ORIGIN: null,
	FABRIKA_TOKEN_KEYS: null,
}
const checkpointFor = (triggered: boolean): JsonValue => ({ appVersionId: 'version-1', triggered })
const PROXY_SOURCE = {
	repository: { owner: 'example', name: 'platform' },
	commitSha: COMMIT_SHA,
	descriptor: await createZeropsArtifactSourceDescriptor('zerops:\n  - setup: proxy\n'),
}
/** These deploys run on the namespace's own pin, so no older proxy is consulted. */
const OLDER_PROXIES: OlderProxyReaders = [{ row: () => true, csp: () => true, signsOut: false }]

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
			proxySource: PROXY_SOURCE,
			projectId: 'project-1',
			proxyServiceId: 'proxy-service-1',
			ready: true,
		}),
	},
})

/** Control approved the contract of the commit it read, unless a test says otherwise. */
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
	access: approvedContract(),
	...overrides,
})

const deployInput = (recorded: Recorded): ProviderDeployInput => ({
	runId: 'run-1',
	app,
	environment: environment(),
	secrets: {},
	vars: {},
	managedEnvironment: MANAGED_DEFAULTS,
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
		boundary: async () => {},
	},
})

const makeApi = (
	recorded: Recorded,
	status: () => ZeropsAppVersionStatus | undefined = () => 'ACTIVE',
	freshService = false,
): ZeropsApi => {
	const records: ZeropsServiceEnv[] = [{ id: 'env-1', key: 'TOKEN', sensitive: true }]
	const deleted = new Set<string>()
	return {
		importServices: async ({ projectId, yaml }) => {
			recorded.calls.push('importServices')
			recorded.imports.push({ projectId, yaml })
			return {
				projectId,
				services: [{
					id: 'service-1',
					name: 'notes',
					processes: freshService
						? [
							{ id: 'creation-1', actionName: 'stack.create', serviceStackId: 'service-1' },
							{ id: 'deployment-1', actionName: 'stack.deploy', serviceStackId: 'service-1', appVersionId: 'bootstrap-1' },
						]
						: [],
				}],
			}
		},
		importProject: async ({ clientId }) => ({ projectId: clientId, services: [] }),
		triggerPipeline: async ({ serviceId, buildFromGit, zeropsSetup }) => {
			recorded.calls.push('triggerPipeline')
			recorded.triggers.push({ serviceId, buildFromGit, zeropsSetup })
			return { id: 'process-1', appVersionId: 'version-1' }
		},
		createAppVersion: async ({ serviceId }) => {
			recorded.calls.push(`createAppVersion:${serviceId}`)
			return { id: 'version-1', uploadUrl: UPLOAD_URL }
		},
		buildAndDeployAppVersion: async ({ appVersionId }) => {
			recorded.calls.push(`buildAndDeployAppVersion:${appVersionId}`)
			return { id: 'process-1', appVersionId }
		},
		deleteAppVersion: async ({ appVersionId }) => {
			recorded.calls.push(`deleteAppVersion:${appVersionId}`)
			if (deleted.has(appVersionId)) throw new ZeropsApiError('absent', 400, 'appVersionNotFound')
			deleted.add(appVersionId)
		},
		getAppVersion: async ({ appVersionId }) => {
			recorded.calls.push(`getAppVersion:${appVersionId}`)
			if (deleted.has(appVersionId)) throw new ZeropsApiError('absent', 400, 'appVersionNotFound')
			return { id: appVersionId, status: status() }
		},
		latestAppVersion: async () => ({ id: 'version-1', status: status(), sequence: 1 }),
		cancelBuild: async ({ appVersionId }) => {
			recorded.calls.push(`cancelBuild:${appVersionId}`)
		},
		getProcess: async ({ processId }) => ({
			id: processId,
			status: 'FINISHED',
			serviceStackId: 'service-1',
			actionName: processId === 'creation-1' ? 'stack.create' : 'stack.deploy',
			...(processId === 'deployment-1' ? { appVersionId: 'bootstrap-1' } : {}),
		}),
		getUserInfo: async () => {
			throw new Error('the control provider must not read the token identity')
		},
		createIntegrationToken: async () => {
			throw new Error('the control provider must not mint a Zerops token')
		},
		enableSubdomainAccess: async ({ serviceId }) => {
			recorded.calls.push(`enableSubdomainAccess:${serviceId}`)
		},
		configureAutoscaling: () => Promise.reject(new Error('the control provider must not change autoscaling')),
		configureCustomAutoscaling: () => Promise.reject(new Error('the control provider must not change autoscaling')),
		getBackupConfig: () => Promise.reject(new Error('the control provider must not read a backup schedule')),
		configureBackup: () => Promise.reject(new Error('the control provider must not change a backup schedule')),
		getService: async ({ serviceId }) => ({ id: serviceId, name: 'notes', projectId: 'project-1', activeAppVersionId: 'bootstrap-1' }),
		findService: async ({ hostname }) => ({ id: 'service-1', name: hostname, subdomainAccess: false }),
		getProject: async ({ projectId }) => ({ id: projectId, name: 'project' }),
		listProjects: async () => [],
		findProjects: async () => [],
		listProjectServices: async () => [],
		listServiceEnv: async () => records.map((record) => ({ ...record })),
		createServiceEnv: async () => {
			throw new Error('the control provider writes service variables only through putServiceEnv')
		},
		putServiceEnv: async ({ serviceId, key, value, sensitive }) => {
			recorded.envWrites.push({ serviceId, key, value, sensitive })
		},
		deleteServiceEnv: async ({ envId }) => {
			recorded.envDeletes.push(envId)
		},
		getProjectEnv: async ({ projectEnvId }) => ({ id: projectEnvId, key: 'KEY', sensitive: false, content: 'value' }),
		getLogAccess: async () => {
			throw new Error('logs unavailable')
		},
		readBuildLog: async () => [],
	}
}

const UPLOAD_URL = 'https://proxy.app-prg1.zerops.io/api/rest/object-storage/upload?signature=test'

const uploaded = (input: ZeropsSourceUploadInput) => ({
	commitSha: input.commitSha,
	descriptorSha256: input.descriptorSha256,
	entryCount: 1,
	expandedBytes: 1,
})

const makeSource = (calls: string[] = []): ZeropsSourcePort => ({
	resolve: async (input) => {
		calls.push(`resolve:${input.repository.owner}/${input.repository.name}:${input.requestedRef}`)
		return { commitSha: input.expectedCommitSha ?? COMMIT_SHA, descriptorSha256: input.descriptorSha256 }
	},
	upload: async (input) => {
		calls.push(`upload:${input.archive.kind}:${input.commitSha}`)
		return uploaded(input)
	},
})

type TestControlProviderOptions = Omit<ZeropsControlProviderOptions, 'source'> & {
	readonly source?: ZeropsSourcePort
}

const createTestControlProvider = (options: TestControlProviderOptions) => {
	const provider = createZeropsControlProvider({ ...options, source: options.source ?? makeSource() })
	const normalize = provider.normalizeRegistration
	if (normalize === undefined) throw new Error('the Zerops provider normalizes registrations')
	return { ...provider, normalizeRegistration: normalize }
}

let recorded: Recorded
beforeEach(() => {
	recorded = fresh()
})

describe('Zerops ControlProvider registration', () => {
	test('validates the candidate against the pinned proxy before publication, without provider effects', () => {
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			api: makeApi(recorded),
			namespaces: {
				clientId: 'client-1',
				proxySource: { ...PROXY_SOURCE, commitSha: 'b'.repeat(40) },
				iamUrl: 'https://iam.example.test',
				iamKey: 'proxy-key',
				olderProxies: [{ row: () => true, csp: (csp) => csp.workerSrc === undefined, signsOut: false }],
			},
		})
		const validate = control.validateAccess
		if (validate === undefined) throw new Error('the Zerops provider validates candidate access')
		const access = approvedContract({
			...notesArtifact,
			csp: { ...notesArtifact.csp, workerSrc: [{ origin: 'blob:', purpose: 'the ALTCHA workers' }] },
		})
		expect(() => validate({ environment: environment(), access })).toThrow(/`csp`[\s\S]*--proxy-source=current/)
		expect(() => validate({ environment: environment(), access: approvedContract() })).not.toThrow()
		const current = createTestControlProvider({
			accessToken: 'zt-secret',
			api: makeApi(recorded),
			namespaces: {
				clientId: 'client-1',
				proxySource: PROXY_SOURCE,
				iamUrl: 'https://iam.example.test',
				iamKey: 'proxy-key',
				olderProxies: [{ row: () => true, csp: () => false, signsOut: false }],
			},
		})
		expect(() => current.validateAccess?.({ environment: environment(), access })).not.toThrow()
		expect(recorded.calls).toEqual([])
		expect(recorded.envWrites).toEqual([])
	})

	for (const coordinates of [{ id: 'other', env: 'prod' }, { id: 'notes', env: 'stage' }]) {
		test(`rejects decoded artifact coordinate drift ${coordinates.id}/${coordinates.env} before effects`, async () => {
			const control = createTestControlProvider({
				accessToken: 'zt-secret',
				api: makeApi(recorded),
				namespaces: {
					clientId: 'client-1',
					proxySource: PROXY_SOURCE,
					iamUrl: 'https://iam.example.test',
					iamKey: 'proxy-key',
					olderProxies: OLDER_PROXIES,
				},
			})
			const invalidEnvironment = environment({
				artifact: {
					provider: 'zerops',
					version: zeropsArtifactCodec.version,
					payload: zeropsArtifactCodec.encode(compileFabrikaManifest({ ...config, id: coordinates.id }, coordinates.env, SOURCE_DESCRIPTOR)),
				},
			})
			const registration = { app, environment: invalidEnvironment }
			const error = coordinates.id === 'notes'
				? 'manifest environment drift: expected `prod`, got `stage`'
				: 'manifest app drift: expected `notes`, got `other`'
			expect(() => control.normalizeRegistration(registration)).toThrow(error)
			await expect(control.deploy({ ...deployInput(recorded), environment: invalidEnvironment })).rejects.toThrow(error)
			const capabilities = control.namespaces
			if (capabilities?.prepareRegistration === undefined) throw new Error('expected registration capabilities')
			const secrets = control.secrets
			if (secrets === undefined) throw new Error('expected secret capabilities')
			expect(() => capabilities.registrationResourceClaims(registration)).toThrow(error)
			await expect(capabilities.prepareRegistration({ registration, signal: new AbortController().signal })).rejects.toThrow(error)
			await expect(secrets.put({ environment: invalidEnvironment, name: 'TOKEN', value: '${notes_PORT}' })).rejects.toThrow(error)
			expect(recorded.calls).toEqual([])
			expect(recorded.envWrites).toEqual([])
		})
	}

	test('returns declared variables from a fresh decode and retains undefined for invalid artifacts', () => {
		const control = createTestControlProvider({ accessToken: 'zt-secret', api: makeApi(recorded) })
		const manifest = compileFabrikaManifest({ ...config, pipeline: { vars: ['IMAGE_TAG'] } }, 'prod', SOURCE_DESCRIPTOR)
		const artifact = { provider: 'zerops', version: zeropsArtifactCodec.version, payload: zeropsArtifactCodec.encode(manifest) }
		expect(control.declaredVariables?.({ artifact })).toEqual(['IMAGE_TAG'])
		expect(control.declaredVariables?.({ artifact: { ...artifact, payload: {} } })).toBeUndefined()
		expect(control.declaredVariables?.({ artifact: { ...artifact, version: 0 } })).toBeUndefined()
	})

	for (const [name, contents] of rejectedDescriptorCorpus) {
		test(`rejects ${name} before registration, hooks, or provider effects`, async () => {
			const manifest = compileFabrikaManifest(config, 'prod', SOURCE_DESCRIPTOR)
			const sourceDescriptor = await createZeropsArtifactSourceDescriptor(contents)
			const invalidEnvironment = environment({
				artifact: {
					provider: 'zerops',
					version: zeropsArtifactCodec.version,
					payload: zeropsArtifactCodec.encode({ ...manifest, target: { ...manifest.target, sourceDescriptor } }),
				},
			})
			const control = createTestControlProvider({
				accessToken: 'zt-secret',
				api: makeApi(recorded),
			})
			expect(() => control.normalizeRegistration({ app, environment: invalidEnvironment })).toThrow('zerops.yaml')
			await expect(control.deploy({ ...deployInput(recorded), environment: invalidEnvironment })).rejects.toThrow('zerops.yaml')
			expect(recorded.calls).toEqual([])
			expect(recorded.envWrites).toEqual([])
		})
	}
	test('normalizes a stored target and static artifact without persisting credentials', () => {
		const control = createTestControlProvider({ accessToken: 'zt-secret', api: makeApi(recorded) })
		const normalized = control.normalizeRegistration({ app, environment: environment() })
		expect(normalized.environment.target.payload).toEqual({ serviceId: 'service-1' })
		expect(JSON.stringify(normalized.environment.target)).not.toContain('buildFromGit')
		expect(JSON.stringify(normalized.environment.target)).not.toContain(app.source.repoUrl)
		expect(normalized.environment.publicOrigin).toBe('https://public.notes.example.test')
		expect(JSON.stringify(normalized.environment)).not.toContain('zt-secret')
	})

	test('rejects foreign, unsupported, and identity-drifted envelopes before source, hooks, or API effects', async () => {
		const sourceCalls: string[] = []
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			api: makeApi(recorded),
			source: makeSource(sourceCalls),
		})
		const failures: Array<{ input: ProviderRegistrationInput; message: string }> = [
			{ input: { app: { ...app, id: 'other' }, environment: environment() }, message: 'Zerops environment belongs to app `notes`, expected `other`' },
			{ input: { app, environment: environment({ env: 'stage' }) }, message: 'Zerops deployment namespace has different environment coordinates' },
			{ input: { app, environment: environment({ namespace: undefined }) }, message: 'Zerops environment requires a deployment namespace' },
			{
				input: { app, environment: environment({ namespace: { ...readyNamespace(), exclusiveAppId: 'other' } }) },
				message: 'Zerops deployment namespace is exclusive to app `other`',
			},
		]
		for (const kind of ['target', 'artifact', 'namespace target']) {
			for (const provider of ['other', 'zerops']) {
				const invalid = { provider, version: 0, payload: {} }
				failures.push({
					input: {
						app,
						environment: environment(
							kind === 'namespace target'
								? { namespace: { ...readyNamespace(), target: invalid } }
								: kind === 'target'
								? { target: invalid }
								: { artifact: invalid },
						),
					},
					message: provider === 'other'
						? `${kind} belongs to provider "other", expected "zerops"`
						: `${kind} schema version 0 is not supported by provider "zerops"`,
				})
			}
		}
		const resolve = control.resolveSource
		if (resolve === undefined) throw new Error('expected source resolution')
		for (const { input, message } of failures) {
			expect(() => control.normalizeRegistration(input)).toThrow(new Error(message))
			await expect(control.deploy({ ...deployInput(recorded), ...input })).rejects.toThrow(new Error(message))
			await expect(resolve({ ...input, runId: 'run-1', signal: new AbortController().signal })).rejects.toThrow(new Error(message))
		}
		expect(sourceCalls).toEqual([])
		expect(recorded.calls).toEqual([])
		expect(recorded.envWrites).toEqual([])
	})

	test('exposes namespace lifecycle only when its installation configuration is composed', () => {
		const withoutNamespaces = createTestControlProvider({ accessToken: 'zt-secret', api: makeApi(recorded) })
		const withNamespaces = createTestControlProvider({
			accessToken: 'zt-secret',
			api: makeApi(recorded),
			namespaces: {
				clientId: 'client-1',
				proxySource: PROXY_SOURCE,
				iamUrl: 'https://iam.example.test',
				iamKey: 'proxy-key',
				olderProxies: OLDER_PROXIES,
			},
		})
		const value: ProviderDeploymentNamespace = {
			id: 'apps-prod',
			env: 'prod',
			target: {
				provider: 'zerops',
				version: zeropsNamespaceTargetCodec.version,
				payload: zeropsNamespaceTargetCodec.encode({ proxySource: PROXY_SOURCE }),
			},
		}
		if (withNamespaces.namespaces === undefined) {
			throw new Error('expected namespace capabilities')
		}

		expect(withoutNamespaces.namespaces).toBeUndefined()
		expect(zeropsNamespaceTargetCodec.decode(withNamespaces.namespaces.normalize(value).target.payload)).toMatchObject({
			projectName: 'apps-prod',
			corePackage: 'LIGHT',
			managed: true,
			ready: false,
		})
	})

	test('prepares codeless services and discovers the deploy-service id', async () => {
		const api = makeApi(recorded, () => 'ACTIVE', true)
		// The services are absent until the registration import creates them.
		let registered = false
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			api: { ...api, findService: async (input) => registered ? api.findService(input) : null },
			namespaces: {
				clientId: 'client-1',
				proxySource: PROXY_SOURCE,
				iamUrl: 'https://iam.example.test',
				iamKey: 'proxy-key',
				olderProxies: OLDER_PROXIES,
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

		registered = true
		expect(prepared.environment.target.payload).toEqual({ serviceId: 'service-1' })
		expect(recorded.imports).toHaveLength(1)
		expect(recorded.imports[0]?.projectId).toBe('project-1')
		expect(recorded.imports[0]?.yaml).toContain('startWithoutCode: true')
		expect(recorded.imports[0]?.yaml).toContain('override: false')
		expect(recorded.envWrites).toEqual([])
		expect(await control.deploy({ ...deployInput(recorded), environment: prepared.environment })).toEqual({ state: 'succeeded' })
	})

	test('persists the buckets its collision-refusing import created, and the first deploy writes them into the marker', async () => {
		const withBucket: ZeropsAppConfig = {
			...config,
			target: {
				...config.target,
				deployService: 'notes',
				services: () => [{ hostname: 'notes', type: 'alpine/bun@1.3' }, { hostname: 'files', type: 'object-storage' }],
			},
		}
		const artifact = {
			provider: 'zerops',
			version: zeropsArtifactCodec.version,
			payload: zeropsArtifactCodec.encode(compileFabrikaManifest(withBucket, 'prod', SOURCE_DESCRIPTOR)),
		}
		const api = makeApi(recorded)
		let registered = false
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			api: {
				...api,
				findService: async ({ hostname }) =>
					registered ? { id: hostname === 'files' ? 'bucket-1' : 'service-1', name: hostname, subdomainAccess: false } : null,
				importServices: async (input) => {
					await api.importServices(input)
					return {
						projectId: input.projectId,
						services: registered ? [] : [
							{ id: 'bucket-1', name: 'files', processes: [{ id: 'create-files', actionName: 'stack.create' }] },
							{ id: 'service-1', name: 'notes', processes: [{ id: 'create-notes', actionName: 'stack.create' }] },
						],
					}
				},
			},
			namespaces: {
				clientId: 'client-1',
				proxySource: PROXY_SOURCE,
				iamUrl: 'https://iam.example.test',
				iamKey: 'proxy-key',
				olderProxies: OLDER_PROXIES,
			},
		})
		const prepare = control.namespaces?.prepareRegistration
		if (prepare === undefined) throw new Error('expected registration preparation')
		const prepared = await prepare({
			registration: {
				app,
				environment: environment({ target: { provider: 'zerops', version: zeropsStoredTargetCodec.version, payload: {} }, artifact }),
			},
			signal: new AbortController().signal,
		})
		registered = true

		expect(prepared.environment.target.payload).toEqual({ serviceId: 'service-1', createdBuckets: ['bucket-1'] })
		expect(recorded.envWrites).toEqual([])
		expect(await control.deploy({ ...deployInput(recorded), environment: prepared.environment })).toEqual({ state: 'succeeded' })
		expect(recorded.envWrites).toContainEqual({ serviceId: 'service-1', key: 'FABRIKA_STORAGE_PROVENANCE', value: 'bucket-1', sensitive: false })
	})

	test('an adopted bucket gets no creation evidence and its deploy is refused', async () => {
		const withBucket: ZeropsAppConfig = {
			...config,
			target: {
				...config.target,
				deployService: 'notes',
				services: () => [{ hostname: 'notes', type: 'alpine/bun@1.3' }, { hostname: 'files', type: 'object-storage' }],
			},
		}
		const artifact = {
			provider: 'zerops',
			version: zeropsArtifactCodec.version,
			payload: zeropsArtifactCodec.encode(compileFabrikaManifest(withBucket, 'prod', SOURCE_DESCRIPTOR)),
		}
		const api = makeApi(recorded)
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			api: {
				...api,
				findService: async ({ hostname }) => ({ id: hostname === 'files' ? 'bucket-1' : 'service-1', name: hostname, subdomainAccess: false }),
			},
			namespaces: {
				clientId: 'client-1',
				proxySource: PROXY_SOURCE,
				iamUrl: 'https://iam.example.test',
				iamKey: 'proxy-key',
				olderProxies: OLDER_PROXIES,
			},
		})
		const prepare = control.namespaces?.prepareRegistration
		if (prepare === undefined) throw new Error('expected registration preparation')
		const prepared = await prepare({
			registration: {
				app,
				environment: environment({ target: { provider: 'zerops', version: zeropsStoredTargetCodec.version, payload: {} }, artifact }),
			},
			signal: new AbortController().signal,
		})

		expect(prepared.environment.target.payload).toEqual({ serviceId: 'service-1' })
		expect(await control.deploy({ ...deployInput(recorded), environment: prepared.environment })).toEqual({ state: 'failed' })
		expect(recorded.logs.join('\n')).toContain('service `files` is a bucket the platform did not create private')
	})

	test('refuses an import collision after an absent lookup without retrying or adopting the raced service', async () => {
		let racedServiceExists = false
		const collision = new ZeropsApiError('zerops: service name unavailable', 400, 'serviceStackNameUnavailable')
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			api: {
				...makeApi(recorded),
				findService: async ({ hostname }) => {
					recorded.calls.push('findService')
					return racedServiceExists ? { id: 'foreign-service', name: hostname } : null
				},
				importServices: async ({ projectId, yaml }) => {
					recorded.calls.push('importServices')
					recorded.imports.push({ projectId, yaml })
					racedServiceExists = true
					throw collision
				},
			},
			namespaces: {
				clientId: 'client-1',
				proxySource: PROXY_SOURCE,
				iamUrl: 'https://iam.example.test',
				iamKey: 'proxy-key',
				olderProxies: OLDER_PROXIES,
			},
		})
		const prepare = control.namespaces?.prepareRegistration
		if (prepare === undefined) throw new Error('expected registration preparation')
		await expect(prepare({ registration: { app, environment: environment() }, signal: new AbortController().signal })).rejects.toBe(collision)
		expect(recorded.calls).toEqual(['findService', 'importServices'])
		expect(recorded.imports).toHaveLength(1)
		expect(recorded.imports[0]?.yaml).toContain('override: false')
	})

	for (const reportedDeployService of [true, false]) {
		test(`awaits every import process before ${reportedDeployService ? 'returning the reported service' : 'refusing missing creation evidence'}`, async () => {
			const sleeping = Promise.withResolvers<void>()
			const release = Promise.withResolvers<void>()
			let settled = false
			let completed = false
			let imported = false
			const base = makeApi(recorded, () => 'ACTIVE', true)
			const control = createTestControlProvider({
				accessToken: 'zt-secret',
				api: {
					...base,
					findService: async () => {
						recorded.calls.push('findService')
						return imported ? { id: 'service-1', name: 'notes' } : null
					},
					importServices: async ({ projectId }) => {
						imported = true
						return {
							projectId,
							services: [
								{
									id: 'service-1',
									name: reportedDeployService ? 'notes' : 'notesdb',
									processes: [{ id: 'create', actionName: 'stack.create', serviceStackId: 'service-1' }, {
										id: 'deploy',
										actionName: 'stack.deploy',
										serviceStackId: 'service-1',
										appVersionId: 'bootstrap-1',
									}],
								},
								{ id: 'service-2', name: 'notesworker', processes: [{ id: 'worker-create', actionName: 'stack.create', serviceStackId: 'service-2' }] },
							],
						}
					},
					getProcess: async ({ processId }) => {
						recorded.calls.push(processId)
						return {
							id: processId,
							status: processId === 'worker-create' && !settled ? 'RUNNING' : 'FINISHED',
							serviceStackId: processId === 'worker-create' ? 'service-2' : 'service-1',
							actionName: processId === 'deploy' ? 'stack.deploy' : 'stack.create',
							...(processId === 'deploy' ? { appVersionId: 'bootstrap-1' } : {}),
						}
					},
				},
				sleep: async () => {
					sleeping.resolve()
					await release.promise
				},
				namespaces: {
					clientId: 'client-1',
					proxySource: PROXY_SOURCE,
					iamUrl: 'https://iam.example.test',
					iamKey: 'proxy-key',
					olderProxies: OLDER_PROXIES,
				},
			})
			const prepare = control.namespaces?.prepareRegistration
			if (prepare === undefined) throw new Error('expected registration preparation')
			const workerConfig: ZeropsAppConfig = {
				...config,
				target: {
					...config.target,
					deployService: 'notes',
					services: () => [{ hostname: 'notes', type: 'alpine/bun@1.3' }, { hostname: 'notesworker', type: 'alpine/bun@1.3' }],
				},
			}
			const preparation = prepare({
				registration: {
					app,
					environment: environment({
						artifact: {
							provider: 'zerops',
							version: zeropsArtifactCodec.version,
							payload: zeropsArtifactCodec.encode(compileFabrikaManifest(workerConfig, 'prod', SOURCE_DESCRIPTOR)),
						},
					}),
				},
				signal: new AbortController().signal,
			}).then((result) => {
				completed = true
				return result
			})
			await sleeping.promise
			try {
				expect(completed).toBe(false)
				expect(recorded.calls).toEqual(['findService', 'findService', 'create', 'deploy', 'worker-create'])
			} finally {
				settled = true
				release.resolve()
			}
			if (reportedDeployService) {
				const prepared = await preparation
				expect(prepared.environment.target.payload).toEqual({ serviceId: 'service-1' })
			} else {
				await expect(preparation).rejects.toThrow('did not create deploy service')
				expect(recorded.envWrites).toEqual([])
			}
			expect(recorded.calls).toEqual([
				'findService',
				'findService',
				'create',
				'deploy',
				'worker-create',
				'worker-create',
			])
		})
	}

	test('fails registration when an import process fails without discovering a service', async () => {
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			api: {
				...makeApi(recorded),
				findService: async () => {
					recorded.calls.push('findService')
					return null
				},
				importServices: async ({ projectId }) => ({
					projectId,
					services: [{ id: 'service-1', name: 'notes', processes: [{ id: 'create' }, { id: 'deploy' }] }],
				}),
				getProcess: async ({ processId }) => {
					recorded.calls.push(processId)
					return { id: processId, status: processId === 'create' ? 'FINISHED' : 'FAILED' }
				},
			},
			namespaces: {
				clientId: 'client-1',
				proxySource: PROXY_SOURCE,
				iamUrl: 'https://iam.example.test',
				iamKey: 'proxy-key',
				olderProxies: OLDER_PROXIES,
			},
		})
		const prepare = control.namespaces?.prepareRegistration
		if (prepare === undefined) throw new Error('expected registration preparation')
		await expect(prepare({ registration: { app, environment: environment() }, signal: new AbortController().signal })).rejects.toThrow(
			'the notes import finished as FAILED',
		)
		expect(recorded.calls).toEqual(['findService', 'create', 'deploy'])
	})

	test('uses the steady-state import when every declared service already exists', async () => {
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			api: makeApi(recorded),
			namespaces: {
				clientId: 'client-1',
				proxySource: PROXY_SOURCE,
				iamUrl: 'https://iam.example.test',
				iamKey: 'proxy-key',
				olderProxies: OLDER_PROXIES,
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
		expect(recorded.imports[0]?.yaml).toContain('override: true')
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
				proxySource: PROXY_SOURCE,
				iamUrl: 'https://iam.example.test',
				iamKey: 'proxy-key',
				olderProxies: OLDER_PROXIES,
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
				proxySource: PROXY_SOURCE,
				iamUrl: 'https://iam.example.test',
				iamKey: 'proxy-key',
				olderProxies: OLDER_PROXIES,
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
					proxySource: PROXY_SOURCE,
					preset: 'cheap',
					env: 'prod',
					projectName: 'apps-prod',
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
				contract: notesArtifact,
				proxy: { upstream: 'notesapi:3000', ...contractProxyTable(notesArtifact) },
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
				proxySource: PROXY_SOURCE,
				iamUrl: 'https://iam.example.test',
				iamKey: 'proxy-key',
				olderProxies: OLDER_PROXIES,
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
					proxySource: PROXY_SOURCE,
					preset: 'mid',
					env: 'prod',
					projectName: 'apps-prod',
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
	for (const name of ['FABRIKA_RELEASE', 'FABRIKA_SERVICE_KEY', 'FABRIKA_APP_STORAGE_SECRET_ACCESS_KEY']) {
		test(`refuses reserved secret ${name} on put and delete before mutation`, async () => {
			const control = createTestControlProvider({ accessToken: 'token', api: makeApi(recorded) })
			if (control.secrets === undefined) throw new Error('missing secrets')
			await expect(control.secrets.put({ environment: environment(), name, value: 'secret' })).rejects.toThrow('Fabrika-managed')
			await expect(control.secrets.delete({ environment: environment(), name })).rejects.toThrow('Fabrika-managed')
			expect(recorded.envWrites).toEqual([])
			expect(recorded.envDeletes).toEqual([])
		})
	}

	for (const { status, code } of [{ status: 400, code: 'otherError' }, { status: 404, code: 'appVersionNotFound' }]) {
		test(`absence recovery refuses an unverified ${status}/${code} error`, async () => {
			const control = createTestControlProvider({
				accessToken: 'token',
				sleep: async () => {},
				api: {
					...makeApi(recorded),
					getAppVersion: async () => {
						throw new ZeropsApiError('unverified absence', status, code)
					},
				},
			})
			if (control.reconcile === undefined) throw new Error('missing recovery')
			expect(
				await control.reconcile({
					runId: 'run-1',
					externalId: 'version-1',
					environment: environment(),
					signal: new AbortController().signal,
					providerState: checkpointFor(true),
				}),
			).toEqual({ state: 'running' })
		})
	}
	test('lease loss during upload never cancels source, deletes a version, or submits a build', async () => {
		const controller = new AbortController()
		const sourceCalls: string[] = []
		const reason = new ProviderInvocationAbort('lease_lost')
		const control = createTestControlProvider({
			accessToken: 'token',
			api: makeApi(recorded),
			source: {
				...makeSource(sourceCalls),
				upload: async () => {
					controller.abort(reason)
					throw reason
				},
			},
		})
		await expect(control.deploy({ ...deployInput(recorded), signal: controller.signal })).rejects.toBe(reason)
		expect(recorded.calls).toEqual(['importServices', 'createAppVersion:service-1'])
		expect(sourceCalls).toEqual([])
		expect(recorded.envWrites).toEqual([{ serviceId: 'service-1', key: 'FABRIKA_PROXY_SECRET', value: 'private-proxy-secret', sensitive: true }])
	})
	test('a lease lost at an await-version boundary neither cancels the build nor deletes the version', async () => {
		const controller = new AbortController()
		const reason = new ProviderInvocationAbort('lease_lost')
		const control = createTestControlProvider({ accessToken: 'token', api: makeApi(recorded, () => 'BUILDING'), sleep: async () => {} })
		const input = deployInput(recorded)
		await expect(control.deploy({
			...input,
			signal: controller.signal,
			events: {
				...input.events,
				boundary: async () => {
					if (!recorded.calls.some((call) => call.startsWith('getAppVersion'))) return
					controller.abort(reason)
					throw reason
				},
			},
		})).rejects.toBe(reason)
		expect(recorded.calls.filter((call) => call.startsWith('getAppVersion'))).toHaveLength(1)
		expect(recorded.calls.filter((call) => call.startsWith('cancelBuild') || call.startsWith('deleteAppVersion'))).toEqual([])
	})
	test('a cancellation whose lease is lost before the next poll never cancels the build', async () => {
		const controller = new AbortController()
		const lost = new ProviderInvocationAbort('lease_lost')
		const api = makeApi(recorded, () => 'BUILDING')
		const control = createTestControlProvider({
			accessToken: 'token',
			sleep: async () => {},
			api: {
				...api,
				getAppVersion: async (input) => {
					const version = await api.getAppVersion(input)
					// A cancellation lands while a poll is out; the lease is gone by the next poll's boundary.
					controller.abort(new ProviderInvocationAbort('cancel_requested'))
					return version
				},
			},
		})
		const input = deployInput(recorded)
		await expect(control.deploy({
			...input,
			signal: controller.signal,
			events: {
				...input.events,
				boundary: async () => {
					if (controller.signal.aborted) throw lost
				},
			},
		})).rejects.toBeInstanceOf(ProviderInvocationAbort)
		expect(recorded.calls.filter((call) => call.startsWith('getAppVersion'))).toHaveLength(1)
		expect(recorded.calls.filter((call) => call.startsWith('cancelBuild') || call.startsWith('deleteAppVersion'))).toEqual([])
	})
	test('a cancellation read at a step boundary stops the deploy before the next step', async () => {
		const controller = new AbortController()
		const reason = new ProviderInvocationAbort('cancel_requested')
		const control = createTestControlProvider({ accessToken: 'token', api: makeApi(recorded) })
		const input = deployInput(recorded)
		let boundaries = 0
		expect(
			await control.deploy({
				...input,
				signal: controller.signal,
				events: {
					...input.events,
					boundary: async () => {
						boundaries++
						if (recorded.calls.at(-1) !== 'importServices') return
						controller.abort(reason)
						throw reason
					},
				},
			}).catch((error: unknown) => error),
		).toBe(reason)
		expect(boundaries).toBe(2)
		expect(recorded.calls).toEqual(['importServices'])
	})
	test('cancelling a triggered build stays pending until the version settles, and activation winning makes it a success', async () => {
		let status: ZeropsAppVersionStatus = 'BUILDING'
		const control = createTestControlProvider({ accessToken: 'token', api: makeApi(recorded, () => status) })
		if (control.cancel === undefined) throw new Error('missing cancellation')
		const input = {
			runId: 'run-1',
			externalId: 'version-1',
			environment: environment(),
			signal: new AbortController().signal,
			providerState: checkpointFor(true),
			startedAtMs: Date.now(),
		}
		expect(await control.cancel(input)).toEqual({ state: 'pending' })
		expect(recorded.calls).toEqual(['getAppVersion:version-1', 'cancelBuild:version-1'])
		status = 'ACTIVE'
		expect(await control.cancel(input)).toEqual({ state: 'settled', outcome: 'succeeded' })
		status = 'CANCELLED'
		expect(await control.cancel(input)).toEqual({ state: 'settled', outcome: 'failed' })
		expect(recorded.calls.filter((call) => call.startsWith('cancelBuild'))).toHaveLength(1)
		expect(recorded.calls).not.toContain('deleteAppVersion:version-1')
	})

	test('a cancel during deploy that lands after the triggered checkpoint still sends the build, and cancel() then stops it', async () => {
		const controller = new AbortController()
		const control = createTestControlProvider({ accessToken: 'token', api: makeApi(recorded, () => 'BUILDING'), sleep: async () => {} })
		if (control.cancel === undefined) throw new Error('missing cancellation')
		const input = deployInput(recorded)
		await expect(control.deploy({
			...input,
			signal: controller.signal,
			events: {
				...input.events,
				checkpoint: async () => {
					controller.abort(new ProviderInvocationAbort('cancel_requested'))
				},
			},
		})).rejects.toBeInstanceOf(ProviderInvocationAbort)
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(recorded.calls).toContain('buildAndDeployAppVersion:version-1')
		expect(
			await control.cancel({
				runId: 'run-1',
				externalId: 'version-1',
				environment: environment(),
				signal: new AbortController().signal,
				providerState: checkpointFor(true),
				startedAtMs: Date.now(),
			}),
		).toEqual({ state: 'pending' })
		expect(recorded.calls.slice(-2)).toEqual(['getAppVersion:version-1', 'cancelBuild:version-1'])
		expect(recorded.calls).not.toContain('deleteAppVersion:version-1')
	})

	test('cancelling before the build request deletes the exact version and settles failed', async () => {
		const control = createTestControlProvider({ accessToken: 'token', api: makeApi(recorded) })
		if (control.cancel === undefined) throw new Error('missing cancellation')
		const input = {
			runId: 'run-1',
			externalId: 'version-1',
			environment: environment(),
			signal: new AbortController().signal,
			providerState: checkpointFor(false),
		}
		expect(await control.cancel(input)).toEqual({ state: 'settled', outcome: 'failed' })
		// A version already gone counts as deleted.
		expect(await control.cancel(input)).toEqual({ state: 'settled', outcome: 'failed' })
		expect(recorded.calls).toEqual(['deleteAppVersion:version-1', 'deleteAppVersion:version-1'])
	})

	test('cancelling before the build request stays pending when the deletion fails', async () => {
		const control = createTestControlProvider({
			accessToken: 'token',
			api: {
				...makeApi(recorded),
				deleteAppVersion: async () => {
					throw new ZeropsApiError('zerops: delete app-version failed (500)', 500, '')
				},
			},
		})
		if (control.cancel === undefined) throw new Error('missing cancellation')
		expect(
			await control.cancel({
				runId: 'run-1',
				externalId: 'version-1',
				environment: environment(),
				signal: new AbortController().signal,
				providerState: checkpointFor(false),
			}),
		).toEqual({ state: 'pending' })
	})

	test('a deploy with a source-map upload reports what its build log said about it', async () => {
		const artifactUpload = {
			url: 'https://errors.test/api/artifacts/source-maps/',
			bearer: 'b'.repeat(64),
			appId: 'notes',
			environment: 'prod',
			serviceKey: 'default',
			release: `fabrika/notes/prod/default/${COMMIT_SHA}`,
			runId: 'run-1',
		}
		const logged = {
			...makeApi(recorded),
			getLogAccess: async () => ({
				url: 'https://logs.test/all',
				urlPlain: 'https://logs.test/plain',
				urlInfo: 'https://logs.test/info',
				urlUi: 'https://logs.test/ui',
				accessToken: 'log-token',
				expiration: '2099-01-01T00:00:00Z',
			}),
			readBuildLog: async () => [{ message: 'fabrika-source-maps: 1 uploaded, state=complete' }],
		}
		const control = createTestControlProvider({ accessToken: 'token', api: logged, sleep: async () => {} })
		expect(await control.deploy({ ...deployInput(recorded), artifactUpload })).toEqual({ state: 'succeeded', artifactState: 'complete' })
		expect(await control.deploy(deployInput(recorded))).toEqual({ state: 'succeeded' })
		// A build log that cannot be read leaves the maps unconfirmed.
		const unread = createTestControlProvider({ accessToken: 'token', api: makeApi(recorded), sleep: async () => {} })
		expect(await unread.deploy({ ...deployInput(recorded), artifactUpload })).toEqual({ state: 'succeeded', artifactState: 'incomplete' })
	})

	test('a failed pipeline process fails the deploy, and a cancel of a version stuck UPLOADING settles at the deadline', async () => {
		const control = createTestControlProvider({
			accessToken: 'token',
			api: { ...makeApi(recorded, () => 'UPLOADING'), getProcess: async ({ processId }) => ({ id: processId, status: 'FAILED' }) },
			sleep: async () => {},
		})
		expect(await control.deploy(deployInput(recorded))).toEqual({ state: 'failed' })
		expect(recorded.logs).toContain('✗ await-version: zerops: pipeline process process-1 is FAILED while app-version version-1 is UPLOADING')
		expect(recorded.calls).not.toContain('deleteAppVersion:version-1')
		recorded.calls = []
		if (control.cancel === undefined) throw new Error('missing cancellation')
		const reference = {
			runId: 'run-1',
			externalId: 'version-1',
			environment: environment(),
			signal: new AbortController().signal,
			providerState: checkpointFor(true),
		}
		expect(await control.cancel({ ...reference, startedAtMs: Date.now() })).toEqual({ state: 'pending' })
		expect(await control.cancel({ ...reference, startedAtMs: Date.now() - 76 * 60 * 1000 })).toEqual({ state: 'settled', outcome: 'failed' })
		expect(recorded.calls).toEqual(['getAppVersion:version-1', 'cancelBuild:version-1', 'getAppVersion:version-1', 'cancelBuild:version-1'])
	})

	test('refuses a descriptor that drifted after registration before it resolves the source', async () => {
		const resolutions: unknown[] = []
		const source: ZeropsSourcePort = {
			...makeSource([]),
			resolve: async (input) => {
				resolutions.push(input)
				return { commitSha: COMMIT_SHA, descriptorSha256: input.descriptorSha256 }
			},
		}
		const control = createTestControlProvider({ accessToken: 'zt-secret', api: makeApi(recorded), source })
		const signal = new AbortController().signal
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
		expect(resolutions).toHaveLength(0)
		expect(recorded.calls).toEqual([])
	})

	test('routes two keyed connections through their exact resolve and upload bindings', async () => {
		const calls: string[] = []
		const source: ZeropsSourcePort = {
			resolve: async (input) => {
				const binding = input.privateBinding
				if (binding === undefined) throw new Error('missing private binding')
				calls.push(`resolve:${binding.connectionId}:${binding.installationId}`)
				return { commitSha: input.expectedCommitSha ?? COMMIT_SHA, descriptorSha256: input.descriptorSha256 }
			},
			upload: async (input) => {
				const binding = input.archive.kind === 'application' ? input.archive.privateBinding : undefined
				if (binding === undefined) throw new Error('missing private binding')
				calls.push(`upload:${binding.connectionId}:${binding.installationId}`)
				return uploaded(input)
			},
		}
		const control = createTestControlProvider({ accessToken: 'zt-secret', api: makeApi(recorded), source })
		const binding1: ProviderSourceBinding = { connectionId: 'connection-1', installationId: 41 }
		const binding2: ProviderSourceBinding = { connectionId: 'connection-2', installationId: 42 }
		const signal = new AbortController().signal
		const resolveSource = control.resolveSource
		if (resolveSource === undefined) throw new Error('expected source resolution')

		await Promise.all([
			resolveSource({ runId: 'run-1', app, environment: environment(), signal, sourceBinding: binding1 }),
			resolveSource({ runId: 'run-2', app, environment: environment(), signal, sourceBinding: binding2 }),
		])
		await Promise.all([
			control.deploy({ ...deployInput(recorded), runId: 'run-1', sourceBinding: binding1 }),
			control.deploy({ ...deployInput(recorded), runId: 'run-2', sourceBinding: binding2 }),
		])

		expect([...calls].sort()).toEqual([
			'resolve:connection-1:41',
			'resolve:connection-2:42',
			'upload:connection-1:41',
			'upload:connection-2:42',
		])
	})

	test('rejects structured manifest drift before the Zerops API', async () => {
		const manifest = compileFabrikaManifest(config, 'prod', SOURCE_DESCRIPTOR)
		// The manifest type cannot carry the drift, so it is spliced into the encoded artifact.
		const drifted: JsonValue = JSON.parse(JSON.stringify(zeropsArtifactCodec.encode(manifest)).replace('"override":true', '"override":false'))
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			api: makeApi(recorded),
		})

		await expect(control.deploy({
			...deployInput(recorded),
			environment: environment({
				artifact: {
					provider: 'zerops',
					version: zeropsArtifactCodec.version,
					payload: drifted,
				},
			}),
		})).rejects.toThrow('invariants')
		expect(recorded.calls).toEqual([])
	})

	test('composes ephemeral credentials and routes run events', async () => {
		const uploads: unknown[] = []
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			apiBaseUrl: 'https://api.test',
			api: makeApi(recorded),
			source: {
				...makeSource(),
				upload: async (input) => {
					uploads.push({ repository: input.repository, commitSha: input.commitSha, uploadUrl: input.uploadUrl })
					return uploaded(input)
				},
			},
		})
		const withSchema = compileFabrikaManifest({ ...config, schema: SCHEMA }, 'prod', SOURCE_DESCRIPTOR)
		const outcome = await control.deploy({
			...deployInput(recorded),
			environment: environment({
				artifact: { provider: 'zerops', version: zeropsArtifactCodec.version, payload: zeropsArtifactCodec.encode(withSchema) },
			}),
		})
		expect(outcome).toEqual({ state: 'succeeded' })
		expect(recorded.imports.map((entry) => entry.projectId)).toEqual(['project-1'])
		expect(uploads).toEqual([{ repository: { owner: 'acme', name: 'notes' }, commitSha: COMMIT_SHA, uploadUrl: UPLOAD_URL }])
		expect(recorded.externalIds).toEqual(['version-1'])
		expect(recorded.triggers).toEqual([])
		expect(recorded.calls).toContain('createAppVersion:service-1')
		expect(recorded.calls).toContain('buildAndDeployAppVersion:version-1')
		expect(recorded.logs.join('\n')).not.toContain('zt-secret')
		expect(JSON.stringify(deployInput(recorded).environment)).not.toContain('zt-secret')
	})

	test('uses the same credential-free runtime coordinates for public and explicitly bound private repositories', async () => {
		const observed: unknown[] = []
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			api: makeApi(recorded),
			source: {
				...makeSource(),
				upload: async (input) => {
					observed.push({ repository: input.repository, commitSha: input.commitSha, archive: input.archive })
					return uploaded(input)
				},
			},
		})

		await control.deploy({
			...deployInput(recorded),
			app: { ...app, source: { ...app.source, repoUrl: 'github.com/acme/notes', ref: COMMIT_SHA } },
		})
		await control.deploy({
			...deployInput(recorded),
			app: { ...app, source: { ...app.source, repoUrl: 'https://github.com/acme/notes', ref: COMMIT_SHA } },
			sourceBinding: { connectionId: 'connection-1', installationId: 42 },
		})

		expect(observed).toEqual([
			{ repository: { owner: 'acme', name: 'notes' }, commitSha: COMMIT_SHA, archive: { kind: 'application' } },
			{
				repository: { owner: 'acme', name: 'notes' },
				commitSha: COMMIT_SHA,
				archive: { kind: 'application', privateBinding: { connectionId: 'connection-1', installationId: 42 } },
			},
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
		})

		for (const repoUrl of unsafe) {
			await expect(control.deploy({
				...deployInput(recorded),
				app: { ...app, source: { ...app.source, repoUrl } },
			})).rejects.toThrow('source repository URL')
		}

		expect(recorded.calls).toEqual([])
		expect(recorded.envWrites).toEqual([])
		expect(recorded.logs.join('\n')).not.toContain('credential-must-not-leak')
	})

	test('writes the managed service variables to the app service and the release only into the execution descriptor', async () => {
		const dsn = 'https://operations-public-key@errors.test/1'
		const release = 'fabrika/notes/prod/default/commit'
		const builds: string[] = []
		const base = makeApi(recorded)
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			api: {
				...base,
				buildAndDeployAppVersion: async (input) => {
					builds.push(input.zeropsYaml)
					return base.buildAndDeployAppVersion(input)
				},
			},
		})
		expect(
			await control.deploy({
				...deployInput(recorded),
				managedEnvironment: { ...MANAGED_DEFAULTS, FABRIKA_OPERATIONS_DSN: dsn, FABRIKA_RELEASE: release },
			}),
		).toEqual({ state: 'succeeded' })
		expect(recorded.envWrites).toEqual([
			{ serviceId: 'service-1', key: 'FABRIKA_OPERATIONS_DSN', value: dsn, sensitive: true },
			{ serviceId: 'service-1', key: 'FABRIKA_PROXY_SECRET', value: 'private-proxy-secret', sensitive: true },
		])
		expect(builds).toHaveLength(1)
		expect(builds[0]).toContain(`FABRIKA_RELEASE: ${release}\n`)
		expect(builds[0]).not.toContain(dsn)
		expect(recorded.imports[0]?.yaml).not.toContain('FABRIKA_OPERATIONS_DSN')
		expect(recorded.imports[0]?.yaml).not.toContain(dsn)
		expect(recorded.logs.join('\n')).not.toContain(dsn)
	})

	test('dry-run names managed service values without mutating Zerops or exposing values', async () => {
		const dsn = 'https://operations-public-key@errors.test/1'
		const sourceCalls: string[] = []
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			api: makeApi(recorded),
			source: makeSource(sourceCalls),
		})
		await control.deploy({
			...deployInput(recorded),
			dryRun: true,
			managedEnvironment: { ...MANAGED_DEFAULTS, FABRIKA_OPERATIONS_DSN: dsn },
		})
		expect(recorded.envWrites).toEqual([])
		expect(recorded.calls).toEqual([])
		expect(sourceCalls).toEqual([])
		expect(recorded.logs.join('\n')).toContain('[dry-run]')
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
							proxySource: PROXY_SOURCE,
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
			connectionString: ZEROPS_SHARED_POSTGRES_CONNECTION_STRING,
		}])
	})

	test('fails before proxy or app mutation when namespace placement is not ready', async () => {
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			api: makeApi(recorded),
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
							proxySource: PROXY_SOURCE,
							projectId: 'project-1',
							proxyServiceId: 'proxy-service-1',
							ready: false,
						}),
					},
				},
			}),
		})).rejects.toThrow('is not ready')
		expect(recorded.calls).toEqual([])
	})

	test('settles an active external run without starting another deploy', async () => {
		let current: ZeropsAppVersionStatus = 'BUILDING'
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			api: makeApi(recorded, () => current),
		})
		if (control.cancel === undefined || control.reconcile === undefined) {
			throw new Error('expected Zerops lifecycle capabilities')
		}
		const reference = {
			signal: new AbortController().signal,
			runId: 'run-1',
			externalId: 'version-1',
			providerState: checkpointFor(true),
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
		expect(recorded.calls).toEqual(['getAppVersion:version-1', 'getAppVersion:version-1'])
		current = 'BUILD_FAILED'
		expect(await control.reconcile(reference)).toEqual<ProviderReconcileOutcome>({ state: 'failed' })
		expect(await control.cancel(reference)).toEqual({ state: 'settled', outcome: 'failed' })
		expect(recorded.calls).not.toContain('cancelBuild:version-1')
		expect(recorded.calls).not.toContain('importServices')
		expect(recorded.calls).not.toContain('triggerPipeline')
	})

	test('keeps unknown and unavailable observations of a triggered version retryable', async () => {
		const reference = {
			signal: new AbortController().signal,
			runId: 'run-1',
			externalId: 'version-1',
			providerState: checkpointFor(true),
			startedAtMs: Date.now(),
			environment: environment(),
		}
		const unknown = createTestControlProvider({
			accessToken: 'zt-secret',
			api: makeApi(recorded, () => undefined),
			sleep: () => Promise.resolve(),
		})
		if (unknown.reconcile === undefined || unknown.cancel === undefined) throw new Error('expected Zerops lifecycle capabilities')

		expect(await unknown.reconcile(reference)).toEqual({ state: 'running' })
		expect(await unknown.cancel(reference)).toEqual({ state: 'pending' })
		expect(recorded.calls).toEqual(['getAppVersion:version-1', 'getAppVersion:version-1', 'cancelBuild:version-1'])

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

	test('recovery after a crash before the build request deletes the exact version and fails the run', async () => {
		const control = createTestControlProvider({ accessToken: 'zt-secret', api: makeApi(recorded) })
		if (control.reconcile === undefined) throw new Error('expected Zerops reconciliation')
		const reference = {
			signal: new AbortController().signal,
			runId: 'run-1',
			externalId: 'version-1',
			environment: environment(),
			providerState: checkpointFor(false),
		}
		expect(await control.reconcile(reference)).toEqual({ state: 'failed' })
		// `appVersionNotFound` on the second pass counts as deleted.
		expect(await control.reconcile(reference)).toEqual({ state: 'failed' })
		expect(recorded.calls).toEqual(['deleteAppVersion:version-1', 'deleteAppVersion:version-1'])
	})

	test('recovery before the build request keeps the run open when the deletion fails', async () => {
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			api: {
				...makeApi(recorded),
				deleteAppVersion: async () => {
					throw new ZeropsApiError('zerops: delete app-version failed (500)', 500, '')
				},
			},
		})
		if (control.reconcile === undefined) throw new Error('expected Zerops reconciliation')
		await expect(control.reconcile({
			signal: new AbortController().signal,
			runId: 'run-1',
			externalId: 'version-1',
			environment: environment(),
			providerState: checkpointFor(false),
		})).rejects.toThrow('delete app-version failed')
	})

	test('recovery after the build request polls without deleting, and abandons a version stuck past the deadline', async () => {
		let status: ZeropsAppVersionStatus = 'UPLOADING'
		const logs: string[] = []
		const control = createTestControlProvider({ accessToken: 'zt-secret', api: makeApi(recorded, () => status) })
		if (control.reconcile === undefined) throw new Error('expected Zerops reconciliation')
		const reference = {
			signal: new AbortController().signal,
			runId: 'run-1',
			externalId: 'version-1',
			environment: environment(),
			providerState: checkpointFor(true),
			log: async (line: string) => {
				logs.push(line)
			},
		}
		expect(await control.reconcile({ ...reference, startedAtMs: Date.now() })).toEqual({ state: 'running' })
		status = 'BUILDING'
		expect(await control.reconcile({ ...reference, startedAtMs: Date.now() })).toEqual({ state: 'running' })
		status = 'UPLOADING'
		expect(await control.reconcile({ ...reference, startedAtMs: Date.now() - 76 * 60 * 1000 })).toEqual({ state: 'failed' })
		expect(recorded.calls).toEqual(['getAppVersion:version-1', 'getAppVersion:version-1', 'getAppVersion:version-1', 'cancelBuild:version-1'])
		expect(logs).toEqual(['abandoned non-terminal app-version version-1 (UPLOADING)'])
		status = 'ACTIVE'
		expect(await control.reconcile({ ...reference, startedAtMs: Date.now() })).toEqual({ state: 'succeeded' })
		expect(recorded.calls).not.toContain('deleteAppVersion:version-1')
		expect(recorded.calls).not.toContain('buildAndDeployAppVersion:version-1')
	})

	test('recovery abandons a triggered version whose status stays unobservable past the deadline', async () => {
		const control = createTestControlProvider({
			accessToken: 'zt-secret',
			api: {
				...makeApi(recorded),
				getAppVersion: async () => {
					recorded.calls.push('getAppVersion:unavailable')
					throw new Error('temporary observation failure')
				},
			},
		})
		if (control.reconcile === undefined) throw new Error('expected Zerops reconciliation')
		const reference = {
			signal: new AbortController().signal,
			runId: 'run-1',
			externalId: 'version-1',
			environment: environment(),
			providerState: checkpointFor(true),
		}
		expect(await control.reconcile({ ...reference, startedAtMs: Date.now() })).toEqual({ state: 'running' })
		expect(await control.reconcile({ ...reference, startedAtMs: Date.now() - 76 * 60 * 1000 })).toEqual({ state: 'failed' })
		expect(recorded.calls).toEqual(['getAppVersion:unavailable', 'getAppVersion:unavailable', 'cancelBuild:version-1'])
		expect(recorded.calls).not.toContain('deleteAppVersion:version-1')
	})

	test('an unrecognised or foreign checkpoint fails or settles the run without platform calls', async () => {
		const logs: string[] = []
		const control = createTestControlProvider({ accessToken: 'zt-secret', api: makeApi(recorded) })
		if (control.reconcile === undefined || control.cancel === undefined) throw new Error('expected Zerops lifecycle capabilities')
		const reference = {
			signal: new AbortController().signal,
			runId: 'run-1',
			externalId: 'version-1',
			environment: environment(),
		}
		const invalidStates: Array<JsonValue | undefined> = [
			undefined,
			{ appVersionId: 'different', triggered: true },
			{ appVersionId: 'version-1', phase: 'source_uploaded' },
			{ appVersionId: 'version-1', triggered: true, phase: 'source_uploaded' },
			{ appVersionId: 'version-1', triggered: 'yes' },
		]
		for (const providerState of invalidStates) {
			expect(await control.reconcile({ ...reference, providerState, log: async (line) => void logs.push(line) })).toEqual({ state: 'failed' })
			expect(await control.cancel({ ...reference, providerState })).toEqual({ state: 'settled', outcome: 'failed' })
		}
		expect(recorded.calls).toEqual([])
		expect(logs).toEqual(invalidStates.map(() => 'unrecognised checkpoint; failing without platform calls'))
	})

	test('writes and deletes one service-level secret and returns an opaque reference', async () => {
		const control = createTestControlProvider({ accessToken: 'zt-secret', api: makeApi(recorded) })
		if (control.secrets === undefined) {
			throw new Error('expected Zerops managed secrets')
		}
		const stored = await control.secrets.put({ environment: environment(), name: 'TOKEN', value: 'secret-value' })
		await control.secrets.delete({ environment: environment(), name: 'TOKEN' })
		expect(stored).toEqual({ valueRef: 'zerops:service-1/TOKEN' })
		expect(recorded.envWrites).toEqual([{ serviceId: 'service-1', key: 'TOKEN', value: 'secret-value', sensitive: true }])
		expect(recorded.envDeletes).toEqual(['env-1'])
	})

	test('deleting a secret the service no longer holds succeeds without a platform delete', async () => {
		const control = createTestControlProvider({ accessToken: 'zt-secret', api: makeApi(recorded) })
		if (control.secrets === undefined) {
			throw new Error('expected Zerops managed secrets')
		}
		await control.secrets.delete({ environment: environment(), name: 'ALREADY_GONE' })
		expect(recorded.envDeletes).toEqual([])
	})

	test('refuses a secret value that references a service the app does not own, before anything is written', async () => {
		const control = createTestControlProvider({ accessToken: 'zt-secret', api: makeApi(recorded) })
		if (control.secrets === undefined) {
			throw new Error('expected Zerops managed secrets')
		}
		const secrets = control.secrets
		const refusal = await secrets
			.put({ environment: environment(), name: 'TOKEN', value: 'sk-live-leakage${proxy_FABRIKA_IAM_KEY}' })
			.catch((cause: unknown) => cause)
		expect(String(refusal)).toContain('references service `proxy`')
		expect(String(refusal)).not.toContain('sk-live-leakage')
		await expect(secrets.put({ environment: environment(), name: 'TOKEN', value: 'x ${RUNTIME_proxy_FABRIKA_IAM_KEY}' })).rejects.toThrow(
			'references service `proxy`',
		)
		await expect(secrets.put({ environment: environment(), name: 'TOKEN', value: '${notesdb_password}' })).rejects.toThrow(
			'references service `notesdb`',
		)
		expect(recorded.envWrites).toEqual([])
	})

	test("refuses a secret that references a PostgreSQL superuser's password, before anything is written", async () => {
		const control = createTestControlProvider({ accessToken: 'zt-secret', api: makeApi(recorded) })
		if (control.secrets === undefined) {
			throw new Error('expected Zerops managed secrets')
		}
		const secrets = control.secrets
		await expect(secrets.put({ environment: environment(), name: 'ROOT', value: 'sk-live-${postgres_superUserPassword}' })).rejects.toThrow(
			"`${postgres_superUserPassword}`, the PostgreSQL superuser's password",
		)
		await expect(secrets.put({ environment: environment(), name: 'ROOT', value: '${RUNTIME_postgres_superUserPassword}' })).rejects.toThrow(
			"the PostgreSQL superuser's password",
		)
		expect(recorded.envWrites).toEqual([])
	})

	test('refuses a secret value Zerops cannot store as a 4xx that names the secret and its size, never the value', async () => {
		const requests: string[] = []
		const client = createZeropsApi({
			token: 'unused',
			baseUrl: 'https://zerops.test',
			fetchImpl: async (url) => {
				requests.push(url)
				return new Response(null, { status: 500 })
			},
		})
		const control = createTestControlProvider({ accessToken: 'zt-secret', api: { ...makeApi(recorded), putServiceEnv: client.putServiceEnv } })
		if (control.secrets === undefined) {
			throw new Error('expected Zerops managed secrets')
		}

		const refusal = await control.secrets
			.put({ environment: environment(), name: 'CERTIFICATE', value: `sk-live-leakage${'x'.repeat(32_001)}` })
			.catch((cause: unknown) => cause)

		expect(refusal).toBeInstanceOf(ProviderSecretError)
		expect(String(refusal)).toContain('`CERTIFICATE` is 32016 bytes')
		expect(String(refusal)).not.toContain('sk-live-leakage')
		expect(requests).toEqual([])
	})

	test('writes a secret that references only own services and the namespace postgres', async () => {
		const control = createTestControlProvider({ accessToken: 'zt-secret', api: makeApi(recorded) })
		if (control.secrets === undefined) {
			throw new Error('expected Zerops managed secrets')
		}
		await control.secrets.put({ environment: environment(), name: 'OWN', value: '${notes_PORT}' })
		await control.secrets.put({ environment: environment(), name: 'DB', value: ZEROPS_SHARED_POSTGRES_CONNECTION_STRING })
		await control.secrets.put({ environment: environment(), name: 'PLAIN', value: 'pa$$word $notes_PORT ${}' })
		expect(recorded.envWrites).toEqual([
			{ serviceId: 'service-1', key: 'OWN', value: '${notes_PORT}', sensitive: true },
			{ serviceId: 'service-1', key: 'DB', value: ZEROPS_SHARED_POSTGRES_CONNECTION_STRING, sensitive: true },
			{ serviceId: 'service-1', key: 'PLAIN', value: 'pa$$word $notes_PORT ${}', sensitive: true },
		])
	})
})
