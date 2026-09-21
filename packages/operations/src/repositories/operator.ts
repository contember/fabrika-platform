import type { IssueStatus } from '@fabrika/operations-contract'
import type { SqlDatabase } from '@fabrika/platform'
import { uuidv7 } from '../uuid.js'
import type { ReleaseRow } from './artifacts.js'
import type { IssueRow } from './issue-row.js'
import { issueRow } from './issue-row.js'
import { number } from './values.js'

export interface OperatorIssueRow extends IssueRow {
	source_app_id: string
	source_environment: string
	source_service_key: string
	source_display_name: string
	source_public_origin: string | null
	source_enabled: number
	occurrence_count: number | string
}

export interface IdentifiedOperatorIssueRow extends OperatorIssueRow {
	id: string
}

export interface OperatorOccurrenceRow {
	id: string
	source_id: string
	fingerprint: string
	event_id: string
	received_at: number | string
	release: string | null
	blob_key: string
}

export interface OperatorIssueTrendRow {
	issue_id: string
	bucket: number
	count: number
}

export interface OperatorNotificationAttemptRow {
	id: string
	attempted_at: number
	delivered: number
	error_code: string | null
}

export interface OperatorNotificationDeliveryRow {
	id: string
	channel_id: string
	kind: string
	created_at: number
	attempts: number
	max_attempts: number
	delivered_at: number | null
	abandoned_at: number | null
	attempt_history: OperatorNotificationAttemptRow[]
}

export type OperatorIssueSort = 'recent' | 'new' | 'frequency'

export interface OperatorIssueCursor {
	value: number
	id: string
}

export interface OperatorOccurrenceCursor {
	receivedAt: number
	id: string
}

export interface OperatorReleaseRow extends ReleaseRow {
	source_app_id: string
	source_environment: string
	source_service_key: string
	source_display_name: string
	source_public_origin: string | null
	source_enabled: number
	new_issue_count: number | string
	regression_count: number | string
}

export class OperatorRepository {
	constructor(protected readonly db: SqlDatabase, protected readonly now: () => number = Date.now) {}

	async ensureIssueIds(sourceIds: readonly string[]): Promise<void> {
		if (sourceIds.length === 0) return
		const placeholders = sourceIds.map(() => '?').join(', ')
		const { results } = await this.db
			.prepare(`SELECT source_id, fingerprint FROM issues
				WHERE id IS NULL AND source_id IN (${placeholders})`)
			.bind(...sourceIds)
			.all<{ source_id: string; fingerprint: string }>()
		if (results.length === 0) return
		await this.db.batch(
			results.map((row) =>
				this.db.prepare('UPDATE issues SET id = ? WHERE source_id = ? AND fingerprint = ? AND id IS NULL')
					.bind(uuidv7(this.now()), row.source_id, row.fingerprint)
			),
		)
	}

	async listIssues(input: {
		sourceIds: readonly string[]
		status?: IssueStatus
		level?: string
		since?: number
		query?: string
		assignee?: { kind: 'principal'; id: string } | { kind: 'none' }
		sort: OperatorIssueSort
		after?: OperatorIssueCursor
		limit: number
	}): Promise<IdentifiedOperatorIssueRow[]> {
		if (input.sourceIds.length === 0) return []
		await this.ensureIssueIds(input.sourceIds)
		const placeholders = input.sourceIds.map(() => '?').join(', ')
		const conditions = [`issue.source_id IN (${placeholders})`, 'issue.id IS NOT NULL', 'issue.merged_into IS NULL']
		const values: SqlBindValue[] = []
		const countConditions = [
			'occurrence.source_id = issue.source_id',
			'COALESCE(occurrence_issue.merged_into, occurrence_issue.fingerprint) = issue.fingerprint',
			'occurrence.applied_at IS NOT NULL',
		]
		if (input.since !== undefined) {
			countConditions.push('occurrence.received_at >= ?')
			values.push(input.since)
		}
		values.push(...input.sourceIds)
		if (input.status !== undefined) {
			conditions.push('issue.status = ?')
			values.push(input.status)
		}
		if (input.level !== undefined) {
			conditions.push('issue.level = ?')
			values.push(input.level)
		}
		if (input.since !== undefined) {
			conditions.push('issue.last_seen >= ?')
			values.push(input.since)
		}
		if (input.query !== undefined && input.query !== '') {
			conditions.push("(LOWER(issue.title) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(issue.culprit, '')) LIKE ? ESCAPE '\\')")
			const query = `%${input.query.toLowerCase().replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
			values.push(query, query)
		}
		if (input.assignee?.kind === 'principal') {
			conditions.push('issue.assigned_to = ?')
			values.push(input.assignee.id)
		} else if (input.assignee?.kind === 'none') {
			conditions.push('issue.assigned_to IS NULL')
		}
		const sortColumn = input.sort === 'new' ? 'first_seen' : input.sort === 'frequency' ? 'occurrence_count' : 'last_seen'
		const cursorCondition = input.after === undefined
			? ''
			: `WHERE (ranked.${sortColumn} < ? OR (ranked.${sortColumn} = ? AND ranked.id < ?))`
		if (input.after !== undefined) values.push(input.after.value, input.after.value, input.after.id)
		const { results } = await this.db
			.prepare(`SELECT ranked.* FROM (SELECT
					issue.*,
					source.app_id AS source_app_id,
					source.environment AS source_environment,
					source.service_key AS source_service_key,
					source.display_name AS source_display_name,
					source.public_origin AS source_public_origin,
					source.enabled AS source_enabled,
					(SELECT COUNT(*) FROM occurrences occurrence
						JOIN issues occurrence_issue
							ON occurrence_issue.source_id = occurrence.source_id
							AND occurrence_issue.fingerprint = occurrence.fingerprint
						WHERE ${countConditions.join(' AND ')}) AS occurrence_count
				FROM issues issue
				JOIN sources source ON source.id = issue.source_id
				WHERE ${conditions.join(' AND ')}) ranked
				${cursorCondition}
				ORDER BY ranked.${sortColumn} DESC, ranked.id DESC
				LIMIT ?`)
			.bind(...values, input.limit)
			.all<OperatorIssueRow>()
		return results.map(operatorIssueRow)
	}

	async issueTrends(input: {
		issues: readonly IdentifiedOperatorIssueRow[]
		since: number
		until: number
		buckets: number
	}): Promise<OperatorIssueTrendRow[]> {
		if (input.issues.length === 0) return []
		const width = Math.max(1, Math.floor((input.until - input.since) / input.buckets))
		const placeholders = input.issues.map(() => '?').join(', ')
		const { results } = await this.db
			.prepare(`SELECT selected.id AS issue_id, CAST((occurrence.received_at - ?) / ? AS INTEGER) AS bucket, COUNT(*) AS count
				FROM occurrences occurrence
				JOIN issues occurrence_issue
					ON occurrence_issue.source_id = occurrence.source_id
					AND occurrence_issue.fingerprint = occurrence.fingerprint
				JOIN issues selected
					ON selected.id IN (${placeholders})
					AND selected.source_id = occurrence.source_id
					AND (
						(selected.merged_into IS NULL AND COALESCE(occurrence_issue.merged_into, occurrence_issue.fingerprint) = selected.fingerprint)
						OR (selected.merged_into IS NOT NULL AND occurrence_issue.fingerprint = selected.fingerprint)
					)
				WHERE occurrence.applied_at IS NOT NULL AND occurrence.received_at >= ? AND occurrence.received_at <= ?
				GROUP BY selected.id, bucket ORDER BY selected.id, bucket`)
			.bind(input.since, width, ...input.issues.map((issue) => issue.id), input.since, input.until)
			.all<{ issue_id: string; bucket: number | string; count: number | string }>()
		return results.map((row) => ({
			issue_id: row.issue_id,
			bucket: Math.min(input.buckets - 1, number(row.bucket, 'occurrences.bucket')),
			count: number(row.count, 'occurrences.count'),
		}))
	}

	async issueStatusCounts(input: {
		sourceIds: readonly string[]
		level?: string
		since?: number
		query?: string
		assignee?: { kind: 'principal'; id: string } | { kind: 'none' }
	}): Promise<{ status: IssueStatus; count: number }[]> {
		if (input.sourceIds.length === 0) return []
		const placeholders = input.sourceIds.map(() => '?').join(', ')
		const conditions = [`source_id IN (${placeholders})`, 'id IS NOT NULL', 'merged_into IS NULL']
		const values: SqlBindValue[] = [...input.sourceIds]
		if (input.level !== undefined) {
			conditions.push('level = ?')
			values.push(input.level)
		}
		if (input.since !== undefined) {
			conditions.push('last_seen >= ?')
			values.push(input.since)
		}
		if (input.query !== undefined && input.query !== '') {
			conditions.push("(LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(culprit, '')) LIKE ? ESCAPE '\\')")
			const query = `%${input.query.toLowerCase().replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
			values.push(query, query)
		}
		if (input.assignee?.kind === 'principal') {
			conditions.push('assigned_to = ?')
			values.push(input.assignee.id)
		} else if (input.assignee?.kind === 'none') {
			conditions.push('assigned_to IS NULL')
		}
		const { results } = await this.db
			.prepare(`SELECT status, COUNT(*) AS count FROM issues
				WHERE ${conditions.join(' AND ')}
				GROUP BY status`)
			.bind(...values)
			.all<{ status: IssueStatus; count: number | string }>()
		return results.map((row) => ({ status: row.status, count: number(row.count, 'issues.count') }))
	}

	getIssueById(id: string): Promise<IdentifiedOperatorIssueRow | null> {
		return this.issueQuery('issue.id = ?', [id])
	}

	async getIssuesByIds(ids: readonly string[]): Promise<IdentifiedOperatorIssueRow[]> {
		if (ids.length === 0) return []
		const placeholders = ids.map(() => '?').join(', ')
		const { results } = await this.db
			.prepare(this.issueSelect(`issue.id IN (${placeholders})`))
			.bind(...ids)
			.all<OperatorIssueRow>()
		return results.map(operatorIssueRow)
	}

	async getIssueByCoordinate(sourceId: string, fingerprint: string): Promise<IdentifiedOperatorIssueRow | null> {
		await this.ensureIssueIds([sourceId])
		return this.issueQuery('issue.source_id = ? AND issue.fingerprint = ?', [sourceId, fingerprint])
	}

	async listOccurrences(input: {
		issue: IdentifiedOperatorIssueRow
		after?: OperatorOccurrenceCursor
		limit: number
	}): Promise<OperatorOccurrenceRow[]> {
		const cursorCondition = input.after === undefined
			? ''
			: 'AND (occurrence.received_at < ? OR (occurrence.received_at = ? AND occurrence.id < ?))'
		const cursorValues: SqlBindValue[] = input.after === undefined
			? []
			: [input.after.receivedAt, input.after.receivedAt, input.after.id]
		const groupCondition = input.issue.merged_into === null
			? 'COALESCE(occurrence_issue.merged_into, occurrence_issue.fingerprint) = ?'
			: 'occurrence_issue.fingerprint = ?'
		const { results } = await this.db
			.prepare(`SELECT occurrence.id, occurrence.source_id, occurrence.fingerprint, occurrence.event_id,
					occurrence.received_at, occurrence.release, occurrence.blob_key
				FROM occurrences occurrence
				WHERE occurrence.source_id = ? AND occurrence.applied_at IS NOT NULL
					AND EXISTS (
						SELECT 1 FROM issues occurrence_issue
						WHERE occurrence_issue.source_id = occurrence.source_id
							AND occurrence_issue.fingerprint = occurrence.fingerprint
							AND ${groupCondition}
					) ${cursorCondition}
				ORDER BY occurrence.received_at DESC, occurrence.id DESC LIMIT ?`)
			.bind(
				input.issue.source_id,
				input.issue.fingerprint,
				...cursorValues,
				input.limit,
			)
			.all<OperatorOccurrenceRow>()
		return results.map(operatorOccurrenceRow)
	}

	async latestOccurrence(issue: IdentifiedOperatorIssueRow): Promise<OperatorOccurrenceRow | null> {
		return (await this.listOccurrences({ issue, limit: 1 }))[0] ?? null
	}

	async getOccurrence(issue: IdentifiedOperatorIssueRow, occurrenceId: string): Promise<OperatorOccurrenceRow | null> {
		const groupCondition = issue.merged_into === null
			? 'COALESCE(occurrence_issue.merged_into, occurrence_issue.fingerprint) = ?'
			: 'occurrence_issue.fingerprint = ?'
		const row = await this.db
			.prepare(`SELECT occurrence.id, occurrence.source_id, occurrence.fingerprint, occurrence.event_id,
					occurrence.received_at, occurrence.release, occurrence.blob_key
				FROM occurrences occurrence
				WHERE occurrence.id = ? AND occurrence.source_id = ? AND occurrence.applied_at IS NOT NULL
					AND EXISTS (
						SELECT 1 FROM issues occurrence_issue
						WHERE occurrence_issue.source_id = occurrence.source_id
							AND occurrence_issue.fingerprint = occurrence.fingerprint
							AND ${groupCondition}
					)`)
			.bind(occurrenceId, issue.source_id, issue.fingerprint)
			.first<OperatorOccurrenceRow>()
		return row === null ? null : operatorOccurrenceRow(row)
	}

	async listNotificationDeliveries(sourceId: string, limit: number = 50): Promise<OperatorNotificationDeliveryRow[]> {
		const { results } = await this.db
			.prepare(`SELECT id, channel_id, kind, created_at, attempts, max_attempts, delivered_at, abandoned_at
				FROM notification_outbox WHERE source_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
			.bind(sourceId, limit)
			.all<{
				id: string
				channel_id: string
				kind: string
				created_at: number | string
				attempts: number | string
				max_attempts: number | string
				delivered_at: number | string | null
				abandoned_at: number | string | null
			}>()
		if (results.length === 0) return []
		const placeholders = results.map(() => '?').join(', ')
		const attempts = await this.db
			.prepare(`SELECT attempt.id, attempt.notification_id, attempt.attempted_at, attempt.delivered, attempt.error_code
				FROM notification_attempts attempt
				JOIN notification_outbox notification ON notification.id = attempt.notification_id
				WHERE notification.source_id = ? AND attempt.notification_id IN (${placeholders})
				ORDER BY attempt.attempted_at DESC, attempt.id DESC`)
			.bind(sourceId, ...results.map((row) => row.id))
			.all<{
				id: string
				notification_id: string
				attempted_at: number | string
				delivered: number
				error_code: string | null
			}>()
		return results.map((row) => ({
			id: row.id,
			channel_id: row.channel_id,
			kind: row.kind,
			created_at: number(row.created_at, 'notification_outbox.created_at'),
			attempts: number(row.attempts, 'notification_outbox.attempts'),
			max_attempts: number(row.max_attempts, 'notification_outbox.max_attempts'),
			delivered_at: row.delivered_at === null ? null : number(row.delivered_at, 'notification_outbox.delivered_at'),
			abandoned_at: row.abandoned_at === null ? null : number(row.abandoned_at, 'notification_outbox.abandoned_at'),
			attempt_history: attempts.results
				.filter((attempt) => attempt.notification_id === row.id)
				.map((attempt) => ({
					id: attempt.id,
					attempted_at: number(attempt.attempted_at, 'notification_attempts.attempted_at'),
					delivered: attempt.delivered,
					error_code: attempt.error_code,
				})),
		}))
	}

	async listReleases(input: { sourceIds: readonly string[]; offset: number; limit: number }): Promise<OperatorReleaseRow[]> {
		if (input.sourceIds.length === 0) return []
		const placeholders = input.sourceIds.map(() => '?').join(', ')
		const { results } = await this.db
			.prepare(
				this.releaseSelect(`release.source_id IN (${placeholders})`)
					+ ' ORDER BY release.created_at DESC, release.id DESC LIMIT ? OFFSET ?',
			)
			.bind(...input.sourceIds, input.limit, input.offset)
			.all<OperatorReleaseRow>()
		return results.map(operatorReleaseRow)
	}

	async getReleaseById(id: string): Promise<OperatorReleaseRow | null> {
		const row = await this.db.prepare(this.releaseSelect('release.id = ?')).bind(id).first<OperatorReleaseRow>()
		return row === null ? null : operatorReleaseRow(row)
	}

	async getReleaseByName(sourceId: string, releaseName: string): Promise<OperatorReleaseRow | null> {
		const row = await this.db.prepare(this.releaseSelect('release.source_id = ? AND release.release_name = ?'))
			.bind(sourceId, releaseName)
			.first<OperatorReleaseRow>()
		return row === null ? null : operatorReleaseRow(row)
	}

	async listReleaseIssues(release: OperatorReleaseRow): Promise<IdentifiedOperatorIssueRow[]> {
		await this.ensureIssueIds([release.source_id])
		const { results } = await this.db
			.prepare(
				this.issueSelect(`issue.source_id = ? AND issue.id IS NOT NULL AND EXISTS (
				SELECT 1 FROM occurrences occurrence
				WHERE occurrence.source_id = issue.source_id
					AND occurrence.fingerprint = issue.fingerprint
					AND occurrence.release = ?
					AND occurrence.applied_at IS NOT NULL
			)`) + ' ORDER BY issue.last_seen DESC, issue.id DESC',
			)
			.bind(release.source_id, release.release_name)
			.all<OperatorIssueRow>()
		return results.map(operatorIssueRow)
	}

	async bulkStatus(input: {
		issues: readonly IdentifiedOperatorIssueRow[]
		status: IssueStatus
		actorId: string | null
		actorLabel: string | null
	}): Promise<IdentifiedOperatorIssueRow[]> {
		const changed = input.issues.filter((issue) => issue.status !== input.status)
		if (changed.length === 0) return [...input.issues]
		const operationId = uuidv7(this.now())
		const placeholders = changed.map(() => '?').join(', ')
		const statements = [
			this.db
				.prepare(`UPDATE issues SET status = ?, revision = revision + 1, last_mutation_id = ?
					WHERE id IN (${placeholders})`)
				.bind(input.status, operationId, ...changed.map((issue) => issue.id)),
			...changed.map((issue) =>
				this.db
					.prepare(`INSERT INTO issue_activity
						(id, source_id, fingerprint, actor_id, actor_label, kind, data, at)
						SELECT ?, source_id, fingerprint, ?, ?, 'status', ?, ?
						FROM issues WHERE id = ? AND last_mutation_id = ?`)
					.bind(
						uuidv7(this.now()),
						input.actorId,
						input.actorLabel,
						JSON.stringify({ from: issue.status, to: input.status }),
						this.now(),
						issue.id,
						operationId,
					)
			),
		]
		await this.db.batch(statements)
		return this.getIssuesByIds(input.issues.map((issue) => issue.id))
	}

	private async issueQuery(condition: string, values: readonly SqlBindValue[]): Promise<IdentifiedOperatorIssueRow | null> {
		const row = await this.db.prepare(this.issueSelect(condition)).bind(...values).first<OperatorIssueRow>()
		return row === null ? null : operatorIssueRow(row)
	}

	private issueSelect(condition: string): string {
		return `SELECT
				issue.*,
				source.app_id AS source_app_id,
				source.environment AS source_environment,
				source.service_key AS source_service_key,
				source.display_name AS source_display_name,
				source.public_origin AS source_public_origin,
				source.enabled AS source_enabled,
				(SELECT COUNT(*) FROM occurrences occurrence
					JOIN issues occurrence_issue
						ON occurrence_issue.source_id = occurrence.source_id
						AND occurrence_issue.fingerprint = occurrence.fingerprint
					WHERE occurrence.source_id = issue.source_id
						AND occurrence.applied_at IS NOT NULL
						AND (
							(issue.merged_into IS NULL AND COALESCE(occurrence_issue.merged_into, occurrence_issue.fingerprint) = issue.fingerprint)
							OR (issue.merged_into IS NOT NULL AND occurrence_issue.fingerprint = issue.fingerprint)
						)) AS occurrence_count
			FROM issues issue
			JOIN sources source ON source.id = issue.source_id
			WHERE ${condition}`
	}

	private releaseSelect(condition: string): string {
		return `SELECT
				release.*,
				source.app_id AS source_app_id,
				source.environment AS source_environment,
				source.service_key AS source_service_key,
				source.display_name AS source_display_name,
				source.public_origin AS source_public_origin,
				source.enabled AS source_enabled,
				(SELECT COUNT(DISTINCT occurrence.fingerprint) FROM occurrences occurrence
					JOIN issues issue
						ON issue.source_id = occurrence.source_id AND issue.fingerprint = occurrence.fingerprint
					WHERE occurrence.source_id = release.source_id
						AND occurrence.release = release.release_name
						AND occurrence.applied_at IS NOT NULL
						AND issue.first_seen = occurrence.received_at) AS new_issue_count,
				(SELECT COUNT(DISTINCT occurrence.fingerprint) FROM occurrences occurrence
					WHERE occurrence.source_id = release.source_id
						AND occurrence.release = release.release_name
						AND occurrence.transition_kind = 'regressed'
						AND occurrence.applied_at IS NOT NULL) AS regression_count
			FROM releases release
			JOIN sources source ON source.id = release.source_id
			WHERE ${condition}`
	}
}

function operatorIssueRow(row: OperatorIssueRow): IdentifiedOperatorIssueRow {
	if (row.id === null) throw new Error('operator issue id was not assigned')
	return {
		...issueRow(row),
		id: row.id,
		source_app_id: row.source_app_id,
		source_environment: row.source_environment,
		source_service_key: row.source_service_key,
		source_display_name: row.source_display_name,
		source_public_origin: row.source_public_origin,
		source_enabled: row.source_enabled,
		occurrence_count: number(row.occurrence_count, 'occurrences.count'),
	}
}

type SqlBindValue = string | number | boolean | null

function operatorOccurrenceRow(row: OperatorOccurrenceRow): OperatorOccurrenceRow {
	return { ...row, received_at: number(row.received_at, 'occurrences.received_at') }
}

function operatorReleaseRow(row: OperatorReleaseRow): OperatorReleaseRow {
	return {
		...row,
		created_at: number(row.created_at, 'releases.created_at'),
		finished_at: row.finished_at === null ? null : number(row.finished_at, 'releases.finished_at'),
		updated_at: number(row.updated_at, 'releases.updated_at'),
		new_issue_count: number(row.new_issue_count, 'releases.new_issue_count'),
		regression_count: number(row.regression_count, 'releases.regression_count'),
	}
}
