import { contractDigest, proxySecretVariable } from '@fabrika/auth-core'
import {
	type JsonValue,
	PROVIDER_NAMESPACE_IMMUTABLE,
	PROVIDER_NAMESPACE_UPDATE_UNCONFIRMED,
	type ProviderDeploymentNamespace,
	ProviderInvocationAbort,
	ProviderNamespaceError,
	type ProviderNamespaceOperator,
	type ProviderRegistration,
} from '@fabrika/provider-contract'
import { contractProxyTable, FABRIKA_PROXY_MANIFEST_JSON } from '@fabrika/proxy-core/manifest'
import { describe, expect, spyOn, test } from 'bun:test'
import { schemaFromContract } from '../../../app/src/contract/platform'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import {
	createZeropsApi,
	ZEROPS_SERVICE_NOT_HTTP,
	type ZeropsApi,
	ZeropsApiError,
	type ZeropsAppVersion,
	type ZeropsImportResult,
	type ZeropsProject,
	type ZeropsService,
} from '../api'
import { withoutSensitiveContent } from '../api/service-env-response'
import { useSharedPostgres } from '../authoring'
import { FABRIKA_CHECK_VERSION } from '../execution'
import {
	compileFabrikaManifest,
	createZeropsArtifactSourceDescriptor,
	manifestServiceHostnames,
	zeropsArtifactCodec,
	type ZeropsArtifactSourceDescriptor,
} from '../manifest'
import {
	compileZeropsNamespaceTopology,
	createZeropsNamespaceCapabilities,
	createZeropsNamespaceOperator,
	ZEROPS_NAMESPACE_IAM_ISSUER_VARIABLE,
	ZEROPS_NAMESPACE_IAM_KEY_VARIABLE,
	ZEROPS_NAMESPACE_LIFECYCLE,
	ZEROPS_NAMESPACE_SUBDOMAIN_VARIABLE,
	ZEROPS_SHARED_POSTGRES_CONNECTION_STRING,
	ZEROPS_SUBDOMAIN_NOT_PUBLISHED,
	type ZeropsNamespaceOptions,
	zeropsNamespacePreset,
	type ZeropsNamespaceTarget,
	zeropsNamespaceTargetCodec,
} from '../namespace'
import { envelope } from '../namespace/codec'
import { ZEROPS_SOURCE_RATE_LIMITED } from '../namespace/errors'
import { decodeZeropsNamespaceProxySource } from '../namespace/proxy-source'
import type { ZeropsNamespaceProxySource } from '../namespace/types'
import { ZeropsSourceRateLimitedError, type ZeropsSourceUploadInput } from '../source/port'
import type { ZeropsAppConfig } from '../types'
import { approvedContract } from './fixtures/access'

/** A variable as the platform stores it: the value of a sensitive one is kept, and `/env` withholds it. */
interface StoredServiceEnv {
	id: string
	key: string
	content: string
	serviceStackId?: string
	type?: string
	sensitive: boolean
}

interface FakeState {
	projects: Map<string, ZeropsProject>
	services: Map<string, ZeropsService[]>
	env: Map<string, Map<string, StoredServiceEnv>>
	versions: Map<string, ZeropsAppVersion[]>
	calls: string[]
	/** The data file of every proxy archive uploaded, in order: the manifest each build was given. */
	uploadedManifests: string[]
	importProjectCount: number
	triggerCount: number
	uploadSequence: number
	failImportAfterMutation: boolean
	failTriggerAfterMutation: boolean
	/** How many more times the platform answers `serviceStackIsNotHttp`: its HTTP ports lag the ACTIVE version. */
	subdomainNotHttpAnswers: number
	/** The 2xx-then-nothing case: the call is accepted and the flag never moves. */
	subdomainStaysDisabled: boolean
	/** A platform refusal of the project import, e.g. a token that may not create projects. */
	importProjectError: ZeropsApiError | null
	/** A platform refusal of a service-variable write, e.g. a value the platform rejects. */
	serviceEnvError: ZeropsApiError | null
	/** A platform refusal of the variable LISTING, armed only once the proxy subdomain is published. */
	failServiceEnvListAfterPublish: boolean
	/** The autoscaling PUT is accepted and the live profile never moves. */
	autoscalingIgnored: boolean
	/** The autoscaling PUT is refused outright, before anything is accepted. */
	autoscalingRefused: boolean
	/** The PUT applies, then the connection drops while its process is polled — the ambiguous case. */
	autoscalingProcessLost: boolean
}

const freshState = (): FakeState => ({
	projects: new Map(),
	services: new Map(),
	env: new Map(),
	versions: new Map(),
	calls: [],
	uploadedManifests: [],
	importProjectCount: 0,
	triggerCount: 0,
	uploadSequence: 0,
	failImportAfterMutation: false,
	failTriggerAfterMutation: false,
	subdomainNotHttpAnswers: 0,
	subdomainStaysDisabled: false,
	importProjectError: null,
	serviceEnvError: null,
	failServiceEnvListAfterPublish: false,
	autoscalingIgnored: false,
	autoscalingRefused: false,
	autoscalingProcessLost: false,
})

const projectId = 'project-1'
const proxyId = 'proxy-service'
const postgresId = 'postgres-service'
const PIN: ZeropsNamespaceProxySource = {
	repository: { owner: 'example', name: 'platform' },
	commitSha: 'a'.repeat(40),
	descriptor: await createZeropsArtifactSourceDescriptor('zerops:\n  - setup: proxy\n'),
}
const pinnedPayload = { proxySource: { repository: { ...PIN.repository }, commitSha: PIN.commitSha, descriptor: { ...PIN.descriptor } } }
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

const ensureServiceEnv = (state: FakeState, serviceId: string): Map<string, StoredServiceEnv> => {
	const found = state.env.get(serviceId)
	if (found !== undefined) return found
	const created = new Map<string, StoredServiceEnv>()
	state.env.set(serviceId, created)
	return created
}

const importedServices = (state: FakeState, id: string): ZeropsImportResult => ({
	projectId: id,
	services: (state.services.get(id) ?? []).map((service) => ({
		id: service.id,
		name: service.name,
		processes: [{ id: `import-${service.id}` }],
	})),
})

const makeApi = (state: FakeState): ZeropsApi => ({
	importServices: async ({ projectId: id, yaml }) => {
		expect(yaml).not.toContain('startWithoutCode')
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
		if (state.importProjectError !== null) throw state.importProjectError
		const name = yaml.includes('name: cheap-prod') ? 'cheap-prod' : 'apps-prod'
		const namespaceId = name
		const description = `Managed by Fabrika namespace ${namespaceId} (prod).`
		// The double creates what the DOCUMENT asked for, the way the platform does — reading both the
		// core package and the PostgreSQL flavour back out of the yaml rather than assuming either.
		state.projects.set(projectId, project(projectId, name, description, yaml.includes('corePackage: SERIOUS') ? 'SERIOUS' : 'LIGHT'))
		state.services.set(projectId, [
			...(yaml.includes('hostname: postgres') ? [postgres(yaml.includes('postgresql:single@18') ? 'postgresql:single@18' : 'postgresql:ha@18')] : []),
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
		state.uploadSequence++
		const version: ZeropsAppVersion = {
			id: `uploaded-version-${state.uploadSequence}`,
			status: 'UPLOADING',
			sequence: versions.length + 1,
			serviceStackId: serviceId,
		}
		versions.push(version)
		state.versions.set(serviceId, versions)
		state.calls.push(`createAppVersion:${serviceId}`)
		return { id: version.id, uploadUrl: `https://proxy.app-prg1.zerops.io/api/rest/object-storage/upload?version=${version.id}&signature=test` }
	},
	buildAndDeployAppVersion: async ({ appVersionId }) => {
		state.triggerCount++
		for (const versions of state.versions.values()) {
			const version = versions.find((candidate) => candidate.id === appVersionId)
			if (version !== undefined) {
				version.status = 'ACTIVE'
				state.calls.push(`buildAndDeployAppVersion:${appVersionId}`)
				if (state.failTriggerAfterMutation) {
					state.failTriggerAfterMutation = false
					throw new Error('build response lost')
				}
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
		throw new ZeropsApiError('App version not found', 400, 'appVersionNotFound')
	},
	latestAppVersion: async ({ serviceId }) => {
		const versions = state.versions.get(serviceId) ?? []
		return versions[versions.length - 1] ?? null
	},
	cancelBuild: async () => {},
	getProcess: async ({ processId }) => {
		state.calls.push(`wait:${processId}`)
		if (state.autoscalingProcessLost && processId.startsWith('autoscaling-')) {
			state.autoscalingProcessLost = false
			throw new Error('socket hang up')
		}
		return { id: processId, status: 'FINISHED' }
	},
	getUserInfo: async () => {
		throw new Error('the namespace operator must not read the token identity')
	},
	createIntegrationToken: async () => {
		throw new Error('the namespace operator must not mint a Zerops token')
	},
	enableSubdomainAccess: async ({ serviceId }) => {
		state.calls.push(`enableSubdomain:${serviceId}`)
		if (state.subdomainNotHttpAnswers > 0) {
			state.subdomainNotHttpAnswers -= 1
			throw new ZeropsApiError('zerops: enable subdomain access failed (400)', 400, ZEROPS_SERVICE_NOT_HTTP)
		}
		if (state.subdomainStaysDisabled) return
		for (const services of state.services.values()) {
			const service = services.find((candidate) => candidate.id === serviceId)
			if (service !== undefined) service.subdomainAccess = true
		}
	},
	configureAutoscaling: async ({ serviceId, autoscalingProfileId }) => {
		state.calls.push(`autoscaling:${serviceId}:${autoscalingProfileId}`)
		if (state.autoscalingRefused) {
			throw new ZeropsApiError('zerops: configure autoscaling failed (400) — invalidUserInput: bad profile', 400, 'invalidUserInput')
		}
		if (!state.autoscalingIgnored) {
			for (const services of state.services.values()) {
				const service = services.find((candidate) => candidate.id === serviceId)
				if (service !== undefined) service.autoscalingProfileId = autoscalingProfileId
			}
		}
		return { id: `autoscaling-${serviceId}`, status: 'PENDING', actionName: 'stack.autoscaling' }
	},
	configureCustomAutoscaling: () => Promise.reject(new Error('a namespace never sets custom autoscaling')),
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
	listServiceEnv: async ({ serviceId }) => {
		const published = [...state.services.values()].flat().find((service) => service.id === serviceId)?.subdomainAccess === true
		if (state.failServiceEnvListAfterPublish && published) {
			throw new ZeropsApiError('zerops: list service env failed (403)', 403, 'insufficientPermissions')
		}
		return [...ensureServiceEnv(state, serviceId).values()].map(withoutSensitiveContent)
	},
	createServiceEnv: async ({ serviceId, key, value, sensitive }) => {
		state.calls.push(`create:${serviceId}:${key}`)
		const environment = ensureServiceEnv(state, serviceId)
		if (environment.has(key)) throw new Error('duplicate service environment key')
		environment.set(key, {
			id: `${serviceId}:${key}`,
			key,
			content: value,
			serviceStackId: serviceId,
			type: key === ZEROPS_NAMESPACE_IAM_KEY_VARIABLE ? 'SECRET' : 'EDITABLE',
			sensitive,
		})
	},
	putServiceEnv: async ({ serviceId, key, value, sensitive }) => {
		state.calls.push(`put:${serviceId}:${key}`)
		if (state.serviceEnvError !== null) throw state.serviceEnvError
		ensureServiceEnv(state, serviceId).set(key, {
			id: `${serviceId}:${key}`,
			key,
			content: value,
			serviceStackId: serviceId,
			type: key === ZEROPS_NAMESPACE_IAM_KEY_VARIABLE ? 'SECRET' : 'EDITABLE',
			sensitive,
		})
	},
	deleteServiceEnv: async ({ envId }) => {
		state.calls.push(`unset:${envId}`)
		for (const variables of state.env.values()) {
			for (const [key, record] of variables) if (record.id === envId) variables.delete(key)
		}
	},
	getProjectEnv: async ({ projectEnvId }) => ({ id: projectEnvId, key: 'KEY', sensitive: false, content: 'value' }),
	getLogAccess: async () => {
		throw new Error('not used')
	},
	readBuildLog: async () => [],
})

const uploadedVersion = (uploadUrl: string): string | null => new URL(uploadUrl).searchParams.get('version')

/** What Control's source reports: the commit, its descriptor, and the digest of the manifest the archive carried. */
const uploaded = (input: ZeropsSourceUploadInput) => {
	const dataFile = input.archive.kind === 'platform' ? input.archive.dataFile : undefined
	return {
		commitSha: input.commitSha,
		descriptorSha256: input.descriptorSha256,
		...(dataFile === undefined ? {} : { dataFileSha256: new Bun.CryptoHasher('sha256').update(dataFile.contents).digest('hex') }),
		entryCount: 1,
		expandedBytes: 1,
	}
}

/** ADR-0045: a namespace proxy archive is the anonymous public commit plus its manifest. */
const expectProxyArchive = (state: FakeState, input: ZeropsSourceUploadInput): void => {
	expect(input.archive).toEqual({ kind: 'platform', dataFile: { path: 'proxy.manifest.json', contents: expect.any(String) } })
	if (input.archive.kind === 'platform' && input.archive.dataFile !== undefined) state.uploadedManifests.push(input.archive.dataFile.contents)
}

const options = (state: FakeState): ZeropsNamespaceOptions => ({
	proxySource: PIN,
	source: {
		resolve: async (input) => ({ commitSha: input.requestedRef, descriptorSha256: input.descriptorSha256 }),
		upload: async (input) => {
			state.calls.push(`upload:${uploadedVersion(input.uploadUrl)}`)
			expectProxyArchive(state, input)
			return uploaded(input)
		},
	},
	clientId: 'client-1',
	iamUrl: 'https://iam.example.test',
	iamKey: 'proxy-key-that-must-never-be-persisted',
	api: makeApi(state),
	sleep: async () => {},
})

const namespace = (
	target: Omit<ZeropsNamespaceTarget, 'proxySource'> & Partial<Pick<ZeropsNamespaceTarget, 'proxySource'>>,
	overrides: Partial<ProviderDeploymentNamespace> = {},
): ProviderDeploymentNamespace => ({
	id: 'apps-prod',
	env: 'prod',
	target: {
		provider: 'zerops',
		version: zeropsNamespaceTargetCodec.version,
		payload: zeropsNamespaceTargetCodec.encode({ proxySource: PIN, ...target }),
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
		members: [],
		signal: new AbortController().signal,
		events: {
			checkpoint: async (checkpoint) => {
				checkpoints.push(checkpoint)
			},
			boundary: async () => {},
		},
	})

const proxyBuildOf = (entry: ProviderDeploymentNamespace | undefined) =>
	entry === undefined ? undefined : zeropsNamespaceTargetCodec.decode(entry.target.payload).proxyBuild

/** The first checkpoint that recorded the attempt with this `triggered` value. */
const attemptCheckpoint = (checkpoints: ProviderDeploymentNamespace[], triggered: boolean): ProviderDeploymentNamespace => {
	const saved = checkpoints.find((entry) => proxyBuildOf(entry)?.triggered === triggered)
	if (saved === undefined) throw new Error('checkpoint missing')
	return saved
}

describe('immutable namespace proxy sources', () => {
	test('copies the selected default only into new plans and preserves persisted pins', () => {
		const state = freshState()
		const other = { ...PIN, commitSha: 'b'.repeat(40) }
		const capabilities = createZeropsNamespaceCapabilities({ ...options(state), proxySource: other })
		const existing = capabilities.normalize(namespace({ proxySource: PIN }))
		expect(zeropsNamespaceTargetCodec.decode(existing.target.payload).proxySource).toEqual(PIN)
		const planned = capabilities.operator?.plan({ id: 'apps-prod', env: 'prod', preset: 'mid' })
		if (planned === undefined) throw new Error('operator missing')
		expect(zeropsNamespaceTargetCodec.decode(planned.namespace.target.payload).proxySource).toEqual(other)
	})

	test('a stored target without a proxy source does not decode', () => {
		expect(() => zeropsNamespaceTargetCodec.decode({ projectName: 'apps-prod', managed: true })).toThrow('proxySource')
	})

	test('rejects malformed pins, byte digest mismatch and legacy checkpoints before writes', async () => {
		for (
			const invalid of [
				{ ...PIN, extra: true },
				{ ...PIN, repository: { owner: 'Example', name: 'platform' } },
				{ ...PIN, commitSha: 'HEAD' },
				{ ...PIN, descriptor: { ...PIN.descriptor, path: 'sub/zerops.yaml' } },
				{ ...PIN, descriptor: { ...PIN.descriptor, contents: 'zerops:\n - setup: other\n' } },
			]
		) expect(() => decodeZeropsNamespaceProxySource(invalid)).toThrow()
		const state = freshState()
		const capabilities = createZeropsNamespaceCapabilities(options(state))
		await expect(run(capabilities, namespace({ proxySource: { ...PIN, descriptor: { ...PIN.descriptor, sha256: '0'.repeat(64) } } }), [])).rejects
			.toThrow('digest mismatch')
		await expect(run(capabilities, namespace({ proxyBaselineSequence: 1 }), [])).rejects.toThrow('Legacy proxy operational')
		expect(state.calls).toEqual([])
	})

	test('refuses a proxy attempt recorded in the retired phase shape', () => {
		const phased = {
			runId: 'run',
			appVersionId: 'v',
			phase: 'build_triggered',
			source: { repository: { ...PIN.repository }, commitSha: PIN.commitSha },
		}
		expect(() => zeropsNamespaceTargetCodec.decode({ ...pinnedPayload, proxyBuild: phased })).toThrow('proxyBuild')
		expect(() => zeropsNamespaceTargetCodec.decode({ ...pinnedPayload, proxyBuild: { appVersionId: 'v', triggered: true, phase: 'build_triggered' } }))
			.toThrow()
		expect(zeropsNamespaceTargetCodec.decode({ ...pinnedPayload, proxyBuild: { appVersionId: 'v', triggered: false } }).proxyBuild).toEqual({
			appVersionId: 'v',
			triggered: false,
		})
	})

	test('resolves and uploads the persisted public commit, builds canonical descriptor on its exact reservation', async () => {
		const state = freshState()
		const base = options(state)
		const capabilities = createZeropsNamespaceCapabilities({
			...base,
			proxySource: { ...PIN, commitSha: 'b'.repeat(40) },
			source: {
				resolve: async (input) => {
					expect(input.repository).toEqual(PIN.repository)
					expect(input.requestedRef).toBe(PIN.commitSha)
					expect(input.expectedCommitSha).toBe(PIN.commitSha)
					expect(input.privateBinding).toBeUndefined()
					return { commitSha: PIN.commitSha, descriptorSha256: PIN.descriptor.sha256 }
				},
				upload: async (input) => {
					expect(input.commitSha).toBe(PIN.commitSha)
					expectProxyArchive(state, input)
					state.calls.push(`upload:${uploadedVersion(input.uploadUrl)}`)
					return uploaded(input)
				},
			},
			api: {
				...base.api,
				buildAndDeployAppVersion: async (input) => {
					expect(input.zeropsYamlSetup).toBe('proxy')
					expect(input.zeropsYaml).toContain('setup: proxy')
					expect(state.calls).toContain(`upload:${input.appVersionId}`)
					return base.api.buildAndDeployAppVersion(input)
				},
			},
		})
		const checkpoints: ProviderDeploymentNamespace[] = []
		await run(capabilities, namespace({}), checkpoints)
		expect(checkpoints.map((entry) => proxyBuildOf(entry)?.triggered)).toContainEqual(false)
		expect(checkpoints.map((entry) => proxyBuildOf(entry)).filter((build) => build !== undefined)).toEqual([
			{ appVersionId: 'uploaded-version-1', triggered: false, manifestSha256: expect.any(String) },
			{ appVersionId: 'uploaded-version-1', triggered: true, manifestSha256: expect.any(String) },
		])
		expect(state.calls.some((call) => call.startsWith('trigger:'))).toBe(false)
	})

	test('recovers an untriggered attempt by deleting its exact version before building a fresh one', async () => {
		const state = freshState()
		const capabilities = createZeropsNamespaceCapabilities(options(state))
		const checkpoints: ProviderDeploymentNamespace[] = []
		await run(capabilities, namespace({}), checkpoints)
		const saved = attemptCheckpoint(checkpoints, false)
		state.calls.length = 0
		state.versions.get(proxyId)?.push({ id: 'unrelated', status: 'ACTIVE', sequence: 999 })
		await run(capabilities, saved, [])
		expect(state.calls.indexOf('deleteAppVersion:uploaded-version-1')).toBeLessThan(state.calls.indexOf(`createAppVersion:${proxyId}`))
		expect(state.calls).toContain('upload:uploaded-version-2')
		expect(state.calls).not.toContain(`put:${proxyId}:${FABRIKA_PROXY_MANIFEST_JSON}`)
		expect(state.calls).not.toContain('buildAndDeployAppVersion:uploaded-version-1')
		expect(state.calls).not.toContain('buildAndDeployAppVersion:unrelated')
	})

	test('recovers a triggered attempt by polling it, without source availability, deletion or another build', async () => {
		const state = freshState()
		const base = options(state)
		const checkpoints: ProviderDeploymentNamespace[] = []
		await run(createZeropsNamespaceCapabilities(base), namespace({}), checkpoints)
		const saved = attemptCheckpoint(checkpoints, true)
		state.calls.length = 0
		state.versions.get(proxyId)?.push({ id: 'unrelated', status: 'ACTIVE', sequence: 999 })
		const result = await run(createZeropsNamespaceCapabilities({ ...base, source: undefined }), saved, [])
		expect(zeropsNamespaceTargetCodec.decode(result.target.payload)).toMatchObject({
			ready: true,
			proxyDeployment: { appVersionId: 'uploaded-version-1' },
		})
		expect(state.calls).toEqual([])
	})

	test('rejects transport identity mismatches before submission', async () => {
		const state = freshState()
		const base = options(state)
		const source = base.source
		if (source === undefined) throw new Error('source missing')
		const wrongResolve = createZeropsNamespaceCapabilities({
			...base,
			source: { ...source, resolve: async (input) => ({ commitSha: 'b'.repeat(40), descriptorSha256: input.descriptorSha256 }) },
		})
		await expect(run(wrongResolve, namespace({}), [])).rejects.toThrow('resolution identity mismatch')
		expect(state.calls).toEqual([])
		const wrongUpload = createZeropsNamespaceCapabilities({
			...base,
			source: {
				...source,
				upload: async (input) => ({ ...uploaded(input), commitSha: 'b'.repeat(40) }),
			},
		})
		const checkpoints: ProviderDeploymentNamespace[] = []
		await expect(run(wrongUpload, namespace({}), checkpoints)).rejects.toThrow('upload identity mismatch')
		expect(state.triggerCount).toBe(0)
		expect(state.calls).toContain('deleteAppVersion:uploaded-version-1')
		expect(zeropsNamespaceTargetCodec.decode(checkpoints.at(-1)?.target.payload ?? {}).proxyBuild).toBeUndefined()
	})

	test('an ambiguous UPLOADING version times out unresolved without deletion or resubmission', async () => {
		const state = freshState()
		const base = options(state)
		const checkpoints: ProviderDeploymentNamespace[] = []
		const capabilities = createZeropsNamespaceCapabilities({
			...base,
			api: {
				...base.api,
				buildAndDeployAppVersion: async () => {
					throw new Error('response lost')
				},
			},
		})
		let now = 0
		const clock = spyOn(Date, 'now').mockImplementation(() => {
			now += 71 * 60 * 1000
			return now
		})
		try {
			await expect(run(capabilities, namespace({}), checkpoints)).rejects.toThrow('remains unresolved')
			const saved = checkpoints.at(-1)
			if (saved === undefined) throw new Error('checkpoint missing')
			expect(proxyBuildOf(saved)?.triggered).toBe(true)
			state.calls.length = 0
			await expect(run(capabilities, saved, [])).rejects.toThrow('remains unresolved')
			expect(state.calls.filter((call) => /createAppVersion|deleteAppVersion|buildAndDeploy/.test(call))).toEqual([])
		} finally {
			clock.mockRestore()
		}
	})

	for (const kind of ['lease_lost', 'cancel_requested']) {
		test(`retains a triggered attempt on ${kind}: no deletion and no build cancellation`, async () => {
			if (kind !== 'lease_lost' && kind !== 'cancel_requested') throw new Error('invalid abort')
			const state = freshState()
			const base = options(state)
			const abort = new AbortController()
			const capabilities = createZeropsNamespaceCapabilities({
				...base,
				api: {
					...base.api,
					buildAndDeployAppVersion: async () => {
						abort.abort(new ProviderInvocationAbort(kind))
						throw abort.signal.reason
					},
					cancelBuild: async ({ signal }) => {
						expect(signal.aborted).toBe(false)
						state.calls.push('cancelBuild')
					},
				},
			})
			const checkpoints: ProviderDeploymentNamespace[] = []
			await expect(capabilities.provision({
				namespace: namespace({}),
				members: [],
				signal: abort.signal,
				events: {
					checkpoint: async (value) => {
						checkpoints.push(value)
					},
					boundary: async () => {},
				},
			})).rejects.toThrow()
			expect(state.calls).not.toContain('cancelBuild')
			expect(state.calls.some((call) => call.startsWith('deleteAppVersion'))).toBe(false)
			expect(proxyBuildOf(checkpoints.at(-1))?.triggered).toBe(true)
		})
	}
})

describe('namespace deployed source evidence and settlement', () => {
	test('explicit reconciliation reactivates persisted A under default B and repairs an out-of-band rollback with A', async () => {
		const state = freshState()
		const base = options(state)
		const initial = await run(createZeropsNamespaceCapabilities(base), namespace({}), [])
		const evidence = zeropsNamespaceTargetCodec.decode(initial.target.payload).proxyDeployment
		expect(evidence).toEqual({
			manifestSha256: 'e4023a65145620889331fd17cb3e09ddcd9684cf7a6ca0f34e3cf8e74898580f',
			appVersionId: 'uploaded-version-1',
			repository: PIN.repository,
			commitSha: PIN.commitSha,
			descriptorSha256: PIN.descriptor.sha256,
		})
		const source = base.source
		if (source === undefined) throw new Error('source missing')
		let resolutions = 0
		const capabilities = createZeropsNamespaceCapabilities({
			...base,
			proxySource: { ...PIN, commitSha: 'b'.repeat(40) },
			source: {
				...source,
				resolve: async (input) => {
					resolutions++
					expect(input.requestedRef).toBe(PIN.commitSha)
					return source.resolve(input)
				},
			},
		})
		state.calls.length = 0
		const unchanged = await run(capabilities, initial, [], 'reconcile')
		expect(resolutions).toBe(1)
		expect(state.calls.some((call) => call.startsWith('createAppVersion:'))).toBe(true)
		const refreshed = zeropsNamespaceTargetCodec.decode(unchanged.target.payload).proxyDeployment
		expect(refreshed?.commitSha).toBe(PIN.commitSha)
		expect(refreshed?.appVersionId).not.toBe(evidence?.appVersionId)
		const prior = state.versions.get(proxyId)?.find(version => version.id === refreshed?.appVersionId)
		if (prior === undefined) throw new Error('version missing')
		prior.status = 'BACKUP'
		state.versions.get(proxyId)?.push({ id: 'external-code', status: 'ACTIVE', sequence: 999 })
		const repaired = await run(capabilities, unchanged, [], 'reconcile')
		expect(resolutions).toBe(2)
		const deployed = zeropsNamespaceTargetCodec.decode(repaired.target.payload).proxyDeployment
		expect(deployed?.commitSha).toBe(PIN.commitSha)
		expect(deployed?.appVersionId).not.toBe('external-code')
		expect(deployed?.appVersionId).not.toBe(evidence?.appVersionId)
	})

	test('mismatched recorded source evidence rebuilds the namespace pin rather than adopting the version', async () => {
		const state = freshState()
		const capabilities = createZeropsNamespaceCapabilities(options(state))
		const initial = await run(capabilities, namespace({}), [])
		const target = zeropsNamespaceTargetCodec.decode(initial.target.payload)
		if (target.proxyDeployment === undefined) throw new Error('deployment missing')
		const result = await run(
			capabilities,
			namespace({ ...target, proxyDeployment: { ...target.proxyDeployment, commitSha: 'b'.repeat(40) } }),
			[],
			'reconcile',
		)
		expect(state.triggerCount).toBe(2)
		expect(zeropsNamespaceTargetCodec.decode(result.target.payload).proxyDeployment?.commitSha).toBe(PIN.commitSha)
		expect(() => zeropsNamespaceTargetCodec.decode({ proxyDeployment: { ...target.proxyDeployment, repository: { ...PIN.repository }, extra: true } }))
			.toThrow()
	})

	for (const observation of ['unavailable', 'unknown', 'UPLOADING']) {
		test(`a recorded deployment that is ${observation} remains unresolved without competing writes`, async () => {
			const state = freshState()
			const base = options(state)
			const initial = await run(createZeropsNamespaceCapabilities(base), namespace({}), [])
			state.calls.length = 0
			const capabilities = createZeropsNamespaceCapabilities({
				...base,
				api: {
					...base.api,
					getAppVersion: async ({ appVersionId }) => {
						if (observation === 'unavailable') throw new Error('unavailable')
						return observation === 'unknown' ? { id: appVersionId } : { id: appVersionId, status: 'UPLOADING' }
					},
				},
			})
			const checkpoints: ProviderDeploymentNamespace[] = []
			try {
				await run(capabilities, initial, checkpoints, 'reconcile')
				throw new Error('expected unresolved state')
			} catch (cause) {
				expect(cause).toBeInstanceOf(ProviderNamespaceError)
				if (!(cause instanceof ProviderNamespaceError)) throw cause
				expect(cause.retryable).toBe(true)
			}
			expect(state.calls).toEqual([])
			expect(zeropsNamespaceTargetCodec.decode(checkpoints.at(-1)?.target.payload ?? {}).ready).toBe(false)
		})
	}

	test('an adopted exclusive namespace retains adoption after a transient readiness failure', async () => {
		const state = freshState()
		state.projects.set(projectId, project(projectId, 'apps-prod', 'operator project'))
		state.services.set(projectId, [proxy()])
		const base = options(state)
		const capabilities = createZeropsNamespaceCapabilities(base)
		const adoption = namespace({ projectId, projectName: 'apps-prod', corePackage: 'SERIOUS', managed: false }, { exclusiveAppId: 'notes' })
		const initial = await run(capabilities, adoption, [])
		state.services.get(projectId)?.push({ id: 'notes-service', name: 'notesapi', projectId, base: 'alpine/bun@1.3', status: 'ACTIVE' })
		const unavailable = createZeropsNamespaceCapabilities({
			...base,
			api: {
				...base.api,
				getAppVersion: async () => {
					throw new Error('temporarily unavailable')
				},
			},
		})
		const checkpoints: ProviderDeploymentNamespace[] = []
		await expect(run(unavailable, initial, checkpoints, 'reconcile')).rejects.toThrow('unresolved')
		const retry = checkpoints.at(-1)
		if (retry === undefined) throw new Error('checkpoint missing')
		expect(zeropsNamespaceTargetCodec.decode(retry.target.payload).ready).toBe(false)
		const recovered = await run(capabilities, retry, [], 'reconcile')
		expect(zeropsNamespaceTargetCodec.decode(recovered.target.payload).ready).toBe(true)
		expect(state.triggerCount).toBe(2)
		await expect(run(capabilities, adoption, [])).rejects.toThrow('contains unmanaged service')
	})

	for (const status of ['BUILD_FAILED', 'DEPLOY_FAILED', 'CANCELLED']) {
		test(`retires settled ${status} before a later explicit retry reserves the same pin`, async () => {
			if (status !== 'BUILD_FAILED' && status !== 'DEPLOY_FAILED' && status !== 'CANCELLED') throw new Error('invalid status')
			const state = freshState()
			const base = options(state)
			const capabilities = createZeropsNamespaceCapabilities({
				...base,
				api: { ...base.api, getAppVersion: async ({ appVersionId }) => ({ id: appVersionId, status }) },
			})
			const checkpoints: ProviderDeploymentNamespace[] = []
			await expect(run(capabilities, namespace({}), checkpoints)).rejects.toThrow(status)
			const settled = checkpoints.at(-1)
			if (settled === undefined) throw new Error('checkpoint missing')
			expect(zeropsNamespaceTargetCodec.decode(settled.target.payload)).toMatchObject({ ready: false, proxySource: PIN })
			expect(zeropsNamespaceTargetCodec.decode(settled.target.payload).proxyBuild).toBeUndefined()
			expect(zeropsNamespaceTargetCodec.decode(settled.target.payload).proxyDeployment).toBeUndefined()
			const result = await run(createZeropsNamespaceCapabilities(base), settled, [])
			expect(zeropsNamespaceTargetCodec.decode(result.target.payload).proxyDeployment).toMatchObject({
				appVersionId: 'uploaded-version-2',
				commitSha: PIN.commitSha,
			})
		})
	}

	test('userDataSyncRunning retries the same version until the variables settle', async () => {
		const state = freshState()
		const base = options(state)
		let refusals = 2
		const capabilities = createZeropsNamespaceCapabilities({
			...base,
			api: {
				...base.api,
				buildAndDeployAppVersion: async (input) => {
					if (refusals-- > 0) throw new ZeropsApiError('sync running', 400, 'userDataSyncRunning')
					return base.api.buildAndDeployAppVersion(input)
				},
			},
		})
		const checkpoints: ProviderDeploymentNamespace[] = []
		const result = await run(capabilities, namespace({}), checkpoints)
		expect(state.calls.filter((call) => call.startsWith('createAppVersion:'))).toHaveLength(1)
		expect(checkpoints.map((entry) => proxyBuildOf(entry)?.triggered).filter((triggered) => triggered !== undefined)).toEqual([
			false,
			true,
			false,
			true,
			false,
			true,
		])
		expect(zeropsNamespaceTargetCodec.decode(result.target.payload).proxyDeployment?.appVersionId).toBe('uploaded-version-1')
	})

	test('userDataSyncRunning that never settles deletes the version it never built', async () => {
		const state = freshState()
		const base = options(state)
		let attempts = 0
		const capabilities = createZeropsNamespaceCapabilities({
			...base,
			api: {
				...base.api,
				buildAndDeployAppVersion: async () => {
					attempts++
					throw new ZeropsApiError('sync running', 400, 'userDataSyncRunning')
				},
			},
		})
		const checkpoints: ProviderDeploymentNamespace[] = []
		await expect(run(capabilities, namespace({}), checkpoints)).rejects.toThrow('still synchronizing')
		expect(attempts).toBe(10)
		expect(state.calls).toContain('deleteAppVersion:uploaded-version-1')
		expect(proxyBuildOf(checkpoints.at(-1))).toBeUndefined()
	})

	test('an inherited untriggered attempt is replaced only after its deletion is confirmed', async () => {
		const state = freshState()
		const base = options(state)
		const checkpoints: ProviderDeploymentNamespace[] = []
		await run(createZeropsNamespaceCapabilities(base), namespace({}), checkpoints)
		const saved = attemptCheckpoint(checkpoints, false)
		let deletionError = new ZeropsApiError('unclassified refusal', 400, 'unknown')
		const deletionApi = createZeropsApi({
			token: 'test-token',
			baseUrl: 'https://zerops.test',
			fetchImpl: async (url, init) => {
				expect(url).toBe('https://zerops.test/app-version/uploaded-version-1')
				expect(init?.method).toBe('DELETE')
				return Response.json({ meta: [{ error: 'upstream-secret-must-not-leak', code: deletionError.code, metadata: null }] }, {
					status: deletionError.status,
				})
			},
		})
		const capabilities = createZeropsNamespaceCapabilities({ ...base, api: { ...base.api, deleteAppVersion: deletionApi.deleteAppVersion } })
		state.calls.length = 0
		for (
			const error of [
				new ZeropsApiError('unclassified refusal', 400, 'unknown'),
				new ZeropsApiError('not found', 404, 'unknown'),
				new ZeropsApiError('wrong status', 404, 'appVersionNotFound'),
			]
		) {
			deletionError = error
			await expect(run(capabilities, saved, [])).rejects.toThrow('remains unresolved')
			expect(state.calls).not.toContain(`createAppVersion:${proxyId}`)
			expect(state.calls.some((call) => call.startsWith('buildAndDeployAppVersion:'))).toBe(false)
		}
		deletionError = new ZeropsApiError('App version not found', 400, 'appVersionNotFound')
		const recovered: ProviderDeploymentNamespace[] = []
		const result = await run(capabilities, saved, recovered)
		expect(zeropsNamespaceTargetCodec.decode(result.target.payload).ready).toBe(true)
		const cleared = recovered.findIndex((entry) => proxyBuildOf(entry) === undefined)
		expect(cleared).toBeGreaterThanOrEqual(0)
		expect(cleared).toBeLessThan(recovered.findIndex((entry) => proxyBuildOf(entry)?.appVersionId === 'uploaded-version-2'))
		expect(state.calls).toContain('buildAndDeployAppVersion:uploaded-version-2')
	})
})

describe('Zerops namespace policy and topology', () => {
	test('exposes provider-owned cheap, mid, and full operator plans', () => {
		const operator = createZeropsNamespaceOperator({ proxySource: PIN })
		expect(operator.presets.map((preset) => [preset.id, preset.requiresExclusiveApp])).toEqual([
			['cheap', false],
			['mid', false],
			['full', true],
		])

		const cheap = operator.plan({ id: 'apps-prod', env: 'prod', preset: 'cheap' })
		const mid = operator.plan({ id: 'apps-stage', env: 'stage', preset: 'mid' })
		const full = operator.plan({ id: 'billing-prod', env: 'prod', preset: 'full', exclusiveAppId: 'billing' })
		expect(zeropsNamespaceTargetCodec.decode(cheap.namespace.target.payload)).toMatchObject({
			projectName: 'fabrika-prod-apps-prod',
			corePackage: 'LIGHT',
			postgres: { type: 'postgresql:single@18' },
		})
		expect(zeropsNamespaceTargetCodec.decode(mid.namespace.target.payload).postgres).toBeUndefined()
		const named = operator.plan({ id: 'apps-stage', env: 'stage', preset: 'mid', options: { projectName: 'apps' } })
		expect(zeropsNamespaceTargetCodec.decode(named.namespace.target.payload).projectName).toBe('apps')
		expect(full.namespace.exclusiveAppId).toBe('billing')
		expect(full.presentation.facts).toContainEqual({ label: 'Placement', value: 'Exclusive to billing' })
		expect(cheap.presentation.instructions.join(' ')).toContain('shares its physical service')
		expect(() => operator.plan({ id: 'billing-prod', env: 'prod', preset: 'full' })).toThrow('requires exclusiveAppId')
	})

	test('resolves cheap, mid, and full presets without putting the presets in the neutral contract', () => {
		const cheap = zeropsNamespacePreset({
			proxySource: PIN,
			preset: 'cheap',
			env: 'prod',
			projectName: 'cheap-prod',
		})
		const mid = zeropsNamespacePreset({
			proxySource: PIN,
			preset: 'mid',
			env: 'stage',
			projectName: 'apps-stage',
		})
		const full = zeropsNamespacePreset({
			proxySource: PIN,
			preset: 'full',
			env: 'prod',
			projectName: 'billing-prod',
		})

		// Sized, never defaulted: a service with no `profile` silently gets its type's default —
		// `oltp-staging` for single, `oltp-production` for HA — so the cheapest preset is written out.
		expect(cheap.postgres).toEqual({ type: 'postgresql:single@18', profile: 'oltp-hobby' })
		expect(mid.postgres).toBeUndefined()
		expect(full.postgres).toBeUndefined()
		// `prod` buys no bigger default than any other environment: the name is not a size, and HA is a
		// deliberate act through the namespace command's explicit provider fields.
		expect(cheap.corePackage).toBe('LIGHT')
		expect(mid.corePackage).toBe('LIGHT')
		expect(full.corePackage).toBe('LIGHT')
	})

	test('compiles proxy plus one namespace-owned PostgreSQL service for cheap', () => {
		const target = zeropsNamespacePreset({
			proxySource: PIN,
			preset: 'cheap',
			env: 'prod',
			projectName: 'cheap-prod',
		})
		const topology = compileZeropsNamespaceTopology(namespace(target, { id: 'cheap-prod' }), target)

		expect(topology.source.services({ env: 'prod' }).map((service) => [service.hostname, service.type])).toEqual([
			['postgres', 'postgresql:single@18'],
			['proxy', 'alpine@3.21'],
		])
		expect(topology.createYaml).toContain('envIsolation: service')
		expect(topology.createYaml).not.toContain('connectionString')
		expect(topology.servicesProvisionYaml).not.toContain('project:')

		const stageTarget = zeropsNamespacePreset({
			proxySource: PIN,
			preset: 'cheap',
			env: 'stage',
			projectName: 'cheap-stage',
		})
		expect(stageTarget.postgres).toEqual({ type: 'postgresql:single@18', profile: 'oltp-hobby' })
	})

	test('rejects unsupported PostgreSQL type/profile combinations at the codec boundary', () => {
		expect(() =>
			zeropsNamespaceTargetCodec.decode({
				...pinnedPayload,
				postgres: { type: 'postgresql:single@18', profile: 'oltp-enterprise' },
			})
		).toThrow('profile is not supported')
		expect(() =>
			zeropsNamespaceTargetCodec.decode({
				...pinnedPayload,
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
			proxySource: PIN,
			preset: 'cheap',
			env: 'prod',
			projectName: 'cheap-prod',
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
		expect(state.calls.indexOf(`wait:import-${proxyId}`)).toBeLessThan(state.calls.indexOf(`put:${proxyId}:FABRIKA_PROXY_SESSION_OWNER_JSON`))
		expect(state.uploadedManifests).toEqual(['{"apps":[]}'])
		expect(state.env.get(proxyId)?.has(FABRIKA_PROXY_MANIFEST_JSON)).toBe(false)
		expect(state.env.get(proxyId)?.get(ZEROPS_NAMESPACE_IAM_ISSUER_VARIABLE)?.content).toBe('https://iam.example.test')
		expect(state.env.get(proxyId)?.get('FABRIKA_PROXY_SESSION_OWNER_JSON')?.content).toBe('null')
		expect(state.env.get(proxyId)?.get(ZEROPS_NAMESPACE_IAM_KEY_VARIABLE)?.sensitive).toBe(true)
		expect(state.calls.indexOf(`put:${proxyId}:FABRIKA_PROXY_SESSION_OWNER_JSON`)).toBeLessThan(
			state.calls.indexOf('buildAndDeployAppVersion:uploaded-version-1'),
		)
		expect(JSON.stringify(checkpoints)).not.toContain('proxy-key-that-must-never-be-persisted')
	})

	test('recovers an imported project after its response is lost without creating a duplicate', async () => {
		const state = freshState()
		state.failImportAfterMutation = true
		const capabilities = createZeropsNamespaceCapabilities(options(state))
		const firstCheckpoints: ProviderDeploymentNamespace[] = []
		const initial = namespace(zeropsNamespacePreset({
			proxySource: PIN,
			preset: 'mid',
			env: 'prod',
			projectName: 'apps-prod',
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
			proxySource: PIN,
			preset: 'mid',
			env: 'prod',
			projectName: 'apps-prod',
		}))

		const result = await run(capabilities, initial, checkpoints)

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
			managed: false,
		})

		await expect(run(capabilities, adopted, [])).rejects.toThrow('uses alpine/bun@1.3')
		expect(state.triggerCount).toBe(0)
	})

	test("refuses to adopt the installation's own project before it imports or builds anything", async () => {
		const state = freshState()
		state.projects.set(projectId, project(projectId, 'platform', 'fabrika platform'))
		state.services.set(projectId, [proxy()])
		const capabilities = createZeropsNamespaceCapabilities({ ...options(state), installationProjectId: projectId })
		const adopted = namespace({
			projectId,
			projectName: 'platform',
			corePackage: 'SERIOUS',
			publicAccess: 'custom-domain',
			managed: false,
		})

		await expect(run(capabilities, adopted, [])).rejects.toThrow("is the installation's own project")
		expect(state.calls).not.toContain(`importServices:${projectId}`)
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
			proxySource: PIN,
			projectId,
			projectName: 'cheap-prod',
			corePackage: 'SERIOUS',
			publicAccess: 'custom-domain',
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
			managed: false,
		}, { id: 'billing-prod', exclusiveAppId: 'billing' })

		await expect(run(capabilities, adopted, [])).rejects.toThrow('contains unmanaged service')
	})

	test('reconciles namespace-owned services, disables session ownership and publishes the manifest its members compile to', async () => {
		const state = freshState()
		const manifest = JSON.stringify({
			apps: [{
				id: 'notes@prod',
				hosts: ['notes.example.test'],
				upstream: 'notes:3000',
				scheme: 'https',
				...contractProxyTable(notesArtifact),
			}],
		})
		state.projects.set(projectId, project(projectId, 'apps-prod', 'Managed by Fabrika namespace apps-prod (prod).'))
		state.services.set(projectId, [proxy()])
		ensureServiceEnv(state, proxyId).set(FABRIKA_PROXY_MANIFEST_JSON, {
			id: 'manifest',
			key: FABRIKA_PROXY_MANIFEST_JSON,
			content: '{"apps":[]}',
			sensitive: false,
		})
		ensureServiceEnv(state, proxyId).set(ZEROPS_NAMESPACE_IAM_ISSUER_VARIABLE, {
			id: 'iam-url',
			key: ZEROPS_NAMESPACE_IAM_ISSUER_VARIABLE,
			content: 'https://iam.example.test',
			sensitive: false,
		})
		ensureServiceEnv(state, proxyId).set('FABRIKA_PROXY_SESSION_OWNER_JSON', {
			id: 'session-owner',
			key: 'FABRIKA_PROXY_SESSION_OWNER_JSON',
			content: JSON.stringify({ issuer: 'https://iam.example.test', upstream: 'iam:3000' }),
			sensitive: false,
		})
		const capabilities = createZeropsNamespaceCapabilities(options(state))
		const ready = namespace({
			projectId,
			projectName: 'apps-prod',
			corePackage: 'SERIOUS',
			publicAccess: 'custom-domain',
			managed: true,
			proxyServiceId: proxyId,
			proxyConfigured: true,
			ready: true,
		})

		const notes = compileFabrikaManifest(
			{
				id: 'notes',
				target: {
					platform: 'zerops',
					services: () => [{ hostname: 'notes', type: 'alpine/bun@1.3' }],
					contract: notesArtifact,
					proxy: { upstream: 'notes:3000', ...contractProxyTable(notesArtifact) },
				},
			},
			'prod',
			SOURCE_DESCRIPTOR,
		)

		const result = await capabilities.reconcile({
			namespace: ready,
			members: [{
				appId: 'notes',
				env: 'prod',
				domain: 'Notes.Example.Test',
				artifact: { provider: 'zerops', version: zeropsArtifactCodec.version, payload: zeropsArtifactCodec.encode(notes) },
				access: approvedContract(),
				proxySecret: 'notes-secret',
			}],
			signal: new AbortController().signal,
			events: { checkpoint: async () => {}, boundary: async () => {} },
		})

		expect(zeropsNamespaceTargetCodec.decode(result.target.payload).ready).toBe(true)
		expect(state.uploadedManifests.at(-1)).toBe(manifest)
		// The manifest an earlier release left in the environment is gone: the archive is the one carrier.
		expect(state.env.get(proxyId)?.has(FABRIKA_PROXY_MANIFEST_JSON)).toBe(false)
		expect(state.env.get(proxyId)?.get('FABRIKA_PROXY_SESSION_OWNER_JSON')?.content).toBe('null')
		expect(state.calls.indexOf(`put:${proxyId}:FABRIKA_PROXY_SESSION_OWNER_JSON`)).toBeLessThan(
			state.calls.indexOf('buildAndDeployAppVersion:uploaded-version-1'),
		)
		expect(state.triggerCount).toBe(1)
		expect(state.calls).toContain(`importServices:${projectId}`)

		state.calls.length = 0
		await run(capabilities, result, [], 'reconcile')
		expect(state.calls).not.toContain(`put:${proxyId}:FABRIKA_PROXY_SESSION_OWNER_JSON`)
	})

	test("writes a contract member's proxy secret to the proxy service before the proxy builds (ADR-0022 rule 5)", async () => {
		const state = freshState()
		state.projects.set(projectId, project(projectId, 'apps-prod', 'Managed by Fabrika namespace apps-prod (prod).'))
		state.services.set(projectId, [proxy()])
		const capabilities = createZeropsNamespaceCapabilities(options(state))
		const ready = namespace({
			projectId,
			projectName: 'apps-prod',
			corePackage: 'SERIOUS',
			publicAccess: 'custom-domain',
			managed: true,
			proxyServiceId: proxyId,
			proxyConfigured: true,
			ready: true,
		})
		const notes = compileFabrikaManifest(
			{
				id: 'notes',
				target: {
					platform: 'zerops',
					services: () => [{ hostname: 'notes', type: 'alpine/bun@1.3' }],
					proxy: { upstream: 'notes:3000', ...contractProxyTable(notesArtifact) },
					contract: notesArtifact,
				},
			},
			'prod',
			SOURCE_DESCRIPTOR,
		)
		const member = {
			appId: 'notes',
			env: 'prod',
			domain: 'notes.example.test',
			artifact: { provider: 'zerops', version: zeropsArtifactCodec.version, payload: zeropsArtifactCodec.encode(notes) },
			access: {
				contract: notesArtifact,
				contractDigest: contractDigest(notesArtifact),
				schema: schemaFromContract(notesArtifact),
				checker: FABRIKA_CHECK_VERSION,
			},
		}
		const events = { checkpoint: async () => {}, boundary: async () => {} }

		await expect(capabilities.reconcile({ namespace: ready, members: [member], signal: new AbortController().signal, events })).rejects.toThrow(
			'no proxy secret',
		)
		await capabilities.reconcile({
			namespace: ready,
			members: [{ ...member, proxySecret: 'notes-proxy-secret' }],
			signal: new AbortController().signal,
			events,
		})

		const variable = proxySecretVariable('notes@prod')
		expect(state.env.get(proxyId)?.get(variable)).toMatchObject({ content: 'notes-proxy-secret', sensitive: true })
		expect(state.calls.indexOf(`put:${proxyId}:${variable}`)).toBeLessThan(state.calls.indexOf('buildAndDeployAppVersion:uploaded-version-1'))
		expect(state.uploadedManifests.join('\n')).not.toContain('notes-proxy-secret')
	})

	// The import cannot establish a `.zerops.app` subdomain — the platform accepts `enableSubdomainAccess`
	// and drops it — so the lifecycle makes the call itself, and it is the only public entry these
	// namespaces have. Every branch below is about that: it happens, it happens AFTER the deploy, and it
	// is never reported as done on the strength of a 2xx.
	const subdomainNamespace = (): ProviderDeploymentNamespace =>
		namespace(
			zeropsNamespacePreset({
				proxySource: PIN,
				preset: 'mid',
				env: 'prod',
				projectName: 'apps-prod',
				publicAccess: 'zerops-subdomain',
			}),
		)

	test('publishes the proxy subdomain after the deploy, because the import never could', async () => {
		const state = freshState()
		const capabilities = createZeropsNamespaceCapabilities(options(state))

		const result = await run(capabilities, subdomainNamespace(), [])

		expect(zeropsNamespaceTargetCodec.decode(result.target.payload).ready).toBe(true)
		expect(state.calls.indexOf('buildAndDeployAppVersion:uploaded-version-1')).toBeLessThan(state.calls.indexOf(`enableSubdomain:${proxyId}`))
		expect((state.services.get(projectId) ?? []).find((service) => service.name === 'proxy')?.subdomainAccess).toBe(true)
	})

	test('refuses when the enable is accepted but the proxy still reads subdomainAccess: false', async () => {
		const state = freshState()
		state.subdomainStaysDisabled = true
		const capabilities = createZeropsNamespaceCapabilities(options(state))

		await expect(run(capabilities, subdomainNamespace(), [])).rejects.toThrow('no public entry point')
	})

	test('waits for the HTTP ports that lag the ACTIVE version, then publishes', async () => {
		const state = freshState()
		state.subdomainNotHttpAnswers = 3
		const capabilities = createZeropsNamespaceCapabilities(options(state))

		const result = await run(capabilities, subdomainNamespace(), [])

		expect(zeropsNamespaceTargetCodec.decode(result.target.payload).ready).toBe(true)
		expect(state.calls.filter((call) => call === `enableSubdomain:${proxyId}`)).toHaveLength(4)
		expect((state.services.get(projectId) ?? []).find((service) => service.name === 'proxy')?.subdomainAccess).toBe(true)
	})

	test('names the missing HTTP port when the platform refuses to publish an undeployed proxy', async () => {
		const state = freshState()
		state.subdomainNotHttpAnswers = Number.POSITIVE_INFINITY
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

// The three live failures that were indistinguishable before backlog 72: a denied project import, a
// refused service-variable write, and a subdomain the platform will not publish. Each now leaves the
// provider with its own code, and the platform's own words survive in `detail` — where the control
// plane redacts them — instead of being thrown away.
describe('Zerops namespace presentation', () => {
	test('marks the project as a live resource and names its id once it exists', () => {
		const operator = createZeropsNamespaceOperator({ proxySource: PIN })
		const target: ZeropsNamespaceTarget = {
			proxySource: PIN,
			projectId,
			projectName: 'apps-prod',
			corePackage: 'SERIOUS',
			publicAccess: 'custom-domain',
			managed: true,
		}

		const facts = operator.present(namespace(target)).facts

		expect(facts.filter((fact) => fact.resource === true)).toEqual([{ label: 'Project', value: `apps-prod (${projectId})`, resource: true }])
	})

	test('marks nothing while the project is still a plan', () => {
		const operator = createZeropsNamespaceOperator({ proxySource: PIN })

		const planned = operator.plan({ id: 'apps-prod', env: 'prod', preset: 'mid' })

		expect(planned.presentation.facts.some((fact) => fact.resource === true)).toBe(false)
		expect(planned.presentation.facts).toContainEqual({ label: 'Project', value: 'fabrika-prod-apps-prod' })
	})

	// The hosts an operator has to name as `--domain`. Before this they were read by hand off the proxy
	// service's `zeropsSubdomain` variable, which is exactly what provisioning now records for them.
	const operator = (): ProviderNamespaceOperator => createZeropsNamespaceOperator({ proxySource: PIN })

	const subdomainPlacement = (): ProviderDeploymentNamespace =>
		namespace(zeropsNamespacePreset({
			proxySource: PIN,
			preset: 'mid',
			env: 'prod',
			projectName: 'apps-prod',
			publicAccess: 'zerops-subdomain',
		}))

	const publishSubdomains = (state: FakeState, content: string): void => {
		ensureServiceEnv(state, proxyId).set(ZEROPS_NAMESPACE_SUBDOMAIN_VARIABLE, {
			id: `${proxyId}:${ZEROPS_NAMESPACE_SUBDOMAIN_VARIABLE}`,
			key: ZEROPS_NAMESPACE_SUBDOMAIN_VARIABLE,
			content,
			serviceStackId: proxyId,
			type: 'SYSTEM',
			sensitive: false,
		})
	}

	test('lists one host per published proxy port, ordered by port and lowercased', async () => {
		const state = freshState()
		// One URL per listening port, newline-separated, exactly as the platform writes it.
		publishSubdomains(
			state,
			'https://proxy-2ec8-8082.prg1.zerops.app\nhttps://PROXY-2EC8-8080.PRG1.zerops.app\n',
		)

		const provisioned = await run(createZeropsNamespaceCapabilities(options(state)), subdomainPlacement(), [])

		// A host is what a Host header is matched against, so it is recorded the way the proxy compares it.
		expect(operator().present(provisioned).hosts).toEqual([
			{ host: 'proxy-2ec8-8080.prg1.zerops.app', port: 8080 },
			{ host: 'proxy-2ec8-8082.prg1.zerops.app', port: 8082 },
		])
	})

	test('lists no host when the variable is absent, portless, or unreadable', async () => {
		const absent = freshState()
		// A proxy that has never deployed still HAS the variable: one line, no port segment
		// (`docs/reference/zerops-platform.md`). It names no listener, so it names no host.
		const portless = freshState()
		publishSubdomains(portless, 'https://proxy-2ec8.prg1.zerops.app\nnot a url at all\n')

		const provisioned = await run(createZeropsNamespaceCapabilities(options(absent)), subdomainPlacement(), [])
		const undeployed = await run(createZeropsNamespaceCapabilities(options(portless)), subdomainPlacement(), [])

		expect(operator().present(provisioned).hosts).toBeUndefined()
		expect(operator().present(undeployed).hosts).toBeUndefined()
	})

	test('stays ready when the host listing fails, because the proxy is already published', async () => {
		const state = freshState()
		publishSubdomains(state, 'https://proxy-2ec8-8080.prg1.zerops.app\n')
		// Only the listing that follows the publish fails: everything the namespace exists for succeeded.
		state.failServiceEnvListAfterPublish = true

		const provisioned = await run(createZeropsNamespaceCapabilities(options(state)), subdomainPlacement(), [])

		expect(zeropsNamespaceTargetCodec.decode(provisioned.target.payload).ready).toBe(true)
		expect(operator().present(provisioned).hosts).toBeUndefined()
		expect(state.calls).toContain(`enableSubdomain:${proxyId}`)
	})

	test('lists no host before the placement is ready, and none at all on a custom-domain placement', () => {
		const recorded: ZeropsNamespaceTarget = {
			proxySource: PIN,
			projectId,
			projectName: 'apps-prod',
			corePackage: 'LIGHT',
			managed: true,
			proxyServiceId: proxyId,
			proxyHosts: [{ host: 'proxy-2ec8-8080.prg1.zerops.app', port: 8080 }],
		}

		expect(operator().present(namespace({ ...recorded, publicAccess: 'zerops-subdomain', ready: false })).hosts).toBeUndefined()
		expect(operator().present(namespace({ ...recorded, publicAccess: 'custom-domain', ready: true })).hosts).toBeUndefined()
	})

	test('carries the recorded hosts through the target codec', () => {
		const encoded = zeropsNamespaceTargetCodec.encode({ proxySource: PIN, proxyHosts: [{ host: 'proxy-2ec8-8080.prg1.zerops.app', port: 8080 }] })

		expect(zeropsNamespaceTargetCodec.decode(encoded).proxyHosts).toEqual([{ host: 'proxy-2ec8-8080.prg1.zerops.app', port: 8080 }])
		expect(() => zeropsNamespaceTargetCodec.decode({ ...pinnedPayload, proxyHosts: [{ host: 'proxy-2ec8-8080.prg1.zerops.app', port: '8080' }] }))
			.toThrow(
				'port must be a positive integer',
			)
	})
})

// A `target.proxy` app is routed by Host: with no domain the namespace proxy has nothing to serve, and
// before this the registration was accepted and the first deploy failed a second later.
describe('Zerops proxy-target registration', () => {
	const proxyRegistration = (domain?: string): ProviderRegistration => {
		const config: ZeropsAppConfig = {
			id: 'notes',
			target: {
				platform: 'zerops',
				services: () => [{ hostname: 'notesapi', type: 'alpine/bun@1.3' }],
				deployService: 'notesapi',
				contract: notesArtifact,
				proxy: { upstream: 'notesapi:3000', ...contractProxyTable(notesArtifact) },
			},
		}
		return {
			app: { id: 'notes', source: { repoUrl: 'https://github.com/example/notes', ref: 'main' } },
			environment: {
				appId: 'notes',
				env: 'prod',
				...(domain === undefined ? {} : { domain }),
				namespace: namespace(
					zeropsNamespacePreset({
						proxySource: PIN,
						preset: 'full',
						env: 'prod',
						projectName: 'apps-prod',
						publicAccess: 'zerops-subdomain',
					}),
					{ exclusiveAppId: 'notes' },
				),
				target: { provider: 'zerops', version: 2, payload: { serviceId: 'notesapi-service' } },
				artifact: {
					provider: 'zerops',
					version: zeropsArtifactCodec.version,
					payload: zeropsArtifactCodec.encode(compileFabrikaManifest(config, 'prod', SOURCE_DESCRIPTOR)),
				},
			},
		}
	}

	test('refuses a proxy target with no domain, naming the flag that supplies one', () => {
		const capabilities = createZeropsNamespaceCapabilities(options(freshState()))

		expect(() => capabilities.registrationResourceClaims(proxyRegistration())).toThrow('--domain')
		expect(() => capabilities.registrationResourceClaims(proxyRegistration('   '))).toThrow('requires a public domain')
	})

	// One Caddy fronts every app in the namespace and its host matcher reads `*` as a wildcard label, so
	// a pattern registered under one app id would answer for its siblings' hostnames.
	test('refuses a domain that is a pattern rather than a literal hostname, naming the domain', () => {
		const capabilities = createZeropsNamespaceCapabilities(options(freshState()))

		expect(() => capabilities.registrationResourceClaims(proxyRegistration('*.apps.example.com'))).toThrow('*.apps.example.com')
		expect(() => capabilities.registrationResourceClaims(proxyRegistration('*.apps.example.com'))).toThrow('is not a literal hostname')
		expect(() => capabilities.registrationResourceClaims(proxyRegistration('notes.example.com:8080'))).toThrow('is not a literal hostname')
	})

	test('claims the app services once a domain is given', () => {
		const capabilities = createZeropsNamespaceCapabilities(options(freshState()))

		expect(capabilities.registrationResourceClaims(proxyRegistration('proxy-2ec8-8080.prg1.zerops.app'))).toEqual(['service:notesapi'])
	})
})

describe('Zerops namespace failure classes', () => {
	const failure = async (promise: Promise<unknown>): Promise<ProviderNamespaceError> => {
		try {
			await promise
		} catch (cause) {
			if (cause instanceof ProviderNamespaceError) return cause
			throw cause
		}
		throw new Error('expected the namespace mutation to fail')
	}

	const provisionNamespace = (publicAccess: 'custom-domain' | 'zerops-subdomain' = 'custom-domain'): ProviderDeploymentNamespace =>
		namespace(zeropsNamespacePreset({
			proxySource: PIN,
			preset: 'mid',
			env: 'prod',
			projectName: 'apps-prod',
			publicAccess,
		}))

	test('keeps the platform code and the platform message apart on a denied project import', async () => {
		const state = freshState()
		// The real shape `apiError` composes: our label and status, then the platform's code AGAIN, then its message.
		state.importProjectError = new ZeropsApiError(
			'zerops: project import failed (403) — insufficientPermissions: client client-1 may not create projects with token px_denied_integration_token',
			403,
			'insufficientPermissions',
		)
		const capabilities = createZeropsNamespaceCapabilities(options(state))

		const error = await failure(run(capabilities, provisionNamespace(), []))

		expect(error.code).toBe('insufficientPermissions')
		expect(error.retryable).toBe(false)
		expect(error.message).toBe('zerops: project import failed (403)')
		expect(error.message).not.toContain('px_denied_integration_token')
		// The code travels in `code`; repeating it in the detail would say the same thing twice.
		expect(error.detail).toBe('client client-1 may not create projects with token px_denied_integration_token')
	})

	test('reports a refused service-variable write as a validation failure, not as the import above', async () => {
		const state = freshState()
		state.serviceEnvError = new ZeropsApiError(
			'zerops: update service env failed (400) — invalidUserInput: content is not a valid value',
			400,
			'invalidUserInput',
		)
		const capabilities = createZeropsNamespaceCapabilities(options(state))

		const error = await failure(run(capabilities, provisionNamespace(), []))

		expect(error.code).toBe('invalidUserInput')
		expect(error.retryable).toBe(false)
		expect(error.message).toBe('zerops: update service env failed (400)')
		expect(error.detail).toBe('content is not a valid value')
	})

	test('yields no detail when the call redacted the platform message and sent only its code', async () => {
		const state = freshState()
		// What `redactDetail: true` produces: the code, and nothing of the server's message.
		state.serviceEnvError = new ZeropsApiError('zerops: update service env failed (400) — invalidUserInput', 400, 'invalidUserInput')
		const capabilities = createZeropsNamespaceCapabilities(options(state))

		const error = await failure(run(capabilities, provisionNamespace(), []))

		expect(error.code).toBe('invalidUserInput')
		expect(error.message).toBe('zerops: update service env failed (400)')
		expect(error.detail).toBeUndefined()
	})

	test('names the missing HTTP port with the platform code the subdomain call answered', async () => {
		const state = freshState()
		state.subdomainNotHttpAnswers = Number.POSITIVE_INFINITY
		const capabilities = createZeropsNamespaceCapabilities(options(state))

		const error = await failure(run(capabilities, provisionNamespace('zerops-subdomain'), []))

		expect(error.code).toBe(ZEROPS_SERVICE_NOT_HTTP)
		expect(error.message).toContain('no deployed HTTP port')
		expect(error.detail).toBeUndefined()
	})

	test('distinguishes a subdomain that never publishes from one the platform refused outright', async () => {
		const state = freshState()
		state.subdomainStaysDisabled = true
		const capabilities = createZeropsNamespaceCapabilities(options(state))

		const error = await failure(run(capabilities, provisionNamespace('zerops-subdomain'), []))

		expect(error.code).toBe(ZEROPS_SUBDOMAIN_NOT_PUBLISHED)
		expect(error.retryable).toBe(true)
		expect(error.message).toContain('no public entry point')
	})

	test('passes a typed error raised by the CALLER through untouched', async () => {
		// Core's own checkpoint invariants are raised inside `events.checkpoint`, which runs in the middle of
		// this lifecycle. They already carry core's code, and re-coding them as a Zerops failure would report
		// core's bug under the platform's vocabulary.
		const state = freshState()
		const capabilities = createZeropsNamespaceCapabilities(options(state))
		const raised = new ProviderNamespaceError('deployment namespace disappeared during checkpoint', 'checkpointInvariant', false)

		const error = await failure(capabilities.provision({
			namespace: provisionNamespace(),
			members: [],
			signal: new AbortController().signal,
			events: {
				checkpoint: () => Promise.reject(raised),
				boundary: async () => {},
			},
		}))

		expect(error).toBe(raised)
		expect(error.code).toBe('checkpointInvariant')
	})

	test('codes an unclassified lifecycle invariant without losing what it said', async () => {
		const state = freshState()
		state.projects.set(projectId, project(projectId, 'apps-prod', 'operator project'))
		state.services.set(projectId, [proxy()])
		const capabilities = createZeropsNamespaceCapabilities(options(state))

		const error = await failure(run(
			capabilities,
			namespace({
				projectId,
				projectName: 'apps-prod',
				corePackage: 'SERIOUS',
				publicAccess: 'custom-domain',
				managed: true,
			}),
			[],
		))

		expect(error.code).toBe(ZEROPS_NAMESPACE_LIFECYCLE)
		expect(error.message).toContain('different Fabrika ownership marker')
	})

	test('marks a platform outage retryable and a refusal not', async () => {
		const outage = freshState()
		outage.importProjectError = new ZeropsApiError('zerops: project import failed (503)', 503, '')
		const capabilities = createZeropsNamespaceCapabilities(options(outage))

		const error = await failure(run(capabilities, provisionNamespace(), []))

		expect(error.code).toBe('zeropsHttp503')
		expect(error.retryable).toBe(true)
	})

	test("a GitHub rate limit on the proxy source is retryable and keeps the source's message", async () => {
		const state = freshState()
		const base = options(state)
		const source = base.source
		if (source === undefined) throw new Error('source missing')
		const message = 'GitHub rate limit for anonymous reads reached; resets at 2026-10-15T21:00:00.000Z; connect the GitHub App to avoid it'
		const capabilities = createZeropsNamespaceCapabilities({
			...base,
			source: { ...source, resolve: () => Promise.reject(new ZeropsSourceRateLimitedError(message)) },
		})

		const error = await failure(run(capabilities, provisionNamespace(), []))

		expect(error.code).toBe(ZEROPS_SOURCE_RATE_LIMITED)
		expect(error.message).toBe(message)
		expect(error.retryable).toBe(true)
	})
})

describe('Zerops namespace update', () => {
	const cheapTarget = (): ZeropsNamespaceTarget =>
		zeropsNamespacePreset({
			proxySource: PIN,
			preset: 'cheap',
			env: 'prod',
			projectName: 'cheap-prod',
		})

	const provisioned = async (state: FakeState): Promise<ProviderDeploymentNamespace> =>
		run(createZeropsNamespaceCapabilities(options(state)), namespace(cheapTarget(), { id: 'cheap-prod' }), [])

	const requested = (payload: JsonValue) => ({ provider: 'zerops', version: zeropsNamespaceTargetCodec.version, payload })

	const toProduction = requested({ postgres: { type: 'postgresql:single@18', profile: 'oltp-production' } })

	const updates = (state: FakeState) => {
		const found = createZeropsNamespaceCapabilities(options(state)).updates
		if (found === undefined) throw new Error('the Zerops provider must offer namespace updates')
		return found
	}

	const update = (state: FakeState, current: ProviderDeploymentNamespace, target = toProduction) => {
		const plan = updates(state).plan(current, target)
		return updates(state).apply({ namespace: current, next: plan.namespace, signal: new AbortController().signal })
	}

	const liveService = (state: FakeState): ZeropsService => {
		const found = (state.services.get(projectId) ?? []).find((service) => service.id === postgresId)
		if (found === undefined) throw new Error('missing postgres')
		return found
	}

	const failure = async (promise: Promise<unknown>): Promise<ProviderNamespaceError> => {
		const error = await promise.then(() => null, (cause: unknown) => cause)
		if (!(error instanceof ProviderNamespaceError)) throw new Error('expected a ProviderNamespaceError')
		return error
	}

	const autoscalingCalls = (state: FakeState): string[] => state.calls.filter((call) => call.startsWith('autoscaling:'))

	describe('re-pinning the proxy source', () => {
		const LEGACY: ZeropsNamespaceProxySource = { ...PIN, commitSha: 'c'.repeat(40) }
		const pinnedTo = (current: ProviderDeploymentNamespace, source: ZeropsNamespaceProxySource): ProviderDeploymentNamespace => ({
			...current,
			target: envelope({ ...zeropsNamespaceTargetCodec.decode(current.target.payload), proxySource: source }),
		})
		const toCurrent = requested({ proxySource: 'current' })

		test('moves the pin to the installation default, touching no platform resource', async () => {
			const state = freshState()
			const legacy = pinnedTo(await provisioned(state), LEGACY)
			state.calls.length = 0

			const plan = updates(state).plan(legacy, toCurrent)
			const result = await updates(state).apply({ namespace: legacy, next: plan.namespace, signal: new AbortController().signal })

			expect(plan.change).toEqual({ field: 'proxySource', from: LEGACY.commitSha, to: PIN.commitSha })
			expect(zeropsNamespaceTargetCodec.decode(result.target.payload)).toEqual({
				...zeropsNamespaceTargetCodec.decode(legacy.target.payload),
				proxySource: PIN,
			})
			expect(state.calls).toEqual([])
		})

		test('is a no-op on a namespace already pinned to the default', async () => {
			const state = freshState()
			expect(updates(state).plan(await provisioned(state), toCurrent).change).toBeNull()
		})

		test('refuses any pin but the installation default, and a pin together with a profile', async () => {
			const state = freshState()
			const legacy = pinnedTo(await provisioned(state), LEGACY)
			const other = { ...PIN, commitSha: 'd'.repeat(40) }
			const otherPayload = { repository: { ...other.repository }, commitSha: other.commitSha, descriptor: { ...other.descriptor } }
			expect(() => updates(state).plan(legacy, requested({ proxySource: otherPayload }))).toThrow("only to the installation's default")
			expect(() =>
				updates(state).plan(legacy, requested({ proxySource: 'current', postgres: { type: 'postgresql:single@18', profile: 'oltp-production' } }))
			)
				.toThrow('separate updates')
		})

		test('refuses while a proxy build is in flight', async () => {
			const state = freshState()
			const current = await provisioned(state)
			const building = {
				...current,
				target: envelope({
					...zeropsNamespaceTargetCodec.decode(current.target.payload),
					proxySource: LEGACY,
					proxyBuild: { appVersionId: 'v9', triggered: true },
				}),
			}
			expect(() => updates(state).plan(building, toCurrent)).toThrow('proxy build in flight')
		})
	})

	test('plans a partial target by merging it over the stored one', async () => {
		const state = freshState()
		const current = await provisioned(state)

		const plan = updates(state).plan(current, toProduction)

		expect(plan.change).toEqual({ field: 'postgres.profile', from: 'oltp-hobby', to: 'oltp-production' })
		expect(zeropsNamespaceTargetCodec.decode(plan.namespace.target.payload)).toEqual({
			...zeropsNamespaceTargetCodec.decode(current.target.payload),
			postgres: { type: 'postgresql:single@18', profile: 'oltp-production' },
		})
		expect(updates(state).plan(current, current.target).change).toBeNull()
	})

	test('moves the live PostgreSQL service through the autoscaling endpoint and returns the planned target', async () => {
		const state = freshState()
		const current = await provisioned(state)
		const importsBefore = state.calls.filter((call) => call.startsWith('import')).length

		const result = await update(state, current)

		expect(zeropsNamespaceTargetCodec.decode(result.target.payload)).toMatchObject({
			postgres: { type: 'postgresql:single@18', profile: 'oltp-production' },
			postgresServiceId: postgresId,
			ready: true,
		})
		expect(liveService(state).autoscalingProfileId).toBe('oltp-production')
		expect(autoscalingCalls(state)).toEqual([`autoscaling:${postgresId}:oltp-production`])
		// Never a re-import: the platform silently ignores a changed profile there.
		expect(state.calls.filter((call) => call.startsWith('import')).length).toBe(importsBefore)
		// The stored result and the live service agree, so a reconcile of it passes the profile check.
		await run(createZeropsNamespaceCapabilities(options(state)), result, [], 'reconcile')
	})

	test('refuses a PostgreSQL type change in the plan, before anything is called', async () => {
		const state = freshState()
		const current = await provisioned(state)
		const callsBefore = state.calls.length

		const error = await failure(
			Promise.resolve().then(() => updates(state).plan(current, requested({ postgres: { type: 'postgresql:ha@18', profile: 'oltp-production' } }))),
		)

		expect(error.code).toBe(PROVIDER_NAMESPACE_IMMUTABLE)
		expect(error.message).toContain('from postgresql:single@18 to postgresql:ha@18')
		expect(state.calls.length).toBe(callsBefore)
	})

	test('names every other changed field and refuses it', async () => {
		const state = freshState()
		const current = await provisioned(state)

		expect(() => updates(state).plan(current, requested({ publicAccess: 'zerops-subdomain', corePackage: 'SERIOUS' }))).toThrow(
			'cannot change corePackage, publicAccess in place',
		)
		expect(() => updates(state).plan(current, requested({ postgres: { type: 'postgresql:single@18' } }))).toThrow('platform default profile')
	})

	test('refuses a payload that is not an object or does not decode', async () => {
		const state = freshState()
		const current = await provisioned(state)

		expect(() => updates(state).plan(current, requested(['postgres']))).toThrow('payload must be an object')
		expect(() => updates(state).plan(current, requested({ postgres: { type: 'postgresql:single@18', profile: 'oltp-enterprise' } }))).toThrow(
			'field postgres.profile is invalid',
		)
	})

	test('refuses a misspelt or unsupported field instead of dropping it', async () => {
		const state = freshState()
		const current = await provisioned(state)

		expect(() => updates(state).plan(current, requested({ corePakage: 'SERIOUS' }))).toThrow('field corePakage is not a namespace target field')
		expect(() => updates(state).plan(current, requested({ postgres: { type: 'postgresql:single@18', profile: 'oltp-production', maxContainers: 3 } })))
			.toThrow('field postgres.maxContainers is not a namespace target field')
		expect(autoscalingCalls(state)).toEqual([])
	})

	test('refuses to move a live service that already disagrees with what the namespace declares', async () => {
		const state = freshState()
		const current = await provisioned(state)
		liveService(state).autoscalingProfileId = 'oltp-staging'

		const error = await failure(update(state, current))

		expect(error.code).not.toBe(PROVIDER_NAMESPACE_UPDATE_UNCONFIRMED)
		expect(error.message).toContain('uses profile oltp-staging, but its namespace declares oltp-hobby')
		expect(autoscalingCalls(state)).toEqual([])
	})

	test('a platform refusal of the PUT is definite, not unconfirmed', async () => {
		const state = freshState()
		const current = await provisioned(state)
		state.autoscalingRefused = true

		const error = await failure(update(state, current))

		expect(error.code).toBe('invalidUserInput')
		expect(liveService(state).autoscalingProfileId).toBe('oltp-hobby')
	})

	test('a lost process after an accepted PUT is unconfirmed, and applying the same plan again converges', async () => {
		const state = freshState()
		const current = await provisioned(state)
		state.autoscalingProcessLost = true

		const error = await failure(update(state, current))

		expect(error.code).toBe(PROVIDER_NAMESPACE_UPDATE_UNCONFIRMED)
		expect(error.retryable).toBe(true)
		expect(liveService(state).autoscalingProfileId).toBe('oltp-production')

		// The stored target still declares the old profile; the live service is the change in progress.
		const result = await update(state, current)

		expect(zeropsNamespaceTargetCodec.decode(result.target.payload).postgres?.profile).toBe('oltp-production')
		expect(autoscalingCalls(state)).toHaveLength(1)
	})

	test('a retry that names the unconfirmed target reads a live service already on it as the change in progress', async () => {
		const state = freshState()
		const current = await provisioned(state)
		const planned = updates(state).plan(current, toProduction).namespace
		liveService(state).autoscalingProfileId = 'oltp-staging'

		// Neither the declared nor the unconfirmed profile: drift, refused before the PUT.
		const drift = await failure(
			updates(state).apply({ namespace: current, next: current, unconfirmed: planned, signal: new AbortController().signal }),
		)
		expect(drift.message).toContain('uses profile oltp-staging, but its namespace declares oltp-hobby')

		liveService(state).autoscalingProfileId = 'oltp-production'
		const back = await updates(state).apply({ namespace: current, next: current, unconfirmed: planned, signal: new AbortController().signal })

		expect(zeropsNamespaceTargetCodec.decode(back.target.payload).postgres?.profile).toBe('oltp-hobby')
		expect(liveService(state).autoscalingProfileId).toBe('oltp-hobby')
		expect(autoscalingCalls(state)).toEqual([`autoscaling:${postgresId}:oltp-hobby`])
	})

	test('a profile the platform accepts but never reads back is unconfirmed', async () => {
		const state = freshState()
		const current = await provisioned(state)
		state.autoscalingIgnored = true

		const error = await failure(update(state, current))

		expect(error.code).toBe(PROVIDER_NAMESPACE_UPDATE_UNCONFIRMED)
		expect(error.detail).toContain('still reads oltp-hobby')
	})
})
