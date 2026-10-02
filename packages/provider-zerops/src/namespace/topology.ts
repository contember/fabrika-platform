import type { ProviderDeploymentNamespace } from '@fabrika/provider-contract'
import { compileImportYaml, compileProvisioningYaml } from '../compile'
import type { ZeropsServiceSpec, ZeropsSourceTarget } from '../types'
import { ZEROPS_NAMESPACE_POSTGRES_HOSTNAME, ZEROPS_NAMESPACE_PROXY_HOSTNAME } from './constants'
import { decodeZeropsNamespaceProxySource } from './proxy-source'
import type {
	ZeropsNamespacePostgres,
	ZeropsNamespacePresetInput,
	ZeropsNamespacePublicAccess,
	ZeropsNamespaceTarget,
	ZeropsNamespaceTopology,
} from './types'

export const PROXY_TYPE = 'alpine@3.21'

/**
 * The namespace-owned PostgreSQL service: the cheapest shape that runs, on EVERY environment.
 *
 * A profile sets the FLOOR and the tuning preset, never the cap — `oltp-hobby` and `oltp-production`
 * share the same 8-core / 48 GB / 250 GB ceiling and the same vertical autoscaler, so the production
 * preset does not buy headroom, it buys an idle bill. `oltp-hobby` starts at one SHARED core and
 * 0.25 GB and grows under load; the shape is proven by a live app with dozens of tables.
 *
 * Keying this off `env === 'prod'` is what this default used to do, and it was wrong: most apps are
 * small on every environment they have, and a name is not a size. HA and a bigger floor stay
 * available and become a DELIBERATE act — `--postgres-type` and `--postgres-profile` on the namespace
 * command — because the failure mode of over-provisioning is silent and monthly, while the failure
 * mode of under-provisioning is visible and fixable at any time.
 *
 * Omitting `profile` would not be neutral: an HA service silently gets `oltp-production` (two
 * DEDICATED cores and 4 GB per container, three containers) and a single one `oltp-staging`. Both
 * read back off a live service.
 */
const defaultPostgres = (): ZeropsNamespacePostgres => ({ type: 'postgresql:single@18', profile: 'oltp-hobby' })

export const zeropsNamespacePreset = (input: ZeropsNamespacePresetInput): ZeropsNamespaceTarget => ({
	...(input.proxySource === undefined ? {} : { proxySource: decodeZeropsNamespaceProxySource(input.proxySource) }),
	projectName: input.projectName,
	// `LIGHT` on every environment. An APP namespace is not the platform project — the argument for
	// `SERIOUS` in `installation-zerops` is that the platform repairs the apps project, which no app
	// namespace does. `corePackage` is upgrade-only, so this stays the caller's explicit choice.
	corePackage: input.corePackage ?? 'LIGHT',
	publicAccess: input.publicAccess ?? 'custom-domain',
	managed: true,
	ready: false,
	...(input.preset === 'cheap' ? { postgres: input.postgres ?? defaultPostgres() } : {}),
})

export const projectMarker = (namespace: ProviderDeploymentNamespace): string => `Managed by Fabrika namespace ${namespace.id} (${namespace.env}).`

// Imports provision services only. The reserved upload-backed build selects the proxy setup.
//
// `enableSubdomainAccess` is a DECLARATION here and not a mechanism: the platform accepts it and drops it,
// including on the service this document creates. `ensureSubdomainAccess` below is what establishes the
// subdomain, after the proxy's first deploy. Written anyway because it is what ADR-0007's
// `assertOnlyPublicService` reads to prove no other service is claimed public.
const proxyService = (publicAccess: ZeropsNamespacePublicAccess): ZeropsServiceSpec => ({
	hostname: ZEROPS_NAMESPACE_PROXY_HOSTNAME,
	type: PROXY_TYPE,
	priority: 10,
	enableSubdomainAccess: publicAccess === 'zerops-subdomain',
	// One container is a real availability trade — the proxy is the only enforcement point (ADR-0022),
	// so a restart is a short outage rather than a rolling one — taken because it is a whole core of
	// idle floor on every namespace, and most namespaces hold one small app. `maxContainers` is
	// unchanged, so load still scales out.
	minContainers: 1,
	maxContainers: 6,
})

const postgresService = (postgres: ZeropsNamespacePostgres): ZeropsServiceSpec => ({
	hostname: ZEROPS_NAMESPACE_POSTGRES_HOSTNAME,
	type: postgres.type,
	priority: 100,
	...(postgres.profile !== undefined ? { profile: postgres.profile } : {}),
})

/** Compile the one project and its namespace-owned services without depending on private deploy code. */
export const compileZeropsNamespaceTopology = (
	namespace: ProviderDeploymentNamespace,
	target: ZeropsNamespaceTarget,
): ZeropsNamespaceTopology => {
	const projectName = target.projectName
	const corePackage = target.corePackage
	const publicAccess = target.publicAccess
	if (projectName === undefined || corePackage === undefined || publicAccess === undefined) {
		throw new Error('Zerops namespace topology requires normalized project policy')
	}
	const services = (): ZeropsServiceSpec[] => [
		...(target.postgres === undefined ? [] : [postgresService(target.postgres)]),
		proxyService(publicAccess),
	]
	const source: ZeropsSourceTarget = {
		platform: 'zerops',
		project: {
			name: projectName,
			description: projectMarker(namespace),
			corePackage,
			tags: ['fabrika', 'namespace', namespace.id, namespace.env],
		},
		services,
	}
	const serviceSource: ZeropsSourceTarget = { platform: 'zerops', services }
	return {
		source,
		createYaml: compileImportYaml({ target: source, ctx: { env: namespace.env } }).yaml,
		servicesProvisionYaml: compileProvisioningYaml({ target: serviceSource, ctx: { env: namespace.env } }).yaml,
		servicesSteadyYaml: compileImportYaml({ target: serviceSource, ctx: { env: namespace.env } }).yaml,
	}
}
