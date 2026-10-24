import type { SqlDatabase } from '@fabrika/platform'
import { type LeaseFence, runLeaseKey } from '../lease'

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

const leaseHeld = 'EXISTS (SELECT 1 FROM deploy_locks WHERE lock_key = ? AND holder = ? AND expires_at > ?)'

/** Every write is fenced on the environment's `<app>:<env>` deploy lease in the same batch, like a run's. */
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

	/** Records a key; `false` when `fence` does not hold the environment's lease. */
	async insert(row: OpsKeyRow, fence: LeaseFence): Promise<boolean> {
		return this.#fenced(
			row.app_id,
			row.env,
			`INSERT INTO app_env_ops_keys (app_id, env, key_id, value_ref, digest, handed_by, created_at)
			SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${leaseHeld} RETURNING key_id`,
			[row.app_id, row.env, row.key_id, row.value_ref, row.digest, row.handed_by, row.created_at],
			fence,
		)
	}

	/** Records that `runId` hands the key again, because the run that handed it before did not succeed. */
	async handTo(appId: string, env: string, keyId: string, runId: string, fence: LeaseFence): Promise<boolean> {
		return this.#fenced(
			appId,
			env,
			`UPDATE app_env_ops_keys SET handed_by = ? WHERE app_id = ? AND env = ? AND key_id = ? AND ${leaseHeld} RETURNING key_id`,
			[runId, appId, env, keyId],
			fence,
		)
	}

	async delete(appId: string, env: string, keyId: string, fence: LeaseFence): Promise<boolean> {
		return this.#fenced(
			appId,
			env,
			`DELETE FROM app_env_ops_keys WHERE app_id = ? AND env = ? AND key_id = ? AND ${leaseHeld} RETURNING key_id`,
			[appId, env, keyId],
			fence,
		)
	}

	async #fenced(appId: string, env: string, sql: string, values: (string | number)[], fence: LeaseFence): Promise<boolean> {
		const key = runLeaseKey(appId, env)
		// The lease row must stay locked through the write: an EXISTS alone races a takeover on Postgres.
		const results = await this.d1.batch<{ key_id: string }>([
			this.d1.prepare('UPDATE deploy_locks SET holder = holder WHERE lock_key = ? AND holder = ? AND expires_at > ?').bind(
				key,
				fence.holder,
				fence.nowMs,
			),
			this.d1.prepare(sql).bind(...values, key, fence.holder, fence.nowMs),
		])
		return (results[1]?.results.length ?? 0) > 0
	}
}
