import { HttpIamRpc } from '@fabrika/auth'
import { PostgresDatabase, S3BlobStore } from '@fabrika/platform-node'
import { createOperationsIam } from '../auth.js'
import { PostgresHealthRepository } from '../health-repository.js'
import { OperationsHealthExecution } from '../health-service.js'
import type { OperationsHttpEnv } from '../http.js'
import { OperationsMaintenance, WebhookNotificationSender } from '../maintenance.js'
import { createPostgresOperationsRepositories } from '../repositories.js'
import { bunPipelineTelemetry, StoredOperationsTelemetryAdapter } from '../telemetry.js'
import { createOperationsIngestQueue, PostgresOperationsConsumer } from './consumer.js'

export interface OperationsRuntime {
	env: OperationsHttpEnv
	port: number
	consumer: PostgresOperationsConsumer
	health: OperationsHealthExecution
	maintenance: OperationsMaintenance
	shutdown(): Promise<void>
}

export function createOperationsRuntime(source: Record<string, string | undefined> = process.env): OperationsRuntime {
	const db = PostgresDatabase.connect(required(source, 'FABRIKA_OPERATIONS_DATABASE_URL'))
	const repositories = createPostgresOperationsRepositories(db)
	const healthRepository = new PostgresHealthRepository(db)
	const ingestQueue = createOperationsIngestQueue(db)
	const payloads = S3BlobStore.connect({
		bucket: required(source, 'FABRIKA_OPERATIONS_BLOB_BUCKET'),
		accessKeyId: required(source, 'FABRIKA_OPERATIONS_BLOB_ACCESS_KEY_ID'),
		secretAccessKey: required(source, 'FABRIKA_OPERATIONS_BLOB_SECRET_ACCESS_KEY'),
		region: source['FABRIKA_OPERATIONS_BLOB_REGION'] ?? 'auto',
		virtualHostedStyle: false,
		...(optional(source, 'FABRIKA_OPERATIONS_BLOB_ENDPOINT') === undefined
			? {}
			: { endpoint: optional(source, 'FABRIKA_OPERATIONS_BLOB_ENDPOINT') }),
	})
	const env: OperationsHttpEnv = {
		repositories,
		ingestQueue,
		payloads,
		publicHost: source['FABRIKA_OPERATIONS_PUBLIC_HOST'] ?? '',
		syncKey: requiredSecret(source, 'OPERATIONS_SYNC_KEY'),
		health: healthRepository,
		iam: operationsIam(source),
	}
	return {
		env,
		port: parsePort(source['PORT']),
		consumer: new PostgresOperationsConsumer(ingestQueue, env, {
			log: (message) => console.warn(message),
		}),
		health: new OperationsHealthExecution(healthRepository, {
			telemetry: new StoredOperationsTelemetryAdapter(db, bunPipelineTelemetry()),
			logger: { warn: (message, fields) => console.warn(message, fields) },
		}),
		maintenance: new OperationsMaintenance(repositories.alerts, new WebhookNotificationSender()),
		async shutdown(): Promise<void> {
			await db.close()
		},
	}
}

function operationsIam(source: Record<string, string | undefined>) {
	const dev = source['DEV'] ?? ''
	const options = { publicHost: source['FABRIKA_OPERATIONS_PUBLIC_HOST'] }
	if (dev !== '') return createOperationsIam({ DEV: dev }, options)
	return createOperationsIam(
		{
			IAM: new HttpIamRpc({
				origin: required(source, 'FABRIKA_IAM_URL'),
				key: requiredSecret(source, 'PROPUSTKA_RPC_KEY'),
			}),
			PROPUSTKA_URL: required(source, 'PROPUSTKA_URL'),
		},
		options,
	)
}

function required(source: Record<string, string | undefined>, name: string): string {
	const value = optional(source, name)
	if (value === undefined) throw new Error(`${name} is required`)
	return value
}

function requiredSecret(source: Record<string, string | undefined>, name: string): string {
	const value = required(source, name)
	if (value.length < 32) throw new Error(`${name} must be at least 32 characters`)
	return value
}

function optional(source: Record<string, string | undefined>, name: string): string | undefined {
	const value = source[name]
	return value === undefined || value.trim() === '' ? undefined : value
}

function parsePort(value: string | undefined): number {
	if (value === undefined || value === '') return 3000
	const port = Number(value)
	if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be an integer between 1 and 65535')
	return port
}
