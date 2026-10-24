// The ops key of one application environment (ADR-0069): the bearer Control calls the environment's object with over
// the platform-composed `/__fabrika/ops/*` row. Control generates it, seals it in the vault and records its digest in
// `app_env_ops_keys`; a deploy at a release that serves the channel hands the object the digests only, as
// `FABRIKA_OPS_KEY_DIGESTS`. A digest has no clock expiry: a gated deploy rotates a key once it is 15 days old and hands
// the old digest beside the new one, and the old key goes only once a deploy that carried the new one succeeded, so a
// failed deploy leaves the running version and the key Control holds for it usable. Every record write is fenced on the
// deploy's lease. The key is never logged and never returned over the API.

import { appEnvironmentId, formatOpsKeyDigests, opsKeyDigest } from '@fabrika/auth-core'
import { uuidv7 } from '@fabrika/platform'
import type { OpsKeyRecord, OpsKeyRepository } from './db'
import type { LeaseFence } from './lease'
import type { Vault, VaultSecretPurpose } from './vault'

/** A gated deploy rotates a key at least this old. */
export const OPS_KEY_ROTATE_AFTER_SECONDS = 15 * 86_400

/** 32 random bytes, base64url: 43 characters after the `ok_` prefix. */
const KEY_BYTES = 32

/** The deploy invocation's fenced write: a refused one throws, and so does one whose outcome is unknown. */
export interface OpsKeyWrites {
	write(mutation: (fence: LeaseFence) => Promise<boolean>): Promise<void>
}

export interface OpsKeysPort {
	/**
	 * The value of `FABRIKA_OPS_KEY_DIGESTS` for deploy `runId` at a release that serves the channel: the key the running
	 * version accepts, and a newer one while a rotation waits for a deploy that carries it to succeed. Issues the first
	 * key, rotates one 15 days old, and drops the previous key once a deploy that carried the newer one succeeded.
	 */
	reconcile(appId: string, env: string, runId: string, invocation: OpsKeyWrites): Promise<string>
	/**
	 * The keys Control may present to the environment's object, the newest first and at most two: a key a deploy handed
	 * that has not succeeded yet, then the one the last succeeded deploy carried. A version can be active although its
	 * run failed later (an IAM reconcile), so a caller tries each in turn until one is not refused.
	 */
	opsKeysFor(appId: string, env: string): Promise<string[]>
}

/** The `{ scope, label }` an ops key is sealed under — the only record of which environment owns its vault row. */
export function opsKeyPurpose(appId: string, env: string, keyId: string): VaultSecretPurpose {
	return { scope: 'platform', label: `platform:ops-key:${appEnvironmentId(appId, env)}:${keyId}` }
}

function generateOpsKey(): string {
	return `ok_${Buffer.from(crypto.getRandomValues(new Uint8Array(KEY_BYTES))).toString('base64url')}`
}

/** Whether the run that handed `row` succeeded, so the version it deployed accepts the key. */
const accepted = (row: OpsKeyRecord): boolean => row.handed_by_status === 'succeeded'

/** The keys no version that can still run holds are the ones older than the newest accepted key. */
const current = (rows: readonly OpsKeyRecord[]): readonly OpsKeyRecord[] => {
	const index = rows.findIndex(accepted)
	return index === -1 ? rows : rows.slice(0, index + 1)
}

/** The digests a gated deploy hands; an installation without a vault keeps no ops key, so the deploy fails. */
export async function reconcileOpsKey(
	deps: { opsKeys?: OpsKeysPort },
	appId: string,
	env: string,
	runId: string,
	invocation: OpsKeyWrites,
): Promise<string> {
	if (deps.opsKeys === undefined) {
		throw new Error("the application's release serves the ops channel, and this installation cannot keep its key (it needs FABRIKA_CONTROL_VAULT_KEY)")
	}
	return deps.opsKeys.reconcile(appId, env, runId, invocation)
}

export class VaultOpsKeys implements OpsKeysPort {
	constructor(
		private readonly records: Pick<OpsKeyRepository, 'list' | 'insert' | 'handTo' | 'delete'>,
		private readonly vault: () => Promise<Vault>,
		private readonly now: () => number = () => Math.floor(Date.now() / 1000),
	) {}

	async reconcile(appId: string, env: string, runId: string, invocation: OpsKeyWrites): Promise<string> {
		const rows = await this.records.list(appId, env)
		const vault = await this.vault()
		const kept = current(rows)
		for (const row of rows.slice(kept.length)) await this.#drop(vault, row, invocation)
		const newest = kept[0]
		if (newest === undefined) {
			return formatOpsKeyDigests([await this.#issue(vault, appId, env, runId, invocation)])
		}
		if (!accepted(newest)) {
			// The run that handed it did not succeed; this one hands it again, and a pending key never rotates.
			await invocation.write((fence) => this.records.handTo(appId, env, newest.key_id, runId, fence))
		} else if (this.now() - newest.created_at >= OPS_KEY_ROTATE_AFTER_SECONDS) {
			return formatOpsKeyDigests([newest.digest, await this.#issue(vault, appId, env, runId, invocation)])
		}
		const [first, second, ...rest] = [...kept].reverse().map((row) => row.digest)
		if (first === undefined || rest.length > 0) throw new Error(`the ops keys of ${appId}/${env} are not one or two`)
		return formatOpsKeyDigests(second === undefined ? [first] : [first, second])
	}

	async opsKeysFor(appId: string, env: string): Promise<string[]> {
		const candidates = current(await this.records.list(appId, env)).slice(0, 2)
		if (candidates.length === 0) return []
		const vault = await this.vault()
		const keys: string[] = []
		for (const row of candidates) keys.push(await vault.getSecretForPurpose(row.value_ref, opsKeyPurpose(appId, env, row.key_id)))
		return keys
	}

	/** Deletes a key no running version holds: its record under the lease, then its vault row, only if the row is the key's. */
	async #drop(vault: Vault, row: OpsKeyRecord, invocation: OpsKeyWrites): Promise<void> {
		try {
			await vault.getSecretForPurpose(row.value_ref, opsKeyPurpose(row.app_id, row.env, row.key_id))
		} catch {
			// A ref that is not this key's points at another credential, or at none: keep the record and touch no vault row.
			console.error(`ops key ${row.key_id} of ${row.app_id}/${row.env} is not sealed under its own purpose; its record is kept`)
			return
		}
		await invocation.write((fence) => this.records.delete(row.app_id, row.env, row.key_id, fence))
		await vault.delete(row.value_ref)
	}

	/** A new key handed by `runId`, sealed and recorded under the lease; its digest. */
	async #issue(vault: Vault, appId: string, env: string, runId: string, invocation: OpsKeyWrites): Promise<string> {
		const keyId = uuidv7()
		const key = generateOpsKey()
		const purpose = opsKeyPurpose(appId, env, keyId)
		const ref = await vault.putSecret(purpose.scope, purpose.label, key)
		const digest = opsKeyDigest(key)
		const row = { app_id: appId, env, key_id: keyId, value_ref: ref, digest, handed_by: runId, created_at: this.now() }
		try {
			await invocation.write((fence) => this.records.insert(row, fence))
		} catch (error) {
			// The record was refused or its outcome is unknown; the fresh vault row is this call's own.
			await vault.delete(ref)
			throw error
		}
		return digest
	}
}
