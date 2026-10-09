import type { SqlDatabase } from '@fabrika/platform'

/**
 * One workload key of an application environment; the key itself lives in the vault (`value_ref`). Kind `app` is the
 * connector key at the owner application `name`.
 */
export interface WorkloadCredentialRow {
	app_id: string
	env: string
	kind: 'job' | 'webhook' | 'app'
	name: string
	value_ref: string
	/** IAM's id of the active key: what the next issuance keeps. */
	credential_id: string
	expires_at: number
}

export class WorkloadCredentialRepository {
	constructor(private readonly d1: SqlDatabase) {}

	async list(appId: string, env: string): Promise<WorkloadCredentialRow[]> {
		const { results } = await this.d1
			.prepare('SELECT * FROM app_env_workload_credentials WHERE app_id = ? AND env = ? ORDER BY kind, name')
			.bind(appId, env)
			.all<WorkloadCredentialRow>()
		return results
	}

	/** Records the workload's current key, replacing the one before it. */
	async put(row: WorkloadCredentialRow): Promise<void> {
		await this.d1
			.prepare(`INSERT INTO app_env_workload_credentials (app_id, env, kind, name, value_ref, credential_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (app_id, env, kind, name) DO UPDATE SET
					value_ref = excluded.value_ref, credential_id = excluded.credential_id, expires_at = excluded.expires_at`)
			.bind(row.app_id, row.env, row.kind, row.name, row.value_ref, row.credential_id, row.expires_at)
			.run()
	}

	async delete(appId: string, env: string, kind: WorkloadCredentialRow['kind'], name: string): Promise<void> {
		await this.d1
			.prepare('DELETE FROM app_env_workload_credentials WHERE app_id = ? AND env = ? AND kind = ? AND name = ?')
			.bind(appId, env, kind, name)
			.run()
	}
}
