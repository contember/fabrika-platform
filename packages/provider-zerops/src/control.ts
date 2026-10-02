import type {
	ControlProvider,
	JsonValue,
	ProviderBoundDeployInput,
	ProviderBoundSourceResolutionInput,
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
	ProviderTerminalOutcome,
	RuntimeProvider,
	RuntimeProviderRun,
	SchemaReconciler,
} from '@fabrika/provider-contract'
import { ProviderSecretError } from '@fabrika/provider-contract'
import {
	createZeropsApi,
	waitForProcess,
	ZEROPS_ACTIVE,
	ZEROPS_PROCESS_FINISHED,
	ZEROPS_PROCESS_TERMINAL,
	ZEROPS_TERMINAL,
	type ZeropsApi,
	ZeropsApiError,
	type ZeropsAppVersion,
	type ZeropsProcess,
} from './api'
import { defaultSleep, defaultZeropsCollaborators, type Sleeper } from './collaborators'
import { prepareZeropsDescriptor } from './descriptor'
import {
	type FabrikaManifest,
	manifestServiceHostnames,
	parseFabrikaManifest,
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
import { createZeropsProvider } from './provider'
import { allowedReferenceHosts, foreignReferenceHost, serviceReferenceHosts } from './service-references'
import { normalizeZeropsSourceRepository, type ZeropsSourceClient, type ZeropsSourceClientV2, type ZeropsSourceResolveResult } from './source'
import type { ZeropsRunState, ZeropsRuntimeTarget } from './types'

/** Provider coordinates that are safe to persist. Credentials are composed only for a live run. */
export interface ZeropsStoredTarget {
	serviceId: string
}

const property = (payload: JsonValue, key: string): JsonValue | undefined => {
	if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
		throw new Error('Zerops stored target must be an object')
	}
	return payload[key]
}

const requiredString = (payload: JsonValue, key: string): string => {
	const value = property(payload, key)
	if (typeof value !== 'string' || value === '') {
		throw new Error(`Zerops stored target ${key} must be a non-empty string`)
	}
	return value
}

export const zeropsStoredTargetCodec: ProviderCodec<ZeropsStoredTarget> = {
	version: 2,
	encode: (target) => ({ serviceId: target.serviceId }),
	decode: (payload) => ({
		serviceId: requiredString(payload, 'serviceId'),
	}),
}

const decodeEnvelope = <T>(kind: string, envelope: ProviderEnvelope, codec: ProviderCodec<T>): T => {
	if (envelope.provider !== 'zerops') {
		throw new Error(`${kind} belongs to provider "${envelope.provider}", expected "zerops"`)
	}
	if (envelope.version !== codec.version) {
		throw new Error(`${kind} schema version ${envelope.version} is not supported by provider "zerops"`)
	}
	return codec.decode(envelope.payload)
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

export type ZeropsProviderExecutor = (
	provider: RuntimeProvider,
	run: RuntimeProviderRun,
) => Promise<ProviderTerminalOutcome>

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
	readonly execute: ZeropsProviderExecutor
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

export type ZeropsBoundSourceResolutionInput = ProviderBoundSourceResolutionInput

export type ZeropsBoundDeployInput = ProviderBoundDeployInput

export type ZeropsControlProvider = ControlProvider & Required<Pick<ControlProvider, 'resolveSourceWithBinding' | 'deployWithBinding'>>

interface DecodedZeropsEnvironment {
	readonly target: ZeropsStoredTarget
	readonly namespace: ProviderDeploymentNamespace
	readonly namespaceTarget: ZeropsNamespaceTarget
}

const decodeEnvironment = (environment: ProviderEnvironment): DecodedZeropsEnvironment => {
	const target = decodeEnvelope('target', environment.target, zeropsStoredTargetCodec)
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
		namespaceTarget: decodeEnvelope('namespace target', namespace.target, zeropsNamespaceTargetCodec),
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

const normalizeRegistration = (input: ProviderRegistrationInput): ProviderRegistration => {
	if (input.app.id !== input.environment.appId) {
		throw new Error(`Zerops environment belongs to app \`${input.environment.appId}\`, expected \`${input.app.id}\``)
	}
	if ((input.app.source.githubConnectionId === undefined) !== (input.app.source.githubInstallationId === undefined)) {
		throw new Error('Zerops private source requires both connection and installation coordinates')
	}
	const decoded = decodeEnvironment(input.environment)
	const artifact = parseFabrikaManifest(
		decodeEnvelope('artifact', input.environment.artifact, zeropsArtifactCodec),
		{ appId: input.app.id, env: input.environment.env },
	)
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

const IMMUTABLE_GIT_OBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const BUILD_TRIGGER_CONSISTENCY_MS = 10_000
const SOURCE_CANCEL_TIMEOUT_MS = 5000

const parseRunState = (value: JsonValue | undefined, externalId: string): ZeropsRunState => {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('Zerops run state must be an object')
	}
	const appVersionId = value['appVersionId']
	const phase = value['phase']
	if (typeof appVersionId !== 'string' || appVersionId === '' || appVersionId !== externalId) {
		throw new Error('Zerops run state appVersionId must match the external id')
	}
	if (phase === 'version_created' || phase === 'source_uploaded' || phase === 'build_trigger_requested') {
		if (Object.keys(value).some((key) => key !== 'appVersionId' && key !== 'phase')) {
			throw new Error('Zerops run state contains an unknown field')
		}
		return { appVersionId, phase }
	}
	if (phase !== 'build_triggered') {
		throw new Error('Zerops run state phase is invalid')
	}
	if (Object.keys(value).some((key) => key !== 'appVersionId' && key !== 'phase' && key !== 'processId')) {
		throw new Error('Zerops run state contains an unknown field')
	}
	const processId = value['processId']
	if (processId !== undefined && (typeof processId !== 'string' || processId === '')) {
		throw new Error('Zerops run state processId must be a non-empty string when present')
	}
	return { appVersionId, phase, ...(processId === undefined ? {} : { processId }) }
}

const runState = (
	appVersionId: string,
	phase: Exclude<ZeropsRunState['phase'], 'build_triggered'>,
): Exclude<ZeropsRunState, { phase: 'build_triggered' }> => ({ appVersionId, phase })

const buildTriggeredState = (
	appVersionId: string,
	processId?: string,
): Extract<ZeropsRunState, { phase: 'build_triggered' }> => ({
	appVersionId,
	phase: 'build_triggered',
	...(processId === undefined ? {} : { processId }),
})

/** Build the complete Zerops lifecycle bundle without importing control-plane persistence. */
export const createZeropsControlProvider = (options: ZeropsControlProviderOptions): ZeropsControlProvider => {
	if (options.accessToken === '') {
		throw new Error('Zerops access token must be a non-empty string')
	}
	const api = options.api ?? createZeropsApi({ token: options.accessToken, baseUrl: options.apiBaseUrl })
	const isAbsentVersion = (error: unknown): boolean => error instanceof ZeropsApiError && error.status === 400 && error.code === 'appVersionNotFound'
	const deleteVersion = async (input: { appVersionId: string; signal: AbortSignal }): Promise<void> => {
		input.signal.throwIfAborted()
		try {
			await api.deleteAppVersion(input)
		} catch (error) {
			input.signal.throwIfAborted()
			if (!isAbsentVersion(error)) throw error
		}
	}
	const getVersion = async (input: { appVersionId: string; signal: AbortSignal }): Promise<ZeropsAppVersion | null> => {
		input.signal.throwIfAborted()
		try {
			return await api.getAppVersion(input)
		} catch (error) {
			input.signal.throwIfAborted()
			if (!isAbsentVersion(error)) throw error
			return null
		}
	}
	const sourceBindings = new Map<string, ProviderSourceBinding>()
	const runtimeProvider = createZeropsProvider((target) => {
		const defaults = defaultZeropsCollaborators(target)
		return {
			api,
			source: options.source,
			...(options.sourceCancelSleep === undefined ? {} : { sourceCancelSleep: options.sourceCancelSleep }),
			reconcileSchema: options.reconcileSchema ?? defaults.reconcileSchema,
			sleep: options.sleep ?? defaultSleep,
		}
	}, {
		bindingForRun: (runId) => sourceBindings.get(runId),
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

	const artifactFor = (environment: ProviderEnvironment): FabrikaManifest =>
		parseFabrikaManifest(
			decodeEnvelope('artifact', environment.artifact, zeropsArtifactCodec),
			{ appId: environment.appId, env: environment.env },
		)

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

	const cancelSourceBestEffort = async (runId: string, appVersionId: string, signal: AbortSignal): Promise<void> => {
		signal.throwIfAborted()
		const sourceController = new AbortController()
		const timeoutController = new AbortController()
		const cancel = Promise.resolve()
			.then(() => options.source.cancel({ runId, appVersionId, signal: AbortSignal.any([signal, sourceController.signal]) }))
			.catch(() => {})
		const timeout = Promise.resolve()
			.then(() => (options.sourceCancelSleep ?? defaultSleep)(SOURCE_CANCEL_TIMEOUT_MS, timeoutController.signal))
			.then(() => sourceController.abort())
			.catch(() => {})
		await Promise.race([cancel, timeout])
		timeoutController.abort()
		sourceController.abort()
		signal.throwIfAborted()
	}

	const reconcileActiveSchema = async (
		input: ProviderReconcileInput,
		placement: ReturnType<typeof resolvedEnvironment>,
		signal: AbortSignal,
	): Promise<void> => {
		const artifact = artifactFor(input.environment)
		if (artifact.app.schema === undefined || options.propustkaUrl === undefined) return
		const runtimeTarget: ZeropsRuntimeTarget = {
			projectId: placement.projectId,
			serviceId: placement.target.serviceId,
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
		state: Extract<ZeropsRunState, { phase: 'build_triggered' }>,
		placement: ReturnType<typeof resolvedEnvironment>,
		signal: AbortSignal,
	): Promise<ProviderReconcileOutcome> => {
		if (state.processId !== undefined) {
			const process = await api.getProcess({ processId: state.processId, signal })
			if (process.id !== state.processId) throw new Error('Zerops process response has different coordinates')
			if (
				process.status !== undefined
				&& ZEROPS_PROCESS_TERMINAL.has(process.status)
				&& process.status !== ZEROPS_PROCESS_FINISHED
			) {
				return { state: 'failed' }
			}
		}
		const version = await getVersion({ appVersionId: state.appVersionId, signal })
		if (version === null) return { state: 'failed' }
		if (version.id !== state.appVersionId) throw new Error('Zerops app-version response has different coordinates')
		if (version.status === ZEROPS_ACTIVE) {
			await reconcileActiveSchema(input, placement, signal)
			return { state: 'succeeded' }
		}
		if (version.status !== undefined && ZEROPS_TERMINAL.has(version.status)) return { state: 'failed' }
		return { state: 'running' }
	}

	const assertSourceBinding = (
		input: Pick<ProviderDeployInput, 'app'>,
		binding: ProviderSourceBinding | undefined,
	): void => {
		const connectionId = input.app.source.githubConnectionId
		const installationId = input.app.source.githubInstallationId
		if (binding === undefined) {
			if (connectionId !== undefined || installationId !== undefined) {
				throw new Error('Zerops private source requires an explicit transport binding')
			}
			return
		}
		if (connectionId !== binding.connectionId || installationId !== binding.installationId) {
			throw new Error('Zerops source transport binding has different application coordinates')
		}
	}

	const resolveSource = async (
		input: ProviderSourceResolutionInput,
		binding?: ProviderSourceBinding,
	): Promise<ProviderSourceResolution> => {
		assertSourceBinding(input, binding)
		const registration = normalizeRegistration({ app: input.app, environment: input.environment })
		const artifact = decodeEnvelope('artifact', registration.environment.artifact, zeropsArtifactCodec)
		await verifyZeropsArtifactSourceDescriptor(artifact.target.sourceDescriptor)
		const base = {
			runId: input.runId,
			repository: normalizeZeropsSourceRepository(registration.app.source.repoUrl),
			requestedRef: registration.app.source.ref,
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
				privateBinding: { connectionId: binding.connectionId, installationId: binding.installationId },
			})
		}
		if (
			result.runId !== input.runId
			|| result.descriptorSha256 !== artifact.target.sourceDescriptor.sha256
			|| (input.expectedCommitSha !== undefined && result.commitSha !== input.expectedCommitSha)
		) throw new Error('Zerops source resolution returned different coordinates')
		return { commitSha: result.commitSha }
	}

	const controlProvider: ZeropsControlProvider = {
		id: 'zerops',
		normalizeRegistration,
		/**
		 * A Zerops artifact IS the compiled manifest, so the declaration is right here and core can refuse
		 * a variable this app would never read. An artifact that will not decode answers `undefined`
		 * rather than an empty set: a broken envelope is a registration problem, and reporting it as an
		 * undeclared variable would point the operator at the wrong thing.
		 */
		declaredVariables: ({ artifact }) => {
			try {
				return parseFabrikaManifest(decodeEnvelope('artifact', artifact, zeropsArtifactCodec)).app.pipeline.vars
			} catch {
				return undefined
			}
		},
		resolveSource: (input) => resolveSource(input),
		resolveSourceWithBinding: (input) => resolveSource(input, input.sourceBinding),
		deploy: async (input: ProviderDeployInput): Promise<ProviderDeployOutcome> => {
			input.signal.throwIfAborted()
			assertSourceBinding(input, sourceBindings.get(input.runId))
			const registration = normalizeRegistration({ app: input.app, environment: input.environment })
			const placement = resolvedEnvironment(registration.environment, { requireReady: true })
			const proxyServiceId = placement.proxyServiceId
			if (proxyServiceId === undefined) {
				throw new Error(`Zerops deployment namespace \`${placement.namespace.id}\` has no proxy service id`)
			}
			const proxySource = placement.proxySource
			if (proxySource === undefined) {
				throw new Error(`Zerops deployment namespace \`${placement.namespace.id}\` is unpinned; explicit migration is required`)
			}
			await verifyZeropsNamespaceProxySource(proxySource)
			const artifact = decodeEnvelope('artifact', registration.environment.artifact, zeropsArtifactCodec)
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
					...(input.app.source.githubInstallationId === undefined
						? {}
						: { githubInstallationId: input.app.source.githubInstallationId }),
				}
			}
			if (!input.dryRun) {
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
					artifact,
					api,
					signal: input.signal,
				})
			}
			const managedEnvironment = input.managedEnvironment
			const managedEntries = Object.entries(managedEnvironment).sort(([left], [right]) => left.localeCompare(right))
			const managedNames = managedEntries.map(([name]) => name)
			if (input.dryRun) {
				if (managedNames.length > 0) {
					input.events.log(
						`  [dry-run] would reconcile managed environment on service ${placement.target.serviceId}: ${managedNames.join(', ')}`,
					)
				}
			} else {
				const removedNames = new Set(managedEntries.filter(([, value]) => value === null).map(([name]) => name))
				const existing = removedNames.size === 0
					? []
					: await api.listServiceEnv({ serviceId: placement.target.serviceId, signal: input.signal })
				for (const [name, value] of managedEntries) {
					input.signal.throwIfAborted()
					if (value === null) {
						for (const item of existing) {
							if (item.key === name) await api.deleteServiceEnv({ envId: item.id, signal: input.signal })
						}
					} else {
						await api.putServiceEnv({
							serviceId: placement.target.serviceId,
							key: name,
							value,
							signal: input.signal,
						})
					}
				}
			}
			const runtimeTarget: ZeropsRuntimeTarget = {
				projectId: placement.projectId,
				serviceId: placement.target.serviceId,
				accessToken: options.accessToken,
				...(source === undefined ? {} : { source }),
				...(options.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
				...(options.propustkaUrl !== undefined ? { propustkaUrl: options.propustkaUrl } : {}),
				...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
			}
			const accepted: { id?: string; state?: JsonValue } = {}
			const result = await options.execute(runtimeProvider.runtime, {
				appId: input.app.id,
				env: input.environment.env,
				...(input.environment.domain !== undefined ? { domain: input.environment.domain } : {}),
				...(input.returnOrigins === undefined ? {} : { returnOrigins: input.returnOrigins }),
				cwd: input.app.source.workerDir ?? '.',
				secrets: input.secrets,
				vars: input.vars,
				managedEnvironment: {},
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
				target: runtimeProvider.encodeTarget(runtimeTarget),
				artifact: registration.environment.artifact,
			})
			input.signal.throwIfAborted()
			if (result.state === 'succeeded' || accepted.id === undefined) return result
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
		deployWithBinding: async (input) => {
			const { sourceBinding, ...deployInput } = input
			assertSourceBinding(deployInput, sourceBinding)
			if (sourceBindings.has(input.runId)) throw new Error('Zerops source transport binding is already active for this run')
			sourceBindings.set(input.runId, sourceBinding)
			try {
				return await controlProvider.deploy(deployInput)
			} finally {
				if (sourceBindings.get(input.runId) === sourceBinding) sourceBindings.delete(input.runId)
			}
		},
		cancel: async (input) => {
			const signal = input.signal
			signal.throwIfAborted()
			resolvedEnvironment(input.environment, { requireReady: false })
			const state = parseRunState(input.providerState, input.externalId)
			await cancelSourceBestEffort(input.runId, state.appVersionId, signal)
			if (state.phase === 'version_created' || state.phase === 'source_uploaded') {
				await deleteVersion({ appVersionId: state.appVersionId, signal })
				return { state: 'settled' }
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
			const placement = resolvedEnvironment(input.environment, { requireReady: false })
			const state = parseRunState(input.providerState, input.externalId)
			if (state.phase === 'version_created') {
				await cancelSourceBestEffort(input.runId, state.appVersionId, signal)
				await deleteVersion({ appVersionId: state.appVersionId, signal })
				return { state: 'failed' }
			}
			if (state.phase === 'source_uploaded') {
				let artifact: FabrikaManifest
				try {
					artifact = artifactFor(input.environment)
					await verifyZeropsArtifactSourceDescriptor(artifact.target.sourceDescriptor)
				} catch {
					await cancelSourceBestEffort(input.runId, state.appVersionId, signal)
					await deleteVersion({ appVersionId: state.appVersionId, signal })
					return { state: 'failed' }
				}
				try {
					await input.checkpoint(runState(state.appVersionId, 'build_trigger_requested'))
				} catch {
					return { state: 'running' }
				}
				let process: ZeropsProcess
				try {
					signal.throwIfAborted()
					const descriptor = prepareZeropsDescriptor(artifact.target.sourceDescriptor.contents, artifact.target.zeropsSetup)
					process = await api.buildAndDeployAppVersion({
						appVersionId: state.appVersionId,
						zeropsYaml: descriptor.contents,
						zeropsYamlSetup: descriptor.setup,
						signal,
					})
				} catch (error) {
					if (error instanceof ZeropsApiError && error.status >= 400 && error.status < 500) {
						await cancelSourceBestEffort(input.runId, state.appVersionId, signal)
						await deleteVersion({ appVersionId: state.appVersionId, signal })
						return { state: 'failed' }
					}
					let observed: ZeropsAppVersion | null
					try {
						await (options.sleep ?? defaultSleep)(BUILD_TRIGGER_CONSISTENCY_MS, signal)
						observed = await getVersion({ appVersionId: state.appVersionId, signal })
					} catch {
						return { state: 'running' }
					}
					if (observed === null) return { state: 'failed' }
					if (observed.id !== state.appVersionId || observed.status === undefined) return { state: 'running' }
					if (observed.status === 'UPLOADING') return { state: 'running' }
					const triggered = buildTriggeredState(state.appVersionId)
					try {
						await input.checkpoint(triggered)
					} catch {
						return { state: 'running' }
					}
					return reconcileTriggered(input, triggered, placement, signal)
				}
				const triggered = buildTriggeredState(state.appVersionId, process.id)
				try {
					await input.checkpoint(triggered)
				} catch {
					return { state: 'running' }
				}
				return reconcileTriggered(input, triggered, placement, signal)
			}
			if (state.phase === 'build_trigger_requested') {
				let version: ZeropsAppVersion | null
				try {
					await (options.sleep ?? defaultSleep)(BUILD_TRIGGER_CONSISTENCY_MS, signal)
					version = await getVersion({ appVersionId: state.appVersionId, signal })
				} catch {
					return { state: 'running' }
				}
				if (version === null) return { state: 'failed' }
				if (version.id !== state.appVersionId || version.status === undefined) return { state: 'running' }
				if (version.status === 'UPLOADING') return { state: 'running' }
				const triggered = buildTriggeredState(state.appVersionId)
				try {
					await input.checkpoint(triggered)
				} catch {
					return { state: 'running' }
				}
				return reconcileTriggered(input, triggered, placement, signal)
			}
			return reconcileTriggered(input, state, placement, signal)
		},
		secrets: {
			put: async (input) => {
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
						const manifest = parseFabrikaManifest(
							decodeEnvelope('artifact', input.registration.environment.artifact, zeropsArtifactCodec),
							{
								appId: input.registration.app.id,
								env: input.registration.environment.env,
							},
						)
						const hostnames = manifestServiceHostnames(manifest)
						const observed = await Promise.all(hostnames.map(async (hostname) => ({
							hostname,
							service: await api.findService({ projectId, hostname, signal: input.signal }),
						})))
						const present = observed.filter((entry) => entry.service !== null)
						if (present.length !== 0 && present.length !== observed.length) {
							throw new Error(`Zerops registration found only ${present.length} of ${observed.length} declared services`)
						}
						// The first import refuses name collisions atomically, including services created after the lookup.
						const imported = await api.importServices({
							projectId,
							yaml: present.length === 0 ? renderFabrikaProvisioningYaml(manifest) : renderFabrikaImportYaml(manifest),
							signal: input.signal,
						})
						for (const service of imported.services) {
							for (const process of service.processes) {
								await waitForProcess({
									api,
									processId: process.id,
									sleep: options.sleep ?? defaultSleep,
									signal: input.signal,
									label: `the ${service.name} import`,
								})
							}
						}
						const reported = imported.services.find((service) => service.name === manifest.target.deployService)
						const observedDeployService = observed.find((entry) => entry.hostname === manifest.target.deployService)?.service
						const discovered = reported ?? observedDeployService
							?? await api.findService({
								projectId,
								hostname: manifest.target.deployService,
								signal: input.signal,
							})
						if (discovered === null || discovered === undefined || discovered.id === '') {
							throw new Error(`Zerops import did not create deploy service \`${manifest.target.deployService}\``)
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
