import { appEnvironmentId, proxySecretVariable } from '@fabrika/auth-core'
import type { ProviderNamespaceMember } from '@fabrika/provider-contract'
import { devSandboxEntryId, isApplicationEntry, type ProxyManifest } from '@fabrika/proxy-core/manifest'

/** The secret Control handed for one manifest entry: a dev sandbox's own, else its member's. */
const entrySecret = (id: string, members: readonly ProviderNamespaceMember[]): string | undefined => {
	for (const member of members) {
		if (member.devSandboxes !== undefined) {
			const sandbox = member.devSandboxes.find((candidate) => devSandboxEntryId(member.appId, candidate.workspaceId) === id)
			if (sandbox !== undefined) return sandbox.proxySecret
			continue
		}
		if (appEnvironmentId(member.appId, member.env) === id) return member.proxySecret
	}
	return undefined
}

/**
 * The proxy service variables a manifest needs: for each contract application, the secret Caddy sends it
 * (ADR-0022 rule 5), keyed by `proxySecretVariable`. A contract entry without a secret is refused, because
 * its application would refuse every request the proxy sends.
 */
export function namespaceProxySecrets(manifest: ProxyManifest, members: readonly ProviderNamespaceMember[]): ReadonlyMap<string, string> {
	const secrets = new Map<string, string>()
	for (const app of manifest.apps) {
		if (!isApplicationEntry(app)) continue
		const secret = entrySecret(app.id, members)
		if (secret === undefined || secret === '') {
			throw new Error(`Zerops proxy target ${app.id} is a contract application, and Control supplied no proxy secret for it`)
		}
		secrets.set(proxySecretVariable(app.id), secret)
	}
	return secrets
}
