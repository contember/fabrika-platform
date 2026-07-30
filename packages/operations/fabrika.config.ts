import { D1Database, defineApp, Queue, R2Bucket, type ResourceContext, ServiceReference, Worker } from '@fabrika/provider-cloudflare'

export const buildOperationsWorker = (ctx: ResourceContext): Worker => {
	const isLocal = ctx.env === 'local'
	const publicHost = ctx.domain ?? ''
	const deadLetterQueue = `${ctx.env}-operations-ingest-dlq`
	return new Worker({
		dir: '.',
		name: 'operations',
		main: './src/worker.ts',
		compatibility_flags: ['nodejs_compat_v2'],
		compatibility_date: '2025-10-01',
		routes: publicHost === '' ? [] : [{ pattern: publicHost, custom_domain: true }],
		observability: { enabled: true },
		triggers: { crons: ['*/5 * * * *'] },
		vars: {
			ENVIRONMENT: ctx.env,
			OPERATIONS_PUBLIC_HOST: publicHost,
			DEV: isLocal ? 'true' : '',
			PROPUSTKA_URL: process.env['PROPUSTKA_URL'] ?? '',
		},
		bindings: {
			DB: new D1Database({ name: 'operations', migrationsDir: './migrations', locationHint: 'weur' }),
			PAYLOADS: new R2Bucket({ name: 'operations-payloads' }),
			INGEST_QUEUE: new Queue({
				name: 'operations-ingest',
				binding: 'both',
				consumer: {
					maxBatchSize: 50,
					maxBatchTimeout: 5,
					maxRetries: 5,
					deadLetterQueue,
					retryDelay: 30,
				},
			}),
			INGEST_DLQ: new Queue({
				name: 'operations-ingest-dlq',
				binding: 'consumer',
				consumer: { maxBatchSize: 50, maxBatchTimeout: 5, maxRetries: 10 },
			}),
			...(isLocal ? {} : {
				IAM: new ServiceReference('propustka-worker'),
			}),
		},
	})
}

export default defineApp({
	id: 'operations',
	resources: buildOperationsWorker,
	pipeline: {
		workerDir: '.',
		secrets: ['OPERATIONS_SYNC_KEY'],
	},
})
