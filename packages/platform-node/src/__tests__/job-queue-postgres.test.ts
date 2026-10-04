// The queue against a real Postgres. The cases that matter are the ones a naive job table gets wrong:
// two consumers must never get the same job (that is what SKIP LOCKED buys), a delayed job must not
// be visible early, and a consumer that dies mid-job must not strand it forever.

import type { SqlDatabase } from '@fabrika/platform'
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { decodeJob, type Job, PostgresJobConsumer, PostgresJobQueue } from '../job-queue-postgres'
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

async function insertStoredJob(queue: string, clock: Clock, payload: string, attempts = 0, maxAttempts = 2): Promise<string> {
	const id = `000-${queue}-invalid`
	await db
		.prepare('INSERT INTO jobs (id, queue, payload, visible_at, attempts, max_attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
		.bind(id, queue, payload, clock.now, attempts, maxAttempts, clock.now)
		.run()
	return id
}

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
		expect(await db.prepare('SELECT attempts FROM jobs WHERE id = ?').bind('bad-1').first<{ attempts: number }>()).toEqual({ attempts: 1 })
	})

	test('legacy claim rejects malformed JSON without deleting its row', async () => {
		const clock: Clock = { now: 1_000_000 }
		const queue = makeQueue('q-bad-json', clock)
		const id = await insertStoredJob('q-bad-json', clock, '{private')
		await expect(queue.claim(CLAIM)).rejects.toThrow()
		expect(await db.prepare('SELECT attempts FROM jobs WHERE id = ?').bind(id).first<{ attempts: number }>()).toEqual({ attempts: 1 })
	})

	test('raw claim retains invalid text and metadata while typed decoding remains per delivery', async () => {
		const clock: Clock = { now: 1_000_000 }
		const queue = makeQueue('q-raw', clock)
		const id = await insertStoredJob('q-raw', clock, '{private')
		await queue.send({ runId: 'peer' })
		const jobs = await queue.claimRaw(CLAIM)
		expect(jobs).toHaveLength(2)
		const invalid = jobs.find((job) => job.id === id)
		const valid = jobs.find((job) => job.id !== id)
		if (!invalid || !valid) throw new Error('missing claimed delivery')
		expect(invalid).toEqual({ id, payload: '{private', attempts: 1, maxAttempts: 2 })
		expect(() => decodeJob(invalid, decodeDeploy)).toThrow()
		expect(decodeJob(valid, decodeDeploy)).toEqual({ ...valid, payload: { runId: 'peer' } })
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
	test.each(['{private', '{"nope":"private"}'])('invalid delivery %s retries to its budget without losing valid peers', async (payload) => {
		const name = payload.startsWith('{"') ? 'c-shape' : 'c-json'
		const clock: Clock = { now: 1_000_000 }
		const queue = makeQueue(name, clock)
		const id = await insertStoredJob(name, clock, payload)
		await queue.send({ runId: 'peer' })
		const handled: string[] = []
		const errors: Job<DeployMessage>[] = []
		const abandoned: Job<DeployMessage>[] = []
		const delays: number[] = []
		const warning = spyOn(console, 'warn').mockImplementation(() => {})
		try {
			const consumer = new PostgresJobConsumer(queue, {
				decode: decodeDeploy,
				batchSize: 10,
				handler: async (job) => {
					handled.push(job.payload.runId)
				},
				retryDelayMs: (attempts) => {
					delays.push(attempts)
					return 1_000
				},
				onError: (_error, job) => {
					errors.push(job)
				},
				onAbandoned: (job) => {
					abandoned.push(job)
				},
			})
			expect(await consumer.poll()).toBe(2)
			expect(handled).toEqual(['peer'])
			expect(warning).not.toHaveBeenCalled()
			expect(delays).toEqual([1])
			clock.now += 999
			expect(await consumer.poll()).toBe(0)
			clock.now++
			expect(await consumer.poll()).toBe(1)
			expect(warning).toHaveBeenCalledWith('undecodable job abandoned', { id, attempts: 2, maxAttempts: 2 })
			expect(errors).toEqual([])
			expect(abandoned).toEqual([])
			expect(await db.prepare('SELECT id FROM jobs WHERE queue = ?').bind(name).all()).toEqual({ results: [] })
			clock.now += 3_600_000
			expect(await consumer.poll()).toBe(0)
		} finally {
			warning.mockRestore()
		}
	})

	test('invalid delivery already beyond budget is deleted without typed callbacks', async () => {
		const clock: Clock = { now: 1_000_000 }
		const queue = makeQueue('c-overbudget', clock)
		const id = await insertStoredJob('c-overbudget', clock, '{}', 7, 2)
		const warning = spyOn(console, 'warn').mockImplementation(() => {})
		const callbacks: string[] = []
		try {
			const consumer = new PostgresJobConsumer(queue, {
				decode: decodeDeploy,
				handler: async () => {
					callbacks.push('handler')
				},
				onError: () => {
					callbacks.push('error')
				},
				onAbandoned: () => {
					callbacks.push('abandoned')
				},
			})
			expect(await consumer.poll()).toBe(1)
			expect(callbacks).toEqual([])
			expect(warning).toHaveBeenCalledWith('undecodable job abandoned', { id, attempts: 8, maxAttempts: 2 })
			clock.now += 3_600_000
			expect(await consumer.poll()).toBe(0)
		} finally {
			warning.mockRestore()
		}
	})

	test.each(['ack', 'defer'])('failed invalid %s settlement leaves visibility retry and processes peers', async (settlement) => {
		const name = `c-failed-${settlement}`
		const clock: Clock = { now: 1_000_000 }
		const id = await insertStoredJob(name, clock, '{private', settlement === 'ack' ? 2 : 0, 2)
		class FailingSettlementQueue extends PostgresJobQueue<DeployMessage> {
			fail = true
			override async ack(jobId: string): Promise<void> {
				if (this.fail && jobId === id && settlement === 'ack') throw new Error('private settlement error')
				await super.ack(jobId)
			}
			override async defer(jobId: string, delayMs: number): Promise<void> {
				if (this.fail && jobId === id && settlement === 'defer') throw new Error('private settlement error')
				await super.defer(jobId, delayMs)
			}
		}
		const queue = new FailingSettlementQueue(db, { queue: name, now: () => clock.now })
		await queue.send({ runId: 'peer' })
		const handled: string[] = []
		const warning = spyOn(console, 'warn').mockImplementation(() => {})
		const errorLog = spyOn(console, 'error').mockImplementation(() => {})
		try {
			const consumer = new PostgresJobConsumer(queue, {
				decode: decodeDeploy,
				batchSize: 10,
				visibilityTimeoutMs: 30_000,
				handler: async (job) => {
					handled.push(job.payload.runId)
				},
			})
			expect(await consumer.poll()).toBe(2)
			expect(handled).toEqual(['peer'])
			expect(errorLog).toHaveBeenCalledTimes(1)
			expect(errorLog).toHaveBeenCalledWith('job settlement failed')
			expect(warning).not.toHaveBeenCalled()
			queue.fail = false
			clock.now += 29_999
			expect(await consumer.poll()).toBe(0)
			clock.now++
			expect(await consumer.poll()).toBe(1)
			expect(warning).toHaveBeenCalledTimes(1)
			clock.now += 30_000
			expect(await consumer.poll()).toBe(0)
		} finally {
			warning.mockRestore()
			errorLog.mockRestore()
		}
	})

	test('successful exhausted handler with a failed ack retries on visibility without blocking its peer or calling failure callbacks', async () => {
		const clock: Clock = { now: 1_000_000 }
		class FailOnceQueue extends PostgresJobQueue<DeployMessage> {
			failedId: string | null = null
			override async ack(id: string): Promise<void> {
				if (this.failedId === null) {
					this.failedId = id
					throw new Error('private ack failure')
				}
				await super.ack(id)
			}
		}
		const queue = new FailOnceQueue(db, { queue: 'c-success-ack-failure', maxAttempts: 1, now: () => clock.now })
		await queue.send({ runId: 'first' })
		await queue.send({ runId: 'peer' })
		const handled: { runId: string; attempts: number }[] = []
		const callbacks: string[] = []
		const errorLog = spyOn(console, 'error').mockImplementation(() => {})
		try {
			const consumer = new PostgresJobConsumer(queue, {
				decode: decodeDeploy,
				batchSize: 10,
				visibilityTimeoutMs: 30_000,
				handler: async (job) => {
					handled.push({ runId: job.payload.runId, attempts: job.attempts })
				},
				onError: () => {
					callbacks.push('error')
				},
				onAbandoned: () => {
					callbacks.push('abandoned')
				},
				retryDelayMs: () => {
					callbacks.push('backoff')
					return 1_000
				},
			})
			expect(await consumer.poll()).toBe(2)
			expect(handled).toEqual([{ runId: 'first', attempts: 1 }, { runId: 'peer', attempts: 1 }])
			expect((await db.prepare('SELECT id, attempts FROM jobs WHERE queue = ?').bind('c-success-ack-failure').all()).results)
				.toEqual([{ id: queue.failedId, attempts: 1 }])
			expect(errorLog).toHaveBeenCalledTimes(1)
			expect(errorLog).toHaveBeenCalledWith('job settlement failed')
			clock.now += 29_999
			expect(await consumer.poll()).toBe(0)
			clock.now++
			expect(await consumer.poll()).toBe(1)
			expect(handled).toEqual([{ runId: 'first', attempts: 1 }, { runId: 'peer', attempts: 1 }, { runId: 'first', attempts: 2 }])
			expect(callbacks).toEqual([])
			expect(errorLog).toHaveBeenCalledTimes(1)
			clock.now += 30_000
			expect(await consumer.poll()).toBe(0)
		} finally {
			errorLog.mockRestore()
		}
	})

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
