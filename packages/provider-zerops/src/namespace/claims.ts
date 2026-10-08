import type { ProviderDeploymentNamespace, ProviderRegistration } from '@fabrika/provider-contract'
import { isProxyHost } from '@fabrika/proxy-core/manifest'
import { assertFabrikaManifestCoordinates, manifestServiceHostnames, zeropsArtifactCodec } from '../manifest'
import { zeropsSharedServicePrefix } from '../service-names'
import { decodeEnvelope } from './codec'
import { ZEROPS_NAMESPACE_POSTGRES_HOSTNAME, ZEROPS_NAMESPACE_PROXY_HOSTNAME } from './constants'

export const namespaceResourceClaims = (namespace: ProviderDeploymentNamespace): string[] => {
	const target = decodeEnvelope(namespace.target)
	return [
		`service:${ZEROPS_NAMESPACE_PROXY_HOSTNAME}`,
		...(target.postgres === undefined ? [] : [`service:${ZEROPS_NAMESPACE_POSTGRES_HOSTNAME}`]),
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
