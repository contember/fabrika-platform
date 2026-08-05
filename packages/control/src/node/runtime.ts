// Runtime assembly for a LONG-RUNNING BUN PROCESS — the other half of what `wrangler` does for the
// Worker: fill the `Env` ports, and hand back the queue consumer the platform cannot drive for us.
//
// Everything under `src/node/` is Bun/Node-only and is the ONLY part of this package allowed to be. It
// imports `@fabrika/platform-node`; `src/index.ts` (the Worker) imports `cloudflare:workers`; the
// shared layer between them (`app.ts`, `consumer.ts`, `cron.ts`, `services.ts`, everything they
// reach) imports neither. `src/__tests__/entrypoint-isolation.test.ts` walks both graphs and fails if
// that stops being true.
//
//   SqlDatabase  → PostgresDatabase       (D1's place)
//   BlobStore    → S3BlobStore            (R2's place — MinIO on Zerops, and R2 itself works unchanged)
//   JobQueue     → PostgresJobQueue       (the Queue binding's place; + the consumer the port omits)
//   AssetServer  → FileSystemAssetServer  (the `ASSETS` binding's place — the built SPA on disk)
//   IamRpc       → HttpIamRpc             (the `IAM` service binding's place)
//   RunnerGateway→ (none — ADR-0003: there is no deploy runner off Cloudflare)

import { HttpIamRpc } from '@fabrika/auth'
import { createBackgroundTasks, FileSystemAssetServer, PostgresDatabase, PostgresJobQueue, S3BlobStore } from '@fabrika/platform-node'
import type { ControlProvider } from '@fabrika/provider-contract'
import { createControlRepositories } from '../db'
import type { Env } from '../env'
import type { DeployJobMessage } from '../run-lifecycle'
import { HttpIamAdminGateway } from './iam-admin'
import { HttpOperationsService } from './operations'
import { zeropsControlProvider } from './provider'

/** Config that exists ONLY off Workers — the process's own knobs, not part of the service's `Env`. */
export interface ProcessConfig {
	/** TCP port to listen on. */
	port: number
	/** Directory holding the built dashboard SPA (`@fabrika/dashboard`'s `dist`). */
	assetsDir: string
}

export interface Runtime {
	env: Env
	/** The single provider selected by this process composition root. */
	provider: ControlProvider
	config: ProcessConfig
	/** The deploy queue, as the concrete producer the in-process consumer is built from. */
	queue: PostgresJobQueue<DeployJobMessage>
	/** Close the connection pool. Callers stop the consumer and the server first. */
	shutdown(): Promise<void>
}

/**
 * Minimum length for the IAM transport secret — the same rule `@fabrika/iam` enforces on the serving
 * side, checked here too so a truncated value fails the BOOT rather than 401ing every request at 3am.
 */
const MIN_RPC_KEY_LENGTH = 32

/**
 * Queue name. Matches the Cloudflare queue (`vozka-deploy`) so the two deployments describe the same
 * thing; `PostgresJobQueue` is keyed by it, so several queues could share the `jobs` table.
 */
const DEPLOY_QUEUE_NAME = 'vozka-deploy'

/**
 * Deliveries allowed per message before it is abandoned. Mirrors the Cloudflare consumer's
 * `maxRetries: 3` (one delivery plus three retries) declared in `fabrika.config.ts`.
 */
export const DEPLOY_MAX_ATTEMPTS = 4

/**
 * Read `process.env`, open the Postgres pool, mount the asset directory and the log bucket, and return
 * the handles both shared entrypoint functions take.
 *
 * Fails LOUDLY and early on missing required configuration: a control plane that boots half-configured
 * and then refuses to serve a run log at 3am is strictly worse than one that never came up. Nothing
 * here ever logs a value — the database URL, the S3 credentials, the IAM key and the vault KEK are all
 * credentials, and only their ABSENCE is reportable.
 */
export function createRuntime(source: Record<string, string | undefined> = process.env): Runtime {
	const databaseUrl = required(source, 'FABRIKA_CONTROL_DATABASE_URL')
	const environment = required(source, 'ENVIRONMENT')

	const config: ProcessConfig = {
		port: parsePort(source['PORT']),
		assetsDir: source['FABRIKA_CONTROL_ASSETS_DIR'] ?? './public',
	}

	const db = PostgresDatabase.connect(databaseUrl)
	const queue = new PostgresJobQueue<DeployJobMessage>(db, { queue: DEPLOY_QUEUE_NAME, maxAttempts: DEPLOY_MAX_ATTEMPTS })
	const tasks = createBackgroundTasks({ label: 'control background task' })
	const operations = operationsConfig(source)
	const controlDomain = source['FABRIKA_CONTROL_DOMAIN']
	const iamUrl = source['FABRIKA_IAM_URL']
	const bootstrapAdmins = source['FABRIKA_CONTROL_BOOTSTRAP_ADMINS']
	const iamProvisioningKey = source['FABRIKA_IAM_PROVISIONING_KEY']
	const vaultKey = source['FABRIKA_CONTROL_VAULT_KEY']

	const env: Env = {
		DB: db,
		REPOSITORIES: createControlRepositories(db),
		// SPA fallback on: the dashboard is client-routed, so `/apps/foo` must serve index.html.
		ASSETS: new FileSystemAssetServer(config.assetsDir, { spaFallback: true }),
		RUN_LOGS: blobStore(source),
		DEPLOY_QUEUE: queue,
		WAIT_UNTIL: tasks.waitUntil,
		IAM: iamRpc(source),
		IAM_ADMIN: new HttpIamAdminGateway(required(source, 'FABRIKA_IAM_RPC_URL')),
		ENVIRONMENT: environment,
		...(operations === null
			? {}
			: { OPERATIONS: new HttpOperationsService(operations.origin), OPERATIONS_SYNC_KEY: operations.syncKey }),
		// Spread conditionally rather than defaulted to '': ABSENT and EMPTY mean different things to
		// several of these. `FABRIKA_CONTROL_VAULT_KEY: ''` would make `buildRunDeps` try to import a zero-length
		// master key instead of running the env/literal path, and `FABRIKA_CONTROL_DOMAIN: ''` would be read as
		// "no public domain" — which is exactly what it means, but only when it really is unset.
		...(controlDomain === undefined ? {} : { FABRIKA_CONTROL_DOMAIN: controlDomain }),
		...(iamUrl === undefined ? {} : { FABRIKA_IAM_URL: iamUrl }),
		...(source['OPERATIONS_ARTIFACT_ORIGIN'] !== undefined
			? { OPERATIONS_ARTIFACT_ORIGIN: source['OPERATIONS_ARTIFACT_ORIGIN'] }
			: {}),
		...(bootstrapAdmins === undefined ? {} : { FABRIKA_CONTROL_BOOTSTRAP_ADMINS: bootstrapAdmins }),
		...(source['GITHUB_WEBHOOK_SECRET'] !== undefined ? { GITHUB_WEBHOOK_SECRET: source['GITHUB_WEBHOOK_SECRET'] } : {}),
		...(source['GITHUB_APP_ID'] !== undefined ? { GITHUB_APP_ID: source['GITHUB_APP_ID'] } : {}),
		...(source['GITHUB_APP_PRIVATE_KEY'] !== undefined ? { GITHUB_APP_PRIVATE_KEY: source['GITHUB_APP_PRIVATE_KEY'] } : {}),
		...(iamProvisioningKey === undefined ? {} : { FABRIKA_IAM_PROVISIONING_KEY: iamProvisioningKey }),
		...(vaultKey === undefined || vaultKey === '' ? {} : { FABRIKA_CONTROL_VAULT_KEY: vaultKey }),
	}

	return {
		env,
		provider: zeropsControlProvider(env, source),
		config,
		queue,
		async shutdown(): Promise<void> {
			await tasks.drain()
			await db.close()
		},
	}
}

interface OperationsProcessConfig {
	origin: string
	syncKey: string
}

function operationsConfig(source: Record<string, string | undefined>): OperationsProcessConfig | null {
	const origin = source['FABRIKA_OPERATIONS_URL']
	const syncKey = source['OPERATIONS_SYNC_KEY']
	if ((origin === undefined || origin === '') && (syncKey === undefined || syncKey === '')) {
		return null
	}
	if (origin === undefined || origin.trim() === '' || syncKey === undefined || syncKey.length < MIN_RPC_KEY_LENGTH) {
		throw new Error(`FABRIKA_OPERATIONS_URL and an OPERATIONS_SYNC_KEY of at least ${MIN_RPC_KEY_LENGTH} characters must be configured together`)
	}
	new URL(origin)
	return { origin, syncKey }
}

/**
 * The run-log bucket. REQUIRED, not optional: serving a run's log is part of what the control plane is
 * for, and a deployment that discovers the bucket is unconfigured only when an operator opens a failed
 * run has already lost the log it wanted.
 *
 * One implementation covers both platforms — R2 and Zerops object storage (MinIO) are S3-compatible, so
 * only the endpoint and the credentials differ. Path-style addressing is the portable default: MinIO
 * normally wants it, and R2/AWS accept it.
 */
function blobStore(source: Record<string, string | undefined>): S3BlobStore {
	const endpoint = source['FABRIKA_CONTROL_RUN_LOGS_ENDPOINT']
	return S3BlobStore.connect({
		bucket: required(source, 'FABRIKA_CONTROL_RUN_LOGS_BUCKET'),
		accessKeyId: required(source, 'FABRIKA_CONTROL_RUN_LOGS_ACCESS_KEY_ID'),
		secretAccessKey: required(source, 'FABRIKA_CONTROL_RUN_LOGS_SECRET_ACCESS_KEY'),
		region: source['FABRIKA_CONTROL_RUN_LOGS_REGION'] ?? 'auto',
		virtualHostedStyle: false,
		...(endpoint !== undefined && endpoint !== '' ? { endpoint } : {}),
	})
}

/**
 * The IAM handle, off-local. ONE instance for the whole process, deliberately: `@fabrika/auth` caches
 * the fetched JWKS and the tokens minted from `px_` share credentials in WeakMaps keyed by the binding
 * OBJECT, so a fresh client per request would re-fetch the JWKS on every request. A service binding
 * lives for the isolate's lifetime; this lives for the process's.
 */
function iamRpc(source: Record<string, string | undefined>): HttpIamRpc {
	const { origin, key } = readIamRpcProcessConfig(source)
	return new HttpIamRpc({ origin, key })
}

export interface IamRpcProcessConfig {
	/** Private origin used only for control-to-IAM management calls. */
	origin: string
	/** Bearer that guards IAM's management surface. */
	key: string
}

/**
 * Keep transport addressing separate from `FABRIKA_IAM_URL`, which is the public token issuer.
 * The two happen to match in a single-process dev setup, but never across Zerops projects.
 */
export function readIamRpcProcessConfig(source: Record<string, string | undefined>): IamRpcProcessConfig {
	const origin = required(source, 'FABRIKA_IAM_RPC_URL')
	const key = required(source, 'FABRIKA_IAM_RPC_KEY')
	if (key.length < MIN_RPC_KEY_LENGTH) {
		throw new Error(`FABRIKA_IAM_RPC_KEY must be at least ${MIN_RPC_KEY_LENGTH} characters (it is the only thing guarding IAM's RPC surface)`)
	}
	return { origin, key }
}

function required(source: Record<string, string | undefined>, name: string): string {
	const value = source[name]
	if (value === undefined || value.trim() === '') {
		throw new Error(`${name} is required`)
	}
	return value
}

function parsePort(raw: string | undefined): number {
	if (raw === undefined || raw.trim() === '') {
		return 3000
	}
	const port = Number.parseInt(raw, 10)
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error('PORT must be an integer between 1 and 65535')
	}
	return port
}
