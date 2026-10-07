import type {
	ControlProvider,
	JsonValue,
	ProviderApp,
	ProviderCodec,
	ProviderDeployInput,
	ProviderDeploymentNamespace,
	ProviderDeployOutcome,
	ProviderEnvelope,
	ProviderEnvironment,
	ProviderReconcileInput,
	ProviderReconcileOutcome,
	ProviderRegistration,
	ProviderRegistrationInput,
	ProviderSourceBinding,
	ProviderSourceResolution,
	ProviderSourceResolutionInput,
	SchemaReconciler,
} from '@fabrika/provider-contract'
import { decodeEnvelope, ProviderSecretError } from '@fabrika/provider-contract'
import { z } from 'zod'
import { createZeropsApi, waitForProcess, ZEROPS_ACTIVE, ZEROPS_TERMINAL, type ZeropsApi, type ZeropsAppVersion, type ZeropsProcess } from './api'
import { defaultSleep, defaultZeropsCollaborators, type Sleeper } from './collaborators'
import { prepareZeropsDescriptor } from './descriptor'
import { admitManagedEnvironment, confirmCodelessManagedService, confirmStagedManagedBinding } from './managed-environment/admission'
import { assertAuthoredManagedInputs, assertAuthoredManagedName, assertNoManagedReferences } from './managed-environment/authored'
import { cleanupManagedReservation, isAbsentManagedVersion } from './managed-environment/cleanup'
import { prepareManagedDescriptor } from './managed-environment/descriptor'
import {
	type ConfirmedManagedBinding,
	encodeManagedCheckpoint,
	MANAGED_ENVIRONMENT_MARKER,
	type ManagedOwner,
	parseManagedMarker,
	parseManagedValues,
	verifyManagedCheckpoint,
} from './managed-environment/protocol'
import { createManagedMarker } from './managed-environment/staging'
import {
	assertFabrikaManifestCoordinates,
	type FabrikaManifest,
	hashFabrikaManifest,
	manifestServiceHostnames,
	renderFabrikaImportYaml,
	renderFabrikaProvisioningYaml,
	verifyZeropsArtifactSourceDescriptor,
	zeropsArtifactCodec,
} from './manifest'
import {
	createZeropsNamespaceCapabilities,
	verifyZeropsNamespaceProxySource,
	type ZeropsNamespaceProxySource,
	type ZeropsNamespaceTarget,
	zeropsNamespaceTargetCodec,
} from './namespace'
import { createZeropsDeployer } from './provider'
import { allowedReferenceHosts, foreignReferenceHost, serviceReferenceHosts } from './service-references'
import {
	normalizeZeropsSourceRepository,
	type ZeropsSourceClient,
	type ZeropsSourceClientV2,
	type ZeropsSourcePrivateBindingV2,
	type ZeropsSourceResolveResult,
} from './source'
import type { ZeropsRunState, ZeropsRuntimeTarget } from './types'

/** Provider coordinates that are safe to persist. Credentials are composed only for a live run. */
export interface ZeropsStoredTarget {
	serviceId: string
}

const storedTargetSchema = z.object({ serviceId: z.string().min(1) })

export const zeropsStoredTargetCodec: ProviderCodec<ZeropsStoredTarget> = {
	version: 2,
	encode: (target) => ({ serviceId: target.serviceId }),
	decode: (payload) => {
		const result = storedTargetSchema.safeParse(payload)
		if (!result.success) throw new Error('Zerops stored target serviceId must be a non-empty string')
		return result.data
	},
}

const envelope = <T>(codec: ProviderCodec<T>, value: T): ProviderEnvelope => ({
	provider: 'zerops',
	version: codec.version,
	payload: codec.encode(value),
})

export interface ZeropsBeforeDeployInput {
	readonly appId: string
	readonly env: string
	readonly namespaceId: string
	readonly target: ZeropsStoredTarget & {
		readonly projectId: string
		readonly proxyServiceId: string
		readonly proxySource: ZeropsNamespaceProxySource
	}
	readonly artifact: FabrikaManifest
	readonly api: ZeropsApi
	readonly signal: AbortSignal
}

export type ZeropsBeforeDeploy = (input: ZeropsBeforeDeployInput) => Promise<void>

export interface ZeropsControlProviderOptions {
	readonly accessToken: string
	readonly apiBaseUrl?: string
	readonly propustkaUrl?: string
	readonly adminKey?: string
	readonly api?: ZeropsApi
	readonly source: ZeropsSourceClient & Partial<ZeropsSourceClientV2>
	readonly reconcileSchema?: SchemaReconciler
	readonly sleep?: Sleeper
	readonly sourceCancelSleep?: Sleeper
	readonly beforeDeploy?: ZeropsBeforeDeploy
	readonly namespaces?: {
		readonly clientId: string
		readonly proxySource?: ZeropsNamespaceProxySource
		readonly proxyBuildFromGit?: string
		readonly proxyManifest?: (namespaceId: string) => Promise<string>
		readonly iamUrl: string
		readonly iamKey: string
	}
}

interface DecodedZeropsEnvironment {
	readonly target: ZeropsStoredTarget
	readonly namespace: ProviderDeploymentNamespace
	readonly namespaceTarget: ZeropsNamespaceTarget
}

const decodeEnvironment = (environment: ProviderEnvironment): DecodedZeropsEnvironment => {
	const target = decodeEnvelope('target', 'zerops', environment.target, zeropsStoredTargetCodec)
	const placement = decodeNamespace(environment)
	return {
		target,
		...placement,
	}
}

const decodeNamespace = (
	environment: ProviderEnvironment,
): Pick<DecodedZeropsEnvironment, 'namespace' | 'namespaceTarget'> => {
	const namespace = environment.namespace
	if (namespace === undefined) {
		throw new Error('Zerops environment requires a deployment namespace')
	}
	if (namespace.id === '' || namespace.env !== environment.env) {
		throw new Error('Zerops deployment namespace has different environment coordinates')
	}
	if (namespace.exclusiveAppId !== undefined && namespace.exclusiveAppId !== environment.appId) {
		throw new Error(`Zerops deployment namespace is exclusive to app \`${namespace.exclusiveAppId}\``)
	}
	return {
		namespace,
		namespaceTarget: decodeEnvelope('namespace target', 'zerops', namespace.target, zeropsNamespaceTargetCodec),
	}
}

const resolvedEnvironment = (
	environment: ProviderEnvironment,
	options: { requireReady: boolean },
): DecodedZeropsEnvironment & { projectId: string; proxyServiceId?: string; proxySource?: ZeropsNamespaceProxySource } => {
	const decoded = decodeEnvironment(environment)
	const projectId = decoded.namespaceTarget.projectId
	if (projectId === undefined) {
		throw new Error(`Zerops deployment namespace \`${decoded.namespace.id}\` has no project id`)
	}
	if (options.requireReady && decoded.namespaceTarget.ready !== true) {
		throw new Error(`Zerops deployment namespace \`${decoded.namespace.id}\` is not ready`)
	}
	const proxyServiceId = decoded.namespaceTarget.proxyServiceId
	if (options.requireReady && proxyServiceId === undefined) {
		throw new Error(`Zerops deployment namespace \`${decoded.namespace.id}\` has no proxy service id`)
	}
	const proxySource = decoded.namespaceTarget.proxySource
	if (options.requireReady && proxySource === undefined) {
		throw new Error(`Zerops deployment namespace \`${decoded.namespace.id}\` is unpinned; explicit migration is required`)
	}
	return {
		...decoded,
		projectId,
		...(proxyServiceId === undefined ? {} : { proxyServiceId }),
		...(proxySource === undefined ? {} : { proxySource }),
	}
}

const assertEnvironmentOfApp = (app: ProviderApp, environment: ProviderEnvironment): void => {
	if (app.id !== environment.appId) {
		throw new Error(`Zerops environment belongs to app \`${environment.appId}\`, expected \`${app.id}\``)
	}
}

const normalizeRegistration = (input: ProviderRegistrationInput): ProviderRegistration => {
	assertEnvironmentOfApp(input.app, input.environment)
	const decoded = decodeEnvironment(input.environment)
	const artifact = decodeEnvelope('artifact', 'zerops', input.environment.artifact, zeropsArtifactCodec)
	assertFabrikaManifestCoordinates(artifact.app, { appId: input.app.id, env: input.environment.env })
	return {
		app: input.app,
		environment: {
			...input.environment,
			namespace: {
				...decoded.namespace,
				target: envelope(zeropsNamespaceTargetCodec, decoded.namespaceTarget),
			},
			target: envelope(zeropsStoredTargetCodec, decoded.target),
			artifact: envelope(zeropsArtifactCodec, artifact),
		},
	}
}

const abortSignal = (): AbortSignal => new AbortController().signal

/** Every private Zerops source names its keyed connection; an installation id alone selects no credential (ADR-0029). */
const privateBinding = (binding: ProviderSourceBinding | undefined): ZeropsSourcePrivateBindingV2 | undefined => {
	if (binding === undefined) return undefined
	if (binding.connectionId === undefined) throw new Error('Zerops private source requires a connection binding')
	return { connectionId: binding.connectionId, installationId: binding.installationId }
}

const IMMUTABLE_GIT_OBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/

const parseRunState = async (
	input: { providerState?: JsonValue; externalId: string; runId: string; environment: ProviderEnvironment },
): Promise<ZeropsRunState> => {
	const state = await verifyManagedCheckpoint(input.providerState)
	if (
		state.appVersionId !== input.externalId || state.runId !== input.runId || state.appId !== input.environment.appId
		|| state.environment !== input.environment.env
	) {
		throw new Error('Zerops managed checkpoint has different run coordinates')
	}
	return state
}

/** Build the complete Zerops lifecycle bundle without importing control-plane persistence. */
export const createZeropsControlProvider = (options: ZeropsControlProviderOptions): ControlProvider => {
	if (options.accessToken === '') {
		throw new Error('Zerops access token must be a non-empty string')
	}
	const api = options.api ?? createZeropsApi({ token: options.accessToken, baseUrl: options.apiBaseUrl })
	const getVersion = async (input: { appVersionId: string; signal: AbortSignal }): Promise<ZeropsAppVersion | null> => {
		input.signal.throwIfAborted()
		try {
			return await api.getAppVersion(input)
		} catch (error) {
			input.signal.throwIfAborted()
			if (!isAbsentManagedVersion(error)) throw error
			return null
		}
	}
	const deployRun = createZeropsDeployer((target) => {
		const defaults = defaultZeropsCollaborators(target)
		return {
			api,
			source: options.source,
			...(options.sourceCancelSleep === undefined ? {} : { sourceCancelSleep: options.sourceCancelSleep }),
			reconcileSchema: options.reconcileSchema ?? defaults.reconcileSchema,
			sleep: options.sleep ?? defaultSleep,
		}
	}, {
		uploadV2: async (input) => {
			const uploadV2 = options.source.uploadV2
			if (uploadV2 === undefined) throw new Error('Zerops keyed source transport is unavailable')
			return uploadV2.call(options.source, input)
		},
	})
	const namespaceCapabilities = options.namespaces === undefined
		? undefined
		: createZeropsNamespaceCapabilities({
			...options.namespaces,
			source: options.source,
			api,
			...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
		})

	const artifactFor = (environment: ProviderEnvironment): FabrikaManifest => {
		const artifact = decodeEnvelope('artifact', 'zerops', environment.artifact, zeropsArtifactCodec)
		assertFabrikaManifestCoordinates(artifact.app, { appId: environment.appId, env: environment.env })
		return artifact
	}

	const ownerFor = (environment: ProviderEnvironment, artifact: FabrikaManifest, serviceId: string): ManagedOwner => {
		const { namespace, namespaceTarget } = decodeNamespace(environment)
		if (namespaceTarget.projectId === undefined) throw new Error('Zerops managed environment requires a project')
		return {
			protocol: 1,
			appId: environment.appId,
			environment: environment.env,
			namespaceId: namespace.id,
			projectId: namespaceTarget.projectId,
			serviceId,
			hostname: artifact.target.deployService,
		}
	}
	const admit = async (
		owner: ManagedOwner,
		signal: AbortSignal,
		readRetainedCheckpoint?: (id: string) => Promise<JsonValue | null>,
	): Promise<{ markerRecordId: string; binding: ConfirmedManagedBinding }> => {
		signal.throwIfAborted()
		const service = await api.getService({ serviceId: owner.serviceId, signal })
		if (service.id !== owner.serviceId || service.projectId !== owner.projectId || service.name !== owner.hostname || !service.activeAppVersionId) {
			throw new Error('Zerops managed service has missing or different coordinates')
		}
		signal.throwIfAborted()
		const records = await api.listServiceEnv({ serviceId: owner.serviceId, signal })
		const record = records.find((entry) => entry.key === MANAGED_ENVIRONMENT_MARKER)
		if (record === undefined) throw new Error('Zerops legacy service has no managed-environment ownership marker')
		const marker = parseManagedMarker(record.content)
		if (service.activeAppVersionId === marker.initialCodelessAppVersionId) {
			return admitManagedEnvironment({ owner, records, observedActiveAppVersionId: service.activeAppVersionId, prior: { kind: 'bootstrap' } })
		}
		if (readRetainedCheckpoint === undefined) throw new Error('Zerops managed deployment requires exact retained checkpoint lookup')
		signal.throwIfAborted()
		const checkpoint = await readRetainedCheckpoint(service.activeAppVersionId)
		signal.throwIfAborted()
		if (checkpoint === null) throw new Error('Zerops active version has no retained owned binding')
		return admitManagedEnvironment({ owner, records, observedActiveAppVersionId: service.activeAppVersionId, prior: { kind: 'retained', checkpoint } })
	}
	const originalArtifact = async (environment: ProviderEnvironment, state: ZeropsRunState): Promise<FabrikaManifest> => {
		const artifact = artifactFor(environment)
		const placement = resolvedEnvironment(environment, { requireReady: false })
		if (
			placement.target.serviceId !== state.serviceId || placement.projectId !== state.projectId || placement.namespace.id !== state.namespaceId
			|| artifact.target.deployService !== state.hostname || artifact.target.sourceDescriptor.sha256 !== state.descriptorSha256
			|| await hashFabrikaManifest(artifact) !== state.originalArtifactSha256
		) throw new Error('Zerops recovery artifact identity changed')
		await verifyZeropsArtifactSourceDescriptor(artifact.target.sourceDescriptor)
		if (prepareZeropsDescriptor(artifact.target.sourceDescriptor.contents, artifact.target.zeropsSetup).setup !== state.setup) {
			throw new Error('Zerops recovery setup changed')
		}
		return artifact
	}
	const cleanup = (state: ZeropsRunState, signal: AbortSignal): Promise<boolean> =>
		cleanupManagedReservation({
			api,
			source: options.source,
			runId: state.runId,
			appVersionId: state.appVersionId,
			signal,
			sleep: options.sourceCancelSleep ?? defaultSleep,
		})

	/**
	 * A variable written through the env API resolves `${host_KEY}` at container start like `run.envVariables`
	 * does, across services whatever `envIsolation` says — so an unchecked secret reads the proxy's key.
	 */
	const assertOwnReferencesOnly = (environment: ProviderEnvironment, name: string, value: string): void => {
		// A secret naming no service at all must not start failing on an artifact that no longer parses.
		if (serviceReferenceHosts(name).length === 0 && serviceReferenceHosts(value).length === 0) return
		const allowed = allowedReferenceHosts(manifestServiceHostnames(artifactFor(environment)))
		const foreign = foreignReferenceHost(name, allowed) ?? foreignReferenceHost(value, allowed)
		if (foreign !== null) {
			throw new ProviderSecretError(`zerops: secret \`${name}\` references service \`${foreign}\`, which this app does not own`, 'foreignReference')
		}
	}

	const reconcileActiveSchema = async (
		input: ProviderReconcileInput,
		state: ZeropsRunState,
		artifact: FabrikaManifest,
		signal: AbortSignal,
	): Promise<void> => {
		if (artifact.app.schema === undefined || options.propustkaUrl === undefined) return
		const runtimeTarget: ZeropsRuntimeTarget = {
			projectId: state.projectId,
			serviceId: state.serviceId,
			accessToken: options.accessToken,
			...(options.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
			propustkaUrl: options.propustkaUrl,
			...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
		}
		const reconcileSchema = options.reconcileSchema ?? defaultZeropsCollaborators(runtimeTarget).reconcileSchema
		signal.throwIfAborted()
		await reconcileSchema({
			url: options.propustkaUrl,
			app: artifact.app.id,
			schema: artifact.app.schema,
			...(input.returnOrigins === undefined || input.returnOrigins.length === 0 ? {} : { returnOrigins: input.returnOrigins }),
			adminKey: options.adminKey,
			signal,
		})
	}

	const reconcileTriggered = async (
		input: ProviderReconcileInput,
		state: ZeropsRunState,
		signal: AbortSignal,
	): Promise<ProviderReconcileOutcome> => {
		signal.throwIfAborted()
		let version: ZeropsAppVersion | null
		try {
			version = await getVersion({ appVersionId: state.appVersionId, signal })
		} catch {
			signal.throwIfAborted()
			return { state: 'running' }
		}
		if (version === null) return { state: 'failed' }
		if (version.id !== state.appVersionId || (version.serviceStackId !== undefined && version.serviceStackId !== state.serviceId)) {
			throw new Error('Zerops app-version response has different coordinates')
		}
		if (version.status === ZEROPS_ACTIVE) {
			let artifact: FabrikaManifest
			try {
				artifact = await originalArtifact(input.environment, state)
			} catch {
				signal.throwIfAborted()
				return { state: 'failed' }
			}
			await reconcileActiveSchema(input, state, artifact, signal)
			return { state: 'succeeded' }
		}
		if (version.status !== undefined && ZEROPS_TERMINAL.has(version.status)) return { state: 'failed' }
		return { state: 'running' }
	}

	const resolveSource = async (input: ProviderSourceResolutionInput): Promise<ProviderSourceResolution> => {
		const binding = privateBinding(input.sourceBinding)
		assertEnvironmentOfApp(input.app, input.environment)
		decodeEnvironment(input.environment)
		const artifact = artifactFor(input.environment)
		await verifyZeropsArtifactSourceDescriptor(artifact.target.sourceDescriptor)
		const base = {
			runId: input.runId,
			repository: normalizeZeropsSourceRepository(input.app.source.repoUrl),
			requestedRef: input.app.source.ref,
			...(input.expectedCommitSha === undefined ? {} : { expectedCommitSha: input.expectedCommitSha }),
			descriptorSha256: artifact.target.sourceDescriptor.sha256,
			signal: input.signal,
		}
		let result: ZeropsSourceResolveResult
		if (binding === undefined) {
			result = await options.source.resolve(base)
		} else {
			const resolveV2 = options.source.resolveV2
			if (resolveV2 === undefined) throw new Error('Zerops keyed source transport is unavailable')
			result = await resolveV2.call(options.source, {
				...base,
				privateBinding: binding,
			})
		}
		if (
			result.runId !== input.runId
			|| result.descriptorSha256 !== artifact.target.sourceDescriptor.sha256
			|| (input.expectedCommitSha !== undefined && result.commitSha !== input.expectedCommitSha)
		) throw new Error('Zerops source resolution returned different coordinates')
		return { commitSha: result.commitSha }
	}

	const controlProvider: ControlProvider = {
		id: 'zerops',
		normalizeRegistration,
		source: { binding: 'connection' },
		/**
		 * A Zerops artifact IS the compiled manifest, so the declaration is right here and core can refuse
		 * a variable this app would never read. An artifact that will not decode answers `undefined`
		 * rather than an empty set: a broken envelope is a registration problem, and reporting it as an
		 * undeclared variable would point the operator at the wrong thing.
		 */
		declaredVariables: ({ artifact }) => {
			try {
				return decodeEnvelope('artifact', 'zerops', artifact, zeropsArtifactCodec).app.pipeline.vars
			} catch {
				return undefined
			}
		},
		resolveSource,
		deploy: async (input: ProviderDeployInput): Promise<ProviderDeployOutcome> => {
			input.signal.throwIfAborted()
			assertAuthoredManagedInputs({
				variableNames: Object.keys(input.vars),
				secretNames: Object.keys(input.secrets),
				variableValues: input.vars,
				secretValues: input.secrets,
			})
			const managedEnvironment = parseManagedValues(input.managedEnvironment)
			const binding = privateBinding(input.sourceBinding)
			assertEnvironmentOfApp(input.app, input.environment)
			const placement = resolvedEnvironment(input.environment, { requireReady: true })
			const proxyServiceId = placement.proxyServiceId
			if (proxyServiceId === undefined) {
				throw new Error(`Zerops deployment namespace \`${placement.namespace.id}\` has no proxy service id`)
			}
			const proxySource = placement.proxySource
			if (proxySource === undefined) {
				throw new Error(`Zerops deployment namespace \`${placement.namespace.id}\` is unpinned; explicit migration is required`)
			}
			await verifyZeropsNamespaceProxySource(proxySource)
			const artifact = artifactFor(input.environment)
			await verifyZeropsArtifactSourceDescriptor(artifact.target.sourceDescriptor)
			let source: ZeropsRuntimeTarget['source']
			if (!input.dryRun) {
				if (!IMMUTABLE_GIT_OBJECT.test(input.app.source.ref)) {
					throw new Error('Zerops deploy source must be an exact lowercase Git object id')
				}
				source = {
					runId: input.runId,
					repository: normalizeZeropsSourceRepository(input.app.source.repoUrl),
					commitSha: input.app.source.ref,
					...(binding === undefined ? {} : { privateBinding: binding }),
				}
			}
			let managedAdmission: ZeropsRuntimeTarget['managedAdmission']
			if (!input.dryRun) {
				const owner = ownerFor(input.environment, artifact, placement.target.serviceId)
				const admitted = await admit(owner, input.signal, input.readRetainedCheckpoint)
				managedAdmission = { owner, markerRecordId: admitted.markerRecordId }
				input.signal.throwIfAborted()
				await options.beforeDeploy?.({
					appId: input.app.id,
					env: input.environment.env,
					namespaceId: placement.namespace.id,
					target: {
						serviceId: placement.target.serviceId,
						projectId: placement.projectId,
						proxyServiceId,
						proxySource,
					},
					// A clone: what the hook sees must not reach the import document or the artifact hash.
					artifact: structuredClone(artifact),
					api,
					signal: input.signal,
				})
			}
			const runtimeTarget: ZeropsRuntimeTarget = {
				projectId: placement.projectId,
				serviceId: placement.target.serviceId,
				accessToken: options.accessToken,
				...(managedAdmission === undefined ? {} : { managedAdmission }),
				...(source === undefined ? {} : { source }),
				...(options.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
				...(options.propustkaUrl !== undefined ? { propustkaUrl: options.propustkaUrl } : {}),
				...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
			}
			const accepted: { id?: string; state?: JsonValue } = {}
			const result = await deployRun({
				appId: input.app.id,
				env: input.environment.env,
				...(input.returnOrigins === undefined ? {} : { returnOrigins: input.returnOrigins }),
				secrets: input.secrets,
				vars: input.vars,
				managedEnvironment,
				target: runtimeTarget,
				artifact,
				dryRun: input.dryRun,
				signal: input.signal,
				events: {
					log: input.events.log,
					externalId: async (id, state) => {
						await input.events.externalId(id, state)
						accepted.id = id
						accepted.state = state
					},
					checkpoint: async (state) => {
						await input.events.checkpoint(state)
						accepted.state = state
					},
				},
			})
			input.signal.throwIfAborted()
			if (result.status === 'succeeded') return { state: 'succeeded' }
			if (accepted.id === undefined) return { state: 'failed' }
			try {
				const reconcile = controlProvider.reconcile
				if (reconcile === undefined) return { state: 'running' }
				return await reconcile({
					runId: input.runId,
					externalId: accepted.id,
					environment: input.environment,
					signal: input.signal,
					...(accepted.state === undefined ? {} : { providerState: accepted.state }),
					...(input.returnOrigins === undefined ? {} : { returnOrigins: input.returnOrigins }),
					checkpoint: input.events.checkpoint,
				})
			} catch {
				input.signal.throwIfAborted()
				return { state: 'running' }
			}
		},
		cancel: async (input) => {
			const signal = input.signal
			signal.throwIfAborted()
			const state = await parseRunState(input)
			if (state.phase === 'managed_env_staging' || state.phase === 'managed_env_staged' || state.phase === 'source_uploaded') {
				return { state: await cleanup(state, signal) ? 'settled' : 'pending' }
			}
			let version = await getVersion({ appVersionId: state.appVersionId, signal })
			if (version === null) return { state: 'settled' }
			if (version.id !== state.appVersionId) throw new Error('Zerops app-version response has different coordinates')
			if (version.status !== undefined && ZEROPS_TERMINAL.has(version.status)) return { state: 'settled' }
			if (version.status === undefined || version.status === 'UPLOADING') return { state: 'pending' }
			signal.throwIfAborted()
			await api.cancelBuild({ appVersionId: state.appVersionId, signal })
			version = await getVersion({ appVersionId: state.appVersionId, signal })
			if (version === null) return { state: 'settled' }
			if (version.id !== state.appVersionId) throw new Error('Zerops app-version response has different coordinates')
			return { state: version.status !== undefined && ZEROPS_TERMINAL.has(version.status) ? 'settled' : 'pending' }
		},
		reconcile: async (input): Promise<ProviderReconcileOutcome> => {
			const signal = input.signal
			signal.throwIfAborted()
			const state = await parseRunState(input)
			if (state.phase === 'managed_env_staging' || state.phase === 'managed_env_staged') {
				return { state: await cleanup(state, signal) ? 'failed' : 'running' }
			}
			if (state.phase === 'source_uploaded') {
				let artifact: FabrikaManifest
				try {
					artifact = await originalArtifact(input.environment, state)
					signal.throwIfAborted()
					confirmStagedManagedBinding(state, await api.listServiceEnv({ serviceId: state.serviceId, signal }))
				} catch {
					signal.throwIfAborted()
					return { state: await cleanup(state, signal) ? 'failed' : 'running' }
				}
				const requested: ZeropsRunState = { ...state, phase: 'build_trigger_requested' }
				try {
					signal.throwIfAborted()
					await input.checkpoint(encodeManagedCheckpoint(requested))
				} catch {
					signal.throwIfAborted()
					return { state: 'running' }
				}
				let process: ZeropsProcess
				try {
					signal.throwIfAborted()
					const descriptor = prepareManagedDescriptor(artifact.target.sourceDescriptor.contents, state.setup, state.binding)
					process = await api.buildAndDeployAppVersion({
						appVersionId: state.appVersionId,
						zeropsYaml: descriptor.contents,
						zeropsYamlSetup: descriptor.setup,
						signal,
					})
				} catch {
					signal.throwIfAborted()
					return reconcileTriggered(input, requested, signal)
				}
				const triggered: ZeropsRunState = { ...requested, phase: 'build_triggered', processId: process.id }
				signal.throwIfAborted()
				if (process.appVersionId !== undefined && process.appVersionId !== state.appVersionId) return { state: 'running' }
				try {
					await input.checkpoint(encodeManagedCheckpoint(triggered))
				} catch {
					signal.throwIfAborted()
					return { state: 'running' }
				}
				return reconcileTriggered(input, triggered, signal)
			}
			return reconcileTriggered(input, state, signal)
		},
		secrets: {
			put: async (input) => {
				assertAuthoredManagedName(input.name)
				assertNoManagedReferences(input.value)
				assertOwnReferencesOnly(input.environment, input.name, input.value)
				const target = decodeEnvironment(input.environment).target
				await api.putServiceEnv({
					serviceId: target.serviceId,
					key: input.name,
					value: input.value,
					signal: abortSignal(),
				})
				return { valueRef: `zerops:${target.serviceId}/${encodeURIComponent(input.name)}` }
			},
			delete: async (input) => {
				assertAuthoredManagedName(input.name)
				const target = decodeEnvironment(input.environment).target
				const variables = await api.listServiceEnv({ serviceId: target.serviceId, signal: abortSignal() })
				const found = variables.find((variable) => variable.key === input.name)
				if (found !== undefined) {
					await api.deleteServiceEnv({ envId: found.id, signal: abortSignal() })
				}
			},
		},
		...(namespaceCapabilities === undefined
			? {}
			: {
				namespaces: {
					...namespaceCapabilities,
					prepareRegistration: async (input) => {
						const { namespace, namespaceTarget } = decodeNamespace(input.registration.environment)
						if (namespaceTarget.ready !== true || namespaceTarget.projectId === undefined) {
							throw new Error(`Zerops deployment namespace \`${namespace.id}\` is not ready`)
						}
						const projectId = namespaceTarget.projectId
						const manifest = decodeEnvelope('artifact', 'zerops', input.registration.environment.artifact, zeropsArtifactCodec)
						assertFabrikaManifestCoordinates(manifest.app, {
							appId: input.registration.app.id,
							env: input.registration.environment.env,
						})
						const hostnames = manifestServiceHostnames(manifest)
						const observed = await Promise.all(hostnames.map(async (hostname) => ({
							hostname,
							service: await api.findService({ projectId, hostname, signal: input.signal }),
						})))
						const present = observed.filter((entry) => entry.service !== null)
						if (present.length !== 0 && present.length !== observed.length) {
							throw new Error(`Zerops registration found only ${present.length} of ${observed.length} declared services`)
						}
						const existingDeploy = observed.find((entry) => entry.hostname === manifest.target.deployService)?.service
						if (present.length > 0) {
							if (existingDeploy === null || existingDeploy === undefined) throw new Error('Zerops registration has no deploy service')
							await admit(ownerFor(input.registration.environment, manifest, existingDeploy.id), input.signal, input.readRetainedCheckpoint)
						}
						input.signal.throwIfAborted()
						// The first import refuses name collisions atomically, including services created after the lookup.
						const imported = await api.importServices({
							projectId,
							yaml: present.length === 0 ? renderFabrikaProvisioningYaml(manifest) : renderFabrikaImportYaml(manifest),
							signal: input.signal,
						})
						const finishedProcesses: ZeropsProcess[] = []
						for (const service of imported.services) {
							for (const process of service.processes) {
								finishedProcesses.push(
									await waitForProcess({
										api,
										processId: process.id,
										sleep: options.sleep ?? defaultSleep,
										signal: input.signal,
										label: `the ${service.name} import`,
									}),
								)
							}
						}
						const reported = imported.services.find((service) => service.name === manifest.target.deployService)
						const discovered = present.length === 0 ? reported : existingDeploy
						if (discovered === null || discovered === undefined || discovered.id === '') {
							throw new Error(`Zerops import did not create deploy service \`${manifest.target.deployService}\``)
						}
						if (present.length === 0) {
							input.signal.throwIfAborted()
							const service = await api.getService({ serviceId: discovered.id, signal: input.signal })
							const owner = ownerFor(input.registration.environment, manifest, discovered.id)
							const creation = confirmCodelessManagedService({
								owner,
								imported,
								finishedProcesses,
								service,
								provisioningDocument: {
									...manifest.target.importDocument,
									services: manifest.target.importDocument.services.map((entry) => ({ ...entry, override: false, startWithoutCode: true })),
								},
							})
							await createManagedMarker({ api, owner, creation, signal: input.signal, sleep: options.sleep ?? defaultSleep })
						}
						return normalizeRegistration({
							app: input.registration.app,
							environment: {
								...input.registration.environment,
								target: envelope(zeropsStoredTargetCodec, { serviceId: discovered.id }),
							},
						})
					},
				},
			}),
	}
	return controlProvider
}
