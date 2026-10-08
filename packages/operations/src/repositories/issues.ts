import type { ActivityItem, IssueMutation, PriorIssueState } from '@fabrika/operations-contract'
import { type SqlDatabase, uuidv7 } from '@fabrika/platform'
import { applyIssueMutation } from '../issues.js'
import type { IssueRow } from './issue-row.js'
import { issueRow } from './issue-row.js'
import { number, parseObject } from './values.js'

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
