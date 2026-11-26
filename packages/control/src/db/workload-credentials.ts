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
	/** When Control last warned the application's Operations that the held key is about to expire; null for a new key. */
	expiry_warned_at: number | null
}

/** A workload key the running version holds that expires soon, with when it expires. */
export interface ExpiringWorkloadKey {
	app_id: string
	env: string
	kind: WorkloadKind
	name: string
	credential_id: string
	expires_at: number
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

	/**
	 * Records the workload's current key in place of the key `replaces` (`null`: no key was recorded). `false` when the
	 * record names another key by now: another writer recorded its own key meanwhile, and this one is not recorded.
	 */
	async put(row: WorkloadCredentialRow, replaces: string | null): Promise<boolean> {
		const result = replaces === null
			? await this.d1
				.prepare(`INSERT INTO app_env_workload_credentials
					(app_id, env, kind, name, value_ref, credential_id, expires_at, pending, handed_by, held_expires_at, expiry_warned_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT (app_id, env, kind, name) DO NOTHING`)
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
					row.expiry_warned_at,
				)
				.run()
			: await this.d1
				.prepare(`UPDATE app_env_workload_credentials SET
					value_ref = ?, credential_id = ?, expires_at = ?, pending = ?, handed_by = ?, held_expires_at = ?, expiry_warned_at = ?
					WHERE app_id = ? AND env = ? AND kind = ? AND name = ? AND credential_id = ?`)
				.bind(
					row.value_ref,
					row.credential_id,
					row.expires_at,
					row.pending,
					row.handed_by,
					row.held_expires_at,
					row.expiry_warned_at,
					row.app_id,
					row.env,
					row.kind,
					row.name,
					replaces,
				)
				.run()
		return result.meta.changes > 0
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

	/**
	 * Every key, in an environment that is not `dev`, whose held copy expires at or before `before` and that was not
	 * warned about after `warnedAfter`. The held copy is the recorded key, or while it is pending and no succeeded run
	 * handed it, the key it replaced.
	 */
	async listExpiring(before: number, warnedAfter: number): Promise<ExpiringWorkloadKey[]> {
		const { results } = await this.d1
			.prepare(`SELECT k.app_id, k.env, k.kind, k.name, k.credential_id, k.expires_at FROM (
					SELECT c.app_id, c.env, c.kind, c.name, c.credential_id, c.expiry_warned_at,
						CASE WHEN c.pending = 1 AND c.held_expires_at IS NOT NULL AND COALESCE(r.status, '') <> 'succeeded'
							THEN c.held_expires_at ELSE c.expires_at END AS expires_at
					FROM app_env_workload_credentials c
					JOIN app_envs e ON e.app_id = c.app_id AND e.env = c.env
					LEFT JOIN runs r ON r.id = c.handed_by
					WHERE e.kind <> 'dev'
				) k
				WHERE k.expires_at <= ? AND (k.expiry_warned_at IS NULL OR k.expiry_warned_at <= ?)
				ORDER BY k.app_id, k.env, k.kind, k.name`)
			.bind(before, warnedAfter)
			.all<ExpiringWorkloadKey>()
		return results
	}

	/** Records that Control warned about the key `credentialId`; a row that names another key is left as it is. */
	async markExpiryWarned(appId: string, env: string, kind: WorkloadKind, name: string, credentialId: string, at: number): Promise<void> {
		await this.d1
			.prepare(`UPDATE app_env_workload_credentials SET expiry_warned_at = ?
				WHERE app_id = ? AND env = ? AND kind = ? AND name = ? AND credential_id = ?`)
			.bind(at, appId, env, kind, name, credentialId)
			.run()
	}

	/**
	 * Records that `run` handed the pending key `credentialId`; a row that names another key, or that a succeeded run
	 * handed already, is left as it is.
	 */
	async markHandedBy(appId: string, env: string, kind: WorkloadCredentialRow['kind'], name: string, credentialId: string, run: string): Promise<void> {
		await this.d1
			.prepare(`UPDATE app_env_workload_credentials SET handed_by = ?
				WHERE app_id = ? AND env = ? AND kind = ? AND name = ? AND credential_id = ? AND pending = 1
					AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = app_env_workload_credentials.handed_by AND r.status = 'succeeded')`)
			.bind(run, appId, env, kind, name, credentialId)
			.run()
	}

	/**
	 * Records that the running version holds every pending key a succeeded run handed, on any provider: the next issuance
	 * then counts the key as the one held. Answers how many keys it confirmed.
	 */
	async confirmHanded(): Promise<number> {
		const result = await this.d1
			.prepare(`UPDATE app_env_workload_credentials SET pending = 0, handed_by = NULL, held_expires_at = NULL
				WHERE pending = 1 AND handed_by IN (SELECT id FROM runs WHERE status = 'succeeded')`)
			.run()
		return result.meta.changes
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
