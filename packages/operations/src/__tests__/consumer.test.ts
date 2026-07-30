import type { IngestMessage } from '@fabrika/operations-contract'
import type { BlobStore, JobQueue } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import { consumeDeliveries, type IngestDelivery } from '../consumer.js'
import { createHarness } from './helpers/sqlite.js'

class MemoryBlobs implements BlobStore {
	readonly values = new Map<string, string>()

	put(key: string, value: string | ArrayBuffer | ReadableStream): Promise<void> {
		if (typeof value !== 'string') throw new Error('strings only')
		this.values.set(key, value)
		return Promise.resolve()
	}

	get(): Promise<null> {
		return Promise.resolve(null)
	}

	delete(key: string): Promise<void> {
		this.values.delete(key)
		return Promise.resolve()
	}
}

class EmptyQueue implements JobQueue<IngestMessage> {
	send(): Promise<void> {
		return Promise.resolve()
	}
}

function message(index: number): IngestMessage {
	return {
		projectId: 'source-a',
		fingerprint: 'storm',
		eventId: `event-${index}`,
		title: 'Error: storm',
		culprit: 'handler',
		level: 'error',
		receivedAt: 1_000 + index,
		payload: { index },
	}
}

describe('shared ingest consumer', () => {
	test('coalesces a 25-event storm into one issue write and preserves every delivery outcome', async () => {
		const harness = createHarness(() => 2_000)
		await harness.repositories.sources.upsert({
			id: 'source-a',
			appId: 'app-a',
			environment: 'production',
			displayName: 'App A',
			enabled: true,
		})
		harness.sqlite.run('CREATE TABLE issue_writes (kind TEXT NOT NULL)')
		harness.sqlite.run(`CREATE TRIGGER count_issue_insert AFTER INSERT ON issues
			BEGIN INSERT INTO issue_writes (kind) VALUES ('insert'); END`)
		harness.sqlite.run(`CREATE TRIGGER count_issue_update AFTER UPDATE ON issues
			BEGIN INSERT INTO issue_writes (kind) VALUES ('update'); END`)
		const acked: number[] = []
		const retried: number[] = []
		const deliveries: IngestDelivery[] = Array.from({ length: 25 }, (_, index) => ({
			body: message(index),
			attempts: 1,
			ack: () => acked.push(index),
			retry: () => retried.push(index),
		}))
		await consumeDeliveries(
			{ repositories: harness.repositories, payloads: new MemoryBlobs(), ingestQueue: new EmptyQueue() },
			deliveries,
		)

		expect(acked).toEqual(Array.from({ length: 25 }, (_, index) => index))
		expect(retried).toEqual([])
		expect((await harness.repositories.ingest.counts({ sourceId: 'source-a', fingerprint: 'storm' }))[0]?.count).toBe(25)
		expect(harness.sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM occurrences').get()?.count).toBe(25)
		expect(harness.sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM issue_writes').get()?.count).toBe(1)
	})
})
