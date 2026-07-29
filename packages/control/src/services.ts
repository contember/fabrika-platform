// Assembly — every dependency bag the control plane's handlers take, built from one `Env`.
//
// The handlers themselves (`handleApi`, `handleWebhook`, `executeDeploy`, `pollPublicRepos`) were
// already written against injected deps, so this is the ONE place that knows how a dep is built. It
// was the private half of the Worker class; it moved here so the Bun entrypoint assembles the same
// deps from the same code rather than a second copy that drifts.
//
// Nothing in this file (or anything it reaches) imports `cloudflare:workers`, `bun:*` or `node:*` —
// every handle arrives through a port. `src/__tests__/entrypoint-isolation.test.ts` enforces that.

import { configFromManifest, deploy, type DeployOptions, parseFabrikaManifest } from '@fabrika/engine'
import { type DeployLocks, SqlDeployLocks } from '@fabrika/platform'
import type { RelayResult, RunnerJob } from '@fabrika/runner'
import type { ApiDeps } from './api/router'
import { Db, type RunRow } from './db'
import type { Env } from './env'
import { createIam } from './iam'
import { GitHubAppRepoSource, type RepoSource } from './repo-source'
import type { RunDeps, RunOutcome, StartZeropsRun } from './run-lifecycle'
import { VaultSecretResolver } from './secret-resolver'
import { Vault } from './vault'

/**
 * How long a deploy may hold its per-app-env lock before it's treated as stale and auto-released. A
 * deploy (clone + install + wrangler + reconcile) finishes well inside this; the runner container is
 * hard-killed ~15 min anyway. The lease self-heals after this if a consumer dies without releasing.
 */
export const DEPLOY_LOCK_TTL_MS = 30 * 60 * 1000

/** Delay before a deferred run (another deploy of the same app-env in flight) is re-checked. */
export const DEPLOY_LOCK_REQUEUE_DELAY_S = 30

/**
 * A `pending`/`running` run older than this is treated as ORPHANED by the cron sweep and marked failed.
 * Set well beyond the container hard-kill (~15 min) + vozka-runner's per-run backstop deadline (~18 min)
 * so a genuinely long deploy is never reaped — the sweep only catches runs the backstop itself missed.
 */
export const STALE_RUN_MAX_AGE_S = 30 * 60

/** All database access, over whichever `SqlDatabase` this runtime supplied. */
export function db(env: Env): Db {
	return new Db(env.DB)
}

/** The per-app-env deploy locks, backed by the `deploy_locks` table in the SAME database as the runs. */
export function locks(env: Env): DeployLocks {
	return new SqlDeployLocks(env.DB)
}

/** Build the v1 RepoSource (GitHub App). The webhook secret + App key come from this env's secrets. */
export function repoSource(env: Env): RepoSource {
	return new GitHubAppRepoSource({
		appId: env.GITHUB_APP_ID ?? '',
		privateKeyPem: env.GITHUB_APP_PRIVATE_KEY ?? '',
		webhookSecret: env.GITHUB_WEBHOOK_SECRET ?? '',
	})
}

/**
 * Build the encrypted-vault handle from the `VOZKA_VAULT_KEY` secret. Rejects (caught by the caller as
 * a clean error) when the key is missing/invalid — vault routes / `vault:` refs require it.
 */
export function vault(env: Env): Promise<Vault> {
	if (env.VOZKA_VAULT_KEY === undefined) {
		return Promise.reject(new Error('VOZKA_VAULT_KEY is not set'))
	}
	return Vault.create(env.DB, env.VOZKA_VAULT_KEY)
}

/**
 * Hand one deploy run to vozka-runner (the deploy EXECUTOR) over the `RUNNER_SVC` service binding.
 * vozka-runner boots the per-run container, relays its logs → R2, and records the terminal status →
 * the database itself — so the run is recorded even if the control plane is reset mid-deploy (which is
 * exactly what a fabrika self-deploy does).
 *
 * NO RUNNER MEANS NO RUN, LOUDLY. Two deployments legitimately have none, and the message names both
 * because the fix differs: local dev has no runner worker bound (and no CF credentials, so a real
 * deploy could not run anyway), and a Zerops installation has none BY DESIGN — ADR-0003, the platform
 * executes the deploy there, so a Cloudflare-shaped `RunnerJob` has nowhere to go. Failing here beats
 * a half-run that leaves the `runs` row saying something that never happened.
 */
export async function startRun(env: Env, job: RunnerJob): Promise<RelayResult> {
	if (env.RUNNER === undefined) {
		// `async`, so a missing runner is a REJECTED promise rather than a synchronous throw — this is an
		// RPC method on the Worker, and a caller that only catches the promise must still see the failure.
		throw new Error(
			'no deploy runner is available: a Cloudflare deploy needs the RUNNER_SVC service binding '
				+ '(absent in local dev), and a Zerops installation has no runner at all by design (ADR-0003)',
		)
	}
	return env.RUNNER.startRun(job)
}

/** Execute a callback-free registered Zerops manifest through the HTTP driver in this process. */
export async function startZeropsRun(
	env: Env,
	input: Parameters<StartZeropsRun>[0],
	options: DeployOptions = {},
): Promise<RunOutcome> {
	const { appEnv } = input
	if (
		appEnv.zerops_project_id === null
		|| appEnv.zerops_service_id === null
		|| appEnv.manifest_json === null
	) {
		throw new Error(`Zerops target ${appEnv.app_id}/${appEnv.env} is incomplete`)
	}
	const accessToken = env.ZEROPS_ACCESS_TOKEN
	if (accessToken === undefined || accessToken === '') {
		throw new Error('ZEROPS_ACCESS_TOKEN is not configured')
	}
	let raw: unknown
	try {
		raw = JSON.parse(appEnv.manifest_json)
	} catch {
		throw new Error(`Zerops target ${appEnv.app_id}/${appEnv.env} has invalid manifest JSON`)
	}
	const manifest = parseFabrikaManifest(raw, { appId: input.app.id, env: appEnv.env })
	const config = configFromManifest(manifest)
	const result = await deploy(
		config,
		{
			env: appEnv.env,
			...(appEnv.domain !== null ? { domain: appEnv.domain } : {}),
			target: {
				platform: 'zerops',
				projectId: appEnv.zerops_project_id,
				serviceId: appEnv.zerops_service_id,
				accessToken,
				...(env.ZEROPS_API_BASE_URL !== undefined && env.ZEROPS_API_BASE_URL !== ''
					? { apiBaseUrl: env.ZEROPS_API_BASE_URL }
					: {}),
			},
			...(env.PROPUSTKA_URL !== undefined && env.PROPUSTKA_URL !== '' ? { propustkaUrl: env.PROPUSTKA_URL } : {}),
			...(env.PROPUSTKA_PROVISIONING_KEY !== undefined && env.PROPUSTKA_PROVISIONING_KEY !== ''
				? { adminKey: env.PROPUSTKA_PROVISIONING_KEY }
				: {}),
			secrets: {},
			vars: input.vars,
			cwd: '.',
			dryRun: input.dryRun,
		},
		{
			...options,
			log: options.log ?? ((line) => console.info(`deploy run ${input.run.id}: ${line}`)),
		},
	)
	return { status: { state: result.status === 'succeeded' ? 'succeeded' : 'failed' } }
}

/**
 * Cancel an in-flight run: have vozka-runner DESTROY the run's container, then free the per-app-env
 * deploy lock so the target can be redeployed immediately. Destroying the container is what makes the
 * lock release safe — it guarantees no orphaned `wrangler deploy` races a fresh run. With no runner
 * there is no container; just mark the run failed. The `runs.status` guard makes the terminal write
 * idempotent, so a concurrent relay finish is a no-op.
 */
export async function cancelRun(env: Env, run: RunRow): Promise<void> {
	if (env.RUNNER !== undefined) {
		await env.RUNNER.cancelRun(run.id)
	} else {
		await db(env).markRunFinished(run.id, 'failed', null)
	}
	await locks(env).release(`${run.app_id}:${run.env}`, run.id)
}

/** Assemble the run-lifecycle deps (`startRun` adapted to the lifecycle's `RunOutcome` union). */
export async function buildRunDeps(env: Env): Promise<RunDeps> {
	const run = async (job: RunnerJob): Promise<RunOutcome> => {
		const result = await startRun(env, job)
		// The relay only resolves on a terminal status; narrow its state to the lifecycle's union.
		const state = result.status.state === 'succeeded' ? 'succeeded' : 'failed'
		return { status: { state, ...(result.status.exitCode !== undefined ? { exitCode: result.status.exitCode } : {}) } }
	}
	// The vault-backed resolver dispatches by ref scheme: `vault:<id>` → the encrypted vault,
	// `secretstore:<name>` → CF Secrets Store (CF-only), `env:`/`literal:` → dev bindings. The vault is
	// built only when VOZKA_VAULT_KEY is present (so the env/literal path still works without it); a
	// `vault:` ref with no vault configured fails the run loudly rather than deploying empty creds.
	return {
		db: db(env),
		repoSource: repoSource(env),
		secrets: new VaultSecretResolver({
			...(env.VOZKA_VAULT_KEY !== undefined ? { vault: await vault(env) } : {}),
			env: {
				GITHUB_WEBHOOK_SECRET: env.GITHUB_WEBHOOK_SECRET,
				GITHUB_APP_ID: env.GITHUB_APP_ID,
			},
		}),
		startRun: run,
		startZeropsRun: (input) => startZeropsRun(env, input),
		// Per-app-env mutual exclusion, one `deploy_locks` row per `<app>:<env>`. The TTL is bound here so
		// the lifecycle never has to know how long a deploy may legitimately take.
		lock: {
			acquire: (key, holder) => locks(env).acquire(key, holder, DEPLOY_LOCK_TTL_MS),
			release: (key, holder) => locks(env).release(key, holder),
		},
		// fabrika's build-time platform deploy config: the single CF account/token + propustka coords,
		// injected into every job (single-account — no per-account registry). Empty creds fail the run
		// loudly in assembleJob rather than deploying empty. Optional propustka coords are omitted when
		// unset (an app without access/schema never needs them).
		deploy: {
			cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID ?? '',
			cloudflareApiToken: env.CLOUDFLARE_API_TOKEN ?? '',
			...(env.PROPUSTKA_URL !== undefined && env.PROPUSTKA_URL !== '' ? { propustkaUrl: env.PROPUSTKA_URL } : {}),
			...(env.PROPUSTKA_PROVISIONING_KEY !== undefined && env.PROPUSTKA_PROVISIONING_KEY !== ''
				? { propustkaProvisioningKey: env.PROPUSTKA_PROVISIONING_KEY }
				: {}),
			...(env.ZEROPS_ACCESS_TOKEN !== undefined && env.ZEROPS_ACCESS_TOKEN !== ''
				? { zeropsAccessToken: env.ZEROPS_ACCESS_TOKEN }
				: {}),
			...(env.ZEROPS_API_BASE_URL !== undefined && env.ZEROPS_API_BASE_URL !== ''
				? { zeropsApiBaseUrl: env.ZEROPS_API_BASE_URL }
				: {}),
		},
	}
}

/** Assemble the `/api/*` router deps. `vault` stays a FACTORY so non-vault routes work without a key. */
export function buildApiDeps(env: Env): ApiDeps {
	return {
		db: db(env),
		iam: createIam(env),
		queue: env.DEPLOY_QUEUE,
		logs: env.RUN_LOGS,
		repoSource: repoSource(env),
		cancelRun: (run) => cancelRun(env, run),
		vault: () => vault(env),
	}
}
