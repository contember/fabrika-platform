import type { AuthContext } from '@fabrika/auth'
import { type DeployLocks, SqlDeployLocks } from '@fabrika/platform'
import type { ControlProvider } from '@fabrika/provider-contract'
import type { BuilderPairingIam } from './api/builder-pairing'
import type { NamespaceProxyChanged } from './api/namespaces'
import type { DeployQueue, LogReader } from './api/runs'
import type { ControlRepositories, RunRow } from './db'
import type { Env } from './env'
import { GitHubConnectionWebhookSecretProvider } from './github-connection-store'
import {
	type OperationsCatalogSyncDeps,
	type OperationsCatalogSyncSummary,
	projectOperationsCatalogChange,
	replayOperationsCatalog,
} from './operations-catalog'
import type { OperationsReleaseProjectionDeps } from './operations-releases'
import { LocalGitHubRepoEvents, type RepoEvents } from './repo-source'
import { cancelDeploy, type RunDeps } from './run-lifecycle'
import { DEPLOY_LEASE_TTL_MS, type DeployLockGate } from './run-ownership'
import { VaultSecretResolver } from './secret-resolver'
import { Vault } from './vault'
import type { WebhookBinding } from './webhook'

export const DEPLOY_LOCK_TTL_MS = DEPLOY_LEASE_TTL_MS
export const DEPLOY_LOCK_REQUEUE_DELAY_S = 30
export const STALE_RUN_MAX_AGE_S = 30 * 60

export function repositories(env: Env): ControlRepositories {
	return env.REPOSITORIES
}

export function locks(env: Env): DeployLocks {
	return new SqlDeployLocks(env.DB)
}

export function deployLock(env: Env): DeployLockGate {
	const store = locks(env)
	return {
		acquire: (key, holder) => store.acquire(key, holder, DEPLOY_LOCK_TTL_MS),
		renew: (key, holder) => store.renew(key, holder, DEPLOY_LOCK_TTL_MS),
		release: (key, holder) => store.release(key, holder),
	}
}

export function operationsCatalogDeps(env: Env): OperationsCatalogSyncDeps {
	const operationsOrigin = env.OPERATIONS_ARTIFACT_ORIGIN?.trim()
	return {
		catalog: repositories(env).operationsCatalog,
		locks: locks(env),
		...(env.OPERATIONS === undefined ? {} : { service: env.OPERATIONS }),
		...(env.OPERATIONS_SYNC_KEY === undefined ? {} : { syncKey: env.OPERATIONS_SYNC_KEY }),
		...(operationsOrigin === undefined || operationsOrigin === '' ? {} : { operationsOrigin }),
	}
}

export function operationsReleaseDeps(env: Env): OperationsReleaseProjectionDeps {
	const artifactOrigin = env.OPERATIONS_ARTIFACT_ORIGIN?.trim()
	return {
		repository: repositories(env).operationsReleases,
		terminalRepair: { runs: repositories(env).runs, lock: deployLock(env) },
		...(env.OPERATIONS === undefined ? {} : { service: env.OPERATIONS }),
		...(env.OPERATIONS_SYNC_KEY === undefined ? {} : { syncKey: env.OPERATIONS_SYNC_KEY }),
		...(artifactOrigin === undefined || artifactOrigin === '' ? {} : { artifactOrigin }),
	}
}

/** Registry writes stay successful even when Operations is unavailable. */
export function scheduleOperationsCatalogChange(env: Env): void {
	env.WAIT_UNTIL(projectOperationsCatalogChange(operationsCatalogDeps(env)))
}

/** Scheduled repair path; the sync function converts transport failures into a durable failed summary. */
export function replayOperationsCatalogProjection(env: Env): Promise<OperationsCatalogSyncSummary> {
	return replayOperationsCatalog(operationsCatalogDeps(env))
}

/** Installation lookup only — webhook verification is resolved per route, never from this instance. */
export function repoEvents(env: Env): RepoEvents {
	return env.REPO_EVENTS
}

export interface WebhookRoute {
	readonly repoSource: RepoEvents
	readonly binding: WebhookBinding
}

/**
 * Resolve one webhook route before its request body is read, by the provider's source mode (ADR-0029).
 *
 * Without keyed connections the installation's single App keeps its static secret on the unscoped path.
 * In the `connection` mode each route selects one exact connection's vault secret, and the unscoped
 * path refuses rather than trying any stored secret.
 */
export function webhookRoute(env: Env, provider: ControlProvider, connectionId?: string): WebhookRoute | null {
	if (provider.source?.binding !== 'connection') {
		return connectionId === undefined ? { repoSource: env.REPO_EVENTS, binding: { kind: 'installation-only' } } : null
	}
	if (connectionId === undefined) return null
	const secrets = new GitHubConnectionWebhookSecretProvider(env.REPOSITORIES.githubConnections, () => vault(env), connectionId)
	return {
		repoSource: new LocalGitHubRepoEvents(secrets, env.REPO_EVENTS),
		binding: { kind: 'connection', connectionId },
	}
}

export function vault(env: Env): Promise<Vault> {
	if (env.FABRIKA_CONTROL_VAULT_KEY === undefined) {
		return Promise.reject(new Error('FABRIKA_CONTROL_VAULT_KEY is not set'))
	}
	return Vault.create(env.DB, env.FABRIKA_CONTROL_VAULT_KEY)
}

/** Assemble provider-neutral run dependencies around one statically selected provider. */
export async function buildRunDeps(env: Env, provider: ControlProvider): Promise<RunDeps> {
	return {
		repositories: repositories(env),
		provider,
		secrets: new VaultSecretResolver({
			...(env.FABRIKA_CONTROL_VAULT_KEY !== undefined ? { vault: await vault(env) } : {}),
		}),
		lock: deployLock(env),
		logs: env.RUN_LOGS,
		operations: operationsReleaseDeps(env),
		// The installation's own IAM issuer, which every application it deploys verifies against (ADR-0035).
		...(env.FABRIKA_IAM_ISSUER === undefined ? {} : { iamIssuer: env.FABRIKA_IAM_ISSUER }),
	}
}

export async function cancelRun(env: Env, provider: ControlProvider, run: RunRow): Promise<void> {
	await cancelDeploy({ repositories: repositories(env), provider, lock: deployLock(env) }, run)
}

/**
 * The one runtime handle a Cloudflare composition never fills: republishing a deployment namespace's
 * proxy manifest. It is a PORT for the same reason every other handle in `env.ts` is one — the shared
 * layer must not name a provider package (ADR-0011), and the process composition root supplies it.
 */
export interface NamespaceProxyEnv {
	NAMESPACE_PROXY?: NamespaceProxyChanged
}

export interface ControlRpcDeps {
	builderPairingIam?: BuilderPairingIam
	repositories: ControlRepositories
	auth: AuthContext
	queue: DeployQueue
	logs: LogReader
	repoSource: RepoEvents
	provider: ControlProvider
	cancelRun: (run: RunRow) => Promise<void>
	vault?: () => Promise<Vault>
	catalogChanged?: () => void
	namespaceProxyChanged?: NamespaceProxyChanged
}

/** Assemble RPC use-case dependencies around the installation's provider. Vault creation stays lazy. */
export function buildControlRpcDeps(env: Env & NamespaceProxyEnv, provider: ControlProvider, auth: AuthContext): ControlRpcDeps {
	return {
		repositories: repositories(env),
		auth,
		queue: env.DEPLOY_QUEUE,
		logs: env.RUN_LOGS,
		repoSource: repoEvents(env),
		provider,
		cancelRun: (run) => cancelRun(env, provider, run),
		vault: () => vault(env),
		catalogChanged: () => scheduleOperationsCatalogChange(env),
		...(env.NAMESPACE_PROXY === undefined ? {} : { namespaceProxyChanged: env.NAMESPACE_PROXY }),
	}
}
