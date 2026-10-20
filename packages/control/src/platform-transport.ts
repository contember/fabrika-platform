// The platform transport key of one application environment: the bearer it calls a platform receiver of Control (the
// mail relay) with. Control issues it itself, keeps only its SHA-256 hash in `platform_transport_keys`, and seals the
// value in the vault to hand it to the next deploy. Never logged, never returned over the API.

import { appEnvironmentId, MAX_KEY_LIFETIME_SECONDS, type PlatformReceiver } from '@fabrika/auth-core'
import { hashPlatformKey } from '@fabrika/email/platform'
import { uuidv7 } from '@fabrika/platform'
import type { PlatformTransportKeyRepository } from './db'
import type { Vault, VaultSecretPurpose } from './vault'

/** Control's private origin, which an application container reaches on Zerops and in the local stack. */
export const CONTROL_PRIVATE_ORIGIN = 'http://control:3000'

export const PLATFORM_KEY_LIFETIME_SECONDS = MAX_KEY_LIFETIME_SECONDS

/** A key with less than this left is replaced, so a running version never holds one that is about to expire. */
export const PLATFORM_KEY_ROTATE_BELOW_SECONDS = PLATFORM_KEY_LIFETIME_SECONDS / 2

export interface PlatformTransportPort {
	/**
	 * The environment's key for `receiver` while `needed`: the newest one while it is fresh, or a newly issued one.
	 * Without need every key of the receiver and its vault row is deleted.
	 */
	reconcile(appId: string, env: string, receiver: PlatformReceiver, needed: boolean): Promise<string | null>
}

/** The `{ scope, label }` the key is sealed under — the only record of which environment owns its vault row. */
export function platformKeyPurpose(appId: string, env: string, receiver: PlatformReceiver): VaultSecretPurpose {
	return { scope: 'platform', label: `platform:platform-key:${appEnvironmentId(appId, env)}:${receiver}` }
}

/** `px_` and 160 random bits as 27 base64url characters, the format of the keys IAM issues. */
export function generatePlatformKey(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(20))
	return `px_${btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}`
}

export class VaultPlatformTransport implements PlatformTransportPort {
	constructor(
		private readonly records: Pick<PlatformTransportKeyRepository, 'insert' | 'listForAppEnv' | 'deleteForAppEnv' | 'deleteExpired'>,
		private readonly vault: () => Promise<Vault>,
		private readonly now: () => number = () => Math.floor(Date.now() / 1000),
	) {}

	async reconcile(appId: string, env: string, receiver: PlatformReceiver, needed: boolean): Promise<string | null> {
		const rows = (await this.records.listForAppEnv(appId, env)).filter((row) => row.receiver === receiver)
		if (!needed) {
			if (rows.length > 0) {
				await this.records.deleteForAppEnv(appId, env, receiver)
				const vault = await this.vault()
				for (const row of rows) await vault.delete(row.value_ref)
			}
			return null
		}
		const vault = await this.vault()
		const purpose = platformKeyPurpose(appId, env, receiver)
		const now = this.now()
		const newest = rows[0]
		if (newest !== undefined && newest.expires_at - now > PLATFORM_KEY_ROTATE_BELOW_SECONDS) {
			return vault.getSecretForPurpose(newest.value_ref, purpose)
		}
		const key = generatePlatformKey()
		const ref = await vault.putSecret(purpose.scope, purpose.label, key)
		try {
			await this.records.insert({
				app_id: appId,
				env,
				receiver,
				key_id: uuidv7(),
				key_hash: await hashPlatformKey(key),
				value_ref: ref,
				expires_at: now + PLATFORM_KEY_LIFETIME_SECONDS,
				created_at: now,
			})
		} catch (error) {
			await vault.delete(ref)
			throw error
		}
		// A replaced key stays valid by its hash row until its own expiry, but Control never hands its value out again.
		for (const row of rows) await vault.delete(row.value_ref)
		await this.records.deleteExpired(now)
		return key
	}
}
