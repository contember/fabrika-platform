import { appEnvironmentId } from '@fabrika/auth-core'
import { decodeEnvelope, type ProviderNamespaceMember } from '@fabrika/provider-contract'
import { isPolicyOrigin } from '@fabrika/proxy-core/headers'
import { contractProxyTable, type ProxyApp, type ProxyManifest } from '@fabrika/proxy-core/manifest'
import { artifactAccessApproved, assertFabrikaManifestCoordinates, zeropsArtifactCodec } from '../manifest'

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
		// Only Control decides what routes the member (ADR-0050): its approved contract's endpoint table, or the artifact's
		// gates when they are the artifact access Control approved. Otherwise it is not routed.
		const access = member.access
		if (access !== undefined) {
			const operationsOrigin = member.operationsOrigin
			if (operationsOrigin !== undefined && !isPolicyOrigin(operationsOrigin, ['https:', 'http:'])) {
				throw new Error(`Zerops proxy target ${member.appId}/${member.env} has an Operations ingest origin that is not an http(s) origin`)
			}
			apps.push({
				id,
				hosts: [host],
				upstream: proxy.upstream,
				scheme,
				...contractProxyTable(access.contract),
				...(operationsOrigin === undefined ? {} : { operationsOrigin }),
			})
		} else if (artifactAccessApproved(manifest, member) && 'gates' in proxy) {
			apps.push({ id, hosts: [host], upstream: proxy.upstream, gates: proxy.gates, scheme })
		}
	}
	return { apps }
}
