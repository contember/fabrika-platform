// The proxy secret of one application environment (ADR-0022 rule 5). On Zerops a namespace is one private network, so
// the namespace proxy proves to the application that it sent a request with a secret only the two share. Control
// generates it the first time it is needed, seals it in the vault and hands it to the provider, which writes it to the
// proxy service and to the application service. It is never logged and never returned over the API.

import { appEnvironmentId } from '@fabrika/auth-core'
import type { ControlRegistryRepository } from './db'
import type { Vault, VaultSecretPurpose } from './vault'

/** 32 random bytes, base64url: 43 characters. */
const SECRET_BYTES = 32

export interface ProxySecrets {
	/** The environment's secret; the first call generates it, every later call answers the same one. */
	forAppEnv(appId: string, env: string): Promise<string>
}

/** The `{ scope, label }` the secret is sealed under — the only record of which environment owns its vault row. */
export function proxySecretPurpose(appId: string, env: string): VaultSecretPurpose {
	return { scope: 'platform', label: `platform:proxy-secret:${appEnvironmentId(appId, env)}` }
}

export function generateProxySecret(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(SECRET_BYTES))
	return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export class VaultProxySecrets implements ProxySecrets {
	constructor(
		private readonly refs: Pick<ControlRegistryRepository, 'getAppEnvProxySecretRef' | 'claimAppEnvProxySecretRef'>,
		private readonly vault: () => Promise<Vault>,
	) {}

	async forAppEnv(appId: string, env: string): Promise<string> {
		const purpose = proxySecretPurpose(appId, env)
		const vault = await this.vault()
		const stored = await this.refs.getAppEnvProxySecretRef(appId, env)
		if (stored !== null) {
			return vault.getSecretForPurpose(stored, purpose)
		}
		const secret = generateProxySecret()
		const ref = await vault.putSecret(purpose.scope, purpose.label, secret)
		if (await this.refs.claimAppEnvProxySecretRef(appId, env, ref)) {
			return secret
		}
		// Another holder recorded the environment's secret first; it stays the one both services share.
		await vault.delete(ref)
		const recorded = await this.refs.getAppEnvProxySecretRef(appId, env)
		if (recorded === null) {
			throw new Error(`the proxy secret of ${appId}/${env} could not be recorded`)
		}
		return vault.getSecretForPurpose(recorded, purpose)
	}
}
