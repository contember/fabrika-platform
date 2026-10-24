import type { SqlDatabase } from '@fabrika/platform'

/** One ops key of an application environment; the key itself lives in the vault (`value_ref`). */
export interface OpsKeyRow {
	app_id: string
	env: string
	key_id: string
	value_ref: string
	/** `sha256:<64 hex>` of the key (`opsKeyDigest`), the form the object holds. */
	digest: string
	/** The newest run that handed the key while no running version accepted it. */
	handed_by: string
	created_at: number
}

/** A key with the status of the run that handed it: `succeeded` means the running version accepts the key. */
export interface OpsKeyRecord extends OpsKeyRow {
	handed_by_status: string | null
}

export class OpsKeyRepository {
	constructor(private readonly d1: SqlDatabase) {}

	/** Every key of the environment, the newest first. */
	async list(appId: string, env: string): Promise<OpsKeyRecord[]> {
		const { results } = await this.d1
			.prepare(
				`SELECT k.app_id, k.env, k.key_id, k.value_ref, k.digest, k.handed_by, k.created_at, r.status AS handed_by_status
				FROM app_env_ops_keys k LEFT JOIN runs r ON r.id = k.handed_by
				WHERE k.app_id = ? AND k.env = ?
				ORDER BY k.created_at DESC, k.key_id DESC`,
			)
			.bind(appId, env)
			.all<OpsKeyRecord>()
		return results
	}

	async insert(row: OpsKeyRow): Promise<void> {
		await this.d1
			.prepare(
				`INSERT INTO app_env_ops_keys (app_id, env, key_id, value_ref, digest, handed_by, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(row.app_id, row.env, row.key_id, row.value_ref, row.digest, row.handed_by, row.created_at)
			.run()
	}

	/** Records that `runId` hands the key again, because the run that handed it before did not succeed. */
	async handTo(appId: string, env: string, keyId: string, runId: string): Promise<void> {
		await this.d1
			.prepare('UPDATE app_env_ops_keys SET handed_by = ? WHERE app_id = ? AND env = ? AND key_id = ?')
			.bind(runId, appId, env, keyId)
			.run()
	}

	async delete(appId: string, env: string, keyId: string): Promise<void> {
		await this.d1.prepare('DELETE FROM app_env_ops_keys WHERE app_id = ? AND env = ? AND key_id = ?').bind(appId, env, keyId).run()
	}
}
