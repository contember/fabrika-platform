import type { IngestMessage } from '@fabrika/operations-contract'
import type { SqlDatabase } from '@fabrika/platform'
import { type Job, PostgresJobQueue } from '@fabrika/platform-node'
import type { OperationsDataEnv } from '../pipeline.js'
import { archiveDeadEvent, persistIngest } from '../pipeline.js'

export interface PostgresOperationsConsumerOptions {
	batchSize?: number
	pollIntervalMs?: number
	visibilityTimeoutMs?: number
	retryDelayMs?: (attempts: number) => number
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>
	log?: (message: string) => void
}

export const OPERATIONS_INGEST_QUEUE = 'operations-ingest'
export const OPERATIONS_INGEST_MAX_ATTEMPTS = 6

export function createOperationsIngestQueue(
	db: SqlDatabase,
	options: { table?: string; now?: () => number } = {},
): PostgresJobQueue<IngestMessage> {
	return new PostgresJobQueue(db, {
		queue: OPERATIONS_INGEST_QUEUE,
		maxAttempts: OPERATIONS_INGEST_MAX_ATTEMPTS,
		...options,
	})
}

export interface OperationsIngestJobQueue {
	claim(options: { limit: number; visibilityTimeoutMs: number; decode: (payload: unknown) => IngestMessage }): Promise<Job<IngestMessage>[]>
	ack(id: string): Promise<void>
	defer(id: string, delayMs: number): Promise<void>
}

function decodeIngestMessage(payload: unknown): IngestMessage {
	if (!isRecord(payload)) throw new Error('ingest job is not an object')
	const sourceId = Reflect.get(payload, 'projectId')
	const fingerprint = Reflect.get(payload, 'fingerprint')
	const eventId = Reflect.get(payload, 'eventId')
	const title = Reflect.get(payload, 'title')
	const culprit = Reflect.get(payload, 'culprit')
	const level = Reflect.get(payload, 'level')
	const receivedAt = Reflect.get(payload, 'receivedAt')
	const body = Reflect.get(payload, 'payload')
	if (
		typeof sourceId !== 'string'
		|| typeof fingerprint !== 'string'
		|| typeof eventId !== 'string'
		|| typeof title !== 'string'
		|| (typeof culprit !== 'string' && culprit !== null)
		|| typeof level !== 'string'
		|| typeof receivedAt !== 'number'
		|| !isRecord(body)
	) {
		throw new Error('ingest job has an invalid shape')
	}
	const message: IngestMessage = {
		projectId: sourceId,
		fingerprint,
		eventId,
		title,
		culprit,
		level,
		receivedAt,
		payload: body,
	}
	const release = Reflect.get(payload, 'release')
	const environment = Reflect.get(payload, 'environment')
	if (typeof release === 'string') message.release = release
	if (typeof environment === 'string') message.environment = environment
	return message
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class PostgresOperationsConsumer {
	private readonly batchSize: number
	private readonly pollIntervalMs: number
	private readonly visibilityTimeoutMs: number
	private readonly retryDelayMs: (attempts: number) => number
	private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
	private readonly log: (message: string) => void
	private controller: AbortController | null = null
	private task: Promise<void> | null = null

	constructor(
		private readonly queue: OperationsIngestJobQueue,
		private readonly env: OperationsDataEnv,
		options: PostgresOperationsConsumerOptions = {},
	) {
		this.batchSize = options.batchSize ?? 100
		this.pollIntervalMs = options.pollIntervalMs ?? 1_000
		this.visibilityTimeoutMs = options.visibilityTimeoutMs ?? 60_000
		this.retryDelayMs = options.retryDelayMs ?? (() => 30_000)
		this.sleep = options.sleep ?? abortableSleep
		this.log = options.log ?? (() => {})
	}

	async poll(): Promise<number> {
		const jobs = await this.queue.claim({
			limit: this.batchSize,
			visibilityTimeoutMs: this.visibilityTimeoutMs,
			decode: decodeIngestMessage,
		})
		for (const job of jobs) await this.handle(job)
		return jobs.length
	}

	async run(signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			let handled = 0
			try {
				handled = await this.poll()
			} catch {
				this.log('operations ingest poll failed')
			}
			if (!signal.aborted && handled === 0) await this.sleep(this.pollIntervalMs, signal)
		}
	}

	start(): void {
		if (this.task) return
		this.controller = new AbortController()
		this.task = this.run(this.controller.signal)
			.catch(() => this.log('operations ingest loop failed'))
			.finally(() => {
				this.controller = null
				this.task = null
			})
	}

	async stop(): Promise<void> {
		this.controller?.abort()
		await this.task
	}

	private async handle(job: Job<IngestMessage>): Promise<void> {
		try {
			await persistIngest(this.env, job.payload)
			await this.queue.ack(job.id)
		} catch {
			if (job.attempts >= job.maxAttempts) {
				try {
					await archiveDeadEvent(this.env, job.payload, {
						attempts: job.attempts,
						reason: 'retry_exhausted',
					})
					await this.queue.ack(job.id)
				} catch {
					await this.queue.defer(job.id, this.retryDelayMs(job.attempts))
				}
				return
			}
			await this.queue.defer(job.id, this.retryDelayMs(job.attempts))
		}
	}
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve()
	return new Promise((resolve) => {
		const timer = setTimeout(done, ms)
		signal.addEventListener('abort', done, { once: true })
		function done(): void {
			clearTimeout(timer)
			signal.removeEventListener('abort', done)
			resolve()
		}
	})
}
