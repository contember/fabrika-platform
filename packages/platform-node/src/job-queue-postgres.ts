// `JobQueue` as a Postgres table plus `SELECT … FOR UPDATE SKIP LOCKED`, and the in-process consumer
// the port deliberately does not model.
//
// WHY THE CONSUMER IS NOT IN THE PORT. On Workers the consumer side is not an API at all — it is an
// inversion of control: the platform delivers a batch to an exported `queue()` handler, with the
// platform owning retries, batching, concurrency and the ack protocol. There is nothing for fabrika to
// call and nothing for it to start or stop. In a long-running process fabrika owns the loop, the
// visibility timeout and the retry policy. Those two shapes have no honest common supertype: putting
// a `poll()`/`start()` on the port would force the Cloudflare implementation to expose a loop it can
// never run, and putting a `queue(batch)` on it would force this side to fake a delivery it never
// receives. `send()` — the only operation both sides genuinely share — is the whole port, and the
// consumer is a concrete class here (see ../../../docs/reference/portability-surface.md: "the reason
// Workers need a queue does not apply" once there is a process to poll with).
//
// The claim is a SINGLE statement — an `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)
// RETURNING …` — so it runs through the `SqlDatabase` port with no explicit transaction: Postgres
// evaluates the sub-select's row locks and the update atomically. `SKIP LOCKED` is what lets N
// consumers drain one queue without blocking each other or handing the same job to two of them.
//
// Visibility, not locking, is the delivery model (same as SQS and Cloudflare Queues): claiming a job
// pushes `visible_at` into the future and bumps `attempts`. Finish it → `ack()` deletes the row.
// Crash → the timeout lapses and the job is claimable again. That is the ONLY reason a consumer that
// dies mid-job does not strand it, so `visibilityTimeoutMs` must exceed the slowest handler.
//
// `FOR UPDATE SKIP LOCKED` is the one Postgres-specific statement in this package; the DDL itself
// (migrations/0001_jobs.sql) is in the SQLite ∩ Postgres common subset.

import type { JobQueue, SqlDatabase } from '@fabrika/platform'
import { uuidv7 } from './uuid'

/** A claimed job, as handed to a handler. `payload` has been through the caller's `decode`. */
export interface Job<T> {
	id: string
	payload: T
	/** How many times this job has been claimed, including now. First delivery is 1. */
	attempts: number
	/** Claims allowed before the job is abandoned. */
	maxAttempts: number
}

export interface PostgresJobQueueOptions {
	/** Table holding the jobs. Must already exist; see migrations/0001_jobs.sql. */
	table?: string
	/** Queue name, so several queues can share one table. */
	queue?: string
	/** Claims allowed per job before it is abandoned. */
	maxAttempts?: number
	/** Injectable clock (unix millis) so delays and timeouts are testable without sleeping. */
	now?: () => number
}

const DEFAULT_TABLE = 'jobs'
const DEFAULT_QUEUE = 'default'
const DEFAULT_MAX_ATTEMPTS = 5
/** A table name is interpolated into SQL, so it is restricted to a bare unqualified identifier. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The claim statement's projection. snake_case, mirroring the migration. */
interface ClaimedRow {
	id: string
	payload: string
	attempts: number
	max_attempts: number
}

/**
 * Producer + claim/ack primitives over one jobs table. Implements the `JobQueue` port (`send`); the
 * rest is the consumer-side surface `PostgresJobConsumer` is built from and tests drive directly.
 */
export class PostgresJobQueue<T> implements JobQueue<T> {
	private readonly queue: string
	private readonly maxAttempts: number
	private readonly now: () => number
	private readonly sendSql: string
	private readonly claimSql: string
	private readonly ackSql: string
	private readonly deferSql: string

	constructor(private readonly db: SqlDatabase, options: PostgresJobQueueOptions = {}) {
		const table = options.table ?? DEFAULT_TABLE
		if (!IDENTIFIER.test(table)) {
			throw new Error(`invalid jobs table name: ${table}`)
		}
		this.queue = options.queue ?? DEFAULT_QUEUE
		this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
		this.now = options.now ?? Date.now

		this.sendSql = `INSERT INTO ${table} (id, queue, payload, visible_at, attempts, max_attempts, created_at)
			VALUES (?, ?, ?, ?, 0, ?, ?)`
		// One statement: the sub-select takes row locks (skipping rows another consumer already holds)
		// and the UPDATE hides + counts them, so a claim can never be split across two consumers.
		this.claimSql = `UPDATE ${table} SET visible_at = ?, attempts = attempts + 1
			WHERE id IN (
				SELECT id FROM ${table}
				WHERE queue = ? AND visible_at <= ?
				ORDER BY visible_at, id
				LIMIT ?
				FOR UPDATE SKIP LOCKED
			)
			RETURNING id, payload, attempts, max_attempts`
		this.ackSql = `DELETE FROM ${table} WHERE id = ?`
		this.deferSql = `UPDATE ${table} SET visible_at = ? WHERE id = ?`
	}

	/** Enqueue a message. `delaySeconds` becomes a visible-after deadline, exactly as on Cloudflare Queues. */
	async send(message: T, options: { delaySeconds?: number } = {}): Promise<void> {
		const now = this.now()
		const visibleAt = now + Math.max(0, options.delaySeconds ?? 0) * 1000
		await this.db
			.prepare(this.sendSql)
			// The id is minted on the queue's own clock, so id order and enqueue order agree — which is
			// what `claim()` sorts a batch by. The generator is monotonic (RFC 9562 §6.2 counter), so
			// two sends inside one millisecond still order by which was sent first.
			.bind(uuidv7(now), this.queue, JSON.stringify(message), visibleAt, this.maxAttempts, now)
			.run()
	}

	/**
	 * Take up to `limit` due jobs and hide them for `visibilityTimeoutMs`. `decode` narrows the stored
	 * JSON at the deserialization boundary — a row this consumer cannot understand throws here rather
	 * than reaching a handler that assumes a shape.
	 */
	async claim(options: { limit: number; visibilityTimeoutMs: number; decode: (payload: unknown) => T }): Promise<Job<T>[]> {
		const now = this.now()
		const { results } = await this.db
			.prepare(this.claimSql)
			.bind(now + options.visibilityTimeoutMs, this.queue, now, options.limit)
			.all<ClaimedRow>()
		// Postgres does NOT promise that `RETURNING` follows the sub-select's `ORDER BY` — that clause
		// only decides WHICH rows the LIMIT takes, not the order they come back in. Sorting by id here
		// restores enqueue order, because ids are monotonic UUIDv7 and therefore strictly time-ordered.
		return results
			.sort((left, right) => (left.id < right.id ? -1 : 1))
			.map((row) => {
				const parsed: unknown = JSON.parse(row.payload)
				return { id: row.id, payload: options.decode(parsed), attempts: row.attempts, maxAttempts: row.max_attempts }
			})
	}

	/** The job is done (or permanently abandoned) — drop the row. Idempotent. */
	async ack(id: string): Promise<void> {
		await this.db.prepare(this.ackSql).bind(id).run()
	}

	/** Make the job claimable again after `delayMs`. Used for retries and for a deferred (locked-out) run. */
	async defer(id: string, delayMs: number): Promise<void> {
		await this.db.prepare(this.deferSql).bind(this.now() + delayMs, id).run()
	}
}

export interface PostgresJobConsumerOptions<T> {
	/** Narrow the stored JSON to the message type. Throwing here abandons the job as undecodable. */
	decode: (payload: unknown) => T
	/** Handle one job. A throw schedules a retry until `maxAttempts` is spent. */
	handler: (job: Job<T>) => Promise<void>
	/** Jobs claimed per pass. Handlers still run one at a time. */
	batchSize?: number
	/** Sleep between passes that found nothing. A pass that found work polls again immediately. */
	pollIntervalMs?: number
	/** How long a claimed job stays hidden. MUST exceed the slowest handler, or the job is redelivered mid-flight. */
	visibilityTimeoutMs?: number
	/** Backoff before the next attempt, from the attempt count just consumed. */
	retryDelayMs?: (attempts: number) => number
	/** A handler threw and the job will be retried. Never log the error object (it may carry a token). */
	onError?: (error: unknown, job: Job<T>) => void
	/** A job spent its last attempt and was dropped. */
	onAbandoned?: (job: Job<T>) => void
}

const DEFAULT_BATCH_SIZE = 1
const DEFAULT_POLL_INTERVAL_MS = 1_000
const DEFAULT_VISIBILITY_TIMEOUT_MS = 15 * 60 * 1_000

/**
 * The in-process poller. One pass = claim a batch, run the handlers in order, ack or reschedule each.
 * Handlers run SEQUENTIALLY: a deploy consumer is one run per message and ordering per queue is the
 * cheapest correct default; raise `batchSize` only for genuinely independent work.
 *
 * `start()` is fire-and-forget and never throws; `stop()` waits for the pass in flight, so a shutdown
 * does not orphan a job it has already made invisible.
 */
export class PostgresJobConsumer<T> {
	private readonly options: Required<Omit<PostgresJobConsumerOptions<T>, 'onError' | 'onAbandoned'>>
	private readonly onError: (error: unknown, job: Job<T>) => void
	private readonly onAbandoned: (job: Job<T>) => void
	private running = false
	private timer: ReturnType<typeof setTimeout> | null = null
	private pass: Promise<void> = Promise.resolve()

	constructor(private readonly queue: PostgresJobQueue<T>, options: PostgresJobConsumerOptions<T>) {
		this.options = {
			decode: options.decode,
			handler: options.handler,
			batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
			pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
			visibilityTimeoutMs: options.visibilityTimeoutMs ?? DEFAULT_VISIBILITY_TIMEOUT_MS,
			retryDelayMs: options.retryDelayMs ?? ((attempts) => Math.min(60_000, 1_000 * 2 ** attempts)),
		}
		this.onError = options.onError ?? ((error) => {
			console.error('job handler failed:', error instanceof Error ? error.message : 'unknown error')
		})
		this.onAbandoned = options.onAbandoned ?? ((job) => {
			console.warn(`job ${job.id} abandoned after ${job.attempts} attempt(s)`)
		})
	}

	/** Run one pass. Returns how many jobs were handled — 0 means the queue was empty. Exposed for tests. */
	async poll(): Promise<number> {
		const jobs = await this.queue.claim({
			limit: this.options.batchSize,
			visibilityTimeoutMs: this.options.visibilityTimeoutMs,
			decode: this.options.decode,
		})
		for (const job of jobs) {
			await this.handle(job)
		}
		return jobs.length
	}

	/** Start polling in the background. Idempotent. */
	start(): void {
		if (this.running) {
			return
		}
		this.running = true
		this.schedule(0)
	}

	/** Stop polling and wait for the pass in flight. Idempotent. */
	async stop(): Promise<void> {
		this.running = false
		if (this.timer !== null) {
			clearTimeout(this.timer)
			this.timer = null
		}
		await this.pass
	}

	private schedule(delayMs: number): void {
		this.timer = setTimeout(() => {
			this.timer = null
			// One pass at a time: the next is scheduled only once this one has settled, so a slow handler
			// can never have two passes claiming against the same visibility window.
			this.pass = this.runPass()
		}, delayMs)
	}

	private async runPass(): Promise<void> {
		let handled = 0
		try {
			handled = await this.poll()
		} catch (error) {
			// A claim failure is usually the database being unreachable — log short and back off.
			console.error('job poll failed:', error instanceof Error ? error.message : 'unknown error')
		}
		if (this.running) {
			this.schedule(handled > 0 ? 0 : this.options.pollIntervalMs)
		}
	}

	private async handle(job: Job<T>): Promise<void> {
		try {
			await this.options.handler(job)
			await this.queue.ack(job.id)
		} catch (error) {
			this.onError(error, job)
			if (job.attempts >= job.maxAttempts) {
				await this.queue.ack(job.id)
				this.onAbandoned(job)
				return
			}
			await this.queue.defer(job.id, this.options.retryDelayMs(job.attempts))
		}
	}
}
