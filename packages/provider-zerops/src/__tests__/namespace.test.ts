import type { ProviderDeploymentNamespace } from '@fabrika/provider-contract'
import { FABRIKA_PROXY_MANIFEST_JSON } from '@fabrika/proxy-contract'
import { describe, expect, test } from 'bun:test'
import {
	ZEROPS_SERVICE_NOT_HTTP,
	type ZeropsApi,
	ZeropsApiError,
	type ZeropsAppVersion,
	type ZeropsImportResult,
	type ZeropsProject,
	type ZeropsService,
	type ZeropsServiceEnv,
} from '../api'
import { useSharedPostgres } from '../authoring'
import { compileFabrikaManifest, manifestServiceHostnames, type ZeropsArtifactSourceDescriptor } from '../manifest'
import {
	compileZeropsNamespaceTopology,
	createZeropsNamespaceCapabilities,
	createZeropsNamespaceOperator,
	ZEROPS_NAMESPACE_IAM_KEY_VARIABLE,
	ZEROPS_NAMESPACE_IAM_URL_VARIABLE,
	ZEROPS_SHARED_POSTGRES_CONNECTION_STRING,
	type ZeropsNamespaceOptions,
	zeropsNamespacePreset,
	type ZeropsNamespaceTarget,
	zeropsNamespaceTargetCodec,
} from '../namespace'
import type { ZeropsAppConfig } from '../types'

interface FakeState {
	projects: Map<string, ZeropsProject>
	services: Map<string, ZeropsService[]>
	env: Map<string, Map<string, ZeropsServiceEnv>>
	versions: Map<string, ZeropsAppVersion[]>
	calls: string[]
	importProjectCount: number
	triggerCount: number
	failImportAfterMutation: boolean
	failTriggerAfterMutation: boolean
	/** The platform's answer before a service has deployed an HTTP port. */
	subdomainNotHttp: boolean
	/** The 2xx-then-nothing case: the call is accepted and the flag never moves. */
	subdomainStaysDisabled: boolean
}

const freshState = (): FakeState => ({
	projects: new Map(),
	services: new Map(),
	env: new Map(),
	versions: new Map(),
	calls: [],
	importProjectCount: 0,
	triggerCount: 0,
	failImportAfterMutation: false,
	failTriggerAfterMutation: false,
	subdomainNotHttp: false,
	subdomainStaysDisabled: false,
})

const projectId = 'project-1'
const proxyId = 'proxy-service'
const postgresId = 'postgres-service'
const SOURCE_DESCRIPTOR: ZeropsArtifactSourceDescriptor = {
	path: 'zerops.yaml',
	contents: 'zerops:\n  - setup: test\n',
	sha256: '560802d669a116e27e5ce76af3312048e3e9e7743a4fb7d6e73f14d800dc46d1',
}

const project = (
	id: string,
	name: string,
	description: string,
	mode: 'LIGHT' | 'SERIOUS' = 'SERIOUS',
): ZeropsProject => ({
	id,
	name,
	description,
	mode,
	status: 'ACTIVE',
	tagList: ['fabrika', 'namespace'],
})

const proxy = (id: string = proxyId, base = 'alpine@3.21'): ZeropsService => ({
	id,
	name: 'proxy',
	projectId,
	base,
	status: 'ACTIVE',
	subdomainAccess: false,
})

// `autoscalingProfileId` is reported for real: a live `postgresql:ha@18` created with no `profile` at
// all reads back `oltp-production`, so the double reports what the platform does.
const postgres = (
	type: 'postgresql:ha@18' | 'postgresql:single@18' = 'postgresql:ha@18',
	profile = type === 'postgresql:ha@18' ? 'oltp-production' : 'oltp-hobby',
): ZeropsService => ({
	id: postgresId,
	name: 'postgres',
	projectId,
	base: type,
	status: 'ACTIVE',
	autoscalingProfileId: profile,
})

const ensureServiceEnv = (state: FakeState, serviceId: string): Map<string, ZeropsServiceEnv> => {
	const found = state.env.get(serviceId)
	if (found !== undefined) return found
	const created = new Map<string, ZeropsServiceEnv>()
	state.env.set(serviceId, created)
	return created
}

const importedServices = (state: FakeState, id: string): ZeropsImportResult => ({
	projectId: id,
	services: (state.services.get(id) ?? []).map((service) => ({
		id: service.id,
		name: service.name,
		processes: [],
	})),
})

const makeApi = (state: FakeState): ZeropsApi => ({
	importServices: async ({ projectId: id, yaml }) => {
		state.calls.push(`importServices:${id}`)
		const services = state.services.get(id) ?? []
		if (!services.some((service) => service.name === 'proxy')) {
			services.push(proxy())
		}
		if (yaml.includes('hostname: postgres') && !services.some((service) => service.name === 'postgres')) {
			services.push(postgres(yaml.includes('postgresql:single@18') ? 'postgresql:single@18' : 'postgresql:ha@18'))
		}
		state.services.set(id, services)
		return importedServices(state, id)
	},
	importProject: async ({ yaml }) => {
		state.importProjectCount++
		state.calls.push('importProject')
		const name = yaml.includes('name: cheap-prod') ? 'cheap-prod' : 'apps-prod'
		const namespaceId = name
		const description = `Managed by Fabrika namespace ${namespaceId} (prod).`
		state.projects.set(projectId, project(projectId, name, description))
		state.services.set(projectId, [
			...(yaml.includes('hostname: postgres') ? [postgres()] : []),
			proxy(),
		])
		if (state.failImportAfterMutation) {
			state.failImportAfterMutation = false
			throw new Error('project import response lost')
		}
		return importedServices(state, projectId)
	},
	triggerPipeline: async ({ serviceId }) => {
		state.triggerCount++
		state.calls.push(`trigger:${serviceId}`)
		const versions = state.versions.get(serviceId) ?? []
		const version: ZeropsAppVersion = {
			id: `proxy-version-${versions.length + 1}`,
			status: 'ACTIVE',
			sequence: versions.length + 1,
			serviceStackId: serviceId,
		}
		versions.push(version)
		state.versions.set(serviceId, versions)
		if (state.failTriggerAfterMutation) {
			state.failTriggerAfterMutation = false
			throw new Error('pipeline response lost')
		}
		return { id: `process-${state.triggerCount}`, appVersionId: version.id }
	},
	createAppVersion: async ({ serviceId }) => {
		const versions = state.versions.get(serviceId) ?? []
		const version: ZeropsAppVersion = {
			id: `uploaded-version-${versions.length + 1}`,
			status: 'UPLOADING',
			sequence: versions.length + 1,
			serviceStackId: serviceId,
		}
		versions.push(version)
		state.versions.set(serviceId, versions)
		state.calls.push(`createAppVersion:${serviceId}`)
		return { id: version.id, uploadUrl: 'https://upload.test/archive?signature=test' }
	},
	buildAndDeployAppVersion: async ({ appVersionId }) => {
		for (const versions of state.versions.values()) {
			const version = versions.find((candidate) => candidate.id === appVersionId)
			if (version !== undefined) {
				version.status = 'ACTIVE'
				state.calls.push(`buildAndDeployAppVersion:${appVersionId}`)
				return { id: `process-${appVersionId}`, appVersionId }
			}
		}
		throw new Error(`missing version ${appVersionId}`)
	},
	deleteAppVersion: async ({ appVersionId }) => {
		for (const [serviceId, versions] of state.versions) {
			state.versions.set(serviceId, versions.filter((candidate) => candidate.id !== appVersionId))
		}
		state.calls.push(`deleteAppVersion:${appVersionId}`)
	},
	getAppVersion: async ({ appVersionId }) => {
		for (const versions of state.versions.values()) {
			const version = versions.find((candidate) => candidate.id === appVersionId)
			if (version !== undefined) return version
		}
		throw new Error(`missing version ${appVersionId}`)
	},
	latestAppVersion: async ({ serviceId }) => {
		const versions = state.versions.get(serviceId) ?? []
		return versions[versions.length - 1] ?? null
	},
	cancelBuild: async () => {},
	getProcess: async ({ processId }) => ({ id: processId, status: 'FINISHED' }),
	createIntegrationToken: async () => {
		throw new Error('the namespace operator must not mint a Zerops token')
	},
	enableSubdomainAccess: async ({ serviceId }) => {
		state.calls.push(`enableSubdomain:${serviceId}`)
		if (state.subdomainNotHttp) {
			throw new ZeropsApiError('zerops: enable subdomain access failed (400)', 400, ZEROPS_SERVICE_NOT_HTTP)
		}
		if (state.subdomainStaysDisabled) return
		for (const services of state.services.values()) {
			const service = services.find((candidate) => candidate.id === serviceId)
			if (service !== undefined) service.subdomainAccess = true
		}
	},
	getService: async ({ serviceId }) => {
		for (const services of state.services.values()) {
			const service = services.find((candidate) => candidate.id === serviceId)
			if (service !== undefined) return service
		}
		throw new Error(`missing service ${serviceId}`)
	},
	findService: async ({ projectId: id, hostname }) => (state.services.get(id) ?? []).find((service) => service.name === hostname) ?? null,
	getProject: async ({ projectId: id }) => {
		const found = state.projects.get(id)
		if (found === undefined) throw new Error(`missing project ${id}`)
		return found
	},
	listProjects: async () => [...state.projects.values()],
	findProjects: async ({ name }) => [...state.projects.values()].filter((candidate) => candidate.name === name),
	listProjectServices: async ({ projectId: id }) => [...(state.services.get(id) ?? [])],
	listServiceEnv: async ({ serviceId }) => [...ensureServiceEnv(state, serviceId).values()],
	createServiceEnv: async ({ serviceId, key, value }) => {
		state.calls.push(`create:${serviceId}:${key}`)
		const environment = ensureServiceEnv(state, serviceId)
		if (environment.has(key)) throw new Error('duplicate service environment key')
		environment.set(key, {
			id: `${serviceId}:${key}`,
			key,
			content: value,
			serviceStackId: serviceId,
			type: key === ZEROPS_NAMESPACE_IAM_KEY_VARIABLE ? 'SECRET' : 'EDITABLE',
		})
	},
	putServiceEnv: async ({ serviceId, key, value }) => {
		state.calls.push(`put:${serviceId}:${key}`)
		ensureServiceEnv(state, serviceId).set(key, {
			id: `${serviceId}:${key}`,
			key,
			content: value,
			serviceStackId: serviceId,
			type: key === ZEROPS_NAMESPACE_IAM_KEY_VARIABLE ? 'SECRET' : 'EDITABLE',
		})
	},
	deleteServiceEnv: async () => {},
	getProjectEnv: async ({ projectEnvId }) => ({ id: projectEnvId, key: 'KEY', content: 'value' }),
	getLogAccess: async () => {
		throw new Error('not used')
	},
	readBuildLog: async () => [],
})

const options = (state: FakeState): ZeropsNamespaceOptions => ({
	clientId: 'client-1',
	proxyBuildFromGit: 'https://github.com/contember/fabrika-platform',
	iamUrl: 'https://iam.example.test',
	iamKey: 'proxy-key-that-must-never-be-persisted',
	api: makeApi(state),
	sleep: async () => {},
})

const namespace = (
	target: ZeropsNamespaceTarget,
	overrides: Partial<ProviderDeploymentNamespace> = {},
): ProviderDeploymentNamespace => ({
	id: 'apps-prod',
	env: 'prod',
	target: {
		provider: 'zerops',
		version: zeropsNamespaceTargetCodec.version,
		payload: zeropsNamespaceTargetCodec.encode(target),
	},
	...overrides,
})

const run = async (
	capabilities: ReturnType<typeof createZeropsNamespaceCapabilities>,
	value: ProviderDeploymentNamespace,
	checkpoints: ProviderDeploymentNamespace[],
	operation: 'provision' | 'reconcile' = 'provision',
): Promise<ProviderDeploymentNamespace> =>
	capabilities[operation]({
		namespace: value,
		signal: new AbortController().signal,
		events: {
			checkpoint: async (checkpoint) => {
				checkpoints.push(checkpoint)
			},
		},
	})

describe('Zerops namespace policy and topology', () => {
	test('exposes provider-owned cheap, mid, and full operator plans', () => {
		const operator = createZeropsNamespaceOperator({
			proxyBuildFromGit: 'https://github.com/contember/fabrika-platform',
		})
		expect(operator.presets.map((preset) => [preset.id, preset.requiresExclusiveApp])).toEqual([
			['cheap', false],
			['mid', false],
			['full', true],
		])

		const cheap = operator.plan({ id: 'apps-prod', env: 'prod', preset: 'cheap' })
		const mid = operator.plan({ id: 'apps-stage', env: 'stage', preset: 'mid' })
		const full = operator.plan({ id: 'billing-prod', env: 'prod', preset: 'full', exclusiveAppId: 'billing' })
		expect(zeropsNamespaceTargetCodec.decode(cheap.namespace.target.payload)).toMatchObject({
			projectName: 'apps-prod',
			corePackage: 'SERIOUS',
			postgres: { type: 'postgresql:ha@18' },
		})
		expect(zeropsNamespaceTargetCodec.decode(mid.namespace.target.payload).postgres).toBeUndefined()
		expect(full.namespace.exclusiveAppId).toBe('billing')
		expect(full.presentation.facts).toContainEqual({ label: 'Placement', value: 'Exclusive to billing' })
		expect(cheap.presentation.instructions.join(' ')).toContain('shares its physical service')
		expect(() => operator.plan({ id: 'billing-prod', env: 'prod', preset: 'full' })).toThrow('requires exclusiveAppId')
	})

	test('resolves cheap, mid, and full presets without putting the presets in the neutral contract', () => {
		const cheap = zeropsNamespacePreset({
			preset: 'cheap',
			env: 'prod',
			projectName: 'cheap-prod',
			proxyBuildFromGit: 'https://github.com/contember/fabrika-platform',
		})
		const mid = zeropsNamespacePreset({
			preset: 'mid',
			env: 'stage',
			projectName: 'apps-stage',
			proxyBuildFromGit: 'https://github.com/contember/fabrika-platform',
		})
		const full = zeropsNamespacePreset({
			preset: 'full',
			env: 'prod',
			projectName: 'billing-prod',
			proxyBuildFromGit: 'https://github.com/contember/fabrika-platform',
		})

		// Sized, never defaulted: an HA service with no `profile` silently gets `oltp-production` anyway.
		expect(cheap.postgres).toEqual({ type: 'postgresql:ha@18', profile: 'oltp-production' })
		expect(mid.postgres).toBeUndefined()
		expect(mid.corePackage).toBe('LIGHT')
		expect(full.postgres).toBeUndefined()
	})

	test('compiles proxy plus one namespace-owned PostgreSQL service for cheap', () => {
		const target = zeropsNamespacePreset({
			preset: 'cheap',
			env: 'prod',
			projectName: 'cheap-prod',
			proxyBuildFromGit: 'https://github.com/contember/fabrika-platform',
		})
		const topology = compileZeropsNamespaceTopology(namespace(target, { id: 'cheap-prod' }), target)

		expect(topology.source.services({ env: 'prod' }).map((service) => [service.hostname, service.type])).toEqual([
			['postgres', 'postgresql:ha@18'],
			['proxy', 'alpine@3.21'],
		])
		expect(topology.createYaml).toContain('envIsolation: service')
		expect(topology.createYaml).not.toContain('connectionString')
		expect(topology.servicesProvisionYaml).not.toContain('project:')

		const stageTarget = zeropsNamespacePreset({
			preset: 'cheap',
			env: 'stage',
			projectName: 'cheap-stage',
			proxyBuildFromGit: 'https://github.com/contember/fabrika-platform',
		})
		expect(stageTarget.postgres).toEqual({ type: 'postgresql:single@18', profile: 'oltp-hobby' })
	})

	test('rejects unsupported PostgreSQL type/profile combinations at the codec boundary', () => {
		expect(() =>
			zeropsNamespaceTargetCodec.decode({
				postgres: { type: 'postgresql:single@18', profile: 'oltp-enterprise' },
			})
		).toThrow('profile is not supported')
		expect(() =>
			zeropsNamespaceTargetCodec.decode({
				postgres: { type: 'postgresql:ha@17' },
			})
		).toThrow('type must be')
	})

	test('lets two cheap apps consume one shared PostgreSQL reference without declaring its service', () => {
		const config = (id: string): ZeropsAppConfig => ({
			id,
			target: {
				platform: 'zerops',
				namespaceResources: [useSharedPostgres()],
				services: () => [{ hostname: `${id}api`, type: 'alpine/bun@1.3' }],
			},
		})
		const manifests = [
			compileFabrikaManifest(config('notes'), 'prod', SOURCE_DESCRIPTOR),
			compileFabrikaManifest(config('billing'), 'prod', SOURCE_DESCRIPTOR),
		]

		for (const manifest of manifests) {
			expect(manifest.target.namespaceResources).toEqual([{
				resourceKey: 'service:postgres',
				hostname: 'postgres',
				connectionString: ZEROPS_SHARED_POSTGRES_CONNECTION_STRING,
			}])
			expect(manifestServiceHostnames(manifest)).not.toContain('postgres')
			expect(JSON.stringify(manifest)).not.toContain('postgres://')
		}
	})

	test('rejects an app that consumes and redeclares namespace PostgreSQL', () => {
		const config: ZeropsAppConfig = {
			id: 'notes',
			target: {
				platform: 'zerops',
				namespaceResources: [useSharedPostgres()],
				services: () => [
					{ hostname: 'postgres', type: 'postgresql:ha@18' },
					{ hostname: 'notesapi', type: 'alpine/bun@1.3' },
				],
				deployService: 'notesapi',
			},
		}

		expect(() => compileFabrikaManifest(config, 'prod', SOURCE_DESCRIPTOR)).toThrow('cannot declare a namespace-owned service')
	})
})

describe('Zerops namespace lifecycle', () => {
	test('creates, configures, deploys, and checkpoints a cheap namespace', async () => {
		const state = freshState()
		const capabilities = createZeropsNamespaceCapabilities(options(state))
		const checkpoints: ProviderDeploymentNamespace[] = []
		const target = zeropsNamespacePreset({
			preset: 'cheap',
			env: 'prod',
			projectName: 'cheap-prod',
			proxyBuildFromGit: 'https://github.com/contember/fabrika-platform',
		})

		const result = await run(capabilities, namespace(target, { id: 'cheap-prod' }), checkpoints)
		const stored = zeropsNamespaceTargetCodec.decode(result.target.payload)

		expect(stored).toMatchObject({
			projectId,
			proxyServiceId: proxyId,
			postgresServiceId: postgresId,
			proxyConfigured: true,
			ready: true,
		})
		expect(state.importProjectCount).toBe(1)
		expect(state.triggerCount).toBe(1)
		expect(state.env.get(proxyId)?.get(FABRIKA_PROXY_MANIFEST_JSON)?.content).toBe('{"apps":[]}')
		expect(state.env.get(proxyId)?.get(ZEROPS_NAMESPACE_IAM_URL_VARIABLE)?.content).toBe('https://iam.example.test')
		expect(JSON.stringify(checkpoints)).not.toContain('proxy-key-that-must-never-be-persisted')
	})

	test('recovers an imported project after its response is lost without creating a duplicate', async () => {
		const state = freshState()
		state.failImportAfterMutation = true
		const capabilities = createZeropsNamespaceCapabilities(options(state))
		const firstCheckpoints: ProviderDeploymentNamespace[] = []
		const initial = namespace(zeropsNamespacePreset({
			preset: 'mid',
			env: 'prod',
			projectName: 'apps-prod',
			proxyBuildFromGit: 'https://github.com/contember/fabrika-platform',
		}))

		await expect(run(capabilities, initial, firstCheckpoints)).rejects.toThrow('response lost')
		const result = await run(capabilities, initial, [])

		expect(zeropsNamespaceTargetCodec.decode(result.target.payload).ready).toBe(true)
		expect(state.importProjectCount).toBe(1)
		expect(state.projects.size).toBe(1)
	})

	test('recovers a triggered proxy version after its response is lost', async () => {
		const state = freshState()
		state.failTriggerAfterMutation = true
		const capabilities = createZeropsNamespaceCapabilities(options(state))
		const checkpoints: ProviderDeploymentNamespace[] = []
		const initial = namespace(zeropsNamespacePreset({
			preset: 'mid',
			env: 'prod',
			projectName: 'apps-prod',
			proxyBuildFromGit: 'https://github.com/contember/fabrika-platform',
		}))

		await expect(run(capabilities, initial, checkpoints)).rejects.toThrow('response lost')
		const last = checkpoints[checkpoints.length - 1]
		if (last === undefined) throw new Error('expected a durable checkpoint before triggering')
		const result = await run(capabilities, last, [])

		expect(zeropsNamespaceTargetCodec.decode(result.target.payload).ready).toBe(true)
		expect(state.triggerCount).toBe(1)
	})

	test('refuses a managed checkpoint when the project ownership marker is absent', async () => {
		const state = freshState()
		state.projects.set(projectId, project(projectId, 'apps-prod', 'operator project'))
		state.services.set(projectId, [proxy()])
		const capabilities = createZeropsNamespaceCapabilities(options(state))
		const checkpoint = namespace({
			projectId,
			projectName: 'apps-prod',
			corePackage: 'SERIOUS',
			publicAccess: 'custom-domain',
			proxyBuildFromGit: 'https://github.com/contember/fabrika-platform',
			managed: true,
		})

		await expect(run(capabilities, checkpoint, [])).rejects.toThrow('different Fabrika ownership marker')
		expect(state.calls).not.toContain(`importServices:${projectId}`)
	})

	test('adopts only a compatible project and rejects a wrong proxy', async () => {
		const state = freshState()
		state.projects.set(projectId, project(projectId, 'external-prod', 'operator project'))
		state.services.set(projectId, [proxy(proxyId, 'alpine/bun@1.3')])
		const capabilities = createZeropsNamespaceCapabilities(options(state))
		const adopted = namespace({
			projectId,
			projectName: 'external-prod',
			corePackage: 'SERIOUS',
			publicAccess: 'custom-domain',
			proxyBuildFromGit: 'https://github.com/contember/fabrika-platform',
			managed: false,
		})

		await expect(run(capabilities, adopted, [])).rejects.toThrow('uses alpine/bun@1.3')
		expect(state.triggerCount).toBe(0)
	})

	test('adopts by observable invariants and reapplies service isolation without creating another project', async () => {
		const state = freshState()
		state.projects.set(projectId, project(projectId, 'external-prod', 'operator project'))
		state.services.set(projectId, [proxy()])
		const capabilities = createZeropsNamespaceCapabilities(options(state))
		const adopted = namespace({
			projectId,
			projectName: 'external-prod',
			corePackage: 'SERIOUS',
			publicAccess: 'custom-domain',
			proxyBuildFromGit: 'https://github.com/contember/fabrika-platform',
			managed: false,
		})

		const result = await run(capabilities, adopted, [])

		expect(zeropsNamespaceTargetCodec.decode(result.target.payload)).toMatchObject({
			projectId,
			proxyServiceId: proxyId,
			managed: false,
			ready: true,
		})
		expect(state.importProjectCount).toBe(0)
		expect(state.calls).toContain(`importServices:${projectId}`)
		expect(state.triggerCount).toBe(1)
	})

	test('rejects cheap adoption with missing or incompatible namespace PostgreSQL', async () => {
		const target: ZeropsNamespaceTarget = {
			projectId,
			projectName: 'cheap-prod',
			corePackage: 'SERIOUS',
			publicAccess: 'custom-domain',
			proxyBuildFromGit: 'https://github.com/contember/fabrika-platform',
			managed: false,
			postgres: { type: 'postgresql:ha@18' },
		}

		const missing = freshState()
		missing.projects.set(projectId, project(projectId, 'cheap-prod', 'operator project'))
		missing.services.set(projectId, [proxy()])
		await expect(run(createZeropsNamespaceCapabilities(options(missing)), namespace(target, { id: 'cheap-prod' }), [])).rejects.toThrow(
			'has no shared PostgreSQL service',
		)

		const wrong = freshState()
		wrong.projects.set(projectId, project(projectId, 'cheap-prod', 'operator project'))
		wrong.services.set(projectId, [proxy(), postgres('postgresql:single@18')])
		await expect(run(createZeropsNamespaceCapabilities(options(wrong)), namespace(target, { id: 'cheap-prod' }), [])).rejects.toThrow(
			'uses postgresql:single@18',
		)
	})

	test('rejects unmanaged services while adopting an exclusive namespace', async () => {
		const state = freshState()
		state.projects.set(projectId, project(projectId, 'billing-prod', 'operator project'))
		state.services.set(projectId, [
			proxy(),
			{
				id: 'foreign',
				name: 'foreign',
				projectId,
				base: 'alpine/bun@1.3',
			},
		])
		const capabilities = createZeropsNamespaceCapabilities(options(state))
		const adopted = namespace({
			projectId,
			projectName: 'billing-prod',
			corePackage: 'SERIOUS',
			publicAccess: 'custom-domain',
			proxyBuildFromGit: 'https://github.com/contember/fabrika-platform',
			managed: false,
		}, { id: 'billing-prod', exclusiveAppId: 'billing' })

		await expect(run(capabilities, adopted, [])).rejects.toThrow('contains unmanaged service')
	})

	test('reconciles namespace-owned services without replacing an existing app proxy manifest', async () => {
		const state = freshState()
		state.projects.set(projectId, project(projectId, 'apps-prod', 'Managed by Fabrika namespace apps-prod (prod).'))
		state.services.set(projectId, [proxy()])
		ensureServiceEnv(state, proxyId).set(FABRIKA_PROXY_MANIFEST_JSON, {
			id: 'manifest',
			key: FABRIKA_PROXY_MANIFEST_JSON,
			content: '{"apps":[{"id":"notes"}]}',
		})
		ensureServiceEnv(state, proxyId).set(ZEROPS_NAMESPACE_IAM_URL_VARIABLE, {
			id: 'iam-url',
			key: ZEROPS_NAMESPACE_IAM_URL_VARIABLE,
			content: 'https://iam.example.test',
		})
		const capabilities = createZeropsNamespaceCapabilities(options(state))
		const ready = namespace({
			projectId,
			projectName: 'apps-prod',
			corePackage: 'SERIOUS',
			publicAccess: 'custom-domain',
			proxyBuildFromGit: 'https://github.com/contember/fabrika-platform',
			managed: true,
			proxyServiceId: proxyId,
			proxyConfigured: true,
			ready: true,
		})

		const result = await run(capabilities, ready, [], 'reconcile')

		expect(zeropsNamespaceTargetCodec.decode(result.target.payload).ready).toBe(true)
		expect(state.env.get(proxyId)?.get(FABRIKA_PROXY_MANIFEST_JSON)?.content).toBe('{"apps":[{"id":"notes"}]}')
		expect(state.triggerCount).toBe(0)
		expect(state.calls).toContain(`importServices:${projectId}`)
	})

	// The import cannot establish a `.zerops.app` subdomain — the platform accepts `enableSubdomainAccess`
	// and drops it — so the lifecycle makes the call itself, and it is the only public entry these
	// namespaces have. Every branch below is about that: it happens, it happens AFTER the deploy, and it
	// is never reported as done on the strength of a 2xx.
	const subdomainNamespace = (): ProviderDeploymentNamespace =>
		namespace(
			zeropsNamespacePreset({
				preset: 'mid',
				env: 'prod',
				projectName: 'apps-prod',
				publicAccess: 'zerops-subdomain',
				proxyBuildFromGit: 'https://github.com/contember/fabrika-platform',
			}),
		)

	test('publishes the proxy subdomain after the deploy, because the import never could', async () => {
		const state = freshState()
		const capabilities = createZeropsNamespaceCapabilities(options(state))

		const result = await run(capabilities, subdomainNamespace(), [])

		expect(zeropsNamespaceTargetCodec.decode(result.target.payload).ready).toBe(true)
		expect(state.calls.indexOf(`trigger:${proxyId}`)).toBeLessThan(state.calls.indexOf(`enableSubdomain:${proxyId}`))
		expect((state.services.get(projectId) ?? []).find((service) => service.name === 'proxy')?.subdomainAccess).toBe(true)
	})

	test('refuses when the enable is accepted but the proxy still reads subdomainAccess: false', async () => {
		const state = freshState()
		state.subdomainStaysDisabled = true
		const capabilities = createZeropsNamespaceCapabilities(options(state))

		await expect(run(capabilities, subdomainNamespace(), [])).rejects.toThrow('no public entry point')
	})

	test('names the missing HTTP port when the platform refuses to publish an undeployed proxy', async () => {
		const state = freshState()
		state.subdomainNotHttp = true
		const capabilities = createZeropsNamespaceCapabilities(options(state))

		await expect(run(capabilities, subdomainNamespace(), [])).rejects.toThrow('no deployed HTTP port')
	})

	test('re-publishes a subdomain that was turned off, and leaves a custom-domain namespace alone', async () => {
		const disabled = freshState()
		disabled.projects.set(projectId, project(projectId, 'apps-prod', 'Managed by Fabrika namespace apps-prod (prod).'))
		disabled.services.set(projectId, [proxy()])
		const ready = (publicAccess: 'zerops-subdomain' | 'custom-domain'): ProviderDeploymentNamespace =>
			namespace({
				projectId,
				projectName: 'apps-prod',
				corePackage: 'SERIOUS',
				publicAccess,
				proxyBuildFromGit: 'https://github.com/contember/fabrika-platform',
				managed: true,
				proxyServiceId: proxyId,
				proxyConfigured: true,
				ready: true,
			})

		await run(createZeropsNamespaceCapabilities(options(disabled)), ready('zerops-subdomain'), [], 'reconcile')
		expect(disabled.calls).toContain(`enableSubdomain:${proxyId}`)

		const custom = freshState()
		custom.projects.set(projectId, project(projectId, 'apps-prod', 'Managed by Fabrika namespace apps-prod (prod).'))
		custom.services.set(projectId, [proxy()])
		await run(createZeropsNamespaceCapabilities(options(custom)), ready('custom-domain'), [], 'reconcile')
		expect(custom.calls).not.toContain(`enableSubdomain:${proxyId}`)
	})
})
