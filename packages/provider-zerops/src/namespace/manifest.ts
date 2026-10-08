import { appEnvironmentId } from '@fabrika/auth-core'
import { decodeEnvelope, type ProviderNamespaceMember } from '@fabrika/provider-contract'
import { contractProxyTable, type ProxyApp, type ProxyManifest } from '@fabrika/proxy-core/manifest'
import { assertFabrikaManifestCoordinates, claimsContract, zeropsArtifactCodec } from '../manifest'

/** Compile every public member of one deployment namespace into its strict proxy manifest. */
export function compileNamespaceProxyManifest(namespaceId: string, members: readonly ProviderNamespaceMember[]): ProxyManifest {
	const apps: ProxyManifest['apps'] = []
	const ids = new Set<string>()
	const hosts = new Set<string>()
	for (const member of members) {
		const manifest = decodeEnvelope('artifact', 'zerops', member.artifact, zeropsArtifactCodec)
		assertFabrikaManifestCoordinates(manifest.app, { appId: member.appId, env: member.env })
		const proxy = manifest.target.proxy
		if (proxy === undefined) continue
		if (member.domain === undefined || member.domain === '') {
			throw new Error(`Zerops proxy target ${member.appId}/${member.env} requires a public domain`)
		}
		const host = member.domain.toLowerCase()
		// The proxy mints for the IAM application id of this environment (ADR-0022 rule 6).
		const id = appEnvironmentId(member.appId, member.env)
		if (ids.has(id)) throw new Error(`duplicate proxy app id \`${id}\` in deployment namespace ${namespaceId}`)
		if (hosts.has(host)) throw new Error(`duplicate proxy host \`${host}\` in deployment namespace ${namespaceId}`)
		ids.add(id)
		hosts.add(host)
		// A Zerops public domain is always served over the project's TLS-terminating L7 balancer, so the
		// browser speaks https even though the proxy itself is reached over plain HTTP (ADR-0022).
		const scheme: ProxyApp['scheme'] = 'https'
		// A contract application is protected by the endpoint table of its approved contract, never the artifact's
		// (ADR-0050); one with nothing approved is not routed. Every other app keeps its gates (ADR-0022 rule 3).
		const access = member.access
		if (access !== undefined) {
			apps.push({ id, hosts: [host], upstream: proxy.upstream, scheme, ...contractProxyTable(access.contract) })
		} else if (!claimsContract(manifest) && 'gates' in proxy) {
			apps.push({ id, hosts: [host], upstream: proxy.upstream, gates: proxy.gates, scheme })
		}
	}
	return { apps }
}
