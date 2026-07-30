import type { IngestMessage } from '@fabrika/operations-contract'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { consumeDeadDeliveries, consumeDeliveries } from './consumer.js'
import { createOperationsFetchHandler, type OperationsHttpEnv } from './http.js'
import { OperationsMaintenance, WebhookNotificationSender } from './maintenance.js'
import { cloudflareBlobStore, cloudflareJobQueue } from './platform-cf.js'
import { createSqliteOperationsRepositories } from './repositories.js'

interface OperationsWorkerBindings {
	DB: D1Database
	PAYLOADS: R2Bucket
	INGEST_QUEUE: Queue<IngestMessage>
	INGEST_DLQ: Queue<IngestMessage>
	OPERATIONS_PUBLIC_HOST: string
	OPERATIONS_SYNC_KEY: string
	ENVIRONMENT: string
}

export class OperationsWorker extends WorkerEntrypoint<OperationsWorkerBindings> {
	private get operations(): OperationsHttpEnv {
		return {
			repositories: createSqliteOperationsRepositories(this.env.DB),
			payloads: cloudflareBlobStore(this.env.PAYLOADS),
			ingestQueue: cloudflareJobQueue(this.env.INGEST_QUEUE),
			publicHost: this.env.OPERATIONS_PUBLIC_HOST,
			syncKey: this.env.OPERATIONS_SYNC_KEY,
		}
	}

	override fetch(request: Request): Promise<Response> {
		return createOperationsFetchHandler(this.operations)(request)
	}

	override async queue(batch: MessageBatch<IngestMessage>): Promise<void> {
		const deliveries = batch.messages.map((message) => ({
			body: message.body,
			attempts: message.attempts,
			ack: () => message.ack(),
			retry: () => message.retry(),
		}))
		if (batch.queue.endsWith('operations-ingest-dlq')) {
			await consumeDeadDeliveries(this.operations, deliveries)
			return
		}
		await consumeDeliveries(this.operations, deliveries)
	}

	override async scheduled(): Promise<void> {
		const env = this.operations
		await new OperationsMaintenance(env.repositories.alerts, new WebhookNotificationSender()).run()
	}
}

export default OperationsWorker
