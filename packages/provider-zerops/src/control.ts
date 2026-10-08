import { appEnvironmentId } from '@fabrika/auth-core'
import type {
	ControlProvider,
	JsonValue,
	ProviderApp,
	ProviderCancelOutcome,
	ProviderCodec,
	ProviderDeployInput,
	ProviderDeploymentNamespace,
	ProviderDeployOutcome,
	ProviderEnvelope,
	ProviderEnvironment,
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
import { createZeropsApi, waitForProcess, ZEROPS_ACTIVE, ZEROPS_TERMINAL, type ZeropsApi, type ZeropsAppVersion } from './api'
import { defaultSleep, defaultZeropsCollaborators, type Sleeper } from './collaborators'
import { createdServices, type ExposureAlerter, isObjectStorageType } from './exposure'
import { assertAuthoredManagedInputs, assertAuthoredManagedName, assertNoFrameworkReference, parseManagedValues } from './managed-env'
import {
	assertFabrikaManifestCoordinates,
	type FabrikaManifest,
	manifestServiceHostnames,
	renderFabrikaImportYaml,
	renderFabrikaProvisioningYaml,
	verifyZeropsArtifactSourceDescriptor,
	zeropsArtifactCodec,
} from './manifest'
import {
	createZeropsNamespaceCapabilities,
	type ZeropsNamespaceProxySource,
	type ZeropsNamespaceTarget,
	zeropsNamespaceTargetCodec,
} from './namespace'
import { createZeropsDeployer, ZEROPS_VERSION_DEADLINE_MS } from './provider'
import { allowedReferenceHosts, foreignReferenceHost, serviceReferenceHosts } from './service-references'
import { normalizeZeropsSourceRepository } from './source'
import type { ZeropsSourcePort, ZeropsSourcePrivateBinding } from './source/port'
import type { ZeropsRunState, ZeropsRuntimeTarget } from './types'
import { deleteVersion, isVersionNotFound } from './version-attempt'

/** Provider coordinates that are safe to persist. Credentials are composed only for a live run. */
export interface ZeropsStoredTarget {
	serviceId: string
	/**
	 * The object-storage service ids the first registration's collision-refusing import created: the creation evidence
	 * the first deploy writes into the provenance marker (ADR-0043). Absent when that import created no bucket.
	 */
	createdBuckets?: string[]
}

const storedTargetSchema = z.object({ serviceId: z.string().min(1), createdBuckets: z.array(z.string().min(1)).min(1).optional() })

export const zeropsStoredTargetCodec: ProviderCodec<ZeropsStoredTarget> = {
	version: 2,
	encode: (target) => ({
		serviceId: target.serviceId,
		...(target.createdBuckets === undefined ? {} : { createdBuckets: [...target.createdBuckets] }),
	}),
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

export interface ZeropsControlProviderOptions {
	readonly accessToken: string
	readonly apiBaseUrl?: string
	readonly propustkaUrl?: string
	readonly adminKey?: string
	readonly api?: ZeropsApi
	readonly source: ZeropsSourcePort
	readonly reconcileSchema?: SchemaReconciler
	readonly alertExposure?: ExposureAlerter
	readonly sleep?: Sleeper
	readonly namespaces?: {
		readonly clientId: string
		readonly proxySource: ZeropsNamespaceProxySource
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
): DecodedZeropsEnvironment & { projectId: string } => {
	const decoded = decodeEnvironment(environment)
	const projectId = decoded.namespaceTarget.projectId
	if (projectId === undefined) {
		throw new Error(`Zerops deployment namespace \`${decoded.namespace.id}\` has no project id`)
	}
	if (options.requireReady && decoded.namespaceTarget.ready !== true) {
		throw new Error(`Zerops deployment namespace \`${decoded.namespace.id}\` is not ready`)
	}
	return { ...decoded, projectId }
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

/** Every private Zerops source names its keyed connection (ADR-0029). */
const privateBinding = (binding: ProviderSourceBinding | undefined): ZeropsSourcePrivateBinding | undefined =>
	binding === undefined ? undefined : { connectionId: binding.connectionId, installationId: binding.installationId }

const IMMUTABLE_GIT_OBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/

const checkpointSchema = z.object({ appVersionId: z.string().min(1), triggered: z.boolean() }).strict()

/** The run checkpoint (ADR-0044), or null for anything else — an older shape included. */
export const parseZeropsCheckpoint = (value: unknown): ZeropsRunState | null => {
	const result = checkpointSchema.safeParse(value)
	return result.success ? result.data : null
}

/** The recorded checkpoint for exactly this run's external id, or null. */
const runCheckpoint = (input: { providerState?: JsonValue; externalId: string }): ZeropsRunState | null => {
	const checkpoint = parseZeropsCheckpoint(input.providerState)
	return checkpoint !== null && checkpoint.appVersionId === input.externalId ? checkpoint : null
}

const pastDeadline = (startedAtMs: number | undefined): boolean => startedAtMs !== undefined && Date.now() > startedAtMs + ZEROPS_VERSION_DEADLINE_MS

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
			if (!isVersionNotFound(error)) throw error
			return null
		}
	}
	const deployRun = createZeropsDeployer((target) => {
		const defaults = defaultZeropsCollaborators(target)
		return {
			api,
			source: options.source,
			reconcileSchema: options.reconcileSchema ?? defaults.reconcileSchema,
			alertExposure: options.alertExposure ?? defaults.alertExposure,
			sleep: options.sleep ?? defaultSleep,
		}
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
		input: { environment: ProviderEnvironment; returnOrigins?: readonly string[] },
		signal: AbortSignal,
	): Promise<void> => {
		const artifact = artifactFor(input.environment)
		if (artifact.app.schema === undefined || options.propustkaUrl === undefined) return
		const placement = resolvedEnvironment(input.environment, { requireReady: false })
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
			app: appEnvironmentId(artifact.app.id, artifact.app.env),
			schema: artifact.app.schema,
			...(input.returnOrigins === undefined || input.returnOrigins.length === 0 ? {} : { returnOrigins: input.returnOrigins }),
			adminKey: options.adminKey,
			signal,
		})
	}

	const assertVersionCoordinates = (environment: ProviderEnvironment, appVersionId: string, version: ZeropsAppVersion): void => {
		const serviceId = decodeEnvironment(environment).target.serviceId
		if (version.id !== appVersionId || (version.serviceStackId !== undefined && version.serviceStackId !== serviceId)) {
			throw new Error('Zerops app-version response has different coordinates')
		}
	}

	/** Best-effort: a refused or slow cancel-build must not decide the outcome. */
	const cancelBuildQuietly = async (appVersionId: string, signal: AbortSignal): Promise<void> => {
		signal.throwIfAborted()
		await api.cancelBuild({ appVersionId, signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) }).catch(() => {})
	}

	const resolveSource = async (input: ProviderSourceResolutionInput): Promise<ProviderSourceResolution> => {
		const binding = privateBinding(input.sourceBinding)
		assertEnvironmentOfApp(input.app, input.environment)
		decodeEnvironment(input.environment)
		const artifact = artifactFor(input.environment)
		await verifyZeropsArtifactSourceDescriptor(artifact.target.sourceDescriptor)
		const result = await options.source.resolve({
			repository: normalizeZeropsSourceRepository(input.app.source.repoUrl),
			requestedRef: input.app.source.ref,
			...(input.expectedCommitSha === undefined ? {} : { expectedCommitSha: input.expectedCommitSha }),
			...(binding === undefined ? {} : { privateBinding: binding }),
			descriptorSha256: artifact.target.sourceDescriptor.sha256,
			signal: input.signal,
		})
		if (
			result.descriptorSha256 !== artifact.target.sourceDescriptor.sha256
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
			assertAuthoredManagedInputs({ variableNames: Object.keys(input.vars), secretNames: Object.keys(input.secrets) })
			const managedEnvironment = parseManagedValues(input.managedEnvironment)
			const binding = privateBinding(input.sourceBinding)
			assertEnvironmentOfApp(input.app, input.environment)
			const placement = resolvedEnvironment(input.environment, { requireReady: true })
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
			const runtimeTarget: ZeropsRuntimeTarget = {
				projectId: placement.projectId,
				serviceId: placement.target.serviceId,
				accessToken: options.accessToken,
				...(placement.target.createdBuckets === undefined ? {} : { createdBuckets: placement.target.createdBuckets }),
				...(source === undefined ? {} : { source }),
				...(options.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
				...(options.propustkaUrl !== undefined ? { propustkaUrl: options.propustkaUrl } : {}),
				...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
			}
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
				events: input.events,
			})
			input.signal.throwIfAborted()
			return { state: result.status }
		},
		cancel: async (input): Promise<ProviderCancelOutcome> => {
			const signal = input.signal
			signal.throwIfAborted()
			const checkpoint = runCheckpoint(input)
			if (checkpoint === null) return { state: 'settled', outcome: 'failed' }
			if (!checkpoint.triggered) {
				try {
					await deleteVersion(api, checkpoint.appVersionId, signal)
				} catch {
					signal.throwIfAborted()
					return { state: 'pending' }
				}
				return { state: 'settled', outcome: 'failed' }
			}
			const version = await getVersion({ appVersionId: checkpoint.appVersionId, signal })
			if (version === null) return { state: 'settled', outcome: 'failed' }
			assertVersionCoordinates(input.environment, checkpoint.appVersionId, version)
			// Cancellation never implies rollback: a version that activated first makes the run a success,
			// which finishes the same IAM touchpoint a deploy does.
			if (version.status === ZEROPS_ACTIVE) {
				try {
					await reconcileActiveSchema(input, signal)
				} catch {
					signal.throwIfAborted()
					return { state: 'pending' }
				}
				return { state: 'settled', outcome: 'succeeded' }
			}
			if (version.status !== undefined && ZEROPS_TERMINAL.has(version.status)) return { state: 'settled', outcome: 'failed' }
			await cancelBuildQuietly(checkpoint.appVersionId, signal)
			// A build request that never landed leaves the version UPLOADING for good; the deadline settles it.
			return pastDeadline(input.startedAtMs) ? { state: 'settled', outcome: 'failed' } : { state: 'pending' }
		},
		reconcile: async (input): Promise<ProviderReconcileOutcome> => {
			const signal = input.signal
			signal.throwIfAborted()
			const log = async (line: string): Promise<void> => {
				await input.log?.(line).catch(() => {})
			}
			const checkpoint = runCheckpoint(input)
			if (checkpoint === null) {
				await log('unrecognised checkpoint; failing without platform calls')
				return { state: 'failed' }
			}
			if (!checkpoint.triggered) {
				// A throw keeps the run running; the next maintenance pass retries the deletion.
				await deleteVersion(api, checkpoint.appVersionId, signal)
				await log(`deleted app-version ${checkpoint.appVersionId}; its build was never requested`)
				return { state: 'failed' }
			}
			let version: ZeropsAppVersion | null
			try {
				version = await getVersion({ appVersionId: checkpoint.appVersionId, signal })
			} catch {
				signal.throwIfAborted()
				if (!pastDeadline(input.startedAtMs)) return { state: 'running' }
				await cancelBuildQuietly(checkpoint.appVersionId, signal)
				await log(`abandoned app-version ${checkpoint.appVersionId}: its status stayed unobservable past the run deadline`)
				return { state: 'failed' }
			}
			if (version === null) return { state: 'failed' }
			assertVersionCoordinates(input.environment, checkpoint.appVersionId, version)
			if (version.status === ZEROPS_ACTIVE) {
				await reconcileActiveSchema(input, signal)
				return { state: 'succeeded' }
			}
			if (version.status !== undefined && ZEROPS_TERMINAL.has(version.status)) return { state: 'failed' }
			if (pastDeadline(input.startedAtMs)) {
				await cancelBuildQuietly(checkpoint.appVersionId, signal)
				await log(`abandoned non-terminal app-version ${checkpoint.appVersionId} (${version.status ?? 'unknown'})`)
				return { state: 'failed' }
			}
			return { state: 'running' }
		},
		secrets: {
			put: async (input) => {
				assertAuthoredManagedName(input.name)
				assertNoFrameworkReference(input.name)
				assertNoFrameworkReference(input.value)
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
						if (present.length > 0 && (existingDeploy === null || existingDeploy === undefined)) {
							throw new Error('Zerops registration has no deploy service')
						}
						input.signal.throwIfAborted()
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
						const discovered = present.length === 0 ? reported : existingDeploy
						if (discovered === null || discovered === undefined || discovered.id === '') {
							throw new Error(`Zerops import did not create deploy service \`${manifest.target.deployService}\``)
						}
						// Only this collision-refusing import proves the platform created the buckets private (ADR-0043). The
						// evidence is persisted with the registration, so no write can fail between it and the first deploy.
						const created = present.length === 0 ? createdServices(imported) : new Map<string, string>()
						const createdBuckets = manifest.target.importDocument.services.flatMap((service) => {
							const id = isObjectStorageType(service.type) ? created.get(service.hostname) : undefined
							return id === undefined ? [] : [id]
						})
						return normalizeRegistration({
							app: input.registration.app,
							environment: {
								...input.registration.environment,
								target: envelope(zeropsStoredTargetCodec, {
									serviceId: discovered.id,
									...(createdBuckets.length === 0 ? {} : { createdBuckets }),
								}),
							},
						})
					},
				},
			}),
	}
	return controlProvider
}
