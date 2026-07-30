import type {
	ControlProvider,
	JsonValue,
	ProviderCodec,
	ProviderDeployInput,
	ProviderDeploymentNamespace,
	ProviderEnvelope,
	ProviderEnvironment,
	ProviderReconcileOutcome,
	ProviderRegistration,
	ProviderRegistrationInput,
	ProviderTerminalOutcome,
	RuntimeProvider,
	RuntimeProviderRun,
	SchemaReconciler,
} from '@fabrika/provider-contract'
import { createZeropsApi, ZEROPS_ACTIVE, ZEROPS_TERMINAL, type ZeropsApi } from './api'
import { defaultSleep, defaultZeropsCollaborators, type Sleeper } from './collaborators'
import { type FabrikaManifest, parseFabrikaManifest, renderFabrikaProvisioningYaml, zeropsArtifactCodec } from './manifest'
import { createZeropsNamespaceCapabilities, type ZeropsNamespaceTarget, zeropsNamespaceTargetCodec } from './namespace'
import { createZeropsProvider } from './provider'
import type { ZeropsRuntimeTarget } from './types'

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
	readonly reconcileSchema?: SchemaReconciler
	readonly sleep?: Sleeper
	readonly execute?: ZeropsProviderExecutor
	readonly beforeDeploy?: ZeropsBeforeDeploy
	readonly namespaces?: {
		readonly clientId: string
		readonly proxyBuildFromGit: string
		readonly iamUrl: string
		readonly iamKey: string
	}
}

const executeSession: ZeropsProviderExecutor = async (provider, run) => {
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
): DecodedZeropsEnvironment & { projectId: string; proxyServiceId?: string } => {
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
	return {
		...decoded,
		projectId,
		...(proxyServiceId === undefined ? {} : { proxyServiceId }),
	}
}

const normalizeRegistration = (input: ProviderRegistrationInput): ProviderRegistration => {
	if (input.app.id !== input.environment.appId) {
		throw new Error(`Zerops environment belongs to app \`${input.environment.appId}\`, expected \`${input.app.id}\``)
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

/** Build the complete Zerops lifecycle bundle without importing control-plane persistence. */
export const createZeropsControlProvider = (options: ZeropsControlProviderOptions): ControlProvider => {
	if (options.accessToken === '') {
		throw new Error('Zerops access token must be a non-empty string')
	}
	const api = options.api ?? createZeropsApi({ token: options.accessToken, baseUrl: options.apiBaseUrl })
	const runtimeProvider = createZeropsProvider((target) => {
		const defaults = defaultZeropsCollaborators(target)
		return {
			api,
			reconcileSchema: options.reconcileSchema ?? defaults.reconcileSchema,
			sleep: options.sleep ?? defaultSleep,
		}
	})
	const execute = options.execute ?? executeSession
	const namespaceCapabilities = options.namespaces === undefined
		? undefined
		: createZeropsNamespaceCapabilities({
			...options.namespaces,
			api,
			...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
		})

	return {
		id: 'zerops',
		normalizeRegistration,
		deploy: async (input: ProviderDeployInput): Promise<ProviderTerminalOutcome> => {
			const registration = normalizeRegistration({ app: input.app, environment: input.environment })
			const placement = resolvedEnvironment(registration.environment, { requireReady: true })
			const proxyServiceId = placement.proxyServiceId
			if (proxyServiceId === undefined) {
				throw new Error(`Zerops deployment namespace \`${placement.namespace.id}\` has no proxy service id`)
			}
			const artifact = decodeEnvelope('artifact', registration.environment.artifact, zeropsArtifactCodec)
			await options.beforeDeploy?.({
				appId: input.app.id,
				env: input.environment.env,
				namespaceId: placement.namespace.id,
				target: {
					serviceId: placement.target.serviceId,
					projectId: placement.projectId,
					proxyServiceId,
				},
				artifact,
				api,
				signal: input.signal,
			})
			const runtimeTarget: ZeropsRuntimeTarget = {
				projectId: placement.projectId,
				serviceId: placement.target.serviceId,
				accessToken: options.accessToken,
				...(options.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
				...(options.propustkaUrl !== undefined ? { propustkaUrl: options.propustkaUrl } : {}),
				...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
			}
			return execute(runtimeProvider.runtime, {
				appId: input.app.id,
				env: input.environment.env,
				...(input.environment.domain !== undefined ? { domain: input.environment.domain } : {}),
				cwd: input.app.source.workerDir ?? '.',
				secrets: input.secrets,
				vars: input.vars,
				dryRun: input.dryRun,
				signal: input.signal,
				events: input.events,
				target: runtimeProvider.encodeTarget(runtimeTarget),
				artifact: registration.environment.artifact,
			})
		},
		cancel: async (input) => {
			resolvedEnvironment(input.environment, { requireReady: false })
			await api.cancelBuild({ appVersionId: input.externalId, signal: abortSignal() })
		},
		reconcile: async (input): Promise<ProviderReconcileOutcome> => {
			resolvedEnvironment(input.environment, { requireReady: false })
			const version = await api.getAppVersion({ appVersionId: input.externalId, signal: abortSignal() })
			if (version.status === ZEROPS_ACTIVE) {
				return { state: 'succeeded' }
			}
			if (version.status !== undefined && ZEROPS_TERMINAL.has(version.status)) {
				return { state: 'failed' }
			}
			return { state: 'running' }
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
}
