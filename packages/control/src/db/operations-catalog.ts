import { DEFAULT_OPERATIONS_SERVICE_KEY } from '@fabrika/operations-contract/catalog'
import { type SqlDatabase, uuidv7 } from '@fabrika/platform'
import { CATALOG_LEASE_KEY, type LeaseFence } from '../lease'
import { firstRow } from './returning'

export interface OperationsCatalogProjectionRow {
	app_id: string
	env: string
	domain: string | null
	public_origin: string | null
	service_key: string
	credential_id: string
	public_key: string
}

export interface OperationsIngestConfigRow {
	app_id: string
	env: string
	service_key: string
	credential_id: string
	public_key: string
	ingest_project_id: string | null
	dsn: string | null
	activated_revision: number | string | null
	created_at: number | string
	updated_at: number | string
}

export interface AppliedOperationsIngestConfig {
	appId: string
	environment: string
	serviceKey: string
	credentialId: string
	ingestProjectId: string
	dsn: string
}

interface OperationsCatalogSyncStateRow {
	desired_revision: number | string
	applied_revision: number | string
	attempted_revision: number | string | null
	last_snapshot_hash: string
	applied_snapshot_hash: string
	last_attempt_at: number | string | null
	last_success_at: number | string | null
	last_error: string | null
}

export interface OperationsCatalogSyncState {
	desiredRevision: number
	appliedRevision: number
	attemptedRevision: number | null
	lastSnapshotHash: string
	appliedSnapshotHash: string
	lastAttemptAt: number | null
	lastSuccessAt: number | null
	lastError: string | null
}

/**
 * Owns the apps⋈app_envs projection and its delivery cursor. The query deliberately excludes
 * provider envelopes: Operations receives only canonical registry coordinates and display metadata.
 */
export class OperationsCatalogRepository {
	constructor(protected readonly db: SqlDatabase, protected readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

	/** Record a registry mutation. Every mutation advances the desired revision, even while one is in flight. */
	async markDirty(): Promise<number> {
		const row = await firstRow<{ desired_revision: number | string }>(
			this.db
				.prepare(`UPDATE operations_catalog_sync
					SET desired_revision = desired_revision + 1
					WHERE singleton = 1
					RETURNING desired_revision`),
		)
		return catalogInteger(row.desired_revision, 'desired_revision')
	}

	/** Maintenance creates work only when no failed or coalesced revision is already pending. */
	async ensurePending(): Promise<number> {
		const row = await firstRow<{ desired_revision: number | string }>(
			this.db
				.prepare(`UPDATE operations_catalog_sync
					SET desired_revision = CASE
						WHEN desired_revision = applied_revision THEN desired_revision + 1
						ELSE desired_revision
					END
					WHERE singleton = 1
					RETURNING desired_revision`),
		)
		return catalogInteger(row.desired_revision, 'desired_revision')
	}

	/** Read one transactionally consistent revision + complete source snapshot. */
	async snapshot(): Promise<{ revision: number; sources: OperationsCatalogProjectionRow[] }> {
		const registered = await this.db.prepare('SELECT app_id, env FROM app_envs ORDER BY app_id, env').all<{ app_id: string; env: string }>()
		for (const row of registered.results) {
			await this.db
				.prepare(`INSERT INTO operations_ingest_configs
					(app_id, env, service_key, credential_id, public_key, ingest_project_id, dsn, activated_revision, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
					ON CONFLICT (app_id, env, service_key) DO NOTHING`)
				.bind(
					row.app_id,
					row.env,
					DEFAULT_OPERATIONS_SERVICE_KEY,
					uuidv7(),
					generateIngestPublicKey(),
					this.now(),
					this.now(),
				)
				.run()
		}
		const results = await this.db.batch<OperationsCatalogSyncStateRow | OperationsCatalogProjectionRow>([
			this.db.prepare(`SELECT
					desired_revision, applied_revision, attempted_revision,
					last_snapshot_hash, applied_snapshot_hash,
					last_attempt_at, last_success_at, last_error
				FROM operations_catalog_sync WHERE singleton = 1`),
			this.db.prepare(`SELECT e.app_id, e.env, e.domain, e.public_origin,
					c.service_key, c.credential_id, c.public_key
				FROM app_envs e
				JOIN apps a ON a.id = e.app_id
				JOIN operations_ingest_configs c ON c.app_id = e.app_id AND c.env = e.env
				ORDER BY e.app_id, e.env`),
		])
		const state = results[0]?.results[0]
		if (state === undefined || !('desired_revision' in state)) {
			throw new Error('operations catalog sync state is missing')
		}
		const sources: OperationsCatalogProjectionRow[] = []
		for (const row of results[1]?.results ?? []) {
			if (!('app_id' in row)) throw new Error('invalid operations catalog projection row')
			sources.push(row)
		}
		return {
			revision: catalogInteger(state.desired_revision, 'desired_revision'),
			sources,
		}
	}

	async getState(): Promise<OperationsCatalogSyncState> {
		const row = await this.db
			.prepare(`SELECT
					desired_revision, applied_revision, attempted_revision,
					last_snapshot_hash, applied_snapshot_hash,
					last_attempt_at, last_success_at, last_error
				FROM operations_catalog_sync WHERE singleton = 1`)
			.first<OperationsCatalogSyncStateRow>()
		if (row === null) throw new Error('operations catalog sync state is missing')
		return catalogState(row)
	}

	async markAttempt(revision: number, snapshotHash: string): Promise<void> {
		await this.db
			.prepare(`UPDATE operations_catalog_sync SET
					attempted_revision = ?,
					last_snapshot_hash = ?,
					last_attempt_at = ?
				WHERE singleton = 1`)
			.bind(revision, snapshotHash, this.now())
			.run()
	}

	/** Record one reconcile's ingest configurations; `false` when `fence` no longer holds the catalog lease. */
	async markApplied(
		revision: number,
		snapshotHash: string,
		configs: readonly AppliedOperationsIngestConfig[],
		fence: LeaseFence,
	): Promise<boolean> {
		const held = 'EXISTS (SELECT 1 FROM deploy_locks WHERE lock_key = ? AND holder = ? AND expires_at > ?)'
		const lease: [string, string, number] = [CATALOG_LEASE_KEY, fence.holder, fence.nowMs]
		// The lease row must stay locked through the writes: an EXISTS alone races takeover on Postgres.
		const results = await this.db.batch<{ singleton: number }>([
			this.db.prepare('UPDATE deploy_locks SET holder = holder WHERE lock_key = ? AND holder = ? AND expires_at > ?').bind(...lease),
			...configs.map((config) =>
				this.db
					.prepare(`UPDATE operations_ingest_configs SET
							ingest_project_id = ?,
							dsn = ?,
							activated_revision = ?,
							updated_at = ?
						WHERE app_id = ? AND env = ? AND service_key = ? AND credential_id = ? AND ${held}`)
					.bind(
						config.ingestProjectId,
						config.dsn,
						revision,
						this.now(),
						config.appId,
						config.environment,
						config.serviceKey,
						config.credentialId,
						...lease,
					)
			),
			this.db
				.prepare(`UPDATE operations_catalog_sync SET
					applied_revision = CASE WHEN applied_revision < ? THEN ? ELSE applied_revision END,
					applied_snapshot_hash = CASE WHEN applied_revision <= ? THEN ? ELSE applied_snapshot_hash END,
					last_success_at = ?,
					last_error = NULL
				WHERE singleton = 1 AND ${held}
				RETURNING singleton`)
				.bind(revision, revision, revision, snapshotHash, this.now(), ...lease),
		])
		return (results.at(-1)?.results.length ?? 0) > 0
	}

	getIngestConfig(appId: string, environment: string, serviceKey = DEFAULT_OPERATIONS_SERVICE_KEY): Promise<OperationsIngestConfigRow | null> {
		return this.db
			.prepare('SELECT * FROM operations_ingest_configs WHERE app_id = ? AND env = ? AND service_key = ?')
			.bind(appId, environment, serviceKey)
			.first<OperationsIngestConfigRow>()
	}

	getActiveIngestConfig(
		appId: string,
		environment: string,
		serviceKey = DEFAULT_OPERATIONS_SERVICE_KEY,
	): Promise<OperationsIngestConfigRow | null> {
		return this.db
			.prepare(`SELECT * FROM operations_ingest_configs
				WHERE app_id = ? AND env = ? AND service_key = ?
					AND dsn IS NOT NULL AND ingest_project_id IS NOT NULL AND activated_revision IS NOT NULL`)
			.bind(appId, environment, serviceKey)
			.first<OperationsIngestConfigRow>()
	}

	/** A restored Operations database may have a later cursor; advance locally and send a fresh full snapshot. */
	async advancePast(remoteRevision: number): Promise<void> {
		await this.db
			.prepare(`UPDATE operations_catalog_sync SET
				desired_revision = CASE WHEN desired_revision <= ? THEN ? ELSE desired_revision END
				WHERE singleton = 1`)
			.bind(remoteRevision, remoteRevision + 1)
			.run()
	}

	async markFailed(message: string): Promise<void> {
		await this.db
			.prepare('UPDATE operations_catalog_sync SET last_error = ? WHERE singleton = 1')
			.bind(message.slice(0, 200))
			.run()
	}
}

function catalogState(row: OperationsCatalogSyncStateRow): OperationsCatalogSyncState {
	return {
		desiredRevision: catalogInteger(row.desired_revision, 'desired_revision'),
		appliedRevision: catalogInteger(row.applied_revision, 'applied_revision'),
		attemptedRevision: row.attempted_revision === null ? null : catalogInteger(row.attempted_revision, 'attempted_revision'),
		lastSnapshotHash: row.last_snapshot_hash,
		appliedSnapshotHash: row.applied_snapshot_hash,
		lastAttemptAt: row.last_attempt_at === null ? null : catalogInteger(row.last_attempt_at, 'last_attempt_at'),
		lastSuccessAt: row.last_success_at === null ? null : catalogInteger(row.last_success_at, 'last_success_at'),
		lastError: row.last_error,
	}
}

function catalogInteger(value: number | string, field: string): number {
	const parsed = typeof value === 'number' ? value : Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid operations catalog ${field}`)
	return parsed
}

function generateIngestPublicKey(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16))
	let value = ''
	for (const byte of bytes) value += byte.toString(16).padStart(2, '0')
	return value
}
