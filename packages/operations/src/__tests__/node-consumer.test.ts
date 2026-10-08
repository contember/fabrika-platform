import type { IngestMessage } from '@fabrika/operations-contract'
import { type Job, PostgresDatabase } from '@fabrika/platform-node'
import { EmptyQueue, MemoryBlobs } from '@fabrika/platform/testing'
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import {
	createOperationsIngestQueue,
	OPERATIONS_INGEST_MAX_ATTEMPTS,
	type OperationsIngestJobQueue,
	PostgresOperationsConsumer,
} from '../node/consumer.js'
import { applyMigrations } from '../node/migrate.js'
import { eventBlobKey } from '../pipeline.js'
import { createPostgresOperationsRepositories, type OperationsRepositories } from '../repositories.js'
import { createHarness } from './helpers/sqlite.js'

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
			{ repositories: harness.repositories, payloads: new MemoryBlobs(), ingestQueue: new EmptyQueue() },
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
		const harness = createHarness(() => 2_000)
		const blobs = new MemoryBlobs()
		const archivedAtAck: { attempts: number | undefined; blob: string | undefined }[] = []
		const queue: OperationsIngestJobQueue = {
			claim: () => Promise.resolve([job]),
			ack: (id) => {
				archivedAtAck.push({
					attempts: harness.sqlite.query<{ attempts: number }, []>('SELECT attempts FROM dead_events').get()?.attempts,
					blob: blobs.values.get('dead/missing-source/event-a.json'),
				})
				acked.push(id)
				return Promise.resolve()
			},
			defer: (id) => {
				deferred.push(id)
				return Promise.resolve()
			},
		}
		const consumer = new PostgresOperationsConsumer(
			queue,
			{ repositories: harness.repositories, payloads: blobs, ingestQueue: new EmptyQueue() },
		)
		expect(await consumer.poll()).toBe(1)
		expect(acked).toEqual(['job-a'])
		expect(deferred).toEqual([])
		expect(archivedAtAck).toEqual([{ attempts: 6, blob: JSON.stringify(job.payload) }])
		expect(harness.sqlite.query<{ attempts: number }, []>('SELECT attempts FROM dead_events').get()?.attempts).toBe(6)
	})

	test.each(['blob', 'index'])('failed dead-event %s archive retains the valid delivery and retries', async (failure) => {
		const job: Job<IngestMessage> = { id: 'archive-retry', payload: ingest(), attempts: 6, maxAttempts: 6 }
		const harness = createHarness(() => 2_000)
		const blobs = new MemoryBlobs()
		const acked: string[] = []
		const deferred: { id: string; delayMs: number }[] = []
		const archivedAtAck: { attempts: number | undefined; blob: string | undefined }[] = []
		const logs: string[] = []
		const queue: OperationsIngestJobQueue = {
			claim: () => Promise.resolve([job]),
			ack: (id) => {
				archivedAtAck.push({
					attempts: harness.sqlite.query<{ attempts: number }, []>('SELECT attempts FROM dead_events').get()?.attempts,
					blob: blobs.values.get('dead/missing-source/event-a.json'),
				})
				acked.push(id)
				return Promise.resolve()
			},
			defer: (id, delayMs) => {
				deferred.push({ id, delayMs })
				return Promise.resolve()
			},
		}
		const failingArchive = failure === 'blob' ? spyOn(blobs, 'put') : spyOn(harness.repositories.deadEvents, 'record')
		failingArchive.mockImplementation(() => Promise.reject(new Error('private archive failure')))
		const consumer = new PostgresOperationsConsumer(
			queue,
			{ repositories: harness.repositories, payloads: blobs, ingestQueue: new EmptyQueue() },
			{ log: (message) => logs.push(message), retryDelayMs: (attempts) => attempts * 1_000 },
		)
		try {
			expect(await consumer.poll()).toBe(1)
			expect(acked).toEqual([])
			expect(deferred).toEqual([{ id: job.id, delayMs: 6_000 }])
			expect(logs).toEqual(['operations ingest dead-event settlement failed'])
		} finally {
			failingArchive.mockRestore()
		}
		job.attempts++
		expect(await consumer.poll()).toBe(1)
		expect(acked).toEqual([job.id])
		expect(archivedAtAck).toEqual([{ attempts: 7, blob: JSON.stringify(job.payload) }])
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

	test('the Bun consumer enqueues a new-issue alert before acknowledging the job', async () => {
		const body = { ...ingest(), projectId: 'source-a' }
		const job: Job<IngestMessage> = { id: 'job-alert', payload: body, attempts: 1, maxAttempts: 6 }
		const acked: string[] = []
		const queue: OperationsIngestJobQueue = {
			claim: () => Promise.resolve([job]),
			ack: (id) => {
				acked.push(id)
				return Promise.resolve()
			},
			defer: () => Promise.resolve(),
		}
		const harness = createHarness(() => 2_000)
		await harness.repositories.sources.upsert({
			id: 'source-a',
			appId: 'app-a',
			environment: 'production',
			displayName: 'App A',
			enabled: true,
		})
		await harness.repositories.alerts.setRule('source-a', 'new_issue', true)
		await harness.repositories.alerts.upsertChannel({
			id: 'new-channel',
			sourceId: 'source-a',
			scope: 'new_issue',
			type: 'webhook',
			target: 'https://example.test/new',
			enabled: true,
		})
		const consumer = new PostgresOperationsConsumer(
			queue,
			{ repositories: harness.repositories, payloads: new MemoryBlobs(), ingestQueue: new EmptyQueue() },
		)

		expect(await consumer.poll()).toBe(1)
		expect(acked).toEqual(['job-alert'])
		expect(harness.sqlite.query<{ kind: string }, []>('SELECT kind FROM notification_outbox').get()?.kind).toBe('new_issue')
	})
})

const POSTGRES_URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const postgresUrl = process.env[POSTGRES_URL_VAR] ?? null
if (!postgresUrl) console.warn('node-consumer.test.ts Postgres cases skipped: set FABRIKA_TEST_POSTGRES_URL to run raw-delivery integration tests')

describe.skipIf(postgresUrl === null)('Postgres Operations raw deliveries', () => {
	let db: PostgresDatabase
	let repositories: OperationsRepositories
	let schema = ''

	beforeAll(async () => {
		if (!postgresUrl) return
		schema = `operations_consumer_${Math.random().toString(36).slice(2, 10)}`
		const admin = PostgresDatabase.connect(postgresUrl)
		await admin.prepare(`CREATE SCHEMA ${schema}`).run()
		await admin.close()
		db = PostgresDatabase.connect(postgresUrl, { connection: { search_path: schema }, max: 1 })
		await applyMigrations(db)
		repositories = createPostgresOperationsRepositories(db, { now: () => 3_000 })
		await repositories.sources.upsert({ id: 'source-a', appId: 'app-a', environment: 'production', displayName: 'App A', enabled: true })
	})

	afterAll(async () => {
		if (!postgresUrl) return
		await db.close()
		const admin = PostgresDatabase.connect(postgresUrl)
		await admin.prepare(`DROP SCHEMA ${schema} CASCADE`).run()
		await admin.close()
	})

	async function insertInvalid(id: string, payload: string, now: number, attempts: number): Promise<void> {
		await db.prepare('DELETE FROM jobs').run()
		await db
			.prepare('INSERT INTO jobs (id, queue, payload, visible_at, attempts, max_attempts, created_at) VALUES (?, ?, ?, ?, ?, 6, ?)')
			.bind(id, 'operations-ingest', payload, now, attempts, now)
			.run()
	}

	test('decodes tolerant queue metadata and preserves opaque payload keys in persisted bytes', async () => {
		const rawPayload = '{"message":"kept","__proto__":{"extension":true},"nested":[null,42]}'
		const rawJob =
			`{"projectId":"source-a","fingerprint":"fp-opaque","eventId":"opaque-event","title":"Error","culprit":null,"level":"error","receivedAt":1000,"release":42,"environment":null,"ignored":true,"payload":${rawPayload}}`
		await insertInvalid('opaque-job', rawJob, 1_000_000, 0)
		const queue = createOperationsIngestQueue(db, { now: () => 1_000_000 })
		const blobs = new MemoryBlobs()
		const consumer = new PostgresOperationsConsumer(queue, { repositories, payloads: blobs, ingestQueue: queue })
		expect(await consumer.poll()).toBe(1)
		expect([...blobs.values.values()]).toEqual([rawPayload])
		expect((await db.prepare('SELECT id FROM jobs').all()).results).toEqual([])
	})

	test.each(['{private', '{"payload":"private"}'])('invalid %s retries below budget and abandons at six while persisting peers', async (payload) => {
		let now = 1_000_000
		const kind = payload.startsWith('{"') ? 'shape' : 'json'
		const id = `000-invalid-${kind}`
		await insertInvalid(id, payload, now, 4)
		const queue = createOperationsIngestQueue(db, { now: () => now })
		const peer = { ...ingest(), projectId: 'source-a', eventId: `peer-${kind}` }
		await queue.send(peer)
		const logs: string[] = []
		const delays: number[] = []
		const blobs = new MemoryBlobs()
		const legacyClaim = spyOn(queue, 'claim')
		const consumer = new PostgresOperationsConsumer(queue, { repositories, payloads: blobs, ingestQueue: queue }, {
			log: (message) => logs.push(message),
			retryDelayMs: (attempts) => {
				delays.push(attempts)
				return 1_000
			},
		})
		try {
			expect(await consumer.poll()).toBe(2)
			expect(legacyClaim).not.toHaveBeenCalled()
			expect((await db.prepare('SELECT event_id FROM occurrences WHERE event_id = ?').bind(peer.eventId).first<{ event_id: string }>())?.event_id)
				.toBe(peer.eventId)
			expect(delays).toEqual([5])
			expect(logs).toEqual([])
			now += 999
			expect(await consumer.poll()).toBe(0)
			now++
			expect(await consumer.poll()).toBe(1)
			expect(logs).toEqual([`operations undecodable ingest job abandoned id="${id}" attempts=6 maxAttempts=6`])
			expect((await db.prepare('SELECT id FROM jobs').all()).results).toEqual([])
			expect((await db.prepare('SELECT id FROM dead_events').all()).results).toEqual([])
			expect([...blobs.values.keys()].some((key) => key.startsWith('dead/'))).toBe(false)
			now += 60_000
			expect(await consumer.poll()).toBe(0)
		} finally {
			legacyClaim.mockRestore()
		}
	})

	test.each(['ack', 'defer'])('failed invalid %s settlement preserves visibility retry and processes the later peer', async (settlement) => {
		let now = 1_000_000
		const id = `000-failed-${settlement}`
		await insertInvalid(id, '{private', now, settlement === 'ack' ? 9 : 0)
		const queue = createOperationsIngestQueue(db, { now: () => now })
		await queue.send({ ...ingest(), projectId: 'source-a', eventId: `peer-failed-${settlement}` })
		let fail = true
		const adapter: OperationsIngestJobQueue = {
			claim: (options) => queue.claim(options),
			claimRaw: (options) => queue.claimRaw(options),
			ack: (jobId) => fail && jobId === id && settlement === 'ack' ? Promise.reject(new Error('private ack failure')) : queue.ack(jobId),
			defer: (jobId, delayMs) =>
				fail && jobId === id && settlement === 'defer' ? Promise.reject(new Error('private defer failure')) : queue.defer(jobId, delayMs),
		}
		const logs: string[] = []
		const consumer = new PostgresOperationsConsumer(adapter, { repositories, payloads: new MemoryBlobs(), ingestQueue: queue }, {
			visibilityTimeoutMs: 30_000,
			retryDelayMs: () => 1_000,
			log: (message) => logs.push(message),
		})
		expect(await consumer.poll()).toBe(2)
		expect(logs).toEqual(['operations ingest settlement failed'])
		expect((await db.prepare('SELECT id FROM jobs').all<{ id: string }>()).results).toEqual([{ id }])
		expect((await db.prepare('SELECT event_id FROM occurrences WHERE event_id = ?').bind(`peer-failed-${settlement}`).all()).results).toHaveLength(1)
		fail = false
		now += 29_999
		expect(await consumer.poll()).toBe(0)
		now++
		expect(await consumer.poll()).toBe(1)
		if (settlement === 'defer') {
			for (let attempt = 3; attempt <= 6; attempt++) {
				now += 1_000
				expect(await consumer.poll()).toBe(1)
			}
		}
		expect(logs).toEqual([
			'operations ingest settlement failed',
			`operations undecodable ingest job abandoned id="${id}" attempts=${settlement === 'ack' ? 11 : 6} maxAttempts=6`,
		])
		now += 60_000
		expect(await consumer.poll()).toBe(0)
		expect((await db.prepare('SELECT id FROM dead_events').all()).results).toEqual([])
	})

	test.each(['raw', 'decoded-only'])(
		'successful exhausted persistence with failed ack retries without dead archiving or peer loss through %s adapter',
		async (variant) => {
			let now = 1_000_000
			await db.prepare('DELETE FROM jobs').run()
			const queue = createOperationsIngestQueue(db, { now: () => now })
			const first = { ...ingest(), projectId: 'source-a', eventId: `success-${variant}-first` }
			const peer = { ...ingest(), projectId: 'source-a', eventId: `success-${variant}-peer` }
			await queue.send(first)
			await queue.send(peer)
			const row = await db.prepare('SELECT id FROM jobs ORDER BY id LIMIT 1').first<{ id: string }>()
			if (!row) throw new Error('missing first queued delivery')
			await db.prepare('UPDATE jobs SET attempts = 5 WHERE id = ?').bind(row.id).run()
			let fail = true
			const deferred: string[] = []
			const adapter: OperationsIngestJobQueue = {
				claim: (options) => queue.claim(options),
				ack: (id) => {
					if (fail && id === row.id) {
						fail = false
						return Promise.reject(new Error('private ack failure'))
					}
					return queue.ack(id)
				},
				defer: (id, delayMs) => {
					deferred.push(id)
					return queue.defer(id, delayMs)
				},
			}
			if (variant === 'raw') adapter.claimRaw = (options) => queue.claimRaw(options)
			const blobs = new MemoryBlobs()
			const logs: string[] = []
			const consumer = new PostgresOperationsConsumer(adapter, { repositories, payloads: blobs, ingestQueue: queue }, {
				visibilityTimeoutMs: 30_000,
				log: (message) => logs.push(message),
			})
			expect(await consumer.poll()).toBe(2)
			expect(
				(await db.prepare('SELECT event_id FROM occurrences WHERE event_id IN (?, ?) ORDER BY event_id').bind(first.eventId, peer.eventId).all()).results,
			)
				.toEqual([{ event_id: first.eventId }, { event_id: peer.eventId }])
			expect(blobs.values.get(eventBlobKey(first))).toBe(JSON.stringify(first.payload))
			expect(blobs.values.get(eventBlobKey(peer))).toBe(JSON.stringify(peer.payload))
			expect((await db.prepare('SELECT id, attempts FROM jobs').all()).results).toEqual([{ id: row.id, attempts: 6 }])
			expect(logs).toEqual(['operations ingest settlement failed'])
			expect(deferred).toEqual([])
			expect((await db.prepare('SELECT id FROM dead_events').all()).results).toEqual([])
			expect([...blobs.values.keys()].some((key) => key.startsWith('dead/'))).toBe(false)
			now += 29_999
			expect(await consumer.poll()).toBe(0)
			now++
			expect(await consumer.poll()).toBe(1)
			expect((await db.prepare('SELECT id FROM jobs').all()).results).toEqual([])
			expect((await db.prepare('SELECT event_id FROM occurrences WHERE event_id = ?').bind(first.eventId).all()).results).toEqual([{
				event_id: first.eventId,
			}])
			expect((await db.prepare('SELECT id FROM dead_events').all()).results).toEqual([])
			expect([...blobs.values.keys()].some((key) => key.startsWith('dead/'))).toBe(false)
			expect(deferred).toEqual([])
			expect(logs).toEqual(['operations ingest settlement failed'])
			now += 30_000
			expect(await consumer.poll()).toBe(0)
		},
	)
})
