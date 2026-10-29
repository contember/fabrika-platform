import { appEnvironmentId } from '@fabrika/auth-core'
import { decodeEnvelope, type ProviderNamespaceMember } from '@fabrika/provider-contract'
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
				const host = sandbox.host.toLowerCase()
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
		// Only Control decides what routes a member (ADR-0050): its approved contract's endpoint table. A member without
		// one is not routed, and its artifact is not decoded, so a legacy one cannot stop the others' republish.
		const access = member.access
		if (access === undefined) continue
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
		claim(id, host)
		apps.push(contractProxyEntry({
			id,
			hosts: [host],
			upstream: proxy.upstream,
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
