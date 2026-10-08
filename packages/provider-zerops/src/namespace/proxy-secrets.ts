import { appEnvironmentId, proxySecretVariable } from '@fabrika/auth-core'
import type { ProviderNamespaceMember } from '@fabrika/provider-contract'
import { isContractProxyApp, type ProxyManifest } from '@fabrika/proxy-core/manifest'

/**
 * The proxy service variables a manifest needs: for each contract application, the secret Caddy sends it
 * (ADR-0022 rule 5), keyed by `proxySecretVariable`. A contract member without a secret is refused, because
 * its application would refuse every request the proxy sends.
 */
export function namespaceProxySecrets(manifest: ProxyManifest, members: readonly ProviderNamespaceMember[]): ReadonlyMap<string, string> {
	const secrets = new Map<string, string>()
	for (const app of manifest.apps) {
		if (!isContractProxyApp(app)) continue
		const member = members.find((candidate) => appEnvironmentId(candidate.appId, candidate.env) === app.id)
		if (member?.proxySecret === undefined || member.proxySecret === '') {
			throw new Error(`Zerops proxy target ${app.id} is a contract application, and Control supplied no proxy secret for it`)
		}
		secrets.set(proxySecretVariable(app.id), member.proxySecret)
	}
	return secrets
}
