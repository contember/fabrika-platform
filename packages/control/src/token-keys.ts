// The keys an application environment signs its tokens with (`token(Claims, { maxDays })` of a contract). A deploy of a
// contract that declares a token purpose reconciles them from the APPROVED snapshot and hands them to the provider as
// `FABRIKA_TOKEN_KEYS`: the signing key first, then each retired key that still verifies. A rotation is an operation on
// one environment (`requestRotation`), applied by its next deploy, never by a platform upgrade. A retired key verifies
// until the last token it signed may expire: its retirement plus the largest `maxDays` the contract had while it signed.
// Each key is sealed in the vault; none is ever logged or returned over the API.

import { appEnvironmentId, type ContractArtifact } from '@fabrika/auth-core'
import type { TokenKeyRepository, TokenKeyRow } from './db'
import type { Vault, VaultSecretPurpose } from './vault'

const DAY_SECONDS = 86_400
/** 8 random bytes, base64url: an 11-character key id each token carries. */
const KEY_ID_BYTES = 8
/** 32 random bytes, base64url: the HMAC-SHA256 key. */
const SECRET_BYTES = 32

export interface TokenKeysPort {
	/**
	 * The value of `FABRIKA_TOKEN_KEYS` for `artifact`: the signing key, generated the first time or after a requested
	 * rotation, then each retired key that still verifies; `null` for a contract without token purposes. A key no token
	 * can still carry is deleted.
	 */
	reconcile(appId: string, env: string, artifact: ContractArtifact | null): Promise<string | null>
}

/** The `{ scope, label }` a token key is sealed under — the only record of which environment owns its vault row. */
export function tokenKeyPurpose(appId: string, env: string, keyId: string): VaultSecretPurpose {
	return { scope: 'platform', label: `platform:token-key:${appEnvironmentId(appId, env)}:${keyId}` }
}

/** The longest lifetime any purpose of the contract declares; `null` without purposes. */
export function longestTokenLifetime(artifact: ContractArtifact | null): number | null {
	const lifetimes = Object.values(artifact?.tokens ?? {}).map((purpose) => purpose.maxDays)
	return lifetimes.length === 0 ? null : Math.max(...lifetimes)
}

function randomText(bytes: number): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url')
}

/** Whether a retired key still verifies a token it signed at `now`. */
function verifies(row: TokenKeyRow, now: number): boolean {
	return row.retired_at === null || row.retired_at + row.max_days * DAY_SECONDS > now
}

export class VaultTokenKeys implements TokenKeysPort {
	constructor(
		private readonly records: Pick<TokenKeyRepository, 'list' | 'insert' | 'retire' | 'raiseMaxDays' | 'delete'>,
		private readonly vault: () => Promise<Vault>,
		private readonly now: () => number = () => Math.floor(Date.now() / 1000),
	) {}

	async reconcile(appId: string, env: string, artifact: ContractArtifact | null): Promise<string | null> {
		const maxDays = longestTokenLifetime(artifact)
		const recorded = await this.records.list(appId, env)
		if (maxDays === null && recorded.length === 0) {
			return null
		}
		const vault = await this.vault()
		const now = this.now()
		let rows = recorded
		if (maxDays !== null) {
			rows = await this.#signing(vault, appId, env, recorded, maxDays, now)
		}
		for (const row of rows.filter((candidate) => !verifies(candidate, now))) {
			await this.records.delete(appId, env, row.key_id)
			await vault.delete(row.value_ref)
		}
		if (maxDays === null) {
			return null
		}
		const keys = rows.filter((row) => verifies(row, now))
		const ordered = [...keys.filter((row) => row.retired_at === null), ...keys.filter((row) => row.retired_at !== null)]
		const entries: string[] = []
		for (const row of ordered) {
			entries.push(`${row.key_id}:${await vault.getSecretForPurpose(row.value_ref, tokenKeyPurpose(appId, env, row.key_id))}`)
		}
		return entries.join(',')
	}

	/**
	 * The rows once one key signs: a requested rotation retires the signing key with the longest lifetime it signed for,
	 * the signing key's lifetime rises to the contract's, and an environment without a signing key gets a new one.
	 */
	async #signing(vault: Vault, appId: string, env: string, recorded: readonly TokenKeyRow[], maxDays: number, now: number): Promise<TokenKeyRow[]> {
		const rows = [...recorded]
		const index = rows.findIndex((row) => row.retired_at === null)
		const signing = rows[index]
		if (signing !== undefined && signing.rotation_requested_at !== null) {
			const longest = Math.max(signing.max_days, maxDays)
			await this.records.retire(appId, env, signing.key_id, now, longest)
			rows[index] = { ...signing, retired_at: now, max_days: longest, rotation_requested_at: null }
		} else if (signing !== undefined) {
			if (maxDays > signing.max_days) {
				await this.records.raiseMaxDays(appId, env, signing.key_id, maxDays)
				rows[index] = { ...signing, max_days: maxDays }
			}
			return rows
		}
		const keyId = randomText(KEY_ID_BYTES)
		const purpose = tokenKeyPurpose(appId, env, keyId)
		const ref = await vault.putSecret(purpose.scope, purpose.label, randomText(SECRET_BYTES))
		const row: TokenKeyRow = {
			app_id: appId,
			env,
			key_id: keyId,
			value_ref: ref,
			created_at: now,
			retired_at: null,
			max_days: maxDays,
			rotation_requested_at: null,
		}
		try {
			await this.records.insert(row)
		} catch (error) {
			await vault.delete(ref)
			throw error
		}
		return [row, ...rows]
	}
}
