import type { SqlDatabase } from '@fabrika/platform'
import type { TelemetryHealthAdapter, TelemetryHealthObservation } from './health.js'

/** Archived dead events prove exhausted deliveries; D1 and Postgres share the same table. */
export class StoredOperationsTelemetryAdapter implements TelemetryHealthAdapter {
	constructor(
		private readonly db: SqlDatabase,
		private readonly now: () => number = Date.now,
	) {}

	async observe(input: { sourceId: string; signal?: AbortSignal }): Promise<TelemetryHealthObservation> {
		const row = await this.db
			.prepare('SELECT COUNT(*) AS count FROM dead_events WHERE source_id = ?')
			.bind(input.sourceId)
			.first<{ count: number | string }>()
		return { observedAt: this.now(), deadLetters: integer(row?.count ?? 0) }
	}
}

function integer(value: number | string): number {
	const parsed = typeof value === 'number' ? value : Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('invalid telemetry counter')
	return parsed
}
