import { appEnvironmentId } from '@fabrika/auth-core'
import {
	decodeEnvelope,
	type ProviderApprovedAccess,
	type ProviderNamespaceMember,
	type ProviderNamespaceMemberRouting,
} from '@fabrika/provider-contract'
import { contractProxyEntry, contractProxyTable, devSandboxEntryId, type ProxyManifest } from '@fabrika/proxy-core/manifest'
import { assertFabrikaManifestCoordinates, zeropsArtifactCodec } from '../manifest'
import { SANDBOX_UPSTREAM } from '../sandbox-host'

/** Compile every public member of one deployment namespace into its strict proxy manifest. */
export function compileNamespaceProxyManifest(namespaceId: string, members: readonly ProviderNamespaceMember[]): ProxyManifest {
	const apps: ProxyManifest['apps'] = []
	const ids = new Set<string>()
	const hosts = new Set<string>()
	const claim = (id: string, host: string): void => {
		if (ids.has(id)) throw new Error(`duplicate proxy app id \`${id}\` in deployment namespace ${namespaceId}`)
		if (hosts.has(host)) throw new Error(`duplicate proxy host \`${host}\` in deployment namespace ${namespaceId}`)
		ids.add(id)
		hosts.add(host)
	}
	for (const member of members) {
		// A dev member is served only through its workspaces' sandboxes, each behind the namespace's own sandbox host; its
		// upstream is never the artifact's, so the artifact is not decoded.
		if (member.devSandboxes !== undefined) {
			const audience = appEnvironmentId(member.appId, member.env)
			for (const sandbox of member.devSandboxes) {
				const id = devSandboxEntryId(member.appId, sandbox.workspaceId)
				const host = sandboxHost(sandbox)
				claim(id, host)
				apps.push(contractProxyEntry({
					id,
					audience,
					hosts: [host],
					upstream: SANDBOX_UPSTREAM,
					upstreamHost: sandbox.upstreamHost,
					scheme: 'https',
					table: contractProxyTable(sandbox.access.contract, sandbox.access.contractDigest),
					...(member.operationsOrigin === undefined ? {} : { operationsOrigin: member.operationsOrigin }),
					...(member.crossOrigins === undefined ? {} : { crossOrigins: member.crossOrigins }),
				}))
			}
			continue
		}
		const routed = routedContractMember(member)
		if (routed === undefined) continue
		const { host, upstream, access } = routed
		// The proxy mints for the IAM application id of this environment (ADR-0022 rule 6).
		const id = appEnvironmentId(member.appId, member.env)
		claim(id, host)
		apps.push(contractProxyEntry({
			id,
			hosts: [host],
			upstream,
			// A Zerops public domain is always served over the project's TLS-terminating L7 balancer, so the
			// browser speaks https even though the proxy itself is reached over plain HTTP (ADR-0022).
			scheme: 'https',
			table: contractProxyTable(access.contract, access.contractDigest),
			...(member.operationsOrigin === undefined ? {} : { operationsOrigin: member.operationsOrigin }),
			...(member.crossOrigins === undefined ? {} : { crossOrigins: member.crossOrigins }),
		}))
	}
	return { apps }
}

/**
 * The hosts the namespace proxy routes one member on, lower-cased: a dev member's workspace sandbox hosts, otherwise its
 * domain once Control approved a contract for a manifest with a proxy target. The compiler above routes by the same rule.
 */
export function namespaceMemberHosts(member: ProviderNamespaceMemberRouting): string[] {
	if (member.devSandboxes !== undefined) return member.devSandboxes.map(sandboxHost)
	const routed = routedContractMember(member)
	return routed === undefined ? [] : [routed.host]
}

const sandboxHost = (sandbox: { readonly host: string }): string => sandbox.host.toLowerCase()

/** A member that is not a dev member, routed on its domain; undefined when the proxy does not route it. */
function routedContractMember(
	member: ProviderNamespaceMemberRouting,
): { readonly host: string; readonly upstream: string; readonly access: ProviderApprovedAccess } | undefined {
	// Only Control decides what routes a member (ADR-0050): its approved contract's endpoint table. A member without
	// one is not routed, and its artifact is not decoded, so a legacy one cannot stop the others' republish.
	const access = member.access
	if (access === undefined) return undefined
	const manifest = decodeEnvelope('artifact', 'zerops', member.artifact, zeropsArtifactCodec)
	assertFabrikaManifestCoordinates(manifest.app, { appId: member.appId, env: member.env })
	const proxy = manifest.target.proxy
	if (proxy === undefined) return undefined
	if (member.domain === undefined || member.domain === '') {
		throw new Error(`Zerops proxy target ${member.appId}/${member.env} requires a public domain`)
	}
	return { host: member.domain.toLowerCase(), upstream: proxy.upstream, access }
}
