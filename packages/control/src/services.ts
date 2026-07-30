import { type DeployLocks, SqlDeployLocks } from '@fabrika/platform'
import type { ControlProvider } from '@fabrika/provider-contract'
import type { ApiDeps } from './api/router'
import type { ControlRepositories, RunRow } from './db'
import type { Env } from './env'
import { createIam } from './iam'
import {
	type OperationsCatalogSyncDeps,
	type OperationsCatalogSyncSummary,
	projectOperationsCatalogChange,
	replayOperationsCatalog,
} from './operations-catalog'
import { GitHubAppRepoSource, type RepoSource } from './repo-source'
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
	return {
		catalog: repositories(env).operationsCatalog,
		locks: locks(env),
		...(env.OPERATIONS === undefined ? {} : { service: env.OPERATIONS }),
		...(env.OPERATIONS_SYNC_KEY === undefined ? {} : { syncKey: env.OPERATIONS_SYNC_KEY }),
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

export function repoSource(env: Env): RepoSource {
	return new GitHubAppRepoSource({
		appId: env.GITHUB_APP_ID ?? '',
		privateKeyPem: env.GITHUB_APP_PRIVATE_KEY ?? '',
		webhookSecret: env.GITHUB_WEBHOOK_SECRET ?? '',
	})
}

export function vault(env: Env): Promise<Vault> {
	if (env.VOZKA_VAULT_KEY === undefined) {
		return Promise.reject(new Error('VOZKA_VAULT_KEY is not set'))
	}
	return Vault.create(env.DB, env.VOZKA_VAULT_KEY)
}

/** Assemble provider-neutral run dependencies around one statically selected provider. */
export async function buildRunDeps(env: Env, provider: ControlProvider): Promise<RunDeps> {
	return {
		repositories: repositories(env),
		provider,
		secrets: new VaultSecretResolver({
			...(env.VOZKA_VAULT_KEY !== undefined ? { vault: await vault(env) } : {}),
			env: {
				GITHUB_WEBHOOK_SECRET: env.GITHUB_WEBHOOK_SECRET,
				GITHUB_APP_ID: env.GITHUB_APP_ID,
			},
		}),
		lock: {
			acquire: (key, holder) => locks(env).acquire(key, holder, DEPLOY_LOCK_TTL_MS),
			release: (key, holder) => locks(env).release(key, holder),
		},
	}
}

export async function cancelRun(env: Env, provider: ControlProvider, run: RunRow): Promise<void> {
	await cancelDeploy({ repositories: repositories(env), provider, lock: locks(env) }, run)
}

/** Assemble the shared API dependencies around one statically selected provider. */
export function buildApiDeps(env: Env, provider: ControlProvider): ApiDeps {
	return {
		repositories: repositories(env),
		iam: createIam(env),
		queue: env.DEPLOY_QUEUE,
		logs: env.RUN_LOGS,
		repoSource: repoSource(env),
		provider,
		cancelRun: (run) => cancelRun(env, provider, run),
		vault: () => vault(env),
		catalogChanged: () => scheduleOperationsCatalogChange(env),
	}
}
