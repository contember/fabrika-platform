import type {
	ControlProvider,
	JsonValue,
	ProviderCodec,
	ProviderDeployInput,
	ProviderEnvelope,
	ProviderReconcileOutcome,
	ProviderRegistration,
	ProviderRegistrationInput,
	ProviderRunReference,
	ProviderTerminalOutcome,
	RuntimeProvider,
	RuntimeProviderRun,
	SchemaReconciler,
} from '@fabrika/provider-contract'
import { createZeropsApi, ZEROPS_ACTIVE, ZEROPS_TERMINAL, type ZeropsApi } from './api'
import { defaultSleep, defaultZeropsCollaborators, type Sleeper } from './collaborators'
import { type FabrikaManifestV1, parseFabrikaManifest, zeropsArtifactCodec } from './manifest'
import { createZeropsProvider } from './provider'
import type { ZeropsRuntimeTarget } from './types'

/** Provider coordinates that are safe to persist. Credentials are composed only for a live run. */
export interface ZeropsStoredTarget {
	projectId: string
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
	version: 1,
	encode: (target) => ({ projectId: target.projectId, serviceId: target.serviceId }),
	decode: (payload) => ({
		projectId: requiredString(payload, 'projectId'),
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
	readonly target: ZeropsStoredTarget
	readonly artifact: FabrikaManifestV1
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

const normalizeRegistration = (input: ProviderRegistrationInput): ProviderRegistration => {
	if (input.app.id !== input.environment.appId) {
		throw new Error(`Zerops environment belongs to app \`${input.environment.appId}\`, expected \`${input.app.id}\``)
	}
	const target = decodeEnvelope('target', input.environment.target, zeropsStoredTargetCodec)
	const artifact = parseFabrikaManifest(
		decodeEnvelope('artifact', input.environment.artifact, zeropsArtifactCodec),
		{ appId: input.app.id, env: input.environment.env },
	)
	return {
		app: input.app,
		environment: {
			...input.environment,
			target: envelope(zeropsStoredTargetCodec, target),
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

	const storedTarget = (reference: ProviderRunReference): ZeropsStoredTarget =>
		decodeEnvelope('target', reference.environment.target, zeropsStoredTargetCodec)

	return {
		id: 'zerops',
		normalizeRegistration,
		deploy: async (input: ProviderDeployInput): Promise<ProviderTerminalOutcome> => {
			const registration = normalizeRegistration({ app: input.app, environment: input.environment })
			const target = decodeEnvelope('target', registration.environment.target, zeropsStoredTargetCodec)
			const artifact = decodeEnvelope('artifact', registration.environment.artifact, zeropsArtifactCodec)
			await options.beforeDeploy?.({
				appId: input.app.id,
				env: input.environment.env,
				target,
				artifact,
				api,
				signal: input.signal,
			})
			const runtimeTarget: ZeropsRuntimeTarget = {
				...target,
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
			storedTarget(input)
			await api.cancelBuild({ appVersionId: input.externalId, signal: abortSignal() })
		},
		reconcile: async (input): Promise<ProviderReconcileOutcome> => {
			storedTarget(input)
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
				const target = decodeEnvelope('target', input.environment.target, zeropsStoredTargetCodec)
				await api.putServiceEnv({
					serviceId: target.serviceId,
					key: input.name,
					value: input.value,
					signal: abortSignal(),
				})
				return { valueRef: `zerops:${target.serviceId}/${encodeURIComponent(input.name)}` }
			},
			delete: async (input) => {
				const target = decodeEnvelope('target', input.environment.target, zeropsStoredTargetCodec)
				const variables = await api.listServiceEnv({ serviceId: target.serviceId, signal: abortSignal() })
				const found = variables.find((variable) => variable.key === input.name)
				if (found !== undefined) {
					await api.deleteServiceEnv({ envId: found.id, signal: abortSignal() })
				}
			},
		},
	}
}
