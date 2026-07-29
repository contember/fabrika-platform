import type { ControlProvider } from '@fabrika/provider-contract'
import { type DeployLocks, SqlDeployLocks } from '@fabrika/platform'
import type { ApiDeps } from './api/router'
import { Db, type RunRow } from './db'
import type { Env } from './env'
import { createIam } from './iam'
import { GitHubAppRepoSource, type RepoSource } from './repo-source'
import { cancelDeploy, type RunDeps } from './run-lifecycle'
import { VaultSecretResolver } from './secret-resolver'
import { Vault } from './vault'

export const DEPLOY_LOCK_TTL_MS = 30 * 60 * 1000
export const DEPLOY_LOCK_REQUEUE_DELAY_S = 30
export const STALE_RUN_MAX_AGE_S = 30 * 60

export function db(env: Env): Db {
	return new Db(env.DB)
}

export function locks(env: Env): DeployLocks {
	return new SqlDeployLocks(env.DB)
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
		db: db(env),
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
	await cancelDeploy({ db: db(env), provider, lock: locks(env) }, run)
}

/** Assemble the shared API dependencies around one statically selected provider. */
export function buildApiDeps(env: Env, provider: ControlProvider): ApiDeps {
	return {
		db: db(env),
		iam: createIam(env),
		queue: env.DEPLOY_QUEUE,
		logs: env.RUN_LOGS,
		repoSource: repoSource(env),
		provider,
		cancelRun: (run) => cancelRun(env, provider, run),
		vault: () => vault(env),
	}
}
