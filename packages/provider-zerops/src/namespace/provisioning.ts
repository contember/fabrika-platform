import {
	type ProviderDeploymentNamespace,
	type ProviderNamespaceCapabilities,
	ProviderNamespaceError,
	type ProviderNamespaceHost,
	type ProviderNamespaceMutationInput,
} from '@fabrika/provider-contract'
import { encodeProxyManifestJson, FABRIKA_PROXY_MANIFEST_JSON } from '@fabrika/proxy-contract'
import {
	ZEROPS_ACTIVE,
	ZEROPS_SERVICE_NOT_HTTP,
	ZEROPS_TERMINAL,
	ZeropsApiError,
	type ZeropsAppVersion,
	type ZeropsProject,
	type ZeropsService,
} from '../api'
import { defaultSleep } from '../collaborators'
import { namespaceResourceClaims, registrationResourceClaims } from './claims'
import { checkpoint, decodeEnvelope, normalizedNamespace, normalizeTarget } from './codec'
import {
	ZEROPS_NAMESPACE_IAM_ISSUER_VARIABLE,
	ZEROPS_NAMESPACE_IAM_KEY_VARIABLE,
	ZEROPS_NAMESPACE_POSTGRES_HOSTNAME,
	ZEROPS_NAMESPACE_PROXY_HOSTNAME,
	ZEROPS_NAMESPACE_SUBDOMAIN_VARIABLE,
} from './constants'
import {
	asNamespaceError,
	namespaceError,
	ZEROPS_NAMESPACE_CANCELLED,
	ZEROPS_PROXY_DEPLOY_FAILED,
	ZEROPS_PROXY_DEPLOY_TIMEOUT,
	ZEROPS_SUBDOMAIN_NOT_PUBLISHED,
} from './errors'
import { createZeropsNamespaceOperator } from './operator'
import { compileZeropsNamespaceTopology, projectMarker, PROXY_TYPE } from './topology'
import type { NamespaceProxyIamInput, NormalizedZeropsNamespaceTarget, ZeropsNamespaceOptions } from './types'

const EMPTY_PROXY_MANIFEST = encodeProxyManifestJson({ apps: [] })

const POLL_INTERVAL_MS = 3000

const POLL_TIMEOUT_MS = 70 * 60 * 1000

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
 * Converge the two variables the namespace proxy's own CODE reads, and call this from everywhere that
 * code is replaced — not only where the namespace is created.
 *
 * `syncZeropsProxy` rebuilds the proxy from git on every app deploy, so a proxy can take new code
 * whose configuration nobody rewrote. That is not hypothetical: the `FABRIKA_IAM_URL` →
 * `FABRIKA_IAM_ISSUER` rename ([ADR-0035](../../../../docs/decisions/0035-the-platform-owns-the-application-iam-issuer.md))
 * left a live namespace proxy crash-looping on `FABRIKA_IAM_ISSUER is required`, because provisioning
 * had written the old name months earlier and the deploy path only ever wrote the manifest. Writing
 * these BEFORE the pipeline is triggered is what makes a rename a flag day rather than an outage
 * ([ADR-0024](../../../../docs/decisions/0024-retire-the-legacy-environment-name-fallback.md)).
 */
export const ensureNamespaceProxyIam = async (input: NamespaceProxyIamInput): Promise<void> => {
	const variables = await input.api.listServiceEnv({ serviceId: input.proxyServiceId, signal: input.signal })
	const issuer = variables.find((variable) => variable.key === ZEROPS_NAMESPACE_IAM_ISSUER_VARIABLE)
	if (issuer?.content !== input.iamUrl) {
		await input.api.putServiceEnv({
			serviceId: input.proxyServiceId,
			key: ZEROPS_NAMESPACE_IAM_ISSUER_VARIABLE,
			value: input.iamUrl,
			signal: input.signal,
		})
	}
	// Secret read-back is not trustworthy, so overwrite it idempotently without inspecting its value.
	await input.api.putServiceEnv({
		serviceId: input.proxyServiceId,
		key: ZEROPS_NAMESPACE_IAM_KEY_VARIABLE,
		value: input.iamKey,
		signal: input.signal,
	})
}

const ensureProxyConfiguration = async (
	target: NormalizedZeropsNamespaceTarget,
	options: ZeropsNamespaceOptions,
	signal: AbortSignal,
): Promise<boolean> => {
	const proxyServiceId = target.proxyServiceId
	if (proxyServiceId === undefined) {
		throw new Error('Zerops namespace has no proxy service id')
	}
	const variables = await options.api.listServiceEnv({ serviceId: proxyServiceId, signal })
	const byKey = new Map(variables.map((variable) => [variable.key, variable]))
	let deployRequired = !target.ready
	const manifest = byKey.get(FABRIKA_PROXY_MANIFEST_JSON)
	if (!target.ready || manifest === undefined) {
		await options.api.putServiceEnv({
			serviceId: proxyServiceId,
			key: FABRIKA_PROXY_MANIFEST_JSON,
			value: EMPTY_PROXY_MANIFEST,
			signal,
		})
		deployRequired = true
	}
	await ensureNamespaceProxyIam({
		api: options.api,
		proxyServiceId,
		iamUrl: options.iamUrl,
		iamKey: options.iamKey,
		signal,
	})
	return deployRequired
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

const latestAfterBaseline = async (
	target: NormalizedZeropsNamespaceTarget,
	options: ZeropsNamespaceOptions,
	signal: AbortSignal,
): Promise<ZeropsAppVersion | null> => {
	const proxyServiceId = target.proxyServiceId
	if (proxyServiceId === undefined) {
		throw new Error('Zerops namespace has no proxy service id')
	}
	const latest = await options.api.latestAppVersion({ serviceId: proxyServiceId, signal })
	const baseline = target.proxyBaselineSequence
	if (latest === null || baseline === undefined || latest.sequence === undefined || latest.sequence <= baseline) {
		return null
	}
	return latest
}

const terminalFailure = (version: ZeropsAppVersion): ProviderNamespaceError =>
	namespaceError(ZEROPS_PROXY_DEPLOY_FAILED, `Zerops namespace proxy deploy ${version.id} finished as ${version.status ?? 'unknown'}`, false)

const waitForProxy = async (
	appVersionId: string,
	options: ZeropsNamespaceOptions,
	signal: AbortSignal,
): Promise<ZeropsAppVersion> => {
	const deadline = Date.now() + POLL_TIMEOUT_MS
	for (;;) {
		if (signal.aborted) {
			throw namespaceError(ZEROPS_NAMESPACE_CANCELLED, 'Zerops namespace provisioning was cancelled', true)
		}
		const version = await options.api.getAppVersion({ appVersionId, signal })
		if (version.status !== undefined && ZEROPS_TERMINAL.has(version.status)) {
			return version
		}
		if (Date.now() > deadline) {
			throw namespaceError(ZEROPS_PROXY_DEPLOY_TIMEOUT, `Zerops namespace proxy deploy ${appVersionId} timed out`, true)
		}
		await (options.sleep ?? defaultSleep)(POLL_INTERVAL_MS, signal)
	}
}

const deployProxy = async (
	input: ProviderNamespaceMutationInput,
	namespace: ProviderDeploymentNamespace,
	target: NormalizedZeropsNamespaceTarget,
	options: ZeropsNamespaceOptions,
): Promise<{ namespace: ProviderDeploymentNamespace; target: NormalizedZeropsNamespaceTarget }> => {
	let currentNamespace = namespace
	let currentTarget = target
	const proxyServiceId = currentTarget.proxyServiceId
	if (proxyServiceId === undefined) {
		throw new Error('Zerops namespace has no proxy service id')
	}
	if (currentTarget.proxyAppVersionId !== undefined) {
		const version = await waitForProxy(currentTarget.proxyAppVersionId, options, input.signal)
		if (version.status === ZEROPS_ACTIVE) {
			return { namespace: currentNamespace, target: currentTarget }
		}
		currentTarget = {
			...currentTarget,
			proxyAppVersionId: undefined,
			proxyBaselineSequence: undefined,
			ready: false,
		}
		currentNamespace = await checkpoint(input, currentNamespace, currentTarget)
	}

	let recovered: ZeropsAppVersion | null = null
	if (currentTarget.proxyBaselineSequence !== undefined) {
		recovered = await latestAfterBaseline(currentTarget, options, input.signal)
	}
	if (recovered === null) {
		if (currentTarget.proxyBaselineSequence === undefined) {
			const prior = await options.api.latestAppVersion({ serviceId: proxyServiceId, signal: input.signal })
			currentTarget = {
				...currentTarget,
				proxyBaselineSequence: prior?.sequence ?? -1,
			}
			currentNamespace = await checkpoint(input, currentNamespace, currentTarget)
		}
		const process = await options.api.triggerPipeline({
			serviceId: proxyServiceId,
			buildFromGit: currentTarget.proxyBuildFromGit,
			zeropsSetup: ZEROPS_NAMESPACE_PROXY_HOSTNAME,
			signal: input.signal,
		})
		recovered = process?.appVersionId === undefined
			? await latestAfterBaseline(currentTarget, options, input.signal)
			: { id: process.appVersionId }
	}
	if (recovered === null || recovered.id === '') {
		throw new Error('Zerops namespace proxy pipeline did not expose a new app-version')
	}
	currentTarget = { ...currentTarget, proxyAppVersionId: recovered.id }
	currentNamespace = await checkpoint(input, currentNamespace, currentTarget)
	const version = await waitForProxy(recovered.id, options, input.signal)
	if (version.status !== ZEROPS_ACTIVE) {
		throw terminalFailure(version)
	}
	return { namespace: currentNamespace, target: currentTarget }
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
		return await runNamespaceMutation(input, options, mode)
	} catch (cause) {
		throw asNamespaceError(cause, mode)
	}
}

const runNamespaceMutation = async (
	input: ProviderNamespaceMutationInput,
	options: ZeropsNamespaceOptions,
	mode: 'provision' | 'reconcile',
): Promise<ProviderDeploymentNamespace> => {
	const suppliedTarget = decodeEnvelope(input.namespace.target)
	let namespace = normalizedNamespace(input.namespace, options)
	let target = normalizeTarget(namespace, options)
	const initiallyAdopted = target.projectId !== undefined && target.managed === false && !target.ready
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
	await options.api.importServices({
		projectId,
		yaml: mode === 'provision' && !target.ready ? topology.servicesProvisionYaml : topology.servicesSteadyYaml,
		signal: input.signal,
	})
	const resolved = await resolveServices(namespace, target, options, input.signal, false)
	target = {
		...target,
		proxyServiceId: resolved.proxy.id,
		...(resolved.postgres !== undefined ? { postgresServiceId: resolved.postgres.id } : {}),
	}
	namespace = await checkpoint(input, namespace, target)

	const deployRequired = await ensureProxyConfiguration(target, options, input.signal)
	target = { ...target, proxyConfigured: true }
	namespace = await checkpoint(input, namespace, target)

	if (deployRequired || !target.ready) {
		const deployed = await deployProxy(input, namespace, target, options)
		namespace = deployed.namespace
		target = deployed.target
	}
	// After the deploy, because the platform refuses a service with no HTTP port — and never before `ready`
	// is checkpointed, because a namespace with no public entry point is not ready.
	if (target.publicAccess === 'zerops-subdomain') {
		await ensureSubdomainAccess(target, options, input.signal)
	}
	const proxyHosts = target.publicAccess === 'zerops-subdomain' ? await readProxyHosts(namespace, target, options, input.signal) : []
	target = {
		...target,
		proxyBaselineSequence: undefined,
		proxyAppVersionId: undefined,
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
	required('proxyBuildFromGit', options.proxyBuildFromGit)
	required('iamUrl', options.iamUrl)
	required('iamKey', options.iamKey)
	return {
		normalize: (namespace) => normalizedNamespace(namespace, options),
		namespaceResourceClaims,
		registrationResourceClaims,
		provision: (input) => mutateNamespace(input, options, 'provision'),
		reconcile: (input) => mutateNamespace(input, options, 'reconcile'),
		operator: createZeropsNamespaceOperator({ proxyBuildFromGit: options.proxyBuildFromGit }),
	}
}
