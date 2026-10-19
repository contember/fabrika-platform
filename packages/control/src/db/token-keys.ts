import type { SqlDatabase } from '@fabrika/platform'

/** One signing key of an application environment's tokens; the secret itself lives in the vault (`value_ref`). */
export interface TokenKeyRow {
	app_id: string
	env: string
	key_id: string
	value_ref: string
	created_at: number
	/** When the key stopped signing, unix seconds; `null` for the key that signs. */
	retired_at: number | null
	/** The largest `maxDays` the contract declared while the key signed: it verifies that long after its retirement. */
	max_days: number
	/** When an operator asked the next deploy to rotate the signing key; `null` when nobody did. */
	rotation_requested_at: number | null
}

export class TokenKeyRepository {
	constructor(private readonly d1: SqlDatabase) {}

	/** Every key of the environment, the newest first. */
	async list(appId: string, env: string): Promise<TokenKeyRow[]> {
		const { results } = await this.d1
			.prepare('SELECT * FROM app_env_token_keys WHERE app_id = ? AND env = ? ORDER BY created_at DESC, key_id')
			.bind(appId, env)
			.all<TokenKeyRow>()
		return results
	}

	async insert(row: TokenKeyRow): Promise<void> {
		await this.d1
			.prepare(
				`INSERT INTO app_env_token_keys (app_id, env, key_id, value_ref, created_at, retired_at, max_days, rotation_requested_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(row.app_id, row.env, row.key_id, row.value_ref, row.created_at, row.retired_at, row.max_days, row.rotation_requested_at)
			.run()
	}

	/** Records the key's retirement and the longest lifetime a token it signed may have. */
	async retire(appId: string, env: string, keyId: string, retiredAt: number, maxDays: number): Promise<void> {
		await this.d1
			.prepare('UPDATE app_env_token_keys SET retired_at = ?, max_days = ?, rotation_requested_at = NULL WHERE app_id = ? AND env = ? AND key_id = ?')
			.bind(retiredAt, maxDays, appId, env, keyId)
			.run()
	}

	/** Raises the signing key's longest lifetime; a lower value never lowers it, so no token it signed is cut off. */
	async raiseMaxDays(appId: string, env: string, keyId: string, maxDays: number): Promise<void> {
		await this.d1
			.prepare('UPDATE app_env_token_keys SET max_days = ? WHERE app_id = ? AND env = ? AND key_id = ? AND max_days < ?')
			.bind(maxDays, appId, env, keyId, maxDays)
			.run()
	}

	/** Asks the next deploy to rotate the signing key; `false` when the environment has none yet. */
	async requestRotation(appId: string, env: string, at: number): Promise<boolean> {
		const result = await this.d1
			.prepare('UPDATE app_env_token_keys SET rotation_requested_at = ? WHERE app_id = ? AND env = ? AND retired_at IS NULL')
			.bind(at, appId, env)
			.run()
		return result.meta.changes > 0
	}

	async delete(appId: string, env: string, keyId: string): Promise<void> {
		await this.d1.prepare('DELETE FROM app_env_token_keys WHERE app_id = ? AND env = ? AND key_id = ?').bind(appId, env, keyId).run()
	}
}
