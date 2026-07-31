import type { IamRpc } from '@fabrika/auth'
import type { IngestMessage } from '@fabrika/operations-contract'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { operationsApp } from './app.js'
import { createOperationsIam } from './auth.js'
import { consumeDeadDeliveries, consumeDeliveries } from './consumer.js'
import { SqliteHealthRepository } from './health-repository.js'
import { OperationsHealthExecution } from './health-service.js'
import type { OperationsHttpEnv } from './http.js'
import { OperationsMaintenance, WebhookNotificationSender } from './maintenance.js'
import { cloudflareBlobStore, cloudflareJobQueue } from './platform-cf.js'
import { createSqliteOperationsRepositories } from './repositories.js'
import { cloudflarePipelineTelemetry, StoredOperationsTelemetryAdapter } from './telemetry.js'

interface OperationsWorkerBindings {
	DB: D1Database
	PAYLOADS: R2Bucket
	INGEST_QUEUE: Queue<IngestMessage>
	INGEST_DLQ: Queue<IngestMessage>
	OPERATIONS_PUBLIC_HOST: string
	OPERATIONS_SYNC_KEY: string
	ENVIRONMENT: string
	DEV: string
	PROPUSTKA_URL?: string
	IAM?: IamRpc
}

export class OperationsWorker extends WorkerEntrypoint<OperationsWorkerBindings> {
	private get operations(): OperationsHttpEnv {
		const health = new SqliteHealthRepository(this.env.DB)
		return {
			repositories: createSqliteOperationsRepositories(this.env.DB),
			payloads: cloudflareBlobStore(this.env.PAYLOADS),
			ingestQueue: cloudflareJobQueue(this.env.INGEST_QUEUE),
			publicHost: this.env.OPERATIONS_PUBLIC_HOST,
			syncKey: this.env.OPERATIONS_SYNC_KEY,
			health,
			iam: createOperationsIam(this.env, { publicHost: this.env.OPERATIONS_PUBLIC_HOST }),
		}
	}

	override fetch(request: Request): Promise<Response> {
		return operationsApp.fetch(request, this.operations, this.ctx)
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
		await new OperationsHealthExecution(new SqliteHealthRepository(this.env.DB), {
			telemetry: new StoredOperationsTelemetryAdapter(this.env.DB, cloudflarePipelineTelemetry()),
			logger: { warn: (message, fields) => console.warn(message, fields) },
		}).run()
		await new OperationsMaintenance(env.repositories.alerts, new WebhookNotificationSender()).run()
	}
}

export default OperationsWorker
