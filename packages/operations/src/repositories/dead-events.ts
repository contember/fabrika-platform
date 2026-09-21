import type { SqlDatabase } from '@fabrika/platform'

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
