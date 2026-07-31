import type { IngestMessage } from '@fabrika/operations-contract'
import type { BlobStore, JobQueue } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import { evaluateSpike, OperationsAlertProducer, SPIKE_DEDUP_WINDOW_SECONDS } from '../alerts.js'
import { persistIngest } from '../pipeline.js'
import { createHarness } from './helpers/sqlite.js'

class MemoryBlobs implements BlobStore {
	put(): Promise<void> {
		return Promise.resolve()
	}

	get(): Promise<null> {
		return Promise.resolve(null)
	}

	delete(): Promise<void> {
		return Promise.resolve()
	}
}

class EmptyQueue implements JobQueue<IngestMessage> {
	send(): Promise<void> {
		return Promise.resolve()
	}
}

describe('alert semantics', () => {
	test('fires exactly at the threshold', () => {
		expect(evaluateSpike({ count: 9, threshold: 10, claimed: false })).toEqual({ fire: false, deduped: false })
		expect(evaluateSpike({ count: 10, threshold: 10, claimed: false })).toEqual({ fire: true, deduped: false })
	})

	test('reports an already claimed spike as deduplicated', () => {
		expect(evaluateSpike({ count: 11, threshold: 10, claimed: true })).toEqual({ fire: false, deduped: true })
	})

	test('enqueues one spike notification per claim window from the last minute of occurrences', async () => {
		let now = 120_000
		const harness = createHarness(() => now)
		await harness.repositories.sources.upsert({
			id: 'source-a',
			appId: 'app-a',
			environment: 'production',
			displayName: 'App A',
			enabled: true,
		})
		await harness.repositories.alerts.setConfig('source-a', { threshold: 3, enabled: true })
		await harness.repositories.alerts.upsertChannel({
			id: 'spike-channel',
			sourceId: 'source-a',
			scope: 'spike',
			type: 'webhook',
			target: 'https://example.test/spikes',
			enabled: true,
		})
		const env = { repositories: harness.repositories, payloads: new MemoryBlobs(), ingestQueue: new EmptyQueue() }
		for (let index = 0; index < 3; index++) {
			await persistIngest(env, {
				projectId: 'source-a',
				fingerprint: 'spiking',
				eventId: `event-${index}`,
				title: 'Spike',
				culprit: null,
				level: 'error',
				receivedAt: 119_000 + index,
				payload: {},
			})
		}
		const producer = new OperationsAlertProducer(harness.repositories.alerts, harness.repositories.ingest, () => now)

		expect(await producer.detectSpikes()).toEqual({ evaluated: 1, enqueued: 1, deduplicated: 0 })
		expect(await producer.detectSpikes()).toEqual({ evaluated: 1, enqueued: 0, deduplicated: 1 })
		expect(harness.sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM notification_outbox').get()?.count).toBe(1)

		now += SPIKE_DEDUP_WINDOW_SECONDS * 1_000
		await persistIngest(env, {
			projectId: 'source-a',
			fingerprint: 'spiking',
			eventId: 'next-window-a',
			title: 'Spike',
			culprit: null,
			level: 'error',
			receivedAt: now - 2,
			payload: {},
		})
		await persistIngest(env, {
			projectId: 'source-a',
			fingerprint: 'spiking',
			eventId: 'next-window-b',
			title: 'Spike',
			culprit: null,
			level: 'error',
			receivedAt: now - 1,
			payload: {},
		})
		await persistIngest(env, {
			projectId: 'source-a',
			fingerprint: 'spiking',
			eventId: 'next-window-c',
			title: 'Spike',
			culprit: null,
			level: 'error',
			receivedAt: now,
			payload: {},
		})
		expect(await producer.detectSpikes()).toEqual({ evaluated: 1, enqueued: 1, deduplicated: 0 })
		expect(harness.sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM notification_outbox').get()?.count).toBe(2)
	})
})
