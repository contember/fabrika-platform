import type { SqlDatabase } from '@fabrika/platform'

/** The membership transport key of an application environment; the key itself lives in the vault (`value_ref`). */
export interface MembershipKeyRow {
	app_id: string
	env: string
	value_ref: string
	/** IAM's id of the active key: what the next issuance keeps. */
	key_id: string
	expires_at: number
}

export class MembershipKeyRepository {
	constructor(private readonly d1: SqlDatabase) {}

	async get(appId: string, env: string): Promise<MembershipKeyRow | null> {
		return this.d1.prepare('SELECT * FROM app_env_membership_keys WHERE app_id = ? AND env = ?').bind(appId, env).first<MembershipKeyRow>()
	}

	/** Records the environment's current key, replacing the one before it. */
	async put(row: MembershipKeyRow): Promise<void> {
		await this.d1
			.prepare(`INSERT INTO app_env_membership_keys (app_id, env, value_ref, key_id, expires_at) VALUES (?, ?, ?, ?, ?)
				ON CONFLICT (app_id, env) DO UPDATE SET value_ref = excluded.value_ref, key_id = excluded.key_id, expires_at = excluded.expires_at`)
			.bind(row.app_id, row.env, row.value_ref, row.key_id, row.expires_at)
			.run()
	}

	async delete(appId: string, env: string): Promise<void> {
		await this.d1.prepare('DELETE FROM app_env_membership_keys WHERE app_id = ? AND env = ?').bind(appId, env).run()
	}
}
