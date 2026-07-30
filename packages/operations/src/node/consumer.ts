import type { IngestMessage } from '@fabrika/operations-contract'
import { type Job, PostgresJobQueue } from '@fabrika/platform-node'
import type { OperationsDataEnv } from '../pipeline.js'
import { archiveDeadEvent, persistIngest } from '../pipeline.js'

export interface PostgresOperationsConsumerOptions {
	batchSize?: number
	visibilityTimeoutMs?: number
	retryDelayMs?: (attempts: number) => number
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
	private readonly visibilityTimeoutMs: number
	private readonly retryDelayMs: (attempts: number) => number

	constructor(
		private readonly queue: PostgresJobQueue<IngestMessage>,
		private readonly env: OperationsDataEnv,
		options: PostgresOperationsConsumerOptions = {},
	) {
		this.batchSize = options.batchSize ?? 100
		this.visibilityTimeoutMs = options.visibilityTimeoutMs ?? 60_000
		this.retryDelayMs = options.retryDelayMs ?? (() => 30_000)
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
