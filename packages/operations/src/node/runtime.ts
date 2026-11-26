import { HttpIamRpc } from '@fabrika/auth'
import { parseStorageConnection, PostgresDatabase, S3BlobStore } from '@fabrika/platform-node'
import { z } from 'zod'
import { OperationsAlertProducer } from '../alerts.js'
import { createOperationsIam, OPERATIONS_OAUTH_RESOURCE_VARIABLE } from '../auth.js'
import { PostgresHealthRepository } from '../health-repository.js'
import { OperationsHealthExecution } from '../health-service.js'
import type { OperationsHttpEnv } from '../http.js'
import { OperationsMaintenance, WebhookNotificationSender } from '../maintenance.js'
import { createPostgresOperationsRepositories } from '../repositories.js'
import { OperationsSecurityAlertProducer } from '../security-alerts.js'
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
	// `parseStorageConnection` reads `_ADDRESSING` and `_CREDENTIALS` too: a container cloud's task signs with its own
	// short-lived credentials instead of a key pair.
	const blobs = parseStorageConnection(source, 'FABRIKA_OPERATIONS_BLOB', { defaultRegion: 'auto', endpoint: 'optional', environment: source })
	if (blobs === undefined) throw new Error('FABRIKA_OPERATIONS_BLOB_BUCKET is required')
	const payloads = S3BlobStore.open(blobs)
	const syncKey = requiredSecret(source, 'OPERATIONS_SYNC_KEY')
	const iamConfig = resolveOperationsIamProcessConfig(source)
	// One client per process: the SDK caches the JWKS per binding object, and the maintenance pass asks the same IAM.
	const iamRpc = new HttpIamRpc({ origin: iamConfig.rpcOrigin, key: iamConfig.rpcKey })
	const env: OperationsHttpEnv = {
		repositories,
		ingestQueue,
		payloads,
		publicHost: source['FABRIKA_OPERATIONS_PUBLIC_HOST'] ?? '',
		syncKey,
		health: healthRepository,
		iam: createOperationsIam({ IAM: iamRpc, FABRIKA_IAM_ISSUER: iamConfig.issuer }, iamConfig.oauthResource),
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
			securityAlerts: new OperationsSecurityAlertProducer(repositories.alerts, repositories.security, iamRpc),
		}),
		async shutdown(): Promise<void> {
			await db.close()
		},
	}
}

export interface OperationsIamProcessConfig {
	issuer: string
	rpcOrigin: string
	rpcKey: string
	/** The console's Operations RPC as an OAuth resource, when the installation serves OAuth. */
	oauthResource?: string
}

/** Resolve public IAM identity separately from its private management transport. */
export function resolveOperationsIamProcessConfig(source: Record<string, string | undefined>): OperationsIamProcessConfig {
	const oauthResource = optional(source, OPERATIONS_OAUTH_RESOURCE_VARIABLE)
	return {
		issuer: required(source, 'FABRIKA_IAM_ISSUER'),
		rpcOrigin: required(source, 'FABRIKA_IAM_RPC_URL'),
		rpcKey: requiredSecret(source, 'FABRIKA_IAM_RPC_KEY'),
		...(oauthResource === undefined ? {} : { oauthResource }),
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
