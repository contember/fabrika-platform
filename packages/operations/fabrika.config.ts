import type { AppGates } from '@fabrika/auth-core'
import { OPERATIONS_RELEASE_RECONCILE_PATH, OPERATIONS_SOURCE_MAP_UPLOAD_PATH } from '@fabrika/operations-contract'
import { environmentAliases } from '@fabrika/platform'
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
import { OPERATOR_GATES } from './src/app'

const OPERATIONS_PROXY_GATES: AppGates = {
	rules: [
		{ path: '/healthz', kind: 'public' },
		{ path: '/api/*/envelope/', kind: 'public' },
		{ path: OPERATIONS_SOURCE_MAP_UPLOAD_PATH, kind: 'public' },
		{ path: '/private/catalog/reconcile', kind: 'service' },
		{ path: OPERATIONS_RELEASE_RECONCILE_PATH, kind: 'service' },
		...OPERATOR_GATES.rules,
	],
}

export const buildOperationsWorker = (ctx: ResourceContext): Worker => {
	const isLocal = ctx.env === 'local'
	const publicHost = ctx.domain ?? ''
	const deadLetterQueue = `${ctx.env}-operations-ingest-dlq`
	const iamUrl = environmentAliases.read(
		{
			FABRIKA_IAM_URL: process.env['FABRIKA_IAM_URL'],
			PROPUSTKA_URL: process.env['PROPUSTKA_URL'],
		},
		{ canonical: 'FABRIKA_IAM_URL', legacy: 'PROPUSTKA_URL' },
	) ?? ''
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
			DEV: isLocal ? 'true' : '',
			FABRIKA_IAM_URL: iamUrl,
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

export const buildOperationsProxy = (ctx: ResourceContext): Worker => {
	const publicHost = ctx.domain ?? ''
	const iamUrl = environmentAliases.read(
		{
			FABRIKA_IAM_URL: process.env['FABRIKA_IAM_URL'],
			PROPUSTKA_URL: process.env['PROPUSTKA_URL'],
		},
		{ canonical: 'FABRIKA_IAM_URL', legacy: 'PROPUSTKA_URL' },
	) ?? ''
	return createCloudflareProxyWorker({
		name: 'operations-proxy',
		app: buildOperationsWorker(ctx),
		appId: 'vozka',
		appHost: publicHost === '' ? 'localhost' : publicHost,
		domain: ctx.domain,
		gates: OPERATIONS_PROXY_GATES,
		iamUrl,
	})
}

export default defineApp({
	id: 'operations',
	resources: buildOperationsProxy,
	pipeline: {
		workerDir: '.',
		secrets: ['OPERATIONS_SYNC_KEY'],
	},
})
