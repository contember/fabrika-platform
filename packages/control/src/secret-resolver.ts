// The APP-SECRET resolution seam.
//
// The registry stores `app_secrets.value_ref` as a REFERENCE, never plaintext. At deploy time those
// refs become the values passed to a provider deploy (the app's `pipeline.secrets`). The only
// backend is the encrypted vault (src/vault.ts): `apps.secrets.put` and `vault.set` seal the value
// and store the `vault:<id>` ref. Resolved values are NEVER logged and live only in the provider
// invocation. A provider that manages secrets itself (`ControlProvider.secrets`) is never resolved here.
//
// Platform credentials (the CF API token, IAM provisioning creds) are NOT resolved here — they are
// fabrika's own Worker secrets (src/env.ts). This seam only turns per-app secret refs into values.

import { parseVaultRef, type SecretScope, type Vault, type VaultSecretPurpose } from './vault'

/**
 * The `{ scope, label }` an app secret's vault row is sealed under — the ONLY record of which app
 * secret owns a `vault:` ref. Every path that follows one from `app_secrets` checks against this.
 */
export function appSecretPurpose(appId: string, env: string | null, name: string): VaultSecretPurpose {
	const scope: SecretScope = env === null ? 'app' : 'app-env'
	return { scope, label: `${scope}:${appId}/${env ?? '*'}/${name}` }
}

/** Turns the registry's opaque app-secret refs into the plaintext values a deploy needs. */
export interface SecretResolver {
	/**
	 * Resolve an app secret's value from its `value_ref`.
	 *
	 * `purpose` is the (scope, label) the owning `app_secrets` row was written under. A `vault:` ref
	 * names a row in the SHARED vault, so it is the only thing that proves the row belongs to this
	 * app secret rather than to another app or to the platform.
	 */
	resolveSecret(ref: string, purpose: VaultSecretPurpose): Promise<string>
}

/** The production `SecretResolver`: a `vault:` ref resolves only when its row's purpose matches. */
export class VaultSecretResolver implements SecretResolver {
	constructor(
		private readonly deps: {
			/** Absent when the installation has no `FABRIKA_CONTROL_VAULT_KEY`. */
			vault?: Vault
		},
	) {}

	resolveSecret(ref: string, purpose: VaultSecretPurpose): Promise<string> {
		if (parseVaultRef(ref) === null) {
			// Names neither the ref nor the value: a legacy ref may carry the plaintext itself.
			return Promise.reject(new Error('app secret is not stored in the vault — set its value again'))
		}
		if (this.deps.vault === undefined) {
			return Promise.reject(new Error('cannot resolve app secret: vault not configured (FABRIKA_CONTROL_VAULT_KEY missing)'))
		}
		return this.deps.vault.getSecretForPurpose(ref, purpose)
	}
}
