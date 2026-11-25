// The proxy manifest of one AWS deployment namespace (ADR-0022, ADR-0045): one contract entry per member Control
// approved a contract for, routed on the member's domain to its service in the namespace's Service Connect namespace.
// The namespace's proxy is built with this manifest in its image, so a running proxy never reads a manifest newer than
// itself; this module only compiles it, purely.
//
// - The entry's id is the environment's IAM application id (`appEnvironmentId`, ADR-0022 rule 6), its table the
//   approved contract's alone (ADR-0050): a member without approved access is not routed.
// - Its upstream is the service's discovery name on the application's port, `<discovery name>:3000`: a Caddy dial
//   address (`host:port`, no scheme, which `reverse_proxy` would refuse as an unknown network), derived from the
//   application id and environment (`awsDiscoveryName`), never read from a registration, so no member can aim the proxy
//   at another environment's service. Only the proxy's security group reaches that port.
// - The scheme is `https`: the installation's balancer terminates TLS, and the proxy is reached over plain HTTP behind
//   it.
// - A member needs a domain to be routed; two members on one host, or a dev member (no sandbox host on AWS), are
//   refused. The proxy secret is not in the manifest: the proxy's own task holds it per application (ADR-0022 rule 5).

import { appEnvironmentId } from '@fabrika/auth-core'
import {
	decodeEnvelope,
	type ProviderApprovedAccess,
	type ProviderNamespaceMember,
	type ProviderNamespaceMemberRouting,
} from '@fabrika/provider-contract'
import { contractProxyEntry, contractProxyTable, type ProxyManifest } from '@fabrika/proxy-core/manifest'
import { AWS_PROVIDER, awsAppArtifactCodec } from './codecs'
import { AWS_APPLICATION_PORT } from './ecs-task'
import { awsDiscoveryName } from './resources'

/** The dial address (`host:port`) the namespace's proxy reaches one environment's service at, in Service Connect. */
export function awsProxyUpstream(appId: string, env: string): string {
	return `${awsDiscoveryName(appId, env)}:${AWS_APPLICATION_PORT}`
}

/** A member the proxy routes: on its domain, lower-cased, with its approved access; undefined for one it does not. */
function routed(
	member: ProviderNamespaceMemberRouting,
): { readonly host: string; readonly access: ProviderApprovedAccess } | undefined {
	if (member.devSandboxes !== undefined) throw new Error(`aws: ${member.appId}/${member.env} is a dev environment, which AWS does not route`)
	// Only Control decides what routes a member (ADR-0050): its approved contract's endpoint table.
	const access = member.access
	if (access === undefined) return undefined
	// The artifact is the provider's own; one of another provider is no member of this namespace.
	decodeEnvelope('artifact', AWS_PROVIDER, member.artifact, awsAppArtifactCodec)
	if (member.domain === undefined || member.domain === '') throw new Error(`aws: ${member.appId}/${member.env} has no domain for its proxy to route`)
	return { host: member.domain.toLowerCase(), access }
}

/** Compile every routed member of one namespace into its strict proxy manifest. */
export function awsNamespaceProxyManifest(namespaceId: string, members: readonly ProviderNamespaceMember[]): ProxyManifest {
	const apps: ProxyManifest['apps'] = []
	const ids = new Set<string>()
	const hosts = new Set<string>()
	for (const member of members) {
		const entry = routed(member)
		if (entry === undefined) continue
		const id = appEnvironmentId(member.appId, member.env)
		if (ids.has(id)) throw new Error(`aws: the namespace ${namespaceId} holds ${id} twice`)
		if (hosts.has(entry.host)) throw new Error(`aws: two members of the namespace ${namespaceId} are routed on ${entry.host}`)
		ids.add(id)
		hosts.add(entry.host)
		apps.push(contractProxyEntry({
			id,
			hosts: [entry.host],
			upstream: awsProxyUpstream(member.appId, member.env),
			scheme: 'https',
			suspended: member.suspended === true,
			table: contractProxyTable(entry.access.contract, entry.access.contractDigest),
			...(member.operationsOrigin === undefined ? {} : { operationsOrigin: member.operationsOrigin }),
			...(member.crossOrigins === undefined ? {} : { crossOrigins: member.crossOrigins }),
		}))
	}
	return { apps }
}

/** The hosts the namespace's proxy routes one member on, by the compiler's rule: its domain once it has approved access. */
export function awsNamespaceMemberHosts(member: ProviderNamespaceMemberRouting): readonly string[] {
	const entry = routed(member)
	return entry === undefined ? [] : [entry.host]
}
