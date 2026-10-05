import type { IngestMessage } from '@fabrika/operations-contract'
import type { SqlDatabase } from '@fabrika/platform'
import { decodeJob, type Job, PostgresJobQueue } from '@fabrika/platform-node'
import { z } from 'zod'
import { OperationsAlertProducer } from '../alerts.js'
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
	/** Built-in queues expose raw deliveries; decoded-only external adapters remain supported. */
	claimRaw?(options: { limit: number; visibilityTimeoutMs: number }): Promise<Job<string>[]>
	ack(id: string): Promise<void>
	defer(id: string, delayMs: number): Promise<void>
}

const ingestMessageSchema = z.object({
	projectId: z.string(),
	fingerprint: z.string(),
	eventId: z.string(),
	title: z.string(),
	culprit: z.string().nullable(),
	level: z.string(),
	receivedAt: z.number(),
	// The event is opaque here: preserve extension keys instead of cloning through an object schema.
	payload: z.unknown().refine((value): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)),
	release: z.string().optional().catch(undefined),
	environment: z.string().optional().catch(undefined),
}).transform(({ release, environment, ...message }) => ({
	...message,
	...(release === undefined ? {} : { release }),
	...(environment === undefined ? {} : { environment }),
}))

function decodeIngestMessage(payload: unknown): IngestMessage {
	const result = ingestMessageSchema.safeParse(payload)
	if (!result.success) throw new Error(result.error.issues[0]?.path.length === 0 ? 'ingest job is not an object' : 'ingest job has an invalid shape')
	return result.data
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
		if (this.queue.claimRaw) {
			const jobs = await this.queue.claimRaw({ limit: this.batchSize, visibilityTimeoutMs: this.visibilityTimeoutMs })
			for (const job of jobs) {
				try {
					await this.handleRaw(job)
				} catch {
					this.log('operations ingest settlement failed')
				}
			}
			return jobs.length
		}
		const jobs = await this.queue.claim({
			limit: this.batchSize,
			visibilityTimeoutMs: this.visibilityTimeoutMs,
			decode: decodeIngestMessage,
		})
		for (const job of jobs) {
			try {
				await this.handle(job)
			} catch {
				this.log('operations ingest settlement failed')
			}
		}
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

	private async handleRaw(raw: Job<string>): Promise<void> {
		let job: Job<IngestMessage>
		try {
			job = decodeJob(raw, decodeIngestMessage)
		} catch {
			if (raw.attempts >= raw.maxAttempts) {
				await this.queue.ack(raw.id)
				this.log(
					`operations undecodable ingest job abandoned id=${JSON.stringify(raw.id)} attempts=${raw.attempts} maxAttempts=${raw.maxAttempts}`,
				)
			} else {
				await this.queue.defer(raw.id, this.retryDelayMs(raw.attempts))
			}
			return
		}
		await this.handle(job)
	}

	private async handle(job: Job<IngestMessage>): Promise<void> {
		try {
			const result = await persistIngest(this.env, job.payload)
			await new OperationsAlertProducer(this.env.repositories.alerts, this.env.repositories.ingest).produceIngest([job.payload], [result])
		} catch {
			if (job.attempts >= job.maxAttempts) {
				try {
					await archiveDeadEvent(this.env, job.payload, {
						attempts: job.attempts,
						reason: 'retry_exhausted',
					})
					await this.queue.ack(job.id)
				} catch {
					this.log('operations ingest dead-event settlement failed')
					await this.queue.defer(job.id, this.retryDelayMs(job.attempts))
				}
				return
			}
			await this.queue.defer(job.id, this.retryDelayMs(job.attempts))
			return
		}
		await this.queue.ack(job.id)
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
