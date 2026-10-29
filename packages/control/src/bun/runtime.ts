// Runtime assembly for a LONG-RUNNING BUN PROCESS — the other half of what `wrangler` does for the
// Worker: fill the `Env` ports, and hand back the queue consumer the platform cannot drive for us.
//
// Everything under `src/bun/` and `src/zerops/` is Bun/Node-only and is the ONLY part of this package allowed to be. It
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
//
// The provider comes from the installation's composition root (`src/zerops/`), which hands it in as a
// `BunProviderComposition`; nothing here names a cloud.

import { HttpIamRpc } from '@fabrika/auth'
import { readEnvironmentName } from '@fabrika/auth-core'
import { FABRIKA_SERVICE_TABLE_DIGEST } from '@fabrika/auth-core'
import { type EmailProviderRegistry, emailSenderFromEnv, pickEmailEnvironment } from '@fabrika/email'
import { builtinEmailProviders } from '@fabrika/email/providers'
import type { GitHubAppFetch } from '@fabrika/github-app'
import {
	type BackgroundTasks,
	createBackgroundTasks,
	FileSystemAssetServer,
	PostgresDatabase,
	PostgresJobQueue,
	S3BlobStore,
} from '@fabrika/platform-node'
import type { ControlProvider } from '@fabrika/provider-contract'
import { z } from 'zod'
import { controlMcpSwitch } from '../../fabrika.service'
import type { McpRoute } from '../app'
import { createControlRepositories } from '../db'
import { DevSignals } from '../dev/signals'
import type { Env } from '../env'
import { gitHubAppClientFactory } from '../github/connections/credentials'
import { createSourceConnections, type SourceConnectionPort } from '../github/connections/port'
import type { GitHubMetadataFetch, SourceDownloadFetch, SourceUploadFetch } from '../github/source'
import type { CommitSource } from '../github/source/commit-files'
import { githubWorkspaceSource, workspaceGitHubClientFactory } from '../github/workspace'
import { controlPublicOrigin } from '../iam'
import { iamMailKeyHash, type MailDispatchMessage } from '../mail-relay/queue'
import { readInstallationMail } from '../mail-transport'
import type { ControlJobMessage } from '../run-lifecycle'
import { vault } from '../services'
import { HttpIamAdminGateway } from './iam-admin'
import { controlMcpRoute } from './mcp'
import { HttpOperationsService } from './operations'

/** Transport seams only the local stack and tests inject; the GitHub origins stay fixed (ADR-0029). */
export interface GitHubSourceSeams {
	readonly metadataFetch?: GitHubMetadataFetch
	readonly downloadFetch?: SourceDownloadFetch
	readonly uploadFetch?: SourceUploadFetch
	readonly githubAppFetch?: GitHubAppFetch
}

/** What an installation's composition root hands the Bun host: its one provider, and the commit source it reads. */
export interface BunProviderComposition {
	compose(
		env: Env,
		source: Record<string, string | undefined>,
		seams: GitHubSourceSeams,
	): { readonly provider: ControlProvider; readonly commits: CommitSource }
	/** The operator step an invalid installation mail transport's refusal names (`readInstallationMail`). */
	readonly mailRemedy: string
}

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
	/** GitHub App administration over vault-held keys, consumed by the shared authenticated workflow. */
	sourceConnection: SourceConnectionPort
	/** The `/mcp` endpoint (ADR-0049); null when the table the proxy publishes has no `oauth` row for it. */
	mcp: McpRoute | null
	config: ProcessConfig
	/** The control queue (deploys + namespace jobs), as the concrete producer the consumer is built from. */
	queue: PostgresJobQueue<ControlJobMessage>
	/** The mail relay's dispatch queue, which its own consumer drains beside the control queue. */
	mailQueue: PostgresJobQueue<MailDispatchMessage>
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

const MAIL_QUEUE_NAME = 'vozka-mail'
/** Deliveries of one dispatch job that THREW; the dispatcher counts a message's send attempts on its row. */
const MAIL_JOB_MAX_ATTEMPTS = 3

/**
 * Read `process.env`, open the Postgres pool, mount the asset directory and the log bucket, and return
 * the handles both shared entrypoint functions take.
 *
 * Fails LOUDLY and early on missing required configuration: a control plane that boots half-configured
 * and then refuses to serve a run log at 3am is strictly worse than one that never came up. Nothing
 * here ever logs a value — the database URL, the S3 credentials, the IAM key and the vault KEK are all
 * credentials, and only their ABSENCE is reportable.
 */
export interface RuntimeOverrides {
	/** The local stack's fixture transports; never read from the environment. */
	readonly sourceSeams?: GitHubSourceSeams
	/** The providers `FABRIKA_EMAIL_PROVIDER` may name. Defaults to the built-in ones. */
	readonly emailProviders?: EmailProviderRegistry
}

export function createRuntime(
	composition: BunProviderComposition,
	source: Record<string, string | undefined> = process.env,
	overrides: RuntimeOverrides = {},
): Runtime {
	// Before anything opens: the table the proxy publishes decides whether this console serves MCP.
	const mcp = controlMcpSwitch(source[FABRIKA_SERVICE_TABLE_DIGEST])
	const databaseUrl = required(source, 'FABRIKA_CONTROL_DATABASE_URL')
	// The console's own public origin is the fact this root states about where it runs; `local` is
	// refused against it. Control does not branch on the name today, and that is exactly why it must not
	// drift — the next branch would inherit an installation already claiming to be a laptop.
	const environment = readEnvironmentName(
		required(source, 'ENVIRONMENT'),
		controlPublicOrigin({ FABRIKA_CONTROL_DOMAIN: source['FABRIKA_CONTROL_DOMAIN'] }),
	)

	const config: ProcessConfig = {
		port: parsePort(source['PORT']),
		assetsDir: source['FABRIKA_CONTROL_ASSETS_DIR'] ?? './public',
	}

	const emailEnvironment = pickEmailEnvironment(source)
	const emailProviders = overrides.emailProviders ?? builtinEmailProviders
	const mailTransport = readInstallationMail(emailEnvironment, emailProviders, composition.mailRemedy)
	if (mailTransport.kind === 'invalid') {
		// One bad variable must not take the Delivery plane down; the deploys that need the transport are refused instead.
		console.warn(`control: the installation's mail transport is invalid, and every deploy that needs it is refused: ${mailTransport.reason}`)
	}

	const db = PostgresDatabase.connect(databaseUrl)
	const queue = new PostgresJobQueue<ControlJobMessage>(db, { queue: DEPLOY_QUEUE_NAME, maxAttempts: DEPLOY_MAX_ATTEMPTS })
	const mailQueue = new PostgresJobQueue<MailDispatchMessage>(db, { queue: MAIL_QUEUE_NAME, maxAttempts: MAIL_JOB_MAX_ATTEMPTS })
	const tasks = createBackgroundTasks({ label: 'control background task' })
	const operations = operationsConfig(source)
	const controlDomain = source['FABRIKA_CONTROL_DOMAIN']
	const iamUrl = source['FABRIKA_IAM_ISSUER']
	const bootstrapAdmins = source['FABRIKA_CONTROL_BOOTSTRAP_ADMINS']
	const iamProvisioningKey = source['FABRIKA_IAM_PROVISIONING_KEY']
	const vaultKey = source['FABRIKA_CONTROL_VAULT_KEY']
	const sourceSeams = overrides.sourceSeams ?? {}
	const iamRpcConfig = readIamRpcProcessConfig(source)
	const controlRepositories = createControlRepositories(db)

	const baseEnv: Env = {
		DB: db,
		REPOSITORIES: controlRepositories,
		// SPA fallback on: the dashboard is client-routed, so `/apps/foo` must serve index.html.
		ASSETS: new FileSystemAssetServer(config.assetsDir, { spaFallback: true }),
		RUN_LOGS: blobStore(source),
		DEPLOY_QUEUE: queue,
		WAIT_UNTIL: tasks.waitUntil,
		IAM: iamRpc(iamRpcConfig),
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
		...(iamUrl === undefined ? {} : { FABRIKA_IAM_ISSUER: iamUrl }),
		...(source['OPERATIONS_ARTIFACT_ORIGIN'] !== undefined
			? { OPERATIONS_ARTIFACT_ORIGIN: source['OPERATIONS_ARTIFACT_ORIGIN'] }
			: {}),
		...(bootstrapAdmins === undefined ? {} : { FABRIKA_CONTROL_BOOTSTRAP_ADMINS: bootstrapAdmins }),
		...(iamProvisioningKey === undefined ? {} : { FABRIKA_IAM_PROVISIONING_KEY: iamProvisioningKey }),
		...(vaultKey === undefined || vaultKey === '' ? {} : { FABRIKA_CONTROL_VAULT_KEY: vaultKey }),
		MAIL_TRANSPORT: mailTransport,
		MAIL_RELAY: {
			queue: mailQueue,
			iamKeyHash: iamMailKeyHash(iamRpcConfig.key),
			sender: mailTransport.kind === 'transport' ? emailSenderFromEnv(emailEnvironment, emailProviders) : null,
		},
	}
	const composed = composition.compose(baseEnv, source, sourceSeams)
	const workspaceSource = githubWorkspaceSource(baseEnv, workspaceGitHubClientFactory(sourceSeams.githubAppFetch))
	const env: Env = {
		...baseEnv,
		COMMITS: composed.commits,
		...(composed.provider.devSandboxes === undefined ? {} : { DEV_SOURCE: { source: workspaceSource, signals: new DevSignals() } }),
	}

	return {
		env,
		provider: composed.provider,
		sourceConnection: createSourceConnections({
			provider: composed.provider.id,
			vault: () => vault(env),
			createClient: gitHubAppClientFactory(sourceSeams.githubAppFetch),
		}),
		mcp: mcp ? controlMcpRoute(env, workspaceSource, composed.provider) : null,
		config,
		queue,
		mailQueue,
		shutdown: () => shutdownProcess(tasks, db),
	}
}

/** Seconds. Background work has drained by then; a query still running is abandoned work, e.g. a stalled lease release. */
const POOL_CLOSE_TIMEOUT_S = 2

/** Drain background work, then close the pool, cutting off any query that outlives the bound. */
export async function shutdownProcess(tasks: Pick<BackgroundTasks, 'drain'>, db: Pick<PostgresDatabase, 'close'>): Promise<void> {
	await tasks.drain()
	await db.close({ timeout: POOL_CLOSE_TIMEOUT_S })
}

interface OperationsProcessConfig {
	origin: string
	syncKey: string
}

const operationsProcessConfigSchema = z.object({
	origin: z.string().refine(value => value.trim() !== ''),
	syncKey: z.string().min(MIN_RPC_KEY_LENGTH),
})

function operationsConfig(source: Record<string, string | undefined>): OperationsProcessConfig | null {
	const origin = source['FABRIKA_OPERATIONS_URL']
	const syncKey = source['OPERATIONS_SYNC_KEY']
	if ((origin === undefined || origin === '') && (syncKey === undefined || syncKey === '')) {
		return null
	}
	const parsed = operationsProcessConfigSchema.safeParse({ origin, syncKey })
	if (!parsed.success) {
		throw new Error(`FABRIKA_OPERATIONS_URL and an OPERATIONS_SYNC_KEY of at least ${MIN_RPC_KEY_LENGTH} characters must be configured together`)
	}
	new URL(parsed.data.origin)
	return parsed.data
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
function iamRpc(config: IamRpcProcessConfig): HttpIamRpc {
	return new HttpIamRpc({ origin: config.origin, key: config.key })
}

export interface IamRpcProcessConfig {
	/** Private origin used only for control-to-IAM management calls. */
	origin: string
	/** Bearer that guards IAM's management surface. */
	key: string
}

/**
 * Keep transport addressing separate from `FABRIKA_IAM_ISSUER`, which is the public token issuer.
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
