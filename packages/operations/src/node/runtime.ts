import { HttpIamRpc } from '@fabrika/auth'
import { PostgresDatabase, S3BlobStore } from '@fabrika/platform-node'
import { z } from 'zod'
import { OperationsAlertProducer } from '../alerts.js'
import { createOperationsIam } from '../auth.js'
import { PostgresHealthRepository } from '../health-repository.js'
import { OperationsHealthExecution } from '../health-service.js'
import type { OperationsHttpEnv } from '../http.js'
import { OperationsMaintenance, WebhookNotificationSender } from '../maintenance.js'
import { createPostgresOperationsRepositories } from '../repositories.js'
import { StoredOperationsTelemetryAdapter } from '../telemetry.js'
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
			telemetry: new StoredOperationsTelemetryAdapter(db),
			logger: { warn: (message, fields) => console.warn(message, fields) },
		}),
		maintenance: new OperationsMaintenance(repositories.alerts, new WebhookNotificationSender(), {
			alertProducer: new OperationsAlertProducer(repositories.alerts, repositories.ingest),
		}),
		async shutdown(): Promise<void> {
			await db.close()
		},
	}
}

function operationsIam(source: Record<string, string | undefined>) {
	// One path everywhere: the process verifies IAM-issued tokens and has no local mode to fall back on.
	const config = resolveOperationsIamProcessConfig(source)
	return createOperationsIam({
		IAM: new HttpIamRpc({
			origin: config.rpcOrigin,
			key: config.rpcKey,
		}),
		FABRIKA_IAM_ISSUER: config.issuer,
	})
}

export interface OperationsIamProcessConfig {
	issuer: string
	rpcOrigin: string
	rpcKey: string
}

/** Resolve public IAM identity separately from its private management transport. */
export function resolveOperationsIamProcessConfig(source: Record<string, string | undefined>): OperationsIamProcessConfig {
	return {
		issuer: required(source, 'FABRIKA_IAM_ISSUER'),
		rpcOrigin: required(source, 'FABRIKA_IAM_RPC_URL'),
		rpcKey: requiredSecret(source, 'FABRIKA_IAM_RPC_KEY'),
	}
}

function required(source: Record<string, string | undefined>, name: string): string {
	const result = requiredEnvironmentValue.safeParse(source[name])
	if (!result.success) throw new Error(`${name} is required`)
	return result.data
}

function requiredSecret(source: Record<string, string | undefined>, name: string): string {
	const value = required(source, name)
	const result = secretEnvironmentValue.safeParse(value)
	if (!result.success) throw new Error(`${name} must be at least 32 characters`)
	return result.data
}

const requiredEnvironmentValue = z.string().refine((value) => value.trim() !== '')
const secretEnvironmentValue = requiredEnvironmentValue.pipe(z.string().min(32))
const portSchema = z.string().optional().transform((value) => value === undefined || value === '' ? 3000 : Number(value))
	.pipe(z.number().int().min(1).max(65_535))

function optional(source: Record<string, string | undefined>, name: string): string | undefined {
	const value = source[name]
	return value === undefined || value.trim() === '' ? undefined : value
}

function parsePort(value: string | undefined): number {
	const result = portSchema.safeParse(value)
	if (!result.success) throw new Error('PORT must be an integer between 1 and 65535')
	return result.data
}
