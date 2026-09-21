import type { SqlDatabase } from '@fabrika/platform'
import { uuidv7 } from '../uuid.js'
import type { IssueRow } from './issue-row.js'
import { issueRow } from './issue-row.js'
import { number } from './values.js'

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

export abstract class ErrorIngestRepository {
	constructor(protected readonly db: SqlDatabase, protected readonly now: () => number = Date.now) {}

	protected abstract issueUpsertSql(): string
	protected abstract groupIssueUpsertSql(eventPlaceholders: string): string
	protected abstract seriesBucketSql(): string

	async record(input: RecordOccurrenceInput): Promise<RecordOccurrenceResult> {
		const occurrenceId = uuidv7(input.receivedAt)
		const issueId = uuidv7(input.receivedAt)
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
					issueId,
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
		const issueId = uuidv7(first.receivedAt)
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
					issueId,
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
			(id, source_id, fingerprint, title, culprit, level, status, first_seen, last_seen)
			SELECT ?, ?, ?, ?, ?, ?, 'open', ?, ?
			WHERE EXISTS (
				SELECT 1 FROM occurrences WHERE source_id = ? AND event_id = ? AND applied_at IS NULL
			)
			ON CONFLICT (source_id, fingerprint) DO UPDATE SET
				last_seen = MAX(issues.last_seen, excluded.last_seen)
			RETURNING *`
	}

	protected groupIssueUpsertSql(eventPlaceholders: string): string {
		return `INSERT INTO issues
			(id, source_id, fingerprint, title, culprit, level, status, first_seen, last_seen)
			SELECT ?, ?, ?, ?, ?, ?, 'open', MIN(received_at), MAX(received_at)
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
			(id, source_id, fingerprint, title, culprit, level, status, first_seen, last_seen)
			SELECT ?, ?, ?, ?, ?, ?, 'open', ?, ?
			WHERE EXISTS (
				SELECT 1 FROM occurrences WHERE source_id = ? AND event_id = ? AND applied_at IS NULL
			)
			ON CONFLICT (source_id, fingerprint) DO UPDATE SET
				last_seen = GREATEST(issues.last_seen, excluded.last_seen)
			RETURNING *`
	}

	protected groupIssueUpsertSql(eventPlaceholders: string): string {
		return `INSERT INTO issues
			(id, source_id, fingerprint, title, culprit, level, status, first_seen, last_seen)
			SELECT ?, ?, ?, ?, ?, ?, 'open', MIN(received_at), MAX(received_at)
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
