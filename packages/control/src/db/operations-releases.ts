import type { SqlDatabase } from '@fabrika/platform'
import { firstRow } from './returning'

export interface OperationsReleaseSyncRow {
	run_id: string
	desired_revision: number | string
	applied_revision: number | string
	payload_json: string
	last_attempt_at: number | string | null
	last_success_at: number | string | null
	last_error: string | null
}

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

	async markFailed(runId: string, message: string): Promise<void> {
		await this.db
			.prepare('UPDATE operations_release_sync SET last_error = ? WHERE run_id = ?')
			.bind(message.slice(0, 200), runId)
			.run()
	}
}

function releaseInteger(value: number | string, field: string): number {
	const parsed = typeof value === 'number' ? value : Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid operations release ${field}`)
	return parsed
}
