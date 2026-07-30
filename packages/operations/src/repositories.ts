import type { IssueStatus } from '@fabrika/operations-contract'
import type { SqlDatabase } from '@fabrika/platform'
import { uuidv7 } from './uuid.js'

export interface SourceRow {
	id: string
	app_id: string
	environment: string
	service_key: string
	display_name: string
	enabled: number
	created_at: number | string
	updated_at: number | string
}

export interface IssueRow {
	source_id: string
	fingerprint: string
	title: string
	culprit: string | null
	level: string
	status: IssueStatus
	first_seen: number | string
	last_seen: number | string
}

export interface CountResult {
	fingerprint: string
	count: number
	first: number
	last: number
}

export interface CountBucket {
	fingerprint: string
	bucket: number
	count: number
}

export interface RecordOccurrenceInput {
	sourceId: string
	fingerprint: string
	eventId: string
	title: string
	culprit: string | null
	level: string
	release: string | null
	receivedAt: number
	blobKey: string
}

export interface RecordOccurrenceResult {
	duplicate: boolean
	issue: IssueRow
}

function number(value: number | string, field: string): number {
	const parsed = typeof value === 'number' ? value : Number(value)
	if (!Number.isSafeInteger(parsed)) throw new Error(`invalid numeric ${field}`)
	return parsed
}

function issueRow(row: IssueRow): IssueRow {
	return {
		...row,
		first_seen: number(row.first_seen, 'issues.first_seen'),
		last_seen: number(row.last_seen, 'issues.last_seen'),
	}
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
	}): Promise<SourceRow> {
		const now = this.now()
		const row = await this.db
			.prepare(`INSERT INTO sources (id, app_id, environment, service_key, display_name, enabled, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (app_id, environment, service_key) DO UPDATE SET
					display_name = excluded.display_name,
					enabled = excluded.enabled,
					updated_at = excluded.updated_at
				RETURNING *`)
			.bind(input.id, input.appId, input.environment, input.serviceKey ?? '', input.displayName, input.enabled ? 1 : 0, now, now)
			.first<SourceRow>()
		if (!row) throw new Error('source upsert returned no row')
		return row
	}

	get(id: string): Promise<SourceRow | null> {
		return this.db.prepare('SELECT * FROM sources WHERE id = ?').bind(id).first<SourceRow>()
	}

	async addCredential(input: { sourceId: string; verifier: string; expiresAt?: number }): Promise<string> {
		const id = uuidv7(this.now())
		await this.db
			.prepare(`INSERT INTO ingest_credentials (id, source_id, verifier, created_at, expires_at, revoked_at)
				VALUES (?, ?, ?, ?, ?, NULL)`)
			.bind(id, input.sourceId, input.verifier, this.now(), input.expiresAt ?? null)
			.run()
		return id
	}

	async resolveCredential(verifier: string, at: number = this.now()): Promise<string | null> {
		const row = await this.db
			.prepare(`SELECT c.source_id FROM ingest_credentials c
				JOIN sources s ON s.id = c.source_id
				WHERE c.verifier = ? AND c.revoked_at IS NULL
					AND (c.expires_at IS NULL OR c.expires_at > ?)
					AND s.enabled = 1`)
			.bind(verifier, at)
			.first<{ source_id: string }>()
		return row?.source_id ?? null
	}

	async revokeCredential(id: string): Promise<boolean> {
		const result = await this.db
			.prepare('UPDATE ingest_credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
			.bind(this.now(), id)
			.run()
		return result.meta.changes === 1
	}
}

export abstract class ErrorIngestRepository {
	constructor(protected readonly db: SqlDatabase, protected readonly now: () => number = Date.now) {}

	protected abstract issueUpsertSql(): string
	protected abstract seriesBucketSql(): string

	async record(input: RecordOccurrenceInput): Promise<RecordOccurrenceResult> {
		const occurrenceId = uuidv7(input.receivedAt)
		const appliedAt = this.now()
		const results = await this.db.batch<IssueRow>([
			this.db
				.prepare(`INSERT INTO occurrences
					(id, source_id, fingerprint, event_id, received_at, release, blob_key, applied_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
					ON CONFLICT (source_id, event_id) DO NOTHING`)
				.bind(
					occurrenceId,
					input.sourceId,
					input.fingerprint,
					input.eventId,
					input.receivedAt,
					input.release,
					input.blobKey,
				),
			this.db
				.prepare(this.issueUpsertSql())
				.bind(
					input.sourceId,
					input.fingerprint,
					input.title,
					input.culprit,
					input.level,
					input.receivedAt,
					input.receivedAt,
					input.sourceId,
					input.eventId,
				),
			this.db
				.prepare(`UPDATE occurrences SET applied_at = ?
					WHERE source_id = ? AND event_id = ? AND applied_at IS NULL`)
				.bind(appliedAt, input.sourceId, input.eventId),
		])
		const appliedIssue = results[1]?.results[0]
		if (appliedIssue) return { duplicate: false, issue: issueRow(appliedIssue) }
		const stored = await this.db
			.prepare('SELECT fingerprint FROM occurrences WHERE source_id = ? AND event_id = ?')
			.bind(input.sourceId, input.eventId)
			.first<{ fingerprint: string }>()
		const existing = stored ? await this.getIssue(input.sourceId, stored.fingerprint) : null
		if (!existing) throw new Error('duplicate occurrence references a missing issue')
		return { duplicate: true, issue: existing }
	}

	getIssue(sourceId: string, fingerprint: string): Promise<IssueRow | null> {
		return this.db
			.prepare(`SELECT source_id, fingerprint, title, culprit, level, status, first_seen, last_seen
				FROM issues WHERE source_id = ? AND fingerprint = ?`)
			.bind(sourceId, fingerprint)
			.first<IssueRow>()
			.then((row) => (row ? issueRow(row) : null))
	}

	async counts(input: { sourceId: string; fingerprint?: string; since?: number; until?: number }): Promise<CountResult[]> {
		const where = ['source_id = ?', 'applied_at IS NOT NULL']
		const values: unknown[] = [input.sourceId]
		if (input.fingerprint) {
			where.push('fingerprint = ?')
			values.push(input.fingerprint)
		}
		if (input.since !== undefined) {
			where.push('received_at >= ?')
			values.push(input.since)
		}
		if (input.until !== undefined) {
			where.push('received_at <= ?')
			values.push(input.until)
		}
		const { results } = await this.db
			.prepare(`SELECT fingerprint, COUNT(*) AS count, MIN(received_at) AS first, MAX(received_at) AS last
				FROM occurrences WHERE ${where.join(' AND ')} GROUP BY fingerprint`)
			.bind(...values)
			.all<{ fingerprint: string; count: number | string; first: number | string; last: number | string }>()
		return results.map((row) => ({
			fingerprint: row.fingerprint,
			count: number(row.count, 'occurrences.count'),
			first: number(row.first, 'occurrences.first'),
			last: number(row.last, 'occurrences.last'),
		}))
	}

	async series(input: {
		sourceId: string
		fingerprint?: string
		since: number
		until: number
		buckets: number
	}): Promise<CountBucket[]> {
		const width = Math.max(1, Math.floor((input.until - input.since) / input.buckets))
		const where = ['source_id = ?', 'applied_at IS NOT NULL', 'received_at >= ?', 'received_at <= ?']
		const values: unknown[] = [input.sourceId, input.since, input.until]
		if (input.fingerprint) {
			where.push('fingerprint = ?')
			values.push(input.fingerprint)
		}
		const { results } = await this.db
			.prepare(`SELECT fingerprint, ${this.seriesBucketSql()} AS bucket, COUNT(*) AS count
				FROM occurrences WHERE ${where.join(' AND ')} GROUP BY fingerprint, bucket`)
			.bind(input.since, width, ...values)
			.all<{ fingerprint: string; bucket: number | string; count: number | string }>()
		return results.map((row) => ({
			fingerprint: row.fingerprint,
			bucket: Math.min(input.buckets - 1, number(row.bucket, 'occurrences.bucket')),
			count: number(row.count, 'occurrences.count'),
		}))
	}
}

export class SqliteErrorIngestRepository extends ErrorIngestRepository {
	protected issueUpsertSql(): string {
		return `INSERT INTO issues
			(source_id, fingerprint, title, culprit, level, status, first_seen, last_seen)
			SELECT ?, ?, ?, ?, ?, 'open', ?, ?
			WHERE EXISTS (
				SELECT 1 FROM occurrences WHERE source_id = ? AND event_id = ? AND applied_at IS NULL
			)
			ON CONFLICT (source_id, fingerprint) DO UPDATE SET
				last_seen = MAX(issues.last_seen, excluded.last_seen)
			RETURNING source_id, fingerprint, title, culprit, level, status, first_seen, last_seen`
	}

	protected seriesBucketSql(): string {
		return 'CAST((received_at - ?) / ? AS INTEGER)'
	}
}

export class PostgresErrorIngestRepository extends ErrorIngestRepository {
	protected issueUpsertSql(): string {
		return `INSERT INTO issues
			(source_id, fingerprint, title, culprit, level, status, first_seen, last_seen)
			SELECT ?, ?, ?, ?, ?, 'open', ?, ?
			WHERE EXISTS (
				SELECT 1 FROM occurrences WHERE source_id = ? AND event_id = ? AND applied_at IS NULL
			)
			ON CONFLICT (source_id, fingerprint) DO UPDATE SET
				last_seen = GREATEST(issues.last_seen, excluded.last_seen)
			RETURNING source_id, fingerprint, title, culprit, level, status, first_seen, last_seen`
	}

	protected seriesBucketSql(): string {
		return 'FLOOR((received_at - ?) / ?)'
	}
}

export class AlertsRepository {
	constructor(protected readonly db: SqlDatabase, protected readonly now: () => number = Date.now) {}

	async tryClaim(key: string, ttlMs: number): Promise<boolean> {
		const now = this.now()
		const row = await this.db
			.prepare(`INSERT INTO alert_claims (claim_key, claimed_at, expires_at)
				VALUES (?, ?, ?)
				ON CONFLICT (claim_key) DO UPDATE SET
					claimed_at = excluded.claimed_at,
					expires_at = excluded.expires_at
				WHERE alert_claims.expires_at <= ?
				RETURNING claim_key`)
			.bind(key, now, now + ttlMs, now)
			.first<{ claim_key: string }>()
		return row !== null
	}

	async enqueueNotification(input: {
		dedupKey: string
		sourceId: string
		channelId: string
		kind: string
		payload: Record<string, unknown>
	}): Promise<boolean> {
		const result = await this.db
			.prepare(`INSERT INTO notification_outbox
				(id, dedup_key, source_id, channel_id, kind, payload, created_at, delivered_at, abandoned_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
				ON CONFLICT (dedup_key) DO NOTHING`)
			.bind(uuidv7(this.now()), input.dedupKey, input.sourceId, input.channelId, input.kind, JSON.stringify(input.payload), this.now())
			.run()
		return result.meta.changes === 1
	}

	async pruneClaims(at: number = this.now()): Promise<number> {
		const result = await this.db.prepare('DELETE FROM alert_claims WHERE expires_at <= ?').bind(at).run()
		return result.meta.changes
	}
}

export class DeadEventsRepository {
	constructor(protected readonly db: SqlDatabase) {}

	async record(input: {
		id: string
		sourceId: string | null
		eventId: string
		fingerprint: string | null
		blobKey: string
		reason: string
		attempts: number
		deadAt: number
	}): Promise<void> {
		await this.db
			.prepare(`INSERT INTO dead_events
				(id, source_id, event_id, fingerprint, blob_key, reason, attempts, dead_at, replayed_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
				ON CONFLICT (source_id, event_id) DO UPDATE SET
					attempts = excluded.attempts,
					reason = excluded.reason,
					dead_at = excluded.dead_at`)
			.bind(
				input.id,
				input.sourceId,
				input.eventId,
				input.fingerprint,
				input.blobKey,
				input.reason,
				input.attempts,
				input.deadAt,
			)
			.run()
	}
}

export class ArtifactsRepository {
	constructor(protected readonly db: SqlDatabase, protected readonly now: () => number = Date.now) {}

	async upsertRelease(input: {
		id: string
		sourceId: string
		runId: string
		commitSha: string
		state: string
		finishedAt?: number
	}): Promise<void> {
		await this.db
			.prepare(`INSERT INTO releases (id, source_id, run_id, commit_sha, state, created_at, finished_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (source_id, run_id) DO UPDATE SET
					commit_sha = excluded.commit_sha,
					state = excluded.state,
					finished_at = excluded.finished_at`)
			.bind(
				input.id,
				input.sourceId,
				input.runId,
				input.commitSha,
				input.state,
				this.now(),
				input.finishedAt ?? null,
			)
			.run()
	}

	async releaseBelongsToSource(sourceId: string, releaseId: string): Promise<boolean> {
		const row = await this.db
			.prepare('SELECT id FROM releases WHERE id = ? AND source_id = ?')
			.bind(releaseId, sourceId)
			.first<{ id: string }>()
		return row !== null
	}

	async indexSourceMap(input: { releaseId: string; fileName: string; blobKey: string }): Promise<void> {
		await this.db
			.prepare(`INSERT INTO source_maps (release_id, file_name, blob_key, uploaded_at)
				VALUES (?, ?, ?, ?)
				ON CONFLICT (release_id, file_name) DO UPDATE SET
					blob_key = excluded.blob_key,
					uploaded_at = excluded.uploaded_at`)
			.bind(input.releaseId, input.fileName, input.blobKey, this.now())
			.run()
	}

	async sourceMapKey(releaseId: string, fileName: string): Promise<string | null> {
		const row = await this.db
			.prepare('SELECT blob_key FROM source_maps WHERE release_id = ? AND file_name = ?')
			.bind(releaseId, fileName)
			.first<{ blob_key: string }>()
		return row?.blob_key ?? null
	}
}

export interface OperationsRepositories {
	sources: SourcesRepository
	ingest: ErrorIngestRepository
	alerts: AlertsRepository
	deadEvents: DeadEventsRepository
	artifacts: ArtifactsRepository
}

export function createSqliteOperationsRepositories(
	db: SqlDatabase,
	options: { now?: () => number; replacements?: Partial<OperationsRepositories> } = {},
): OperationsRepositories {
	const now = options.now ?? Date.now
	const replacements = options.replacements ?? {}
	return {
		sources: replacements.sources ?? new SourcesRepository(db, now),
		ingest: replacements.ingest ?? new SqliteErrorIngestRepository(db, now),
		alerts: replacements.alerts ?? new AlertsRepository(db, now),
		deadEvents: replacements.deadEvents ?? new DeadEventsRepository(db),
		artifacts: replacements.artifacts ?? new ArtifactsRepository(db, now),
	}
}

export function createPostgresOperationsRepositories(
	db: SqlDatabase,
	options: { now?: () => number; replacements?: Partial<OperationsRepositories> } = {},
): OperationsRepositories {
	const now = options.now ?? Date.now
	const replacements = options.replacements ?? {}
	return {
		sources: replacements.sources ?? new SourcesRepository(db, now),
		ingest: replacements.ingest ?? new PostgresErrorIngestRepository(db, now),
		alerts: replacements.alerts ?? new AlertsRepository(db, now),
		deadEvents: replacements.deadEvents ?? new DeadEventsRepository(db),
		artifacts: replacements.artifacts ?? new ArtifactsRepository(db, now),
	}
}
