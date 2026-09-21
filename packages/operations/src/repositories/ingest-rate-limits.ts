import type { SqlDatabase } from '@fabrika/platform'

export class IngestRateLimitsRepository {
	constructor(protected readonly db: SqlDatabase, protected readonly now: () => number = Date.now) {}

	async consume(input: {
		sourceId: string
		windowStart: number
		amount?: number
		limit: number
	}): Promise<boolean> {
		const amount = input.amount ?? 1
		if (!Number.isInteger(amount) || amount < 1) throw new RangeError('rate-limit amount must be a positive integer')
		if (!Number.isInteger(input.limit) || input.limit < 1) throw new RangeError('rate limit must be a positive integer')
		if (amount > input.limit) return false
		const row = await this.db
			.prepare(`INSERT INTO ingest_rate_limits (source_id, window_start, consumed_count, updated_at)
				SELECT id, ?, ?, ? FROM sources WHERE id = ? AND enabled = 1
				ON CONFLICT (source_id, window_start) DO UPDATE SET
					consumed_count = ingest_rate_limits.consumed_count + excluded.consumed_count,
					updated_at = excluded.updated_at
				WHERE ingest_rate_limits.consumed_count + excluded.consumed_count <= ?
				RETURNING consumed_count`)
			.bind(input.windowStart, amount, this.now(), input.sourceId, input.limit)
			.first<{ consumed_count: number }>()
		return row !== null
	}

	async prune(beforeWindowStart: number): Promise<number> {
		const result = await this.db.prepare('DELETE FROM ingest_rate_limits WHERE window_start < ?').bind(beforeWindowStart).run()
		return result.meta.changes
	}
}
