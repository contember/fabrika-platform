import { DEFAULT_OPERATIONS_SERVICE_KEY } from '@fabrika/operations-contract'
import type { SqlDatabase } from '@fabrika/platform'

export interface SourceRow {
	id: string
	app_id: string
	environment: string
	service_key: string
	display_name: string
	enabled: number
	disabled_at: number | string | null
	origin: string
	public_origin: string | null
	ingest_project_id: string | null
	created_at: number | string
	updated_at: number | string
}

export interface IngestCredentialResolution {
	sourceId: string
	ingestProjectId: string
}

export class SourcesRepository {
	constructor(protected readonly db: SqlDatabase, protected readonly now: () => number = Date.now) {}

	async upsert(input: {
		id: string
		appId: string
		environment: string
		serviceKey?: string
		displayName: string
		enabled: boolean
		publicOrigin?: string | null
	}): Promise<SourceRow> {
		const now = this.now()
		const row = await this.db
			.prepare(`INSERT INTO sources
				(id, app_id, environment, service_key, display_name, enabled, disabled_at, origin, public_origin, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, 'control', ?, ?, ?)
				ON CONFLICT (app_id, environment, service_key) DO UPDATE SET
					display_name = excluded.display_name,
					enabled = excluded.enabled,
					disabled_at = CASE
						WHEN excluded.enabled = 1 THEN NULL
						ELSE COALESCE(sources.disabled_at, excluded.disabled_at)
					END,
					public_origin = excluded.public_origin,
					updated_at = excluded.updated_at
				RETURNING *`)
			.bind(
				input.id,
				input.appId,
				input.environment,
				input.serviceKey ?? DEFAULT_OPERATIONS_SERVICE_KEY,
				input.displayName,
				input.enabled ? 1 : 0,
				input.enabled ? null : now,
				input.publicOrigin ?? null,
				now,
				now,
			)
			.first<SourceRow>()
		if (!row) throw new Error('source upsert returned no row')
		return row
	}

	get(id: string): Promise<SourceRow | null> {
		return this.db.prepare('SELECT * FROM sources WHERE id = ?').bind(id).first<SourceRow>()
	}

	getByCoordinate(appId: string, environment: string, serviceKey: string): Promise<SourceRow | null> {
		return this.db
			.prepare('SELECT * FROM sources WHERE app_id = ? AND environment = ? AND service_key = ? AND enabled = 1')
			.bind(appId, environment, serviceKey)
			.first<SourceRow>()
	}

	async ensureIngestProjectId(sourceId: string, candidate: string): Promise<string | null> {
		const updated = await this.db
			.prepare(`UPDATE sources SET ingest_project_id = ?, updated_at = ?
				WHERE id = ? AND enabled = 1 AND ingest_project_id IS NULL
				RETURNING ingest_project_id`)
			.bind(candidate, this.now(), sourceId)
			.first<{ ingest_project_id: string }>()
		if (updated) return updated.ingest_project_id
		const source = await this.db
			.prepare('SELECT ingest_project_id FROM sources WHERE id = ? AND enabled = 1')
			.bind(sourceId)
			.first<{ ingest_project_id: string | null }>()
		return source?.ingest_project_id ?? null
	}

	async rotateCredential(input: {
		id: string
		sourceId: string
		verifier: string
		overlapUntil: number
	}): Promise<boolean> {
		const now = this.now()
		const results = await this.db.batch<{ id: string }>([
			this.db
				.prepare(`INSERT INTO ingest_credentials (id, source_id, verifier, created_at, expires_at, revoked_at)
					SELECT ?, id, ?, ?, NULL, NULL FROM sources
					WHERE id = ? AND enabled = 1 AND ingest_project_id IS NOT NULL
					ON CONFLICT DO NOTHING
					RETURNING id`)
				.bind(input.id, input.verifier, now, input.sourceId),
			this.db
				.prepare(`UPDATE ingest_credentials SET expires_at = CASE
						WHEN expires_at IS NULL OR expires_at > ? THEN ?
						ELSE expires_at
					END
					WHERE source_id = ? AND id <> ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
						AND EXISTS (
							SELECT 1 FROM ingest_credentials replacement
							WHERE replacement.id = ? AND replacement.source_id = ? AND replacement.verifier = ?
								AND replacement.revoked_at IS NULL
						)`)
				.bind(
					input.overlapUntil,
					input.overlapUntil,
					input.sourceId,
					input.id,
					input.overlapUntil,
					input.id,
					input.sourceId,
					input.verifier,
				),
		])
		if (results[0]?.results.length === 1) return true
		const existing = await this.db
			.prepare(`SELECT id FROM ingest_credentials
				WHERE id = ? AND source_id = ? AND verifier = ? AND revoked_at IS NULL`)
			.bind(input.id, input.sourceId, input.verifier)
			.first<{ id: string }>()
		return existing !== null
	}

	async resolveIngestCredential(verifier: string, at: number = this.now()): Promise<IngestCredentialResolution | null> {
		const row = await this.db
			.prepare(`SELECT c.source_id, s.ingest_project_id FROM ingest_credentials c
				JOIN sources s ON s.id = c.source_id
				WHERE c.verifier = ? AND c.revoked_at IS NULL
					AND (c.expires_at IS NULL OR c.expires_at > ?)
					AND s.enabled = 1 AND s.ingest_project_id IS NOT NULL`)
			.bind(verifier, at)
			.first<{ source_id: string; ingest_project_id: string }>()
		return row ? { sourceId: row.source_id, ingestProjectId: row.ingest_project_id } : null
	}

	async revokeSourceCredential(sourceId: string, id: string): Promise<boolean> {
		const result = await this.db
			.prepare('UPDATE ingest_credentials SET revoked_at = ? WHERE id = ? AND source_id = ? AND revoked_at IS NULL')
			.bind(this.now(), id, sourceId)
			.run()
		return result.meta.changes === 1
	}
}
