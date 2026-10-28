import type { SqlDatabase } from '@fabrika/platform'

/** One key an application environment calls a platform receiver with; the value itself lives in the vault (`value_ref`). */
export interface PlatformTransportKeyRow {
	app_id: string
	env: string
	/** A `PlatformReceiver` of `@fabrika/auth-core`: `mail`. */
	receiver: string
	key_id: string
	/** SHA-256 hex of the key, which is what the relay looks a bearer up by. */
	key_hash: string
	value_ref: string
	/** Unix seconds; the key is valid strictly before it. */
	expires_at: number
	created_at: number
	/** The workspace a dev sandbox's `source` key authenticates its launcher to; null for every other key. */
	workspace_id: string | null
}

/** A key to record; only a dev sandbox's key names a workspace. */
export type PlatformTransportKeyInsert = Omit<PlatformTransportKeyRow, 'workspace_id'> & { workspace_id?: string | null }

export class PlatformTransportKeyRepository {
	constructor(private readonly d1: SqlDatabase) {}

	async insert(row: PlatformTransportKeyInsert): Promise<void> {
		await this.d1
			.prepare(
				`INSERT INTO platform_transport_keys (app_id, env, receiver, key_id, key_hash, value_ref, expires_at, created_at, workspace_id)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(row.app_id, row.env, row.receiver, row.key_id, row.key_hash, row.value_ref, row.expires_at, row.created_at, row.workspace_id ?? null)
			.run()
	}

	/** The key whose hash is `keyHash`, when it has not expired at `now`. */
	async findValidByHash(keyHash: string, now: number): Promise<PlatformTransportKeyRow | null> {
		return await this.d1
			.prepare('SELECT * FROM platform_transport_keys WHERE key_hash = ? AND expires_at > ?')
			.bind(keyHash, now)
			.first<PlatformTransportKeyRow>()
	}

	/** Every key of the environment, of every receiver, the newest first. */
	async listForAppEnv(appId: string, env: string): Promise<PlatformTransportKeyRow[]> {
		const { results } = await this.d1
			.prepare('SELECT * FROM platform_transport_keys WHERE app_id = ? AND env = ? ORDER BY created_at DESC, key_id DESC')
			.bind(appId, env)
			.all<PlatformTransportKeyRow>()
		return results
	}

	/** Deletes every key of one receiver of the environment; returns how many. */
	async deleteForAppEnv(appId: string, env: string, receiver: string): Promise<number> {
		const result = await this.d1
			.prepare('DELETE FROM platform_transport_keys WHERE app_id = ? AND env = ? AND receiver = ?')
			.bind(appId, env, receiver)
			.run()
		return result.meta.changes
	}

	/** Deletes every key of one receiver that authenticates one workspace of the environment; returns how many. */
	async deleteForWorkspace(appId: string, env: string, receiver: string, workspaceId: string): Promise<number> {
		const result = await this.d1
			.prepare('DELETE FROM platform_transport_keys WHERE app_id = ? AND env = ? AND receiver = ? AND workspace_id = ?')
			.bind(appId, env, receiver, workspaceId)
			.run()
		return result.meta.changes
	}

	/** Deletes every key expired at `now`; returns how many. */
	async deleteExpired(now: number): Promise<number> {
		const result = await this.d1.prepare('DELETE FROM platform_transport_keys WHERE expires_at <= ?').bind(now).run()
		return result.meta.changes
	}
}
