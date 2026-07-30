import type { IngestMessage } from '@fabrika/operations-contract'
import type { BlobStore, JobQueue } from '@fabrika/platform'
import type { Job } from '@fabrika/platform-node'
import { describe, expect, test } from 'bun:test'
import {
	createOperationsIngestQueue,
	OPERATIONS_INGEST_MAX_ATTEMPTS,
	type OperationsIngestJobQueue,
	PostgresOperationsConsumer,
} from '../node/consumer.js'
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

class EmptyProducer implements JobQueue<IngestMessage> {
	send(): Promise<void> {
		return Promise.resolve()
	}
}

function ingest(): IngestMessage {
	return {
		projectId: 'missing-source',
		fingerprint: 'fp-a',
		eventId: 'event-a',
		title: 'Error',
		culprit: null,
		level: 'error',
		receivedAt: 1_000,
		payload: { message: 'private' },
	}
}

describe('Postgres Operations consumer lifecycle', () => {
	test('stops through AbortSignal and can restart without overlapping loops', async () => {
		let claims = 0
		const queue: OperationsIngestJobQueue = {
			claim: () => {
				claims++
				if (claims === 1) return Promise.reject(new Error('postgres://user:secret@example.test/db'))
				return Promise.resolve([])
			},
			ack: () => Promise.resolve(),
			defer: () => Promise.resolve(),
		}
		const harness = createHarness()
		const logs: string[] = []
		const consumer = new PostgresOperationsConsumer(
			queue,
			{ repositories: harness.repositories, payloads: new MemoryBlobs(), ingestQueue: new EmptyProducer() },
			{
				log: (message) => logs.push(message),
				sleep: (_ms, signal) =>
					new Promise((resolve) => {
						if (signal.aborted) resolve()
						else signal.addEventListener('abort', () => resolve(), { once: true })
					}),
			},
		)
		consumer.start()
		consumer.start()
		await Promise.resolve()
		await Promise.resolve()
		await consumer.stop()
		expect(claims).toBe(1)
		expect(logs).toEqual(['operations ingest poll failed'])
		expect(JSON.stringify(logs)).not.toContain('secret')

		consumer.start()
		await Promise.resolve()
		await Promise.resolve()
		await consumer.stop()
		expect(claims).toBe(2)
	})

	test('archives and acknowledges the sixth failed delivery', async () => {
		const job: Job<IngestMessage> = {
			id: 'job-a',
			payload: ingest(),
			attempts: OPERATIONS_INGEST_MAX_ATTEMPTS,
			maxAttempts: OPERATIONS_INGEST_MAX_ATTEMPTS,
		}
		const acked: string[] = []
		const deferred: string[] = []
		const queue: OperationsIngestJobQueue = {
			claim: () => Promise.resolve([job]),
			ack: (id) => {
				acked.push(id)
				return Promise.resolve()
			},
			defer: (id) => {
				deferred.push(id)
				return Promise.resolve()
			},
		}
		const harness = createHarness(() => 2_000)
		const blobs = new MemoryBlobs()
		const consumer = new PostgresOperationsConsumer(
			queue,
			{ repositories: harness.repositories, payloads: blobs, ingestQueue: new EmptyProducer() },
		)
		expect(await consumer.poll()).toBe(1)
		expect(acked).toEqual(['job-a'])
		expect(deferred).toEqual([])
		expect(harness.sqlite.query<{ attempts: number }, []>('SELECT attempts FROM dead_events').get()?.attempts).toBe(6)
	})

	test('the Operations queue factory pins maxAttempts to six', async () => {
		const harness = createHarness(() => 1_000)
		harness.sqlite.run(`CREATE TABLE jobs (
			id TEXT PRIMARY KEY, queue TEXT NOT NULL, payload TEXT NOT NULL, visible_at INTEGER NOT NULL,
			attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL, created_at INTEGER NOT NULL
		)`)
		const queue = createOperationsIngestQueue(harness.db, { now: () => 1_000 })
		await queue.send(ingest())
		expect(harness.sqlite.query<{ queue: string; max_attempts: number }, []>('SELECT queue, max_attempts FROM jobs').get()).toEqual({
			queue: 'operations-ingest',
			max_attempts: 6,
		})
	})
})
