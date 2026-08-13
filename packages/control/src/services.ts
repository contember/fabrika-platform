import type { AuthContext } from '@fabrika/auth'
import { type DeployLocks, SqlDeployLocks } from '@fabrika/platform'
import type { ControlProvider } from '@fabrika/provider-contract'
import type { ApiDeps } from './api/router'
import type { ControlRepositories, RunRow } from './db'
import type { Env } from './env'
import {
	type OperationsCatalogSyncDeps,
	type OperationsCatalogSyncSummary,
	projectOperationsCatalogChange,
	replayOperationsCatalog,
} from './operations-catalog'
import type { OperationsReleaseProjectionDeps } from './operations-releases'
import { LocalGitHubRepoEvents, type RepoEvents } from './repo-source'
import { cancelDeploy, type RunDeps } from './run-lifecycle'
import { VaultSecretResolver } from './secret-resolver'
import { Vault } from './vault'

export const DEPLOY_LOCK_TTL_MS = 30 * 60 * 1000
export const DEPLOY_LOCK_REQUEUE_DELAY_S = 30
export const STALE_RUN_MAX_AGE_S = 30 * 60

export function repositories(env: Env): ControlRepositories {
	return env.REPOSITORIES
}

export function locks(env: Env): DeployLocks {
	return new SqlDeployLocks(env.DB)
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

export function repoEvents(env: Env): RepoEvents {
	return env.GITHUB_WEBHOOK_SECRETS === undefined ? env.REPO_EVENTS : new LocalGitHubRepoEvents(env.GITHUB_WEBHOOK_SECRETS, env.REPO_EVENTS)
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
		lock: {
			acquire: (key, holder) => locks(env).acquire(key, holder, DEPLOY_LOCK_TTL_MS),
			release: (key, holder) => locks(env).release(key, holder),
		},
		logs: env.RUN_LOGS,
		operations: operationsReleaseDeps(env),
	}
}

export async function cancelRun(env: Env, provider: ControlProvider, run: RunRow): Promise<void> {
	await cancelDeploy({ repositories: repositories(env), provider, lock: locks(env) }, run)
}

/** Assemble the shared API dependencies around one statically selected provider. */
export function buildApiDeps(env: Env, provider: ControlProvider, auth: AuthContext): ApiDeps {
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
	}
}
