// The queue against a real Postgres. The cases that matter are the ones a naive job table gets wrong:
// two consumers must never get the same job (that is what SKIP LOCKED buys), a delayed job must not
// be visible early, and a consumer that dies mid-job must not strand it forever.

import type { SqlDatabase } from '@fabrika/platform'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type Job, PostgresJobConsumer, PostgresJobQueue } from '../job-queue-postgres'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

if (!hasPostgres) {
	console.warn(`job-queue-postgres.test.ts ${skipReason}`)
}

interface DeployMessage {
	runId: string
}

/** The deserialization boundary: narrow the stored JSON, never trust its shape. */
function decodeDeploy(payload: unknown): DeployMessage {
	if (typeof payload !== 'object' || payload === null) {
		throw new Error('job payload is not an object')
	}
	const runId: unknown = Reflect.get(payload, 'runId')
	if (typeof runId !== 'string') {
		throw new Error('job payload has no runId')
	}
	return { runId }
}

let fixture: PostgresFixture | null = null
let db: SqlDatabase

beforeAll(async () => {
	if (!hasPostgres) {
		return
	}
	fixture = await createPostgres('pgjobs')
	db = fixture.db
})

afterAll(async () => {
	await fixture?.close()
})

interface Clock {
	now: number
}

/** A queue on a test-driven clock, with its own queue name so suites never see each other's jobs. */
function makeQueue(name: string, clock: Clock, maxAttempts = 5): PostgresJobQueue<DeployMessage> {
	return new PostgresJobQueue<DeployMessage>(db, { queue: name, maxAttempts, now: () => clock.now })
}

const CLAIM = { limit: 10, visibilityTimeoutMs: 30_000, decode: decodeDeploy }

describe.skipIf(!hasPostgres)('PostgresJobQueue — send and claim', () => {
	test('a sent message is claimable and round-trips its payload', async () => {
		const clock: Clock = { now: 1_000_000 }
		const queue = makeQueue('q-basic', clock)
		await queue.send({ runId: 'run-1' })
		const claimed = await queue.claim(CLAIM)
		expect(claimed).toHaveLength(1)
		expect(claimed[0]?.payload).toEqual({ runId: 'run-1' })
		expect(claimed[0]?.attempts).toBe(1)
		expect(claimed[0]?.maxAttempts).toBe(5)
	})

	test('an empty queue claims nothing', async () => {
		const queue = makeQueue('q-empty', { now: 1_000_000 })
		expect(await queue.claim(CLAIM)).toEqual([])
	})

	test('claiming hides the job for the visibility timeout', async () => {
		const clock: Clock = { now: 1_000_000 }
		const queue = makeQueue('q-hide', clock)
		await queue.send({ runId: 'run-1' })
		expect(await queue.claim({ ...CLAIM, visibilityTimeoutMs: 30_000 })).toHaveLength(1)
		expect(await queue.claim(CLAIM)).toEqual([])
		clock.now += 29_999
		expect(await queue.claim(CLAIM)).toEqual([])
		// The one thing that stops a dead consumer stranding a job: the timeout lapses and it comes back.
		clock.now += 1
		const redelivered = await queue.claim(CLAIM)
		expect(redelivered).toHaveLength(1)
		expect(redelivered[0]?.attempts).toBe(2)
	})

	test('ack removes the job for good', async () => {
		const clock: Clock = { now: 1_000_000 }
		const queue = makeQueue('q-ack', clock)
		await queue.send({ runId: 'run-1' })
		const [job] = await queue.claim(CLAIM)
		await queue.ack(job?.id ?? '')
		clock.now += 60_000
		expect(await queue.claim(CLAIM)).toEqual([])
	})

	test('delaySeconds keeps the job invisible until it is due', async () => {
		const clock: Clock = { now: 1_000_000 }
		const queue = makeQueue('q-delay', clock)
		await queue.send({ runId: 'later' }, { delaySeconds: 30 })
		expect(await queue.claim(CLAIM)).toEqual([])
		clock.now += 29_999
		expect(await queue.claim(CLAIM)).toEqual([])
		clock.now += 1
		expect(await queue.claim(CLAIM)).toHaveLength(1)
	})

	test('defer pushes a claimed job back into the future', async () => {
		const clock: Clock = { now: 1_000_000 }
		const queue = makeQueue('q-defer', clock)
		await queue.send({ runId: 'run-1' })
		const [job] = await queue.claim(CLAIM)
		await queue.defer(job?.id ?? '', 10_000)
		clock.now += 9_999
		expect(await queue.claim(CLAIM)).toEqual([])
		clock.now += 1
		expect(await queue.claim(CLAIM)).toHaveLength(1)
	})

	test('a claimed batch comes back oldest-first', async () => {
		// Postgres does not order `RETURNING` by the sub-select's `ORDER BY`, so without the driver's
		// own sort this arrives in whatever order the UPDATE happened to produce.
		const clock: Clock = { now: 1_000_000 }
		const queue = makeQueue('q-order', clock)
		await queue.send({ runId: 'first' })
		clock.now += 10
		await queue.send({ runId: 'second' })
		clock.now += 10
		await queue.send({ runId: 'third' })
		const claimed = await queue.claim(CLAIM)
		expect(claimed.map((job) => job.payload.runId)).toEqual(['first', 'second', 'third'])
	})

	test('limit caps a claim and takes the DUE-SOONEST jobs', async () => {
		const clock: Clock = { now: 1_000_000 }
		const queue = makeQueue('q-limit', clock)
		await queue.send({ runId: 'a' })
		clock.now += 10
		await queue.send({ runId: 'b' })
		clock.now += 10
		await queue.send({ runId: 'c' })
		const claimed = await queue.claim({ ...CLAIM, limit: 2 })
		expect(claimed.map((job) => job.payload.runId)).toEqual(['a', 'b'])
	})

	test('queues in one table are isolated from each other', async () => {
		const clock: Clock = { now: 1_000_000 }
		const mine = makeQueue('q-mine', clock)
		const theirs = makeQueue('q-theirs', clock)
		await mine.send({ runId: 'mine' })
		expect(await theirs.claim(CLAIM)).toEqual([])
		expect(await mine.claim(CLAIM)).toHaveLength(1)
	})

	test('an undecodable payload throws at the boundary rather than reaching a handler', async () => {
		const clock: Clock = { now: 1_000_000 }
		const queue = makeQueue('q-bad', clock)
		await db
			.prepare('INSERT INTO jobs (id, queue, payload, visible_at, attempts, max_attempts, created_at) VALUES (?, ?, ?, ?, 0, 5, ?)')
			.bind('bad-1', 'q-bad', '{"nope":1}', clock.now, clock.now)
			.run()
		await expect(queue.claim(CLAIM)).rejects.toThrow('job payload has no runId')
	})

	test('rejects a table name that is not a bare identifier', () => {
		expect(() => new PostgresJobQueue(db, { table: 'jobs; DROP TABLE runs' })).toThrow('invalid jobs table name')
	})
})

describe.skipIf(!hasPostgres)('PostgresJobQueue — SKIP LOCKED', () => {
	test('concurrent claims never hand the same job to two consumers', async () => {
		const clock: Clock = { now: 1_000_000 }
		const queue = makeQueue('q-race', clock)
		for (let i = 0; i < 12; i += 1) {
			await queue.send({ runId: `run-${i}` })
		}
		// Six consumers claiming at once. Every job must be claimed exactly once — no duplicates and,
		// because SKIP LOCKED does not block, no consumer waiting on another's rows.
		const batches = await Promise.all(Array.from({ length: 6 }, () => queue.claim({ ...CLAIM, limit: 2 })))
		const ids = batches.flat().map((job) => job.id)
		expect(ids).toHaveLength(12)
		expect(new Set(ids).size).toBe(12)
	})
})

describe.skipIf(!hasPostgres)('PostgresJobConsumer', () => {
	test('poll() handles a due job and acks it', async () => {
		const clock: Clock = { now: 1_000_000 }
		const queue = makeQueue('c-basic', clock)
		const handled: string[] = []
		const consumer = new PostgresJobConsumer(queue, {
			decode: decodeDeploy,
			handler: async (job) => {
				handled.push(job.payload.runId)
			},
		})
		await queue.send({ runId: 'run-1' })
		expect(await consumer.poll()).toBe(1)
		expect(handled).toEqual(['run-1'])
		clock.now += 3_600_000
		expect(await consumer.poll()).toBe(0)
	})

	test('a failing handler is retried after a backoff, then abandoned', async () => {
		const clock: Clock = { now: 1_000_000 }
		const queue = makeQueue('c-retry', clock, 3)
		const attempts: number[] = []
		const abandoned: Job<DeployMessage>[] = []
		const consumer = new PostgresJobConsumer(queue, {
			decode: decodeDeploy,
			handler: async (job) => {
				attempts.push(job.attempts)
				throw new Error('handler exploded')
			},
			retryDelayMs: () => 1_000,
			onError: () => {},
			onAbandoned: (job) => abandoned.push(job),
		})
		await queue.send({ runId: 'doomed' })

		expect(await consumer.poll()).toBe(1)
		// Still inside the retry backoff.
		expect(await consumer.poll()).toBe(0)
		clock.now += 1_000
		expect(await consumer.poll()).toBe(1)
		clock.now += 1_000
		expect(await consumer.poll()).toBe(1)

		expect(attempts).toEqual([1, 2, 3])
		expect(abandoned).toHaveLength(1)
		// Abandoned means the row is gone, not that it retries forever.
		clock.now += 3_600_000
		expect(await consumer.poll()).toBe(0)
	})

	test('a handler that recovers on a later attempt acks normally', async () => {
		const clock: Clock = { now: 1_000_000 }
		const queue = makeQueue('c-recover', clock, 5)
		let calls = 0
		const consumer = new PostgresJobConsumer(queue, {
			decode: decodeDeploy,
			handler: async () => {
				calls += 1
				if (calls === 1) {
					throw new Error('transient')
				}
			},
			retryDelayMs: () => 500,
			onError: () => {},
		})
		await queue.send({ runId: 'flaky' })
		await consumer.poll()
		clock.now += 500
		await consumer.poll()
		clock.now += 3_600_000
		expect(await consumer.poll()).toBe(0)
		expect(calls).toBe(2)
	})

	test('start()/stop() drains the queue in the background and stops cleanly', async () => {
		const clock: Clock = { now: 1_000_000 }
		const queue = makeQueue('c-loop', clock)
		const handled: string[] = []
		const consumer = new PostgresJobConsumer(queue, {
			decode: decodeDeploy,
			pollIntervalMs: 5,
			handler: async (job) => {
				handled.push(job.payload.runId)
			},
		})
		await queue.send({ runId: 'a' })
		await queue.send({ runId: 'b' })
		consumer.start()
		consumer.start() // idempotent
		const deadline = Date.now() + 5_000
		while (handled.length < 2 && Date.now() < deadline) {
			await Bun.sleep(5)
		}
		await consumer.stop()
		await consumer.stop() // idempotent
		expect(handled.sort()).toEqual(['a', 'b'])

		// Nothing keeps polling after stop().
		await queue.send({ runId: 'c' })
		await Bun.sleep(30)
		expect(handled).toHaveLength(2)
	})
})
