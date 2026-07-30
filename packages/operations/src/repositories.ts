import {
	type ActivityItem,
	type CanonicalOperationsCatalogSourceV1,
	DEFAULT_OPERATIONS_SERVICE_KEY,
	type IssueMutation,
	type IssueStatus,
	OPERATIONS_CATALOG_PROTOCOL_VERSION,
	type OperationsCatalogReconcileResponseV1,
	type PriorIssueState,
} from '@fabrika/operations-contract'
import type { SqlDatabase } from '@fabrika/platform'
import { applyIssueMutation } from './issues.js'
import { uuidv7 } from './uuid.js'

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
	created_at: number | string
	updated_at: number | string
}

export interface CatalogCursorRow {
	revision: number
	snapshot_hash: string
	applied_at: number | string
}

export interface IssueRow {
	source_id: string
	fingerprint: string
	title: string
	culprit: string | null
	level: string
	status: IssueStatus
	assigned_to: string | null
	assigned_to_label: string | null
	first_seen: number | string
	last_seen: number | string
	regressed_at: number | string | null
	snooze_until: number | string | null
	snooze_until_count: number | string | null
	resolved_in_release: string | null
	merged_into: string | null
	revision: number
	last_mutation_id: string | null
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
		regressed_at: row.regressed_at === null ? null : number(row.regressed_at, 'issues.regressed_at'),
		snooze_until: row.snooze_until === null ? null : number(row.snooze_until, 'issues.snooze_until'),
		snooze_until_count: row.snooze_until_count === null ? null : number(row.snooze_until_count, 'issues.snooze_until_count'),
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

export class CatalogRepository {
	constructor(protected readonly db: SqlDatabase, protected readonly now: () => number = Date.now) {}

	getCursor(): Promise<CatalogCursorRow> {
		return this.db
			.prepare('SELECT revision, snapshot_hash, applied_at FROM operations_catalog_cursor WHERE singleton = 1')
			.first<CatalogCursorRow>()
			.then((row) => {
				if (!row) throw new Error('operations catalog cursor is missing')
				return {
					revision: number(row.revision, 'operations_catalog_cursor.revision'),
					snapshot_hash: row.snapshot_hash,
					applied_at: number(row.applied_at, 'operations_catalog_cursor.applied_at'),
				}
			})
	}

	async listControlSources(): Promise<SourceRow[]> {
		const { results } = await this.db
			.prepare(`SELECT * FROM sources WHERE origin = 'control'
				ORDER BY app_id, environment, service_key`)
			.all<SourceRow>()
		return results
	}

	async reconcile(input: {
		revision: number
		snapshotHash: string
		sources: CanonicalOperationsCatalogSourceV1[]
	}): Promise<OperationsCatalogReconcileResponseV1> {
		const cursor = await this.getCursor()
		if (input.revision < cursor.revision) return catalogResponse(cursor.revision, 'stale')
		if (input.revision === cursor.revision) {
			if (input.snapshotHash !== cursor.snapshot_hash) {
				throw new CatalogRevisionConflictError()
			}
			return catalogResponse(input.revision, 'unchanged', { unchanged: input.sources.length })
		}

		const before = await this.listControlSources()
		const beforeByCoordinate = new Map(before.map((source) => [sourceCoordinateKey(source.app_id, source.environment, source.service_key), source]))
		const statements = [
			this.db
				.prepare(`UPDATE sources SET
					enabled = 0,
					disabled_at = COALESCE(disabled_at, ?),
					updated_at = ?
				WHERE origin = 'control' AND enabled = 1
					AND (SELECT revision FROM operations_catalog_cursor WHERE singleton = 1) < ?
				RETURNING id`)
				.bind(this.now(), this.now(), input.revision),
			...input.sources.map((source) => {
				const id = uuidv7(this.now())
				return this.db
					.prepare(`INSERT INTO sources
					(id, app_id, environment, service_key, display_name, enabled, disabled_at, origin, public_origin, created_at, updated_at)
					SELECT ?, ?, ?, ?, ?, 1, NULL, 'control', ?, ?, ?
					WHERE (SELECT revision FROM operations_catalog_cursor WHERE singleton = 1) < ?
					ON CONFLICT (app_id, environment, service_key) DO UPDATE SET
						display_name = excluded.display_name,
						enabled = 1,
						disabled_at = NULL,
						public_origin = excluded.public_origin,
						updated_at = excluded.updated_at
					WHERE (SELECT revision FROM operations_catalog_cursor WHERE singleton = 1) < ?
					RETURNING id`)
					.bind(
						id,
						source.coordinate.appId,
						source.coordinate.environment,
						source.coordinate.serviceKey,
						source.displayName,
						source.publicOrigin,
						this.now(),
						this.now(),
						input.revision,
						input.revision,
					)
			}),
		]
		statements.push(
			this.db
				.prepare(`UPDATE operations_catalog_cursor SET revision = ?, snapshot_hash = ?, applied_at = ?
					WHERE singleton = 1 AND revision < ?
					RETURNING revision`)
				.bind(input.revision, input.snapshotHash, this.now(), input.revision),
		)
		const results = await this.db.batch<{ id?: string; revision?: number }>(statements)
		const cursorResult = results.at(-1)?.results[0]
		if (cursorResult?.revision !== input.revision) {
			const current = await this.getCursor()
			if (current.revision === input.revision && current.snapshot_hash !== input.snapshotHash) {
				throw new CatalogRevisionConflictError()
			}
			return catalogResponse(current.revision, current.revision === input.revision ? 'unchanged' : 'stale', {
				unchanged: current.revision === input.revision ? input.sources.length : 0,
			})
		}

		let created = 0
		let updated = 0
		let reenabled = 0
		let unchanged = 0
		for (const source of input.sources) {
			const key = sourceCoordinateKey(source.coordinate.appId, source.coordinate.environment, source.coordinate.serviceKey)
			const prior = beforeByCoordinate.get(key)
			if (!prior) {
				created++
			} else if (prior.enabled !== 1) {
				reenabled++
			} else if (prior.display_name !== source.displayName || prior.public_origin !== source.publicOrigin) {
				updated++
			} else {
				unchanged++
			}
		}
		const desiredSet = new Set(
			input.sources.map((source) => sourceCoordinateKey(source.coordinate.appId, source.coordinate.environment, source.coordinate.serviceKey)),
		)
		const disabled = before.filter((source) =>
			source.enabled === 1 && !desiredSet.has(
				sourceCoordinateKey(source.app_id, source.environment, source.service_key),
			)
		).length
		return catalogResponse(input.revision, 'applied', { created, updated, disabled, reenabled, unchanged })
	}
}

export class CatalogRevisionConflictError extends Error {
	constructor() {
		super('catalog revision was reused with different content')
	}
}

function sourceCoordinateKey(appId: string, environment: string, serviceKey: string): string {
	return JSON.stringify([appId, environment, serviceKey])
}

function catalogResponse(
	revision: number,
	outcome: OperationsCatalogReconcileResponseV1['outcome'],
	counts: Partial<Pick<OperationsCatalogReconcileResponseV1, 'created' | 'updated' | 'disabled' | 'reenabled' | 'unchanged'>> = {},
): OperationsCatalogReconcileResponseV1 {
	return {
		protocolVersion: OPERATIONS_CATALOG_PROTOCOL_VERSION,
		revision,
		outcome,
		created: counts.created ?? 0,
		updated: counts.updated ?? 0,
		disabled: counts.disabled ?? 0,
		reenabled: counts.reenabled ?? 0,
		unchanged: counts.unchanged ?? 0,
	}
}

export abstract class ErrorIngestRepository {
	constructor(protected readonly db: SqlDatabase, protected readonly now: () => number = Date.now) {}

	protected abstract issueUpsertSql(): string
	protected abstract groupIssueUpsertSql(eventPlaceholders: string): string
	protected abstract seriesBucketSql(): string

	async record(input: RecordOccurrenceInput): Promise<RecordOccurrenceResult> {
		const occurrenceId = uuidv7(input.receivedAt)
		const activityId = uuidv7(input.receivedAt)
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
				.prepare(`UPDATE occurrences AS occurrence SET transition_kind = (
					SELECT CASE
						WHEN issue.status = 'resolved'
							AND (issue.resolved_in_release IS NULL
								OR (occurrence.release IS NOT NULL AND occurrence.release <> issue.resolved_in_release))
							THEN 'regressed'
						WHEN issue.status = 'ignored'
							AND (
								(issue.snooze_until IS NOT NULL AND occurrence.received_at >= issue.snooze_until)
								OR (
									issue.snooze_until_count IS NOT NULL
									AND issue.snooze_until_count <= 1 + (
										SELECT COUNT(*) FROM occurrences counted
										WHERE counted.source_id = occurrence.source_id
											AND counted.fingerprint = occurrence.fingerprint
											AND counted.applied_at IS NOT NULL
									)
								)
							)
							THEN 'unsnoozed'
						ELSE NULL
					END
					FROM issues issue
					WHERE issue.source_id = occurrence.source_id AND issue.fingerprint = occurrence.fingerprint
				)
				WHERE source_id = ? AND event_id = ? AND applied_at IS NULL`)
				.bind(input.sourceId, input.eventId),
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
				.prepare(`UPDATE issues SET
					status = 'open',
					regressed_at = CASE
						WHEN (SELECT transition_kind FROM occurrences WHERE source_id = ? AND event_id = ?) = 'regressed'
							THEN ?
						ELSE regressed_at
					END,
					snooze_until = NULL,
					snooze_until_count = NULL,
					resolved_in_release = NULL,
					revision = revision + 1,
					last_mutation_id = ?
				WHERE source_id = ? AND fingerprint = ?
					AND status <> 'open'
					AND EXISTS (
						SELECT 1 FROM occurrences
						WHERE source_id = ? AND event_id = ? AND applied_at IS NULL AND transition_kind IS NOT NULL
					)
				RETURNING *`)
				.bind(
					input.sourceId,
					input.eventId,
					input.receivedAt,
					occurrenceId,
					input.sourceId,
					input.fingerprint,
					input.sourceId,
					input.eventId,
				),
			this.db
				.prepare(`INSERT INTO issue_activity
					(id, source_id, fingerprint, actor_id, actor_label, kind, data, at)
					SELECT ?, occurrence.source_id, occurrence.fingerprint, NULL, NULL, occurrence.transition_kind, ?, occurrence.received_at
					FROM occurrences occurrence
					JOIN issues issue
						ON issue.source_id = occurrence.source_id AND issue.fingerprint = occurrence.fingerprint
					WHERE occurrence.source_id = ? AND occurrence.event_id = ?
						AND occurrence.applied_at IS NULL AND occurrence.transition_kind IS NOT NULL
						AND issue.last_mutation_id = ?`)
				.bind(activityId, JSON.stringify({ release: input.release }), input.sourceId, input.eventId, occurrenceId),
			this.db
				.prepare(`UPDATE occurrences SET applied_at = ?
					WHERE source_id = ? AND event_id = ? AND applied_at IS NULL`)
				.bind(appliedAt, input.sourceId, input.eventId),
		])
		const appliedIssue = results[3]?.results[0] ?? results[2]?.results[0]
		if (appliedIssue) return { duplicate: false, issue: issueRow(appliedIssue) }
		const stored = await this.db
			.prepare('SELECT fingerprint FROM occurrences WHERE source_id = ? AND event_id = ?')
			.bind(input.sourceId, input.eventId)
			.first<{ fingerprint: string }>()
		const existing = stored ? await this.getIssue(input.sourceId, stored.fingerprint) : null
		if (!existing) throw new Error('duplicate occurrence references a missing issue')
		return { duplicate: true, issue: existing }
	}

	async recordGroup(inputs: RecordOccurrenceInput[]): Promise<RecordOccurrenceResult[]> {
		if (inputs.length === 0) return []
		if (inputs.length > 50) throw new RangeError('occurrence group exceeds 50 events')
		const first = inputs[0]
		if (!first) return []
		if (inputs.some((input) => input.sourceId !== first.sourceId || input.fingerprint !== first.fingerprint)) {
			throw new Error('occurrence group must share one source and fingerprint')
		}
		const eventPlaceholders = inputs.map(() => '?').join(', ')
		const eventIds = inputs.map((input) => input.eventId)
		const statements = inputs.map((input) =>
			this.db
				.prepare(`INSERT INTO occurrences
					(id, source_id, fingerprint, event_id, received_at, release, blob_key, transition_kind, applied_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
					ON CONFLICT (source_id, event_id) DO NOTHING
					RETURNING event_id`)
				.bind(
					uuidv7(input.receivedAt),
					input.sourceId,
					input.fingerprint,
					input.eventId,
					input.receivedAt,
					input.release,
					input.blobKey,
				)
		)
		statements.push(
			this.db
				.prepare(this.groupIssueUpsertSql(eventPlaceholders))
				.bind(
					first.sourceId,
					first.fingerprint,
					first.title,
					first.culprit,
					first.level,
					first.sourceId,
					first.fingerprint,
					...eventIds,
				),
			this.db
				.prepare(`UPDATE occurrences SET applied_at = ?
					WHERE source_id = ? AND fingerprint = ? AND event_id IN (${eventPlaceholders}) AND applied_at IS NULL
						AND EXISTS (
							SELECT 1 FROM issues WHERE source_id = ? AND fingerprint = ? AND status = 'open'
						)`)
				.bind(this.now(), first.sourceId, first.fingerprint, ...eventIds, first.sourceId, first.fingerprint),
		)
		const results = await this.db.batch<{ event_id?: string; fingerprint?: string }>(statements)
		const issueApplied = results[inputs.length]?.results[0]?.fingerprint === first.fingerprint
		if (!issueApplied) {
			const fallback: RecordOccurrenceResult[] = []
			for (const input of inputs) fallback.push(await this.record(input))
			return fallback
		}
		const issue = await this.getIssue(first.sourceId, first.fingerprint)
		if (!issue) throw new Error('grouped occurrences reference a missing issue')
		return inputs.map((input, index) => ({
			duplicate: results[index]?.results[0]?.event_id !== input.eventId,
			issue,
		}))
	}

	getIssue(sourceId: string, fingerprint: string): Promise<IssueRow | null> {
		return this.db
			.prepare('SELECT * FROM issues WHERE source_id = ? AND fingerprint = ?')
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
			RETURNING *`
	}

	protected groupIssueUpsertSql(eventPlaceholders: string): string {
		return `INSERT INTO issues
			(source_id, fingerprint, title, culprit, level, status, first_seen, last_seen)
			SELECT ?, ?, ?, ?, ?, 'open', MIN(received_at), MAX(received_at)
			FROM occurrences
			WHERE source_id = ? AND fingerprint = ? AND event_id IN (${eventPlaceholders}) AND applied_at IS NULL
			HAVING COUNT(*) > 0
			ON CONFLICT (source_id, fingerprint) DO UPDATE SET
				last_seen = MAX(issues.last_seen, excluded.last_seen)
			WHERE issues.status = 'open'
			RETURNING fingerprint`
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
			RETURNING *`
	}

	protected groupIssueUpsertSql(eventPlaceholders: string): string {
		return `INSERT INTO issues
			(source_id, fingerprint, title, culprit, level, status, first_seen, last_seen)
			SELECT ?, ?, ?, ?, ?, 'open', MIN(received_at), MAX(received_at)
			FROM occurrences
			WHERE source_id = ? AND fingerprint = ? AND event_id IN (${eventPlaceholders}) AND applied_at IS NULL
			HAVING COUNT(*) > 0
			ON CONFLICT (source_id, fingerprint) DO UPDATE SET
				last_seen = GREATEST(issues.last_seen, excluded.last_seen)
			WHERE issues.status = 'open'
			RETURNING fingerprint`
	}

	protected seriesBucketSql(): string {
		return 'FLOOR((received_at - ?) / ?)'
	}
}

export class IssuesRepository {
	constructor(protected readonly db: SqlDatabase, protected readonly now: () => number = Date.now) {}

	async mutate(input: {
		sourceId: string
		fingerprint: string
		mutation: IssueMutation
		actorId: string | null
		actorLabel: string | null
	}): Promise<IssueRow | null> {
		if (input.mutation.kind === 'merge') {
			if (input.mutation.target === input.fingerprint) throw new RangeError('An issue cannot be merged into itself.')
		}
		for (let attempt = 0; attempt < 8; attempt++) {
			if (input.mutation.kind === 'merge') {
				const target = await this.get(input.sourceId, input.mutation.target)
				if (!target) throw new RangeError('Merge target does not exist in this source.')
				if (target.merged_into !== null) throw new RangeError('Merge target must be a canonical issue.')
			}
			const prior = await this.get(input.sourceId, input.fingerprint)
			if (!prior) return null
			let mutation = input.mutation
			if (mutation.kind === 'snooze_count') {
				const row = await this.db
					.prepare(`SELECT COUNT(*) AS count FROM occurrences
						WHERE source_id = ? AND fingerprint = ? AND applied_at IS NOT NULL`)
					.bind(input.sourceId, input.fingerprint)
					.first<{ count: number | string }>()
				mutation = { kind: 'snooze_count', additional: mutation.additional, currentCount: number(row?.count ?? 0, 'occurrences.count') }
			}
			const decision = applyIssueMutation(issuePrior(prior), mutation)
			const mutationId = uuidv7(this.now())
			const assignedTo = decision.assignedTo !== undefined ? decision.assignedTo : prior.assigned_to
			const assignedToLabel = decision.assignedToLabel !== undefined ? decision.assignedToLabel : prior.assigned_to_label
			const snoozeUntil = decision.snoozeUntil !== undefined ? decision.snoozeUntil : prior.snooze_until
			const snoozeUntilCount = decision.snoozeUntilCount !== undefined ? decision.snoozeUntilCount : prior.snooze_until_count
			const resolvedInRelease = decision.resolvedInRelease !== undefined ? decision.resolvedInRelease : prior.resolved_in_release
			const mergedInto = decision.mergedInto !== undefined ? decision.mergedInto : prior.merged_into
			const mergeTarget = mutation.kind === 'merge' ? mutation.target : null
			const mergeGuard = mergeTarget === null
				? ''
				: `AND EXISTS (
					SELECT 1 FROM issues target
					WHERE target.source_id = ? AND target.fingerprint = ? AND target.merged_into IS NULL
				)`
			const updateValues: unknown[] = [
				decision.status,
				assignedTo,
				assignedToLabel,
				snoozeUntil,
				snoozeUntilCount,
				resolvedInRelease,
				mergedInto,
				mutationId,
				input.sourceId,
				input.fingerprint,
				prior.revision,
			]
			if (mergeTarget !== null) updateValues.push(input.sourceId, mergeTarget)
			const statements = [
				this.db
					.prepare(`UPDATE issues SET
						status = ?, assigned_to = ?, assigned_to_label = ?,
						snooze_until = ?, snooze_until_count = ?, resolved_in_release = ?, merged_into = ?,
						revision = revision + 1, last_mutation_id = ?
					WHERE source_id = ? AND fingerprint = ? AND revision = ?
						${mergeGuard}
					RETURNING *`)
					.bind(...updateValues),
			]
			if (decision.activity) {
				statements.push(
					this.db
						.prepare(`INSERT INTO issue_activity
							(id, source_id, fingerprint, actor_id, actor_label, kind, data, at)
							SELECT ?, source_id, fingerprint, ?, ?, ?, ?, ?
							FROM issues WHERE source_id = ? AND fingerprint = ? AND last_mutation_id = ?`)
						.bind(
							mutationId,
							input.actorId,
							input.actorLabel,
							decision.activity.kind,
							JSON.stringify(decision.activity.data),
							this.now(),
							input.sourceId,
							input.fingerprint,
							mutationId,
						),
				)
			}
			const results = await this.db.batch<IssueRow>(statements)
			const updated = results[0]?.results[0]
			if (updated) return issueRow(updated)
		}
		throw new Error('issue changed too frequently to apply mutation')
	}

	async canonicalFingerprint(sourceId: string, fingerprint: string): Promise<string> {
		const issue = await this.get(sourceId, fingerprint)
		return issue?.merged_into ?? fingerprint
	}

	get(sourceId: string, fingerprint: string): Promise<IssueRow | null> {
		return this.db.prepare('SELECT * FROM issues WHERE source_id = ? AND fingerprint = ?')
			.bind(sourceId, fingerprint)
			.first<IssueRow>()
			.then((row) => (row ? issueRow(row) : null))
	}

	async activity(sourceId: string, fingerprint: string): Promise<ActivityItem[]> {
		const { results } = await this.db
			.prepare(`SELECT id, kind, actor_label, data, at FROM issue_activity
				WHERE source_id = ? AND fingerprint = ? ORDER BY at, id`)
			.bind(sourceId, fingerprint)
			.all<{ id: string; kind: ActivityItem['kind']; actor_label: string | null; data: string | null; at: number | string }>()
		return results.map((row) => ({
			id: row.id,
			kind: row.kind,
			actorLabel: row.actor_label,
			data: row.data === null ? null : parseObject(row.data),
			at: number(row.at, 'issue_activity.at'),
		}))
	}
}

function issuePrior(issue: IssueRow): PriorIssueState {
	return {
		status: issue.status,
		resolvedInRelease: issue.resolved_in_release,
		snoozeUntil: issue.snooze_until === null ? null : number(issue.snooze_until, 'issues.snooze_until'),
		snoozeUntilCount: issue.snooze_until_count === null ? null : number(issue.snooze_until_count, 'issues.snooze_until_count'),
	}
}

function parseObject(value: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(value)
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('activity data is not an object')
	return Object.fromEntries(Object.entries(parsed))
}

export interface NotificationChannelRow {
	id: string
	source_id: string
	scope: string
	type: string
	target: string
	enabled: number
}

export interface AlertConfigRow {
	source_id: string
	threshold: number
	enabled: number
}

export interface AlertRuleRow {
	source_id: string
	type: string
	enabled: number
}

export interface ClaimedNotification {
	id: string
	dedupKey: string
	type: string
	target: string
	payload: Record<string, unknown>
	attempts: number
	maxAttempts: number
	claimToken: string
}

export abstract class AlertsRepository {
	constructor(protected readonly db: SqlDatabase, protected readonly now: () => number = Date.now) {}

	protected abstract claimSql(): string

	async setConfig(sourceId: string, input: { threshold: number; enabled: boolean }): Promise<void> {
		if (!Number.isInteger(input.threshold) || input.threshold <= 0) throw new RangeError('Alert threshold must be a positive integer.')
		await this.db
			.prepare(`INSERT INTO alert_config (source_id, threshold, enabled) VALUES (?, ?, ?)
				ON CONFLICT (source_id) DO UPDATE SET threshold = excluded.threshold, enabled = excluded.enabled`)
			.bind(sourceId, input.threshold, input.enabled ? 1 : 0)
			.run()
	}

	getConfig(sourceId: string): Promise<AlertConfigRow | null> {
		return this.db.prepare('SELECT * FROM alert_config WHERE source_id = ?').bind(sourceId).first<AlertConfigRow>()
	}

	async deleteConfig(sourceId: string): Promise<boolean> {
		const result = await this.db.prepare('DELETE FROM alert_config WHERE source_id = ?').bind(sourceId).run()
		return result.meta.changes === 1
	}

	async setRule(sourceId: string, type: string, enabled: boolean): Promise<void> {
		await this.db
			.prepare(`INSERT INTO alert_rules (source_id, type, enabled) VALUES (?, ?, ?)
				ON CONFLICT (source_id, type) DO UPDATE SET enabled = excluded.enabled`)
			.bind(sourceId, type, enabled ? 1 : 0)
			.run()
	}

	async listRules(sourceId: string): Promise<AlertRuleRow[]> {
		const { results } = await this.db.prepare('SELECT * FROM alert_rules WHERE source_id = ? ORDER BY type')
			.bind(sourceId)
			.all<AlertRuleRow>()
		return results
	}

	async deleteRule(sourceId: string, type: string): Promise<boolean> {
		const result = await this.db.prepare('DELETE FROM alert_rules WHERE source_id = ? AND type = ?').bind(sourceId, type).run()
		return result.meta.changes === 1
	}

	async upsertChannel(input: {
		id: string
		sourceId: string
		scope: string
		type: string
		target: string
		enabled: boolean
	}): Promise<void> {
		await this.db
			.prepare(`INSERT INTO notification_channels (id, source_id, scope, type, target, enabled)
				VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT (id) DO UPDATE SET
					scope = excluded.scope, type = excluded.type, target = excluded.target, enabled = excluded.enabled
				WHERE notification_channels.source_id = excluded.source_id`)
			.bind(input.id, input.sourceId, input.scope, input.type, input.target, input.enabled ? 1 : 0)
			.run()
	}

	async listChannels(sourceId: string): Promise<NotificationChannelRow[]> {
		const { results } = await this.db.prepare('SELECT * FROM notification_channels WHERE source_id = ? ORDER BY id')
			.bind(sourceId)
			.all<NotificationChannelRow>()
		return results
	}

	async deleteChannel(sourceId: string, id: string): Promise<boolean> {
		const result = await this.db.prepare('DELETE FROM notification_channels WHERE source_id = ? AND id = ?')
			.bind(sourceId, id)
			.run()
		return result.meta.changes === 1
	}

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
				(id, dedup_key, source_id, channel_id, kind, payload, created_at, attempts, max_attempts, visible_at,
					claimed_until, claim_token, delivered_at, abandoned_at)
				SELECT ?, ?, ?, ?, ?, ?, ?, 0, 6, ?, NULL, NULL, NULL, NULL
				FROM notification_channels
				WHERE id = ? AND source_id = ? AND enabled = 1
				ON CONFLICT (dedup_key) DO NOTHING`)
			.bind(
				uuidv7(this.now()),
				input.dedupKey,
				input.sourceId,
				input.channelId,
				input.kind,
				JSON.stringify(input.payload),
				this.now(),
				this.now(),
				input.channelId,
				input.sourceId,
			)
			.run()
		return result.meta.changes === 1
	}

	async claimNotifications(input: { limit: number; leaseMs: number }): Promise<ClaimedNotification[]> {
		const now = this.now()
		const claimToken = uuidv7(now)
		const claimed = await this.db.batch<{
			id: string
			dedup_key: string
			channel_id: string
			payload: string
			attempts: number
			max_attempts: number
			claim_token: string
		}>([
			this.db
				.prepare(`UPDATE notification_outbox SET abandoned_at = ?, claimed_until = NULL, claim_token = NULL
						WHERE delivered_at IS NULL AND abandoned_at IS NULL
							AND attempts >= max_attempts AND claimed_until IS NOT NULL AND claimed_until <= ?`)
				.bind(now, now),
			this.db.prepare(this.claimSql())
				.bind(now + input.leaseMs, claimToken, now, now, input.limit),
		])
		const results = claimed[1]?.results ?? []
		const notifications: ClaimedNotification[] = []
		for (const row of results) {
			const channel = await this.db.prepare('SELECT type, target FROM notification_channels WHERE id = ?')
				.bind(row.channel_id)
				.first<{ type: string; target: string }>()
			if (!channel) throw new Error('notification channel disappeared')
			notifications.push({
				id: row.id,
				dedupKey: row.dedup_key,
				type: channel.type,
				target: channel.target,
				payload: parseObject(row.payload),
				attempts: row.attempts,
				maxAttempts: row.max_attempts,
				claimToken: row.claim_token,
			})
		}
		return notifications
	}

	async completeNotification(input: {
		id: string
		claimToken: string
		delivered: boolean
		retryDelayMs?: number
		errorCode?: string
	}): Promise<boolean> {
		const now = this.now()
		const attemptId = uuidv7(now)
		const terminal = input.delivered
			? 'delivered_at = ?, claimed_until = NULL, claim_token = NULL'
			: `abandoned_at = CASE WHEN attempts >= max_attempts THEN ? ELSE abandoned_at END,
				visible_at = CASE WHEN attempts < max_attempts THEN ? ELSE visible_at END,
				claimed_until = NULL, claim_token = NULL`
		const terminalValues = input.delivered
			? [now]
			: [now, now + Math.max(0, input.retryDelayMs ?? 0)]
		const results = await this.db.batch([
			this.db
				.prepare(`INSERT INTO notification_attempts
					(id, notification_id, attempted_at, delivered, error_code)
					SELECT ?, id, ?, ?, ? FROM notification_outbox WHERE id = ? AND claim_token = ?`)
				.bind(attemptId, now, input.delivered ? 1 : 0, input.errorCode ?? null, input.id, input.claimToken),
			this.db
				.prepare(`UPDATE notification_outbox SET ${terminal} WHERE id = ? AND claim_token = ? RETURNING id`)
				.bind(...terminalValues, input.id, input.claimToken),
		])
		return results[1]?.results.length === 1
	}

	async pruneClaims(at: number = this.now()): Promise<number> {
		const result = await this.db.prepare('DELETE FROM alert_claims WHERE expires_at <= ?').bind(at).run()
		return result.meta.changes
	}
}

export class SqliteAlertsRepository extends AlertsRepository {
	protected claimSql(): string {
		return `UPDATE notification_outbox SET claimed_until = ?, claim_token = ?, attempts = attempts + 1
			WHERE id IN (
				SELECT id FROM notification_outbox
				WHERE delivered_at IS NULL AND abandoned_at IS NULL AND visible_at <= ?
					AND (claimed_until IS NULL OR claimed_until <= ?)
					AND attempts < max_attempts
					AND EXISTS (
						SELECT 1 FROM notification_channels
						WHERE notification_channels.id = notification_outbox.channel_id AND enabled = 1
					)
				ORDER BY visible_at, id LIMIT ?
			)
			RETURNING id, dedup_key, channel_id, payload, attempts, max_attempts, claim_token`
	}
}

export class PostgresAlertsRepository extends AlertsRepository {
	protected claimSql(): string {
		return `UPDATE notification_outbox SET claimed_until = ?, claim_token = ?, attempts = attempts + 1
			WHERE id IN (
				SELECT id FROM notification_outbox
				WHERE delivered_at IS NULL AND abandoned_at IS NULL AND visible_at <= ?
					AND (claimed_until IS NULL OR claimed_until <= ?)
					AND attempts < max_attempts
					AND EXISTS (
						SELECT 1 FROM notification_channels
						WHERE notification_channels.id = notification_outbox.channel_id AND enabled = 1
					)
				ORDER BY visible_at, id LIMIT ?
				FOR UPDATE SKIP LOCKED
			)
			RETURNING id, dedup_key, channel_id, payload, attempts, max_attempts, claim_token`
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
	catalog: CatalogRepository
	ingest: ErrorIngestRepository
	issues: IssuesRepository
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
		catalog: replacements.catalog ?? new CatalogRepository(db, now),
		ingest: replacements.ingest ?? new SqliteErrorIngestRepository(db, now),
		issues: replacements.issues ?? new IssuesRepository(db, now),
		alerts: replacements.alerts ?? new SqliteAlertsRepository(db, now),
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
		catalog: replacements.catalog ?? new CatalogRepository(db, now),
		ingest: replacements.ingest ?? new PostgresErrorIngestRepository(db, now),
		issues: replacements.issues ?? new IssuesRepository(db, now),
		alerts: replacements.alerts ?? new PostgresAlertsRepository(db, now),
		deadEvents: replacements.deadEvents ?? new DeadEventsRepository(db),
		artifacts: replacements.artifacts ?? new ArtifactsRepository(db, now),
	}
}
