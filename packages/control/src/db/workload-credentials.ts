import type { WorkloadKind } from '@fabrika/auth-core'
import type { SqlDatabase } from '@fabrika/platform'

/**
 * One workload key of an application environment; the key itself lives in the vault (`value_ref`). Kind `public` is a
 * public procedure's, `name` its endpoint id; kind `app` is the connector key at the owner application `name`.
 */
export interface WorkloadCredentialRow {
	app_id: string
	env: string
	kind: WorkloadKind
	name: string
	value_ref: string
	/** IAM's id of the active key: what the next issuance keeps. */
	credential_id: string
	expires_at: number
	/** 1 while the running version may not hold this key: no succeeded deploy and no secret write has handed it yet. */
	pending: number
	/** The newest run that handed the key while it was pending, which the maintenance pass reads to confirm it. */
	handed_by: string | null
	/** While pending after a rotation: when the key the running version still holds expires. */
	held_expires_at: number | null
}

/** An environment with a workload key the maintenance pass has to renew or hand to its running version. */
export interface DueWorkloadKeyEnvironment {
	app_id: string
	env: string
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
			.prepare(`INSERT INTO app_env_workload_credentials
				(app_id, env, kind, name, value_ref, credential_id, expires_at, pending, handed_by, held_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (app_id, env, kind, name) DO UPDATE SET
					value_ref = excluded.value_ref, credential_id = excluded.credential_id, expires_at = excluded.expires_at,
					pending = excluded.pending, handed_by = excluded.handed_by, held_expires_at = excluded.held_expires_at`)
			.bind(
				row.app_id,
				row.env,
				row.kind,
				row.name,
				row.value_ref,
				row.credential_id,
				row.expires_at,
				row.pending,
				row.handed_by,
				row.held_expires_at,
			)
			.run()
	}

	/**
	 * Every environment, `dev` ones aside, with a key that expires at or before `before` or that its running version may
	 * not hold yet.
	 */
	async listDue(before: number): Promise<DueWorkloadKeyEnvironment[]> {
		const { results } = await this.d1
			.prepare(`SELECT DISTINCT c.app_id, c.env FROM app_env_workload_credentials c
				JOIN app_envs e ON e.app_id = c.app_id AND e.env = c.env
				WHERE e.kind <> 'dev' AND (c.pending = 1 OR c.expires_at <= ?)
				ORDER BY c.app_id, c.env`)
			.bind(before)
			.all<DueWorkloadKeyEnvironment>()
		return results
	}

	/** Records that `run` handed the pending key `credentialId`; a row that names another key is left as it is. */
	async markHandedBy(appId: string, env: string, kind: WorkloadCredentialRow['kind'], name: string, credentialId: string, run: string): Promise<void> {
		await this.d1
			.prepare(`UPDATE app_env_workload_credentials SET handed_by = ?
				WHERE app_id = ? AND env = ? AND kind = ? AND name = ? AND credential_id = ? AND pending = 1`)
			.bind(run, appId, env, kind, name, credentialId)
			.run()
	}

	/** Records that the running version holds `credentialId`; a row that names another key is left as it is. */
	async confirm(appId: string, env: string, kind: WorkloadCredentialRow['kind'], name: string, credentialId: string): Promise<void> {
		await this.d1
			.prepare(`UPDATE app_env_workload_credentials SET pending = 0, handed_by = NULL, held_expires_at = NULL
				WHERE app_id = ? AND env = ? AND kind = ? AND name = ? AND credential_id = ?`)
			.bind(appId, env, kind, name, credentialId)
			.run()
	}

	async delete(appId: string, env: string, kind: WorkloadCredentialRow['kind'], name: string): Promise<void> {
		await this.d1
			.prepare('DELETE FROM app_env_workload_credentials WHERE app_id = ? AND env = ? AND kind = ? AND name = ?')
			.bind(appId, env, kind, name)
			.run()
	}
}
