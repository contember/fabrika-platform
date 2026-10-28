import type {
	ProviderClaimedResource,
	ProviderClaimedResourcesInput,
	ProviderDeploymentNamespace,
	ProviderRegistration,
} from '@fabrika/provider-contract'
import { isProxyHost } from '@fabrika/proxy-core/manifest'
import { type ZeropsApi, ZeropsApiError } from '../api'
import { assertFabrikaManifestCoordinates, manifestServiceHostnames, zeropsArtifactCodec } from '../manifest'
import { SANDBOX_HOST_HOSTNAME } from '../sandbox-host'
import { zeropsSharedServicePrefix } from '../service-names'
import { decodeEnvelope } from './codec'
import { ZEROPS_NAMESPACE_POSTGRES_HOSTNAME, ZEROPS_NAMESPACE_PROXY_HOSTNAME } from './constants'
import { asNamespaceError } from './errors'

export const namespaceResourceClaims = (namespace: ProviderDeploymentNamespace): string[] => {
	const target = decodeEnvelope(namespace.target)
	return [
		`service:${ZEROPS_NAMESPACE_PROXY_HOSTNAME}`,
		...(target.postgres === undefined ? [] : [`service:${ZEROPS_NAMESPACE_POSTGRES_HOSTNAME}`]),
		...(target.sandboxHost === undefined ? [] : [`service:${SANDBOX_HOST_HOSTNAME}`]),
	]
}

export const registrationResourceClaims = (registration: ProviderRegistration): string[] => {
	const namespace = registration.environment.namespace
	if (namespace === undefined) {
		throw new Error('Zerops registration requires a deployment namespace')
	}
	if (
		namespace.exclusiveAppId !== undefined
		&& namespace.exclusiveAppId !== registration.app.id
	) {
		throw new Error(`Zerops namespace is exclusive to app \`${namespace.exclusiveAppId}\``)
	}
	const artifactEnvelope = registration.environment.artifact
	if (artifactEnvelope.provider !== 'zerops' || artifactEnvelope.version !== zeropsArtifactCodec.version) {
		throw new Error('Zerops registration artifact envelope is not supported')
	}
	const manifest = zeropsArtifactCodec.decode(artifactEnvelope.payload)
	assertFabrikaManifestCoordinates(manifest.app, {
		appId: registration.app.id,
		env: registration.environment.env,
	})
	// A proxy target is routed by HOST, so a registration with no domain has nothing the proxy can serve:
	// refuse it here, where nothing has been created yet, instead of at the first deploy's manifest compile.
	if (manifest.target.proxy !== undefined) {
		const domain = registration.environment.domain ?? ''
		if (domain.trim() === '') {
			throw new Error(
				`Zerops proxy target \`${registration.app.id}/${registration.environment.env}\` requires a public domain: `
					+ `pass --domain with a host this namespace serves (\`namespaces get ${namespace.id}\` lists them)`,
			)
		}
		// One Caddy fronts the whole namespace and its host matcher reads `*` as a wildcard label, so a
		// pattern here would answer for every sibling app. The manifest parser refuses it either way.
		if (!isProxyHost(domain.toLowerCase())) {
			throw new Error(
				`Zerops proxy target \`${registration.app.id}/${registration.environment.env}\` domain \`${domain}\` is not a literal hostname: `
					+ 'use dot-separated labels of letters, digits and `-` (no wildcard, no port, no placeholder)',
			)
		}
	}
	const namespaceClaims = new Set(namespaceResourceClaims(namespace))
	for (const requirement of manifest.target.namespaceResources ?? []) {
		if (!namespaceClaims.has(requirement.resourceKey)) {
			throw new Error(`Zerops namespace does not provide required resource \`${requirement.resourceKey}\``)
		}
	}
	const hostnames = manifestServiceHostnames(manifest)
	for (const hostname of hostnames) {
		const key = `service:${hostname}`
		if (namespaceClaims.has(key)) {
			throw new Error(`Zerops service hostname \`${hostname}\` is reserved by the namespace`)
		}
	}
	if (namespace.exclusiveAppId === undefined) {
		const prefix = zeropsSharedServicePrefix(registration.app.id)
		for (const hostname of hostnames) {
			if (!hostname.startsWith(prefix) || hostname.length === prefix.length) {
				throw new Error(`Zerops shared namespace service \`${hostname}\` must use app prefix \`${prefix}\``)
			}
		}
	}
	return hostnames.map((hostname) => `service:${hostname}`).sort()
}

/**
 * The platform's answer for a project that does not exist, a deleted one included. A project the token holds no grant
 * on answers `403 insufficientPermissions` instead (zerops-platform.md), so this never reads an unreachable one as gone.
 */
export const ZEROPS_PROJECT_NOT_FOUND = 'projectNotFound'

const SERVICE_CLAIM_PREFIX = 'service:'

/**
 * Whether each claimed service still exists in the namespace's project. Gone means the project reads `projectNotFound`,
 * or it exists and has no service under the claimed hostname. Any other answer, a key that names no service, or a
 * namespace that never recorded its project throws: Control then releases nothing.
 */
export const claimedResources = async (
	api: Pick<ZeropsApi, 'getProject' | 'findService'>,
	input: ProviderClaimedResourcesInput,
): Promise<ProviderClaimedResource[]> => {
	try {
		const services = input.resourceKeys.map((resourceKey) => {
			const hostname = resourceKey.startsWith(SERVICE_CLAIM_PREFIX) ? resourceKey.slice(SERVICE_CLAIM_PREFIX.length) : ''
			if (hostname === '') throw new Error(`Zerops cannot tell whether claimed resource \`${resourceKey}\` exists`)
			return { resourceKey, hostname }
		})
		const projectId = decodeEnvelope(input.namespace.target).projectId
		// An interrupted first provision can leave a project its marker names but the target does not.
		if (projectId === undefined) {
			throw new Error(`Zerops namespace \`${input.namespace.id}\` records no project, so its services cannot be read back`)
		}
		if (!(await projectExists(api, projectId, input.signal))) return services.map(({ resourceKey }) => ({ resourceKey, exists: false }))
		return await Promise.all(services.map(async ({ resourceKey, hostname }) => ({
			resourceKey,
			exists: (await api.findService({ projectId, hostname, signal: input.signal })) !== null,
		})))
	} catch (cause) {
		throw asNamespaceError(cause, 'claim check')
	}
}

export const projectExists = async (api: Pick<ZeropsApi, 'getProject'>, projectId: string, signal: AbortSignal): Promise<boolean> => {
	try {
		await api.getProject({ projectId, signal })
		return true
	} catch (error) {
		if (error instanceof ZeropsApiError && error.code === ZEROPS_PROJECT_NOT_FOUND) return false
		throw error
	}
}
