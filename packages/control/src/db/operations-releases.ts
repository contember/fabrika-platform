import type { SqlDatabase } from '@fabrika/platform'
import { firstRow } from './returning'
import type { RunRow } from './runs'

export interface OperationsReleaseSyncRow {
	run_id: string
	desired_revision: number | string
	applied_revision: number | string
	payload_json: string
	last_attempt_at: number | string | null
	last_success_at: number | string | null
	last_error: string | null
}

export interface TerminalOperationsReleaseRow extends OperationsReleaseSyncRow, RunRow {}

export const TERMINAL_RELEASE_REPAIR_DIAGNOSTIC = 'operations terminal release repair requires valid frozen context'

/** Durable per-run outbox for the private Delivery → Operations release projection. */
export class OperationsReleaseRepository {
	constructor(protected readonly db: SqlDatabase, protected readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

	async project(runId: string, payloadJson: string): Promise<number> {
		const row = await firstRow<{ desired_revision: number | string }>(
			this.db
				.prepare(`INSERT INTO operations_release_sync
					(run_id, desired_revision, applied_revision, payload_json)
					VALUES (?, 1, 0, ?)
					ON CONFLICT (run_id) DO UPDATE SET
						desired_revision = operations_release_sync.desired_revision + 1,
						payload_json = excluded.payload_json
					RETURNING desired_revision`)
				.bind(runId, payloadJson),
		)
		return releaseInteger(row.desired_revision, 'desired_revision')
	}

	async listPending(limit = 100): Promise<OperationsReleaseSyncRow[]> {
		const { results } = await this.db
			.prepare(`SELECT * FROM operations_release_sync
				WHERE applied_revision < desired_revision
				ORDER BY run_id LIMIT ?`)
			.bind(limit)
			.all<OperationsReleaseSyncRow>()
		return results
	}

	async get(runId: string): Promise<OperationsReleaseSyncRow | null> {
		return this.db.prepare('SELECT * FROM operations_release_sync WHERE run_id = ?').bind(runId).first<OperationsReleaseSyncRow>()
	}

	async terminalScanBoundary(): Promise<string | null> {
		const row = await this.db.prepare(`SELECT MAX(s.run_id) AS boundary FROM operations_release_sync s
			JOIN runs r ON r.id = s.run_id WHERE r.status IN ('succeeded', 'failed')`).first<{ boundary: string | null }>()
		return row?.boundary ?? null
	}

	async listTerminalPage(after: string, boundary: string, limit: number): Promise<TerminalOperationsReleaseRow[]> {
		const { results } = await this.db.prepare(`SELECT s.*, r.* FROM operations_release_sync s
			JOIN runs r ON r.id = s.run_id
			WHERE r.status IN ('succeeded', 'failed') AND s.run_id > ? AND s.run_id <= ?
			ORDER BY s.run_id LIMIT ?`).bind(after, boundary, limit).all<TerminalOperationsReleaseRow>()
		return results
	}

	async getTerminal(runId: string): Promise<TerminalOperationsReleaseRow | null> {
		return this.db.prepare(`SELECT s.*, r.* FROM operations_release_sync s JOIN runs r ON r.id = s.run_id
			WHERE s.run_id = ? AND r.status IN ('succeeded', 'failed')`).bind(runId).first<TerminalOperationsReleaseRow>()
	}

	/**
	 * Replace a terminal run's stale release payload, or record why it cannot be repaired. Unfenced: the
	 * revision predicate makes overlapping replays idempotent, and the run is already terminal.
	 */
	async repairTerminal(expected: TerminalOperationsReleaseRow, payloadJson: string | null): Promise<boolean> {
		const assignment = payloadJson === null
			? 'last_error = ?'
			: 'payload_json = ?, desired_revision = desired_revision + 1, last_error = NULL'
		const externalPredicate = expected.external_run_id === null ? 'r.external_run_id IS NULL' : 'r.external_run_id = ?'
		const externalValues = expected.external_run_id === null ? [] : [expected.external_run_id]
		const finishedPredicate = expected.finished_at === null ? 'r.finished_at IS NULL' : 'r.finished_at = ?'
		const finishedValues = expected.finished_at === null ? [] : [expected.finished_at]
		const result = await this.db.prepare(`UPDATE operations_release_sync SET ${assignment}
			WHERE run_id = ? AND desired_revision = ?
				AND EXISTS (SELECT 1 FROM runs r WHERE r.id = operations_release_sync.run_id
					AND r.app_id = ? AND r.env = ? AND r.status = ? AND r.status IN ('succeeded', 'failed')
					AND ${finishedPredicate} AND ${externalPredicate})`).bind(
			payloadJson ?? TERMINAL_RELEASE_REPAIR_DIAGNOSTIC,
			expected.run_id,
			expected.desired_revision,
			expected.app_id,
			expected.env,
			expected.status,
			...finishedValues,
			...externalValues,
		).run()
		return (result.meta.changes ?? 0) > 0
	}

	async markAttempt(runId: string, revision: number): Promise<void> {
		await this.db
			.prepare(`UPDATE operations_release_sync SET last_attempt_at = ?
				WHERE run_id = ? AND desired_revision = ?`)
			.bind(this.now(), runId, revision)
			.run()
	}

	async markApplied(runId: string, revision: number): Promise<void> {
		await this.db
			.prepare(`UPDATE operations_release_sync SET
					applied_revision = CASE WHEN applied_revision < ? THEN ? ELSE applied_revision END,
					last_success_at = ?,
					last_error = NULL
				WHERE run_id = ?`)
			.bind(revision, revision, this.now(), runId)
			.run()
	}

	async markFailed(row: OperationsReleaseSyncRow, message: string): Promise<void> {
		await this.db
			.prepare('UPDATE operations_release_sync SET last_error = ? WHERE run_id = ? AND desired_revision = ? AND payload_json = ?')
			.bind(message.slice(0, 200), row.run_id, row.desired_revision, row.payload_json)
			.run()
	}
}

function releaseInteger(value: number | string, field: string): number {
	const parsed = typeof value === 'number' ? value : Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid operations release ${field}`)
	return parsed
}
