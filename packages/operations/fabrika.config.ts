import { CONTROL_OPERATIONS_RPC_PATH } from '@fabrika/control-contract'
import { OPERATIONS_APP_ID } from '@fabrika/operations-contract'
import {
	createCloudflareProxyWorker,
	D1Database,
	defineApp,
	NO_IMPORTABLE_ENV_FLAG,
	NO_PROCESS_ENV_FLAG,
	platformNames,
	Queue,
	R2Bucket,
	type ResourceContext,
	ServiceReference,
	Worker,
} from '@fabrika/provider-cloudflare'
import { serviceProxyTable } from '@fabrika/proxy-core/manifest'
import { OPERATIONS_PUBLIC_SERVICE } from './src/service'

/**
 * IAM's origin — the issuer both this Worker and the proxy in front of it verify tokens against.
 * Locally it falls back to `packages/iam`'s own `bun run dev` port, because there is no environment in
 * which the issuer is optional: `createIam` refuses to build without it.
 */
const LOCAL_IAM_URL = 'http://localhost:18191'

const resolveIamUrl = (isLocal: boolean): string => process.env['FABRIKA_IAM_ISSUER'] ?? (isLocal ? LOCAL_IAM_URL : '')

/**
 * The command-line client's Operations resource: the console's path that its gateway forwards here unchanged, on the
 * console's origin (`FABRIKA_CONTROL_URL`, ADR-0049). Without that origin, or locally, Operations accepts no resource
 * token. IAM's deploy derives the same URI from the same origin.
 */
const operationsOAuthResource = (isLocal: boolean, source: Readonly<Record<string, string | undefined>>): string | undefined => {
	const control = source['FABRIKA_CONTROL_URL']
	if (isLocal || control === undefined || control === '') return undefined
	if (!control.startsWith('https://') || URL.parse(control)?.origin !== control) {
		throw new Error('FABRIKA_CONTROL_URL must be the https origin of the console, with no path and no trailing slash')
	}
	return `${control}${CONTROL_OPERATIONS_RPC_PATH}`
}

export const buildOperationsWorker = (ctx: ResourceContext, source: Readonly<Record<string, string | undefined>> = process.env): Worker => {
	const isLocal = ctx.env === 'local'
	const publicHost = ctx.domain ?? ''
	const names = platformNames(process.env)
	const deadLetterQueue = `${ctx.env}-${names.operationsIngestDlq}`
	const iamUrl = resolveIamUrl(isLocal)
	const oauthResource = operationsOAuthResource(isLocal, source)
	return new Worker({
		dir: '.',
		name: names.operationsWorker,
		main: './src/worker.ts',
		// `process.env` and the importable `env` of `cloudflare:workers` stay empty: otherwise each could hold every secret
		// for any bundled module to read (`nodejs_compat_v2` alone already leaves `process.env` empty). Operations reads its
		// configuration from the Worker's `env` only.
		compatibility_flags: ['nodejs_compat_v2', NO_PROCESS_ENV_FLAG, NO_IMPORTABLE_ENV_FLAG],
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
			...(oauthResource === undefined ? {} : { FABRIKA_OPERATIONS_OAUTH_RESOURCE: oauthResource }),
		},
		bindings: {
			DB: new D1Database({ name: names.operationsDatabase, migrationsDir: './migrations', locationHint: 'weur' }),
			PAYLOADS: new R2Bucket({ name: names.operationsPayloads }),
			INGEST_QUEUE: new Queue({
				name: names.operationsIngest,
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
				name: names.operationsIngestDlq,
				binding: 'consumer',
				consumer: { maxBatchSize: 50, maxBatchTimeout: 5, maxRetries: 10 },
			}),
			// Bound in EVERY environment, local included: `src/auth.ts` verifies an IAM-issued token and
			// has no local mode, and the proxy Worker in front of this one binds the same service anyway.
			IAM: new ServiceReference(names.iamWorker),
		},
	})
}

export const buildOperationsProxy = (ctx: ResourceContext): Worker => {
	const publicHost = ctx.domain ?? ''
	const iamUrl = resolveIamUrl(ctx.env === 'local')
	const names = platformNames(process.env)
	return createCloudflareProxyWorker({
		name: names.operationsProxy,
		app: buildOperationsWorker(ctx),
		appId: OPERATIONS_APP_ID,
		appHost: publicHost === '' ? 'localhost' : publicHost,
		domain: ctx.domain,
		installation: serviceProxyTable(OPERATIONS_PUBLIC_SERVICE, { oauth: false }),
		iamService: names.iamWorker,
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
