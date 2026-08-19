import { OPERATIONS_APP_ID } from '@fabrika/operations-contract'
import {
	createCloudflareProxyWorker,
	D1Database,
	defineApp,
	Queue,
	R2Bucket,
	type ResourceContext,
	ServiceReference,
	Worker,
} from '@fabrika/provider-cloudflare'
import { OPERATIONS_PROXY_GATES } from './src/gates'

/**
 * IAM's origin — the issuer both this Worker and the proxy in front of it verify tokens against.
 * Locally it falls back to `packages/iam`'s own `bun run dev` port, because there is no environment in
 * which the issuer is optional: `createIam` refuses to build without it.
 */
const LOCAL_IAM_URL = 'http://localhost:18191'

const resolveIamUrl = (isLocal: boolean): string => process.env['FABRIKA_IAM_ISSUER'] ?? (isLocal ? LOCAL_IAM_URL : '')

export const buildOperationsWorker = (ctx: ResourceContext): Worker => {
	const isLocal = ctx.env === 'local'
	const publicHost = ctx.domain ?? ''
	const deadLetterQueue = `${ctx.env}-operations-ingest-dlq`
	const iamUrl = resolveIamUrl(isLocal)
	return new Worker({
		dir: '.',
		name: 'operations',
		main: './src/worker.ts',
		compatibility_flags: ['nodejs_compat_v2'],
		compatibility_date: '2025-10-01',
		workers_dev: false,
		// Public routing belongs to the proxy Worker. Operations is reached through its APP service binding.
		routes: [],
		observability: { enabled: true },
		triggers: { crons: ['* * * * *'] },
		vars: {
			ENVIRONMENT: ctx.env,
			OPERATIONS_PUBLIC_HOST: publicHost,
			FABRIKA_IAM_ISSUER: iamUrl,
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
			// Bound in EVERY environment, local included: `src/auth.ts` verifies an IAM-issued token and
			// has no local mode, and the proxy Worker in front of this one binds the same service anyway.
			IAM: new ServiceReference('propustka-worker'),
		},
	})
}

export const buildOperationsProxy = (ctx: ResourceContext): Worker => {
	const publicHost = ctx.domain ?? ''
	const iamUrl = resolveIamUrl(ctx.env === 'local')
	return createCloudflareProxyWorker({
		name: 'operations-proxy',
		app: buildOperationsWorker(ctx),
		appId: OPERATIONS_APP_ID,
		appHost: publicHost === '' ? 'localhost' : publicHost,
		domain: ctx.domain,
		gates: OPERATIONS_PROXY_GATES,
		iamUrl,
	})
}

export default defineApp({
	id: OPERATIONS_APP_ID,
	resources: buildOperationsProxy,
	pipeline: {
		workerDir: '.',
		secrets: ['OPERATIONS_SYNC_KEY'],
	},
})
