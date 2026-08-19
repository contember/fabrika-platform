import type {
	ControlProvider,
	JsonValue,
	ProviderCodec,
	ProviderDeployInput,
	ProviderDeploymentNamespace,
	ProviderEnvelope,
	ProviderEnvironment,
	ProviderReconcileInput,
	ProviderReconcileOutcome,
	ProviderRegistration,
	ProviderRegistrationInput,
	ProviderSourceResolution,
	ProviderSourceResolutionInput,
	ProviderTerminalOutcome,
	RuntimeProvider,
	RuntimeProviderRun,
	SchemaReconciler,
} from '@fabrika/provider-contract'
import {
	createZeropsApi,
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
import {
	type FabrikaManifest,
	parseFabrikaManifest,
	renderFabrikaProvisioningYaml,
	verifyZeropsArtifactSourceDescriptor,
	zeropsArtifactCodec,
} from './manifest'
import { createZeropsNamespaceCapabilities, type ZeropsNamespaceTarget, zeropsNamespaceTargetCodec } from './namespace'
import { createZeropsProvider, type ZeropsSourceTransportBinding } from './provider'
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
		/** The namespace proxy has no Git integration, so its pipeline must be told what to build. */
		readonly proxyBuildFromGit: string
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
		readonly proxyBuildFromGit: string
		readonly iamUrl: string
		readonly iamKey: string
	}
}

export interface ZeropsBoundSourceResolutionInput extends ProviderSourceResolutionInput {
	readonly sourceBinding: ZeropsSourceTransportBinding
}

export interface ZeropsBoundDeployInput extends ProviderDeployInput {
	readonly sourceBinding: ZeropsSourceTransportBinding
}

export interface ZeropsControlProvider extends ControlProvider {
	resolveSourceWithBinding(input: ZeropsBoundSourceResolutionInput): Promise<ProviderSourceResolution>
	deployWithBinding(input: ZeropsBoundDeployInput): Promise<ProviderTerminalOutcome>
}

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
): DecodedZeropsEnvironment & { projectId: string; proxyServiceId?: string; proxyBuildFromGit?: string } => {
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
	const proxyBuildFromGit = decoded.namespaceTarget.proxyBuildFromGit
	if (options.requireReady && proxyBuildFromGit === undefined) {
		throw new Error(`Zerops deployment namespace \`${decoded.namespace.id}\` has no proxy build source`)
	}
	return {
		...decoded,
		projectId,
		...(proxyServiceId === undefined ? {} : { proxyServiceId }),
		...(proxyBuildFromGit === undefined ? {} : { proxyBuildFromGit }),
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
	const sourceBindings = new Map<string, ZeropsSourceTransportBinding>()
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
			api,
			...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
		})

	const artifactFor = (environment: ProviderEnvironment): FabrikaManifest =>
		parseFabrikaManifest(
			decodeEnvelope('artifact', environment.artifact, zeropsArtifactCodec),
			{ appId: environment.appId, env: environment.env },
		)

	const cancelSourceBestEffort = async (runId: string, appVersionId: string): Promise<void> => {
		const sourceController = new AbortController()
		const timeoutController = new AbortController()
		const cancel = Promise.resolve()
			.then(() => options.source.cancel({ runId, appVersionId, signal: sourceController.signal }))
			.catch(() => {})
		const timeout = Promise.resolve()
			.then(() => (options.sourceCancelSleep ?? defaultSleep)(SOURCE_CANCEL_TIMEOUT_MS, timeoutController.signal))
			.then(() => sourceController.abort())
			.catch(() => {})
		await Promise.race([cancel, timeout])
		timeoutController.abort()
		sourceController.abort()
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
		const version = await api.getAppVersion({ appVersionId: state.appVersionId, signal })
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
		binding: ZeropsSourceTransportBinding | undefined,
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
		binding?: ZeropsSourceTransportBinding,
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
		if (binding?.transportKind === 'keyed-v2') {
			const resolveV2 = options.source.resolveV2
			if (resolveV2 === undefined) throw new Error('Zerops keyed source transport is unavailable')
			result = await resolveV2.call(options.source, {
				...base,
				privateBinding: { connectionId: binding.connectionId, installationId: binding.installationId },
			})
		} else {
			result = await options.source.resolve({
				...base,
				...(binding === undefined ? {} : { githubInstallationId: binding.installationId }),
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
		deploy: async (input: ProviderDeployInput): Promise<ProviderTerminalOutcome> => {
			assertSourceBinding(input, sourceBindings.get(input.runId))
			const registration = normalizeRegistration({ app: input.app, environment: input.environment })
			const placement = resolvedEnvironment(registration.environment, { requireReady: true })
			const proxyServiceId = placement.proxyServiceId
			if (proxyServiceId === undefined) {
				throw new Error(`Zerops deployment namespace \`${placement.namespace.id}\` has no proxy service id`)
			}
			const proxyBuildFromGit = placement.proxyBuildFromGit
			if (proxyBuildFromGit === undefined) {
				throw new Error(`Zerops deployment namespace \`${placement.namespace.id}\` has no proxy build source`)
			}
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
						proxyBuildFromGit,
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
			return options.execute(runtimeProvider.runtime, {
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
				events: input.events,
				target: runtimeProvider.encodeTarget(runtimeTarget),
				artifact: registration.environment.artifact,
			})
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
			resolvedEnvironment(input.environment, { requireReady: false })
			const state = parseRunState(input.providerState, input.externalId)
			await cancelSourceBestEffort(input.runId, state.appVersionId)
			if (state.phase === 'build_triggered') {
				await api.cancelBuild({ appVersionId: state.appVersionId, signal: abortSignal() })
				return
			}
			if (state.phase === 'build_trigger_requested') {
				await (options.sleep ?? defaultSleep)(BUILD_TRIGGER_CONSISTENCY_MS, abortSignal())
				const version = await api.getAppVersion({ appVersionId: state.appVersionId, signal: abortSignal() })
				if (version.id !== state.appVersionId) throw new Error('Zerops app-version response has different coordinates')
				if (version.status === undefined) {
					throw new Error('Zerops app-version status is not observable yet')
				}
				if (version.status !== 'UPLOADING') {
					await api.cancelBuild({ appVersionId: state.appVersionId, signal: abortSignal() })
					return
				}
			}
			await api.deleteAppVersion({ appVersionId: state.appVersionId, signal: abortSignal() })
		},
		reconcile: async (input): Promise<ProviderReconcileOutcome> => {
			const signal = abortSignal()
			const placement = resolvedEnvironment(input.environment, { requireReady: false })
			const state = parseRunState(input.providerState, input.externalId)
			if (state.phase === 'version_created') {
				await cancelSourceBestEffort(input.runId, state.appVersionId)
				await api.deleteAppVersion({ appVersionId: state.appVersionId, signal: abortSignal() })
				return { state: 'failed' }
			}
			if (state.phase === 'source_uploaded') {
				let artifact: FabrikaManifest
				try {
					artifact = artifactFor(input.environment)
					await verifyZeropsArtifactSourceDescriptor(artifact.target.sourceDescriptor)
				} catch {
					await cancelSourceBestEffort(input.runId, state.appVersionId)
					await api.deleteAppVersion({ appVersionId: state.appVersionId, signal: abortSignal() })
					return { state: 'failed' }
				}
				try {
					await input.checkpoint(runState(state.appVersionId, 'build_trigger_requested'))
				} catch {
					return { state: 'running' }
				}
				let process: ZeropsProcess
				try {
					process = await api.buildAndDeployAppVersion({
						appVersionId: state.appVersionId,
						zeropsYaml: artifact.target.sourceDescriptor.contents,
						...(artifact.target.zeropsSetup === undefined ? {} : { zeropsYamlSetup: artifact.target.zeropsSetup }),
						signal,
					})
				} catch (error) {
					if (error instanceof ZeropsApiError && error.status >= 400 && error.status < 500) {
						await cancelSourceBestEffort(input.runId, state.appVersionId)
						await api.deleteAppVersion({ appVersionId: state.appVersionId, signal: abortSignal() })
						return { state: 'failed' }
					}
					let observed: ZeropsAppVersion
					try {
						await (options.sleep ?? defaultSleep)(BUILD_TRIGGER_CONSISTENCY_MS, signal)
						observed = await api.getAppVersion({ appVersionId: state.appVersionId, signal })
					} catch {
						return { state: 'running' }
					}
					if (observed.id !== state.appVersionId || observed.status === undefined) return { state: 'running' }
					if (observed.status === 'UPLOADING') {
						await cancelSourceBestEffort(input.runId, state.appVersionId)
						await api.deleteAppVersion({ appVersionId: state.appVersionId, signal: abortSignal() })
						return { state: 'failed' }
					}
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
				let version: ZeropsAppVersion
				try {
					await (options.sleep ?? defaultSleep)(BUILD_TRIGGER_CONSISTENCY_MS, signal)
					version = await api.getAppVersion({ appVersionId: state.appVersionId, signal })
				} catch {
					return { state: 'running' }
				}
				if (version.id !== state.appVersionId || version.status === undefined) return { state: 'running' }
				if (version.status === 'UPLOADING') {
					await cancelSourceBestEffort(input.runId, state.appVersionId)
					await api.deleteAppVersion({ appVersionId: state.appVersionId, signal: abortSignal() })
					return { state: 'failed' }
				}
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
						const manifest = parseFabrikaManifest(
							decodeEnvelope('artifact', input.registration.environment.artifact, zeropsArtifactCodec),
							{
								appId: input.registration.app.id,
								env: input.registration.environment.env,
							},
						)
						const imported = await api.importServices({
							projectId: namespaceTarget.projectId,
							yaml: renderFabrikaProvisioningYaml(manifest),
							signal: input.signal,
						})
						const reported = imported.services.find((service) => service.name === manifest.target.deployService)
						const discovered = reported === undefined
							? await api.findService({
								projectId: namespaceTarget.projectId,
								hostname: manifest.target.deployService,
								signal: input.signal,
							})
							: reported
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
