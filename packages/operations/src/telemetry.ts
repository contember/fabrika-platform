import type { SqlDatabase } from '@fabrika/platform'
import { type TelemetryHealthAdapter, type TelemetryHealthObservation, type TelemetryValue, unavailableTelemetryValue } from './health.js'

interface CountRow {
	count: number | string
	last_at: number | string | null
}

export interface PipelineTelemetryFacts {
	observe(input: {
		sourceId: string
	}): Promise<Pick<TelemetryHealthObservation, 'rejects' | 'queue'>>
}

/**
 * Durable facts shared by D1 and Postgres. Occurrences prove processed throughput and archived dead
 * events prove exhausted deliveries. Provider queue and reject counters remain separate capabilities.
 */
export class StoredOperationsTelemetryAdapter implements TelemetryHealthAdapter {
	constructor(
		private readonly db: SqlDatabase,
		private readonly pipeline: PipelineTelemetryFacts,
		private readonly now: () => number = Date.now,
	) {}

	async observe(input: { sourceId: string; signal?: AbortSignal }): Promise<TelemetryHealthObservation> {
		const [processed, dlq, pipeline] = await Promise.all([
			this.processed(input.sourceId),
			this.deadLetters(input.sourceId),
			this.pipeline.observe({ sourceId: input.sourceId }),
		])
		return {
			observedAt: this.now(),
			processed,
			dlq,
			rejects: pipeline.rejects,
			queue: pipeline.queue,
		}
	}

	private async processed(sourceId: string): Promise<TelemetryHealthObservation['processed']> {
		try {
			const row = await this.db
				.prepare('SELECT COUNT(*) AS count, MAX(received_at) AS last_at FROM occurrences WHERE source_id = ?')
				.bind(sourceId)
				.first<CountRow>()
			return {
				available: true,
				value: {
					count: integer(row?.count ?? 0),
					lastProcessedAt: row?.last_at === null || row?.last_at === undefined ? null : integer(row.last_at),
				},
			}
		} catch {
			return unavailableTelemetryValue('processed event store is unavailable')
		}
	}

	private async deadLetters(sourceId: string): Promise<TelemetryHealthObservation['dlq']> {
		try {
			const row = await this.db
				.prepare('SELECT COUNT(*) AS count, NULL AS last_at FROM dead_events WHERE source_id = ?')
				.bind(sourceId)
				.first<CountRow>()
			return { available: true, value: { count: integer(row?.count ?? 0) } }
		} catch {
			return unavailableTelemetryValue('dead-event store is unavailable')
		}
	}
}

/** Cloudflare queue analytics need an approved provider capability; no API credential is inferred. */
export function cloudflarePipelineTelemetry(): PipelineTelemetryFacts {
	return unavailablePipelineTelemetry(
		'Cloudflare reject counters are not durably available',
		'Cloudflare per-source Queue and DLQ backlog metrics are not configured',
	)
}

/** Bun has a shared jobs table, but its JSON payload cannot prove a portable per-source backlog fact. */
export function bunPipelineTelemetry(): PipelineTelemetryFacts {
	return unavailablePipelineTelemetry(
		'Bun reject counters are not durably available',
		'Bun per-source queue backlog metrics are not durably available',
	)
}

function unavailablePipelineTelemetry(rejectReason: string, queueReason: string): PipelineTelemetryFacts {
	return {
		observe(): Promise<Pick<TelemetryHealthObservation, 'rejects' | 'queue'>> {
			return Promise.resolve({
				rejects: unavailableTelemetryValue(rejectReason),
				queue: unavailableTelemetryValue(queueReason),
			})
		},
	}
}

function integer(value: number | string): number {
	const parsed = typeof value === 'number' ? value : Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('invalid telemetry counter')
	return parsed
}
