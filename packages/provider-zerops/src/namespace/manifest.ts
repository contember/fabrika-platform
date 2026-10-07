import { decodeEnvelope, type ProviderNamespaceMember } from '@fabrika/provider-contract'
import type { ProxyManifest } from '@fabrika/proxy-contract'
import { assertFabrikaManifestCoordinates, zeropsArtifactCodec } from '../manifest'

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
		if (ids.has(member.appId)) throw new Error(`duplicate proxy app id \`${member.appId}\` in deployment namespace ${namespaceId}`)
		if (hosts.has(host)) throw new Error(`duplicate proxy host \`${host}\` in deployment namespace ${namespaceId}`)
		ids.add(member.appId)
		hosts.add(host)
		// A Zerops public domain is always served over the project's TLS-terminating L7 balancer, so the
		// browser speaks https even though the proxy itself is reached over plain HTTP (ADR-0022).
		apps.push({ id: member.appId, hosts: [host], upstream: proxy.upstream, gates: proxy.gates, scheme: 'https' })
	}
	return { apps }
}
