// The ops key of one application environment (ADR-0069): the bearer Control calls the environment's object with over
// the platform-composed `/__fabrika/ops/*` row. Control generates it, seals it in the vault and records its digest in
// `app_env_ops_keys`; a deploy at a release that serves the channel hands the object the digests only, as
// `FABRIKA_OPS_KEY_DIGESTS`. A digest has no clock expiry: a gated deploy rotates a key once it is 15 days old and hands
// the old digest beside the new one, and the old key goes only once a deploy that carried the new one succeeded, so a
// failed deploy leaves the running version and the key Control holds for it usable. Never logged, never returned over
// the API.

import { appEnvironmentId, formatOpsKeyDigests, opsKeyDigest } from '@fabrika/auth-core'
import { uuidv7 } from '@fabrika/platform'
import type { OpsKeyRecord, OpsKeyRepository } from './db'
import type { Vault, VaultSecretPurpose } from './vault'

/** A gated deploy rotates a key at least this old. */
export const OPS_KEY_ROTATE_AFTER_SECONDS = 15 * 86_400

/** 32 random bytes, base64url: 43 characters after the `ok_` prefix. */
const KEY_BYTES = 32

export interface OpsKeysPort {
	/**
	 * The value of `FABRIKA_OPS_KEY_DIGESTS` for deploy `runId` at a release that serves the channel: the key the running
	 * version accepts, and a newer one while a rotation waits for a deploy that carries it to succeed. Issues the first
	 * key, rotates one 15 days old, and drops the previous key once the running version accepts the newer one.
	 */
	reconcile(appId: string, env: string, runId: string): Promise<string>
	/** The newest key the running version accepts, for Control's own ops calls; `null` while none does. */
	opsKeyFor(appId: string, env: string): Promise<string | null>
}

/** The `{ scope, label }` an ops key is sealed under — the only record of which environment owns its vault row. */
export function opsKeyPurpose(appId: string, env: string, keyId: string): VaultSecretPurpose {
	return { scope: 'platform', label: `platform:ops-key:${appEnvironmentId(appId, env)}:${keyId}` }
}

function generateOpsKey(): string {
	return `ok_${Buffer.from(crypto.getRandomValues(new Uint8Array(KEY_BYTES))).toString('base64url')}`
}

/** Whether the running version accepts `row`: the run that handed it succeeded. */
const accepted = (row: OpsKeyRecord): boolean => row.handed_by_status === 'succeeded'

/** The digests a gated deploy hands; an installation without a vault keeps no ops key, so the deploy fails. */
export async function reconcileOpsKey(deps: { opsKeys?: OpsKeysPort }, appId: string, env: string, runId: string): Promise<string> {
	if (deps.opsKeys === undefined) {
		throw new Error("the application's release serves the ops channel, and this installation cannot keep its key (it needs FABRIKA_CONTROL_VAULT_KEY)")
	}
	return deps.opsKeys.reconcile(appId, env, runId)
}

export class VaultOpsKeys implements OpsKeysPort {
	constructor(
		private readonly records: Pick<OpsKeyRepository, 'list' | 'insert' | 'handTo' | 'delete'>,
		private readonly vault: () => Promise<Vault>,
		private readonly now: () => number = () => Math.floor(Date.now() / 1000),
	) {}

	async reconcile(appId: string, env: string, runId: string): Promise<string> {
		const rows = await this.records.list(appId, env)
		const vault = await this.vault()
		const current = rows.findIndex(accepted)
		// Older than the key the running version accepts: no version that can still run holds it.
		const kept = current === -1 ? rows : rows.slice(0, current + 1)
		for (const row of rows.slice(kept.length)) {
			await this.records.delete(appId, env, row.key_id)
			await vault.delete(row.value_ref)
		}
		const newest = kept[0]
		if (newest === undefined) {
			return formatOpsKeyDigests([await this.#issue(vault, appId, env, runId)])
		}
		if (!accepted(newest)) {
			// The run that handed it did not succeed; this one hands it again, and a pending key never rotates.
			await this.records.handTo(appId, env, newest.key_id, runId)
		} else if (this.now() - newest.created_at >= OPS_KEY_ROTATE_AFTER_SECONDS) {
			return formatOpsKeyDigests([newest.digest, await this.#issue(vault, appId, env, runId)])
		}
		const [first, second, ...rest] = [...kept].reverse().map((row) => row.digest)
		if (first === undefined || rest.length > 0) throw new Error(`the ops keys of ${appId}/${env} are not one or two`)
		return formatOpsKeyDigests(second === undefined ? [first] : [first, second])
	}

	async opsKeyFor(appId: string, env: string): Promise<string | null> {
		const row = (await this.records.list(appId, env)).find(accepted)
		if (row === undefined) return null
		const vault = await this.vault()
		return vault.getSecretForPurpose(row.value_ref, opsKeyPurpose(appId, env, row.key_id))
	}

	/** A new key handed by `runId`, sealed and recorded; its digest. */
	async #issue(vault: Vault, appId: string, env: string, runId: string): Promise<string> {
		const keyId = uuidv7()
		const key = generateOpsKey()
		const purpose = opsKeyPurpose(appId, env, keyId)
		const ref = await vault.putSecret(purpose.scope, purpose.label, key)
		const digest = opsKeyDigest(key)
		try {
			await this.records.insert({ app_id: appId, env, key_id: keyId, value_ref: ref, digest, handed_by: runId, created_at: this.now() })
		} catch (error) {
			await vault.delete(ref)
			throw error
		}
		return digest
	}
}
