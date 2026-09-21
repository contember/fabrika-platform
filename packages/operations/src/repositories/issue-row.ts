import type { IssueStatus } from '@fabrika/operations-contract'
import { number } from './values.js'

export interface IssueRow {
	id: string | null
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

export function issueRow(row: IssueRow): IssueRow {
	return {
		...row,
		first_seen: number(row.first_seen, 'issues.first_seen'),
		last_seen: number(row.last_seen, 'issues.last_seen'),
		regressed_at: row.regressed_at === null ? null : number(row.regressed_at, 'issues.regressed_at'),
		snooze_until: row.snooze_until === null ? null : number(row.snooze_until, 'issues.snooze_until'),
		snooze_until_count: row.snooze_until_count === null ? null : number(row.snooze_until_count, 'issues.snooze_until_count'),
	}
}
