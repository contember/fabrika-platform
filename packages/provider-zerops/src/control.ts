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
	ProviderSourceDescriptorInput,
	ProviderSourceResolution,
	ProviderSourceResolutionInput,
} from '@fabrika/provider-contract'
import { cancelRun, decodeEnvelope, ProviderSecretError, reconcileRun } from '@fabrika/provider-contract'
import { z } from 'zod'
import { createZeropsApi, waitForProcess, type ZeropsApi, ZeropsServiceEnvValueTooLargeError } from './api'
import { lockfileBuildBaseRefusal } from './build-base'
import { defaultSleep, defaultZeropsCollaborators, type Sleeper } from './collaborators'
import { createdServices, type ExposureAlerter, isObjectStorageType, readExposure } from './exposure'
import { assertApplicationSecretName, assertAuthoredManagedInputs, assertAuthoredManagedName, assertNoFrameworkReference } from './managed-env'
import {
	assertFabrikaManifestCoordinates,
	createZeropsArtifactSourceDescriptor,
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
	type ZeropsNamespaceProxySource,
	type ZeropsNamespaceTarget,
	zeropsNamespaceTargetCodec,
} from './namespace'
import { namespaceError, ZEROPS_DEV_TARGET_RETIRED } from './namespace/errors'
import { assertNamespaceProxyAcceptsSandboxes, assertNamespaceProxyReads, type OlderProxyReaders } from './namespace/proxy-reads'
import type { ZeropsNamespaceSandboxHost } from './namespace/types'
import { createZeropsDeployer } from './provider'
import { zeropsRunAttempt } from './run-attempt'
import { deploySandbox, parseSandboxCheckpoint } from './sandbox/deploy'
import { assertSandboxArtifact } from './sandbox/dev-artifact'
import { createZeropsDevSandboxes } from './sandbox/lifecycle'
import { allowedReferenceHosts, assertNoPlatformOnlyReference, foreignReferenceHost, serviceReferenceHosts } from './service-references'
import { normalizeZeropsSourceRepository } from './source'
import type { ZeropsSourcePort, ZeropsSourcePrivateBinding } from './source/port'
import type { ZeropsRuntimeTarget } from './types'
import { createZboxClient, type ZboxClient, type ZboxFetch } from './zbox'

/** Provider coordinates that are safe to persist. Credentials are composed only for a live run. */
export type ZeropsStoredTarget = ZeropsServiceTarget | ZeropsDevSandboxesTarget

/** An environment served by its own Zerops service. */
export interface ZeropsServiceTarget {
	serviceId: string
	/**
	 * The object-storage service ids the first registration's collision-refusing import created: the creation evidence
	 * the first deploy writes into the provenance marker (ADR-0043). Absent when that import created no bucket.
	 */
	createdBuckets?: string[]
}

/** A `dev` environment: it has no service, and each MCP workspace runs in a sandbox of the namespace's sandbox host. */
export interface ZeropsDevSandboxesTarget {
	kind: 'devSandboxes'
}

const storedTargetSchema = z.union([
	z.object({ kind: z.literal('devSandboxes') }).strict(),
	z.object({ serviceId: z.string().min(1), createdBuckets: z.array(z.string().min(1)).min(1).optional() }),
])

// The dev variant is additive: every stored service target still reads as it did, so the version stays.
export const zeropsStoredTargetCodec: ProviderCodec<ZeropsStoredTarget> = {
	version: 2,
	encode: (target): JsonValue => {
		if ('kind' in target) return { kind: target.kind }
		return {
			serviceId: target.serviceId,
			...(target.createdBuckets === undefined ? {} : { createdBuckets: [...target.createdBuckets] }),
		}
	},
	decode: (payload) => {
		const result = storedTargetSchema.safeParse(payload)
		if (!result.success) throw new Error('Zerops stored target serviceId must be a non-empty string')
		return result.data
	},
}

/** The service of a target that has one; a dev environment's sandboxes are not one. */
const serviceTargetOf = (target: ZeropsStoredTarget): ZeropsServiceTarget => {
	if ('kind' in target) throw new Error('zerops: a dev environment runs in workspace sandboxes and has no Zerops service')
	return target
}

const envelope = <T>(codec: ProviderCodec<T>, value: T): ProviderEnvelope => ({
	provider: 'zerops',
	version: codec.version,
	payload: codec.encode(value),
})

export interface ZeropsControlProviderOptions {
	readonly accessToken: string
	readonly apiBaseUrl?: string
	readonly api?: ZeropsApi
	readonly source: ZeropsSourcePort
	readonly alertExposure?: ExposureAlerter
	readonly sleep?: Sleeper
	readonly namespaces?: {
		readonly clientId: string
		readonly proxySource: ZeropsNamespaceProxySource
		readonly iamUrl: string
		readonly iamKey: string
		/** The installation's own project, which no namespace may adopt. */
		readonly installationProjectId?: string
		/** The manifest parsers of the older releases' proxies, which a namespace pinned to an older source may run. */
		readonly olderProxies: OlderProxyReaders
	}
	/** The transport of the sandbox host API; tests pass a fake. */
	readonly zboxFetch?: ZboxFetch
	/** Where a provider event outside a run is reported (a dev sandbox replaced); the process's stderr by default. */
	readonly log?: (line: string) => void
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

export { parseZeropsCheckpoint } from './run-attempt'

/** Build the complete Zerops lifecycle bundle without importing control-plane persistence. */
export const createZeropsControlProvider = (options: ZeropsControlProviderOptions): ControlProvider => {
	if (options.accessToken === '') {
		throw new Error('Zerops access token must be a non-empty string')
	}
	const api = options.api ?? createZeropsApi({ token: options.accessToken, baseUrl: options.apiBaseUrl })
	/** The run's app version on the environment's own service; a dev environment has none, which the read then refuses. */
	const runAttempt = (environment: ProviderEnvironment) =>
		zeropsRunAttempt(api, () => serviceTargetOf(decodeEnvironment(environment).target).serviceId)
	const deployRun = createZeropsDeployer((target) => {
		const defaults = defaultZeropsCollaborators(target)
		return {
			api,
			source: options.source,
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

	/**
	 * The artifact with the commit's `zerops.yaml`, through the parse a registration's decode runs (ADR-0043). Only a
	 * contract application's: `fabrika app build` checks the run section of any other for plain credentials, with the
	 * `notSecret` list of its config, which the stored manifest does not carry.
	 */
	const withSourceDescriptor = async (input: ProviderSourceDescriptorInput): Promise<ProviderEnvelope | null> => {
		const artifact = artifactFor(input.environment)
		if (artifact.target.contract === undefined) return null
		if (input.path !== artifact.target.sourceDescriptor.path) {
			throw new Error(`zerops: the build descriptor is ${artifact.target.sourceDescriptor.path}, not ${input.path}`)
		}
		const sourceDescriptor = await createZeropsArtifactSourceDescriptor(input.contents)
		const candidate = { ...artifact, target: { ...artifact.target, sourceDescriptor } }
		const manifest = parseFabrikaManifest(zeropsArtifactCodec.encode(candidate), { appId: input.environment.appId, env: input.environment.env })
		return envelope(zeropsArtifactCodec, manifest)
	}

	/** The namespace's sandbox host, which runs the workspace sandboxes of its dev environment; null until it is created. */
	const sandboxHostOf = (environment: ProviderEnvironment): ZeropsNamespaceSandboxHost | null => {
		const { target, namespaceTarget } = decodeEnvironment(environment)
		// An older release registered a dev environment as its own Zerops service; it never runs in a sandbox.
		if (environment.kind === 'dev' && !('kind' in target)) {
			throw namespaceError(
				ZEROPS_DEV_TARGET_RETIRED,
				`zerops: dev environment \`${environment.appId}/${environment.env}\` was registered with its own Zerops service, which this release `
					+ 'no longer runs; delete the environment and register it again with --kind=dev and a wildcard domain',
				false,
			)
		}
		return namespaceTarget.sandboxHost ?? null
	}

	const sandboxClient = (apiOrigin: string, sandboxKey: string): ZboxClient =>
		createZboxClient({ baseUrl: apiOrigin, apiKey: sandboxKey, ...(options.zboxFetch === undefined ? {} : { fetch: options.zboxFetch }) })

	const devSandboxes = createZeropsDevSandboxes({
		client: (environment, sandboxKey) => {
			const host = sandboxHostOf(environment)
			return host === null ? null : sandboxClient(host.apiOrigin, sandboxKey)
		},
		admit: (environment) => {
			sandboxHostOf(environment)
			const { namespace, namespaceTarget } = decodeNamespace(environment)
			assertNamespaceProxyAcceptsSandboxes(namespace.id, namespaceTarget.proxySource)
		},
		sleep: options.sleep ?? defaultSleep,
		log: options.log ?? ((line) => console.warn(line)),
	})

	/**
	 * A dev environment imports no service: each workspace gets a sandbox when it binds. What a sandbox cannot give the
	 * application is refused here, before anything is created.
	 */
	const prepareDevRegistration = (
		registration: ProviderRegistration,
		namespaceId: string,
		namespaceTarget: ZeropsNamespaceTarget,
	): ProviderRegistration => {
		if (namespaceTarget.publicAccess === 'zerops-subdomain') {
			throw new Error(
				`zerops: a dev environment serves each workspace on its own host, so namespace \`${namespaceId}\` needs custom-domain public access`,
			)
		}
		const manifest = decodeEnvelope('artifact', 'zerops', registration.environment.artifact, zeropsArtifactCodec)
		assertFabrikaManifestCoordinates(manifest.app, { appId: registration.app.id, env: registration.environment.env })
		assertSandboxArtifact(manifest)
		return normalizeRegistration({
			app: registration.app,
			environment: { ...registration.environment, target: envelope(zeropsStoredTargetCodec, { kind: 'devSandboxes' }) },
		})
	}

	const controlProvider: ControlProvider = {
		id: 'zerops',
		normalizeRegistration,
		// The deploy reads `zerops.yaml` from the repository, so a workspace may not change it (ADR-0049 D6).
		authoring: { protectedFiles: ['zerops.yaml', 'zerops.yml'] },
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
		declaredSecrets: ({ artifact }) => {
			try {
				return decodeEnvelope('artifact', 'zerops', artifact, zeropsArtifactCodec).app.pipeline.secrets
			} catch {
				return undefined
			}
		},
		resolveSource,
		withSourceDescriptor,
		validateAccess: ({ environment, access }) => {
			const placement = resolvedEnvironment(environment, { requireReady: true })
			assertNamespaceProxyReads(placement.namespace.id, access, placement.namespaceTarget.proxySource, options.namespaces)
		},
		// The check `fabrika app build` runs, on the commit a run deploys. A dev sandbox builds on its own image, not `build.base`.
		lockfileRefusal: ({ environment, lockfile }) => environment.kind === 'dev' ? null : lockfileBuildBaseRefusal(artifactFor(environment), lockfile),
		deploy: async (input: ProviderDeployInput): Promise<ProviderDeployOutcome> => {
			input.signal.throwIfAborted()
			assertAuthoredManagedInputs({ variableNames: Object.keys(input.vars), secretNames: Object.keys(input.secrets) })
			for (const name of Object.keys(input.secrets)) assertApplicationSecretName(name)
			const binding = privateBinding(input.sourceBinding)
			assertEnvironmentOfApp(input.app, input.environment)
			const placement = resolvedEnvironment(input.environment, { requireReady: true })
			assertNamespaceProxyReads(placement.namespace.id, input.environment.access, placement.namespaceTarget.proxySource, options.namespaces)
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
			if (input.devSandbox !== undefined && input.environment.kind !== 'dev') {
				throw new Error('zerops: only a dev environment deploys into a workspace sandbox')
			}
			if (input.environment.kind === 'dev') {
				if (input.devSandbox === undefined) throw new Error('zerops: a dev environment deploys only into a workspace sandbox, through bind_dev')
				const host = sandboxHostOf(input.environment)
				if (host === null) throw new Error("zerops: the namespace's sandbox host is not created yet; bind the workspace again")
				const result = await deploySandbox({
					appId: input.app.id,
					env: input.environment.env,
					runId: input.runId,
					artifact,
					access: input.environment.access,
					vars: input.vars,
					secrets: input.secrets,
					managedEnvironment: input.managedEnvironment,
					...(source === undefined
						? {}
						: {
							source: {
								repository: source.repository,
								commitSha: source.commitSha,
								...(source.privateBinding === undefined ? {} : { privateBinding: source.privateBinding }),
							},
						}),
					sandbox: { sandboxId: input.devSandbox.sandboxId, apiOrigin: host.apiOrigin, sandboxKey: input.devSandbox.sandboxKey },
					client: sandboxClient(host.apiOrigin, input.devSandbox.sandboxKey),
					sourcePort: options.source,
					sleep: options.sleep ?? defaultSleep,
					dryRun: input.dryRun,
					signal: input.signal,
					events: input.events,
				})
				input.signal.throwIfAborted()
				return { state: result.status }
			}
			const serviceTarget = serviceTargetOf(placement.target)
			const runtimeTarget: ZeropsRuntimeTarget = {
				projectId: placement.projectId,
				serviceId: serviceTarget.serviceId,
				accessToken: options.accessToken,
				...(serviceTarget.createdBuckets === undefined ? {} : { createdBuckets: serviceTarget.createdBuckets }),
				...(source === undefined ? {} : { source }),
				...(options.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
			}
			const result = await deployRun({
				appId: input.app.id,
				env: input.environment.env,
				secrets: input.secrets,
				vars: input.vars,
				managedEnvironment: input.managedEnvironment,
				target: runtimeTarget,
				artifact,
				...(input.environment.access === undefined ? {} : { access: input.environment.access }),
				...(input.artifactUpload === undefined ? {} : { artifactUpload: input.artifactUpload }),
				...(input.backupBeforeMigrations === undefined
					? {}
					: { backupBeforeMigrations: { migrations: input.backupBeforeMigrations.migrations, runId: input.runId } }),
				dryRun: input.dryRun,
				signal: input.signal,
				events: input.events,
			})
			input.signal.throwIfAborted()
			return { state: result.status, ...(result.artifactState === undefined ? {} : { artifactState: result.artifactState }) }
		},
		/**
		 * The deploy's exposure read-back between deploys. Nothing was imported, so only the marker and the stored target
		 * vouch for a bucket, and a declared service the project does not hold yet is left to the deploy that creates it.
		 */
		exposure: {
			check: async ({ environment, signal }) => {
				signal.throwIfAborted()
				const placement = resolvedEnvironment(environment, { requireReady: false })
				const target = serviceTargetOf(placement.target)
				const { findings } = await readExposure({
					api,
					artifact: artifactFor(environment),
					projectId: placement.projectId,
					serviceId: target.serviceId,
					created: new Map<string, string>(),
					createdBuckets: target.createdBuckets ?? [],
					signal,
					assertRunning: (running) => running.throwIfAborted(),
				})
				return findings.flatMap((finding) => finding.absent === true ? [] : [{ service: finding.hostname, reason: finding.reason }])
			},
		},
		devSandboxes,
		cancel: async (input): Promise<ProviderCancelOutcome> => {
			input.signal.throwIfAborted()
			// The deploy's own invocation stops a sandbox build on a cancel; nothing here holds the sandbox host's key.
			if (parseSandboxCheckpoint(input) !== null) return { state: 'settled', outcome: 'failed' }
			return cancelRun(runAttempt(input.environment), input)
		},
		reconcile: async (input): Promise<ProviderReconcileOutcome> => {
			input.signal.throwIfAborted()
			if (parseSandboxCheckpoint(input) !== null) {
				await input.log?.('deploy interrupted: Control stopped while it deployed into the workspace sandbox; bind the workspace again').catch(() => {})
				return { state: 'failed' }
			}
			return reconcileRun(runAttempt(input.environment), input)
		},
		secrets: {
			put: async (input) => {
				assertApplicationSecretName(input.name)
				assertNoFrameworkReference(input.name)
				assertNoFrameworkReference(input.value)
				assertNoPlatformOnlyReference(input.name)
				assertNoPlatformOnlyReference(input.value)
				assertOwnReferencesOnly(input.environment, input.name, input.value)
				const stored = decodeEnvironment(input.environment).target
				if ('kind' in stored) {
					throw new ProviderSecretError(
						'zerops: a dev environment runs in workspace sandboxes and keeps no secret on a Zerops service',
						'devEnvironment',
					)
				}
				const target = stored
				try {
					await api.putServiceEnv({
						serviceId: target.serviceId,
						key: input.name,
						value: input.value,
						sensitive: true,
						signal: abortSignal(),
					})
				} catch (cause) {
					if (cause instanceof ZeropsServiceEnvValueTooLargeError) throw new ProviderSecretError(cause.message, cause.code)
					throw cause
				}
				return { valueRef: `zerops:${target.serviceId}/${encodeURIComponent(input.name)}` }
			},
			delete: async (input) => {
				assertAuthoredManagedName(input.name)
				const stored = decodeEnvironment(input.environment).target
				// A dev environment's put refuses, so there is nothing to delete.
				if ('kind' in stored) return
				const target = stored
				const variables = await api.listServiceEnv({ serviceId: target.serviceId, signal: abortSignal() })
				const found = variables.find((variable) => variable.key === input.name)
				if (found !== undefined) {
					await api.deleteServiceEnv({ envId: found.id, signal: abortSignal() })
				}
			},
			// The record id moves on a delete and re-create, `lastUpdate` on a write in place; the value is never read.
			version: async (input) => {
				const stored = decodeEnvironment(input.environment).target
				if ('kind' in stored) return null
				const variables = await api.listServiceEnv({ serviceId: stored.serviceId, signal: abortSignal() })
				const found = variables.find((variable) => variable.key === input.name)
				if (found === undefined) return null
				if (found.lastUpdate === undefined) throw new Error(`zerops: the record of \`${input.name}\` carries no last update, so its version is unknown`)
				return `${found.id}@${found.lastUpdate}`
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
						if (input.registration.environment.kind === 'dev') return prepareDevRegistration(input.registration, namespace.id, namespaceTarget)
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
