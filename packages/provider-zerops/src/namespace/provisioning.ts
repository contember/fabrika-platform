import {
	type ProviderDeploymentNamespace,
	type ProviderNamespaceCapabilities,
	type ProviderNamespaceHost,
	type ProviderNamespaceMutationInput,
	type ProviderNamespaceRepublishInput,
	type ProviderNamespaceRepublishResult,
} from '@fabrika/provider-contract'
import { waitForProcess, ZEROPS_SERVICE_NOT_HTTP, ZEROPS_TERMINAL, ZeropsApiError, type ZeropsProject, type ZeropsService } from '../api'
import { defaultSleep } from '../collaborators'
import { namespaceResourceClaims, registrationResourceClaims } from './claims'
import { checkpoint, decodeEnvelope, normalizedNamespace, normalizeTarget } from './codec'
import { ZEROPS_NAMESPACE_POSTGRES_HOSTNAME, ZEROPS_NAMESPACE_PROXY_HOSTNAME, ZEROPS_NAMESPACE_SUBDOMAIN_VARIABLE } from './constants'
import { asNamespaceError, namespaceError, ZEROPS_NAMESPACE_CANCELLED, ZEROPS_SUBDOMAIN_NOT_PUBLISHED } from './errors'
import { compileNamespaceProxyManifest } from './manifest'
import { createZeropsNamespaceOperator } from './operator'
import { republishProxy } from './proxy-attempt'
import { verifyZeropsNamespaceProxySource } from './proxy-source'
import { compileZeropsNamespaceTopology, projectMarker, PROXY_TYPE } from './topology'
import type { NormalizedZeropsNamespaceTarget, ZeropsNamespaceOptions, ZeropsNamespaceProxySource } from './types'

const POLL_INTERVAL_MS = 3000

/** The live enable finishes in under a second, but one run still read `false` once before flipping; ten reads is slack. */
const SUBDOMAIN_READBACK_ATTEMPTS = 10

/**
 * One host per published HTTP port, out of the newline-separated URLs the platform writes.
 *
 * The form is `<hostname>-<hash>-<port>.<region>.zerops.app` (e.g. `proxy-2ec8-8080`). Read as URLs
 * rather than split on `-`, so a hostname whose own first label ends in digits cannot be misread; a line
 * that is not a URL, or whose first label carries no trailing port — the single portless line a proxy
 * that has never deployed publishes — is skipped rather than guessed at.
 */
const parseZeropsProxyHosts = (value: string): ProviderNamespaceHost[] => {
	const hosts: ProviderNamespaceHost[] = []
	for (const line of value.split('\n')) {
		const trimmed = line.trim()
		if (trimmed === '') continue
		let hostname: string
		try {
			hostname = new URL(trimmed).hostname
		} catch {
			continue
		}
		const port = /-(\d+)$/.exec(hostname.split('.')[0] ?? '')?.[1]
		if (port === undefined) continue
		hosts.push({ host: hostname, port: Number.parseInt(port, 10) })
	}
	return hosts.sort((left, right) => left.port - right.port)
}

const validateProject = (
	namespace: ProviderDeploymentNamespace,
	target: NormalizedZeropsNamespaceTarget,
	project: ZeropsProject,
	adopting: boolean,
): void => {
	if (project.id === '') {
		throw new Error('Zerops namespace project returned an empty id')
	}
	if (target.projectName !== project.name) {
		throw new Error(`Zerops namespace project name mismatch: expected \`${target.projectName}\`, got \`${project.name}\``)
	}
	if (project.mode !== target.corePackage) {
		throw new Error(`Zerops namespace project ${project.id} uses ${project.mode ?? 'an unknown core package'}, expected ${target.corePackage}`)
	}
	// Zerops does not expose project envIsolation. Every managed service import writes its own override.
	if (!adopting && target.managed && project.description?.includes(projectMarker(namespace)) !== true) {
		throw new Error(`Zerops namespace project ${project.id} has a different Fabrika ownership marker`)
	}
}

const managedProjectByMarker = async (
	namespace: ProviderDeploymentNamespace,
	target: NormalizedZeropsNamespaceTarget,
	options: ZeropsNamespaceOptions,
	signal: AbortSignal,
): Promise<ZeropsProject | null> => {
	const matches = await options.api.findProjects({
		clientId: options.clientId,
		name: target.projectName,
		signal,
	})
	const owned: ZeropsProject[] = []
	for (const match of matches) {
		const project = await options.api.getProject({ projectId: match.id, signal })
		if (project.description?.includes(projectMarker(namespace)) === true) {
			owned.push(project)
		}
	}
	if (owned.length > 1) {
		throw new Error(`Zerops namespace project name \`${target.projectName}\` has multiple matching Fabrika ownership markers`)
	}
	if (owned.length === 1) {
		return owned[0] ?? null
	}
	if (matches.length > 0) {
		throw new Error(`Zerops namespace project name \`${target.projectName}\` is already used without this namespace's ownership marker`)
	}
	return null
}

const uniqueService = (services: ZeropsService[], hostname: string): ZeropsService | null => {
	const matches = services.filter((service) => service.name === hostname)
	if (matches.length > 1) {
		throw new Error(`Zerops namespace has multiple services named \`${hostname}\``)
	}
	return matches[0] ?? null
}

const validateService = (
	service: ZeropsService,
	projectId: string,
	expectedBase: string,
	adopting: boolean,
	expectedPublic?: boolean,
	expectedProfile?: string,
): void => {
	if (service.id === '') {
		throw new Error(`Zerops namespace service \`${service.name}\` returned an empty id`)
	}
	if (service.projectId !== undefined && service.projectId !== projectId) {
		throw new Error(`Zerops namespace service \`${service.name}\` belongs to another project`)
	}
	if ((adopting || service.base !== undefined) && service.base !== expectedBase) {
		throw new Error(`Zerops namespace service \`${service.name}\` uses ${service.base ?? 'an unknown type'}, expected ${expectedBase}`)
	}
	if (expectedPublic !== undefined && adopting && service.subdomainAccess !== expectedPublic) {
		throw new Error(`Zerops namespace service \`${service.name}\` has incompatible public access`)
	}
	if (expectedProfile !== undefined && service.autoscalingProfileId !== expectedProfile) {
		throw new Error(
			`Zerops namespace service \`${service.name}\` uses profile ${service.autoscalingProfileId ?? 'unknown'}, expected ${expectedProfile}`,
		)
	}
}

const resolveServices = async (
	namespace: ProviderDeploymentNamespace,
	target: NormalizedZeropsNamespaceTarget,
	options: ZeropsNamespaceOptions,
	signal: AbortSignal,
	adopting: boolean,
): Promise<{ proxy: ZeropsService; postgres?: ZeropsService }> => {
	const projectId = target.projectId
	if (projectId === undefined) {
		throw new Error('Zerops namespace has no project id')
	}
	const services = await options.api.listProjectServices({ projectId, signal })
	const proxy = uniqueService(services, ZEROPS_NAMESPACE_PROXY_HOSTNAME)
	if (proxy === null) {
		throw new Error(`Zerops namespace project ${projectId} has no proxy service`)
	}
	validateService(
		proxy,
		projectId,
		PROXY_TYPE,
		adopting,
		target.publicAccess === 'zerops-subdomain',
	)
	const postgres = uniqueService(services, ZEROPS_NAMESPACE_POSTGRES_HOSTNAME)
	if (target.postgres === undefined && postgres !== null && adopting) {
		throw new Error(`Zerops namespace project ${projectId} has an undeclared namespace PostgreSQL service`)
	}
	if (target.postgres !== undefined) {
		if (postgres === null) {
			throw new Error(`Zerops namespace project ${projectId} has no shared PostgreSQL service`)
		}
		validateService(postgres, projectId, target.postgres.type, adopting, undefined, target.postgres.profile)
	}
	if (adopting && namespace.exclusiveAppId !== undefined) {
		const reserved = new Set([
			ZEROPS_NAMESPACE_PROXY_HOSTNAME,
			...(target.postgres === undefined ? [] : [ZEROPS_NAMESPACE_POSTGRES_HOSTNAME]),
		])
		const unexpected = services.filter((service) => !reserved.has(service.name))
		if (unexpected.length > 0) {
			throw new Error(`exclusive Zerops namespace project ${projectId} contains unmanaged service \`${unexpected[0]?.name ?? 'unknown'}\``)
		}
	}
	return postgres === null ? { proxy } : { proxy, postgres }
}

/**
 * The hosts the proxy publishes, off the platform-owned `zeropsSubdomain` variable.
 *
 * Read through the same `/env` listing every other namespace variable uses, and read AFTER the proxy is
 * published: the variable names a host per DEPLOYED HTTP port, so a proxy that never deployed names none.
 * Recording the answer in the target is what keeps `namespaces get` a database read.
 */
const readProxyHosts = async (
	namespace: ProviderDeploymentNamespace,
	target: NormalizedZeropsNamespaceTarget,
	options: ZeropsNamespaceOptions,
	signal: AbortSignal,
): Promise<readonly ProviderNamespaceHost[]> => {
	const proxyServiceId = target.proxyServiceId
	if (proxyServiceId === undefined) {
		throw new Error('Zerops namespace has no proxy service id')
	}
	try {
		const variables = await options.api.listServiceEnv({ serviceId: proxyServiceId, signal })
		const subdomains = variables.find((variable) => variable.key === ZEROPS_NAMESPACE_SUBDOMAIN_VARIABLE)
		return subdomains === undefined ? [] : parseZeropsProxyHosts(subdomains.content)
	} catch {
		// A host listing is a convenience; the proxy is already built, deployed and published. Failing the
		// namespace over it would report a placement that WORKS as broken. Never the cause: it can carry
		// upstream text this provider has not redacted.
		console.warn(
			`Zerops namespace ${namespace.id}: reading the published proxy hosts failed; the placement is ready and lists none until its next reconcile`,
		)
		return []
	}
}

const resolveProxySource = async (source: ZeropsNamespaceProxySource, options: ZeropsNamespaceOptions, signal: AbortSignal): Promise<void> => {
	if (options.source === undefined) throw new Error('Zerops namespace source client is required')
	signal.throwIfAborted()
	const resolved = await options.source.resolve({
		repository: source.repository,
		requestedRef: source.commitSha,
		expectedCommitSha: source.commitSha,
		descriptorSha256: source.descriptor.sha256,
		signal,
	})
	if (resolved.commitSha !== source.commitSha || resolved.descriptorSha256 !== source.descriptor.sha256) {
		throw new Error('Proxy source resolution identity mismatch')
	}
}

const deployProxy = async (
	input: ProviderNamespaceMutationInput,
	namespace: ProviderDeploymentNamespace,
	target: NormalizedZeropsNamespaceTarget,
	options: ZeropsNamespaceOptions,
	wait: ProviderNamespaceRepublishInput['wait'],
): Promise<{ namespace: ProviderDeploymentNamespace; target: NormalizedZeropsNamespaceTarget }> => {
	let currentNamespace = namespace
	const result = await republishProxy({
		target,
		manifest: compileNamespaceProxyManifest(namespace.id, input.members),
		...(options.source === undefined ? {} : { source: options.source }),
		api: options.api,
		iamUrl: options.iamUrl,
		iamKey: options.iamKey,
		signal: input.signal,
		wait,
		sleep: options.sleep ?? defaultSleep,
		boundary: () => input.events.boundary(),
		checkpoint: async next => {
			currentNamespace = await checkpoint(input, currentNamespace, { ...target, ...next })
		},
	})
	return { namespace: currentNamespace, target: { ...target, ...result } }
}

/** Rebuild a ready namespace's proxy from its current members; provisioning stays with `provision`/`reconcile`. */
const republishNamespace = async (
	input: ProviderNamespaceRepublishInput,
	options: ZeropsNamespaceOptions,
): Promise<ProviderNamespaceRepublishResult> => {
	const namespace = normalizedNamespace(input.namespace, options)
	const target = normalizeTarget(namespace, options)
	if (target.proxyServiceId === undefined || (target.proxyBuild === undefined && !target.ready)) {
		throw new Error(`Namespace ${namespace.id} is not ready`)
	}
	const deployed = await deployProxy(input, namespace, target, options, input.wait)
	return { namespace: deployed.namespace, settled: deployed.target.proxyBuild === undefined && deployed.target.ready }
}

/**
 * Publish the proxy on its `*.zerops.app` subdomain — the ONE thing the import document cannot do.
 *
 * `enableSubdomainAccess: true` is accepted by the import and then silently dropped, on a service the
 * document CREATES as much as on one `override` leaves alone; a service imported with it reads back
 * `subdomainAccess: false` for ever. The subdomain is established by
 * `PUT /service-stack/{id}/enable-subdomain-access` and by nothing else, and that call needs a DEPLOYED
 * HTTP port — which is why this runs after `deployProxy` rather than beside the import.
 *
 * It runs on RECONCILE too, so a subdomain someone turned off in the GUI comes back. What it must never
 * do is finish quietly: `zerops-subdomain` is the only public entry a namespace has, so this either
 * observes `subdomainAccess === true` or throws naming what is missing.
 *
 * The decision is the READ-BACK, never the call returning. On an already-published service the platform
 * answers 2xx and then fails the process it handed back — live-verified — so a 2xx proves nothing.
 */
const ensureSubdomainAccess = async (
	target: NormalizedZeropsNamespaceTarget,
	options: ZeropsNamespaceOptions,
	signal: AbortSignal,
): Promise<void> => {
	const proxyServiceId = target.proxyServiceId
	if (proxyServiceId === undefined) {
		throw new Error('Zerops namespace has no proxy service id')
	}
	const published = async (): Promise<boolean> => (await options.api.getService({ serviceId: proxyServiceId, signal })).subdomainAccess === true
	if (await published()) {
		return
	}
	try {
		await options.api.enableSubdomainAccess({ serviceId: proxyServiceId, signal })
	} catch (error) {
		if (error instanceof ZeropsApiError && error.code === ZEROPS_SERVICE_NOT_HTTP) {
			throw namespaceError(
				ZEROPS_SERVICE_NOT_HTTP,
				`Zerops namespace proxy ${proxyServiceId} cannot be published on a zerops.app subdomain: it exposes no deployed HTTP port (${ZEROPS_SERVICE_NOT_HTTP})`,
				false,
			)
		}
		throw error
	}
	for (let attempt = 0;; attempt += 1) {
		if (signal.aborted) {
			throw namespaceError(ZEROPS_NAMESPACE_CANCELLED, 'Zerops namespace provisioning was cancelled', true)
		}
		if (await published()) {
			return
		}
		if (attempt >= SUBDOMAIN_READBACK_ATTEMPTS) {
			throw namespaceError(
				ZEROPS_SUBDOMAIN_NOT_PUBLISHED,
				`Zerops namespace proxy ${proxyServiceId} accepted enable-subdomain-access but still reads subdomainAccess: false — the namespace has no public entry point`,
				true,
			)
		}
		await (options.sleep ?? defaultSleep)(POLL_INTERVAL_MS, signal)
	}
}

/** Every exit from the lifecycle below is a `ProviderNamespaceError`, so a caller never has to guess. */
const mutateNamespace = async (
	input: ProviderNamespaceMutationInput,
	options: ZeropsNamespaceOptions,
	mode: 'provision' | 'reconcile',
): Promise<ProviderDeploymentNamespace> => {
	try {
		return await runNamespaceMutation(input, options)
	} catch (cause) {
		throw asNamespaceError(cause, mode)
	}
}

const runNamespaceMutation = async (
	input: ProviderNamespaceMutationInput,
	options: ZeropsNamespaceOptions,
): Promise<ProviderDeploymentNamespace> => {
	const suppliedTarget = decodeEnvelope(input.namespace.target)
	let namespace = normalizedNamespace(input.namespace, options)
	let target = normalizeTarget(namespace, options)
	if (target.proxySource === undefined) throw new Error('Zerops namespace proxy source is unpinned; explicit migration is required')
	if (target.proxyBaselineSequence !== undefined || target.proxyAppVersionId !== undefined) {
		throw new Error('Legacy proxy operational checkpoints require explicit migration')
	}
	if (target.proxyBuild !== undefined && (target.projectId === undefined || target.proxyServiceId === undefined)) {
		throw new Error('Proxy build is missing checkpointed project or service identity')
	}
	await verifyZeropsNamespaceProxySource(target.proxySource)
	input.signal.throwIfAborted()
	if (target.proxyBuild === undefined && target.proxyDeployment !== undefined) {
		try {
			const version = await options.api.getAppVersion({ appVersionId: target.proxyDeployment.appVersionId, signal: input.signal })
			if (version.id !== target.proxyDeployment.appVersionId || version.status === undefined || !ZEROPS_TERMINAL.has(version.status)) {
				throw new Error('unresolved')
			}
		} catch {
			input.signal.throwIfAborted()
			await checkpoint(input, namespace, { ...target, ready: false })
			throw namespaceError('proxyAttemptUnresolved', `Proxy version ${target.proxyDeployment.appVersionId} remains unresolved`, true)
		}
	}
	if (target.proxyBuild === undefined && target.proxyDeployment === undefined) await resolveProxySource(target.proxySource, options, input.signal)
	const initiallyAdopted = target.projectId !== undefined && target.managed === false
		&& target.proxyServiceId === undefined && target.proxyDeployment === undefined
	const topology = compileZeropsNamespaceTopology(namespace, target)

	if (target.projectId === undefined) {
		const recovered = await managedProjectByMarker(namespace, target, options, input.signal)
		const result = recovered === null
			? await options.api.importProject({ clientId: options.clientId, yaml: topology.createYaml, signal: input.signal })
			: { projectId: recovered.id, projectName: recovered.name, services: [] }
		if (result.projectId === '') {
			throw new Error('Zerops namespace project import returned an empty project id')
		}
		target = { ...target, projectId: result.projectId, managed: true }
		namespace = await checkpoint(input, namespace, target)
		for (const service of result.services) {
			for (const process of service.processes) {
				await waitForProcess({
					api: options.api,
					processId: process.id,
					sleep: options.sleep ?? defaultSleep,
					signal: input.signal,
					label: 'namespace import',
				})
			}
		}
	}

	const projectId = target.projectId
	if (projectId === undefined) {
		throw new Error('Zerops namespace project id was not checkpointed')
	}
	const project = await options.api.getProject({ projectId, signal: input.signal })
	if (target.projectName !== project.name && initiallyAdopted && suppliedTarget.projectName === undefined) {
		target = { ...target, projectName: project.name }
		namespace = await checkpoint(input, namespace, target)
	}
	validateProject(namespace, target, project, initiallyAdopted)

	if (initiallyAdopted) {
		// Validate before the first mutation; the import below then enforces service-level envIsolation.
		await resolveServices(namespace, target, options, input.signal, true)
	}
	if (target.proxyBuild === undefined) {
		const imported = await options.api.importServices({
			projectId,
			yaml: topology.servicesSteadyYaml,
			signal: input.signal,
		})
		for (const service of imported.services) {
			for (const process of service.processes) {
				await waitForProcess({
					api: options.api,
					processId: process.id,
					sleep: options.sleep ?? defaultSleep,
					signal: input.signal,
					label: 'namespace import',
				})
			}
		}
	}
	const resolved = await resolveServices(namespace, target, options, input.signal, false)
	if (target.proxyServiceId !== undefined && target.proxyServiceId !== resolved.proxy.id) {
		throw new Error('Checkpointed namespace proxy service identity changed')
	}
	target = {
		...target,
		proxyServiceId: resolved.proxy.id,
		...(resolved.postgres !== undefined ? { postgresServiceId: resolved.postgres.id } : {}),
	}
	namespace = await checkpoint(input, namespace, target)

	const deployed = await deployProxy(input, namespace, target, options, 'active')
	namespace = deployed.namespace
	target = { ...deployed.target, proxyConfigured: true }
	// After the deploy, because the platform refuses a service with no HTTP port — and never before `ready`
	// is checkpointed, because a namespace with no public entry point is not ready.
	if (target.publicAccess === 'zerops-subdomain') {
		await ensureSubdomainAccess(target, options, input.signal)
	}
	const proxyHosts = target.publicAccess === 'zerops-subdomain' ? await readProxyHosts(namespace, target, options, input.signal) : []
	target = {
		...target,
		proxyBuild: undefined,
		// Cleared when the proxy publishes none and on a custom-domain namespace, so the record never
		// outlives what it describes.
		proxyHosts: proxyHosts.length === 0 ? undefined : proxyHosts,
		ready: true,
	}
	return checkpoint(input, namespace, target)
}

/** Build the provider-owned namespace lifecycle capability. */
export const createZeropsNamespaceCapabilities = (options: ZeropsNamespaceOptions): ProviderNamespaceCapabilities => {
	const required = (name: string, value: string): void => {
		if (value.trim() === '') {
			throw new Error(`Zerops namespace ${name} must be a non-empty string`)
		}
	}
	required('clientId', options.clientId)
	required('iamUrl', options.iamUrl)
	required('iamKey', options.iamKey)
	return {
		normalize: (namespace) => normalizedNamespace(namespace, options),
		namespaceResourceClaims,
		registrationResourceClaims,
		provision: (input) => mutateNamespace(input, options, 'provision'),
		reconcile: (input) => mutateNamespace(input, options, 'reconcile'),
		republish: (input) => republishNamespace(input, options),
		operator: createZeropsNamespaceOperator({
			proxyBuildFromGit: options.proxyBuildFromGit,
			...(options.proxySource === undefined ? {} : { proxySource: options.proxySource }),
		}),
	}
}
