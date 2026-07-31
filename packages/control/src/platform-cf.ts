// The CLOUDFLARE side of the platform seam: the raw binding shape `wrangler` hands the Worker, and the
// adapters that present it as the runtime-neutral `Env` (src/env.ts) everything else is written against.
//
// This file is Cloudflare-only and is imported by `src/index.ts` alone. It lives HERE, with the worker
// that uses it, not in @fabrika/platform (which is types only) — the port declares the capability, the
// worker binds it to whatever the runtime actually offers.
//
// D1 and Fetcher satisfy the neutral ports structurally. R2 and Queues need small return-type adapters.
// The runner is not a core port: it is consumed only while composing the Cloudflare provider below.

import type { IamRpc } from '@fabrika/auth'
import { type BlobStore, environmentAliases, type HttpService, type JobQueue } from '@fabrika/platform'
import { type CloudflareRunnerJob, createCloudflareControlProvider } from '@fabrika/provider-cloudflare'
import type { ControlProvider, ProviderSource, ProviderTerminalOutcome } from '@fabrika/provider-contract'
import type { VozkaRunner } from '@fabrika/runner-cloudflare'
import { createControlRepositories } from './db'
import type { Env } from './env'
import type { DeployJobMessage } from './run-lifecycle'
import { repoSource } from './services'

/**
 * The control-plane Worker's raw Cloudflare bindings + vars/secrets — what `WorkerEntrypoint` fills
 * `this.env` with. It differs from `Env` in exactly the five handles and in nothing else: every var and
 * secret is inherited, so there is one place to add one.
 */
export interface WorkerBindings
	extends Omit<Env, 'DB' | 'REPOSITORIES' | 'ASSETS' | 'RUN_LOGS' | 'DEPLOY_QUEUE' | 'WAIT_UNTIL' | 'IAM' | 'IAM_ADMIN'>
{
	/** Registry + run history + vault + deploy locks. Migrations in `./migrations` (SQLite dialect). */
	DB: D1Database
	/** Control-plane SPA static assets. */
	ASSETS: Fetcher
	/** R2 bucket run logs + terminal status are written into (by vozka-runner), keyed by run id. */
	RUN_LOGS: R2Bucket
	/** Deploy job queue — producer here, consumer via the Worker's `queue()` handler. */
	DEPLOY_QUEUE: Queue<DeployJobMessage>
	/** The single Cloudflare account selected by this composition root. */
	CLOUDFLARE_ACCOUNT_ID?: string
	/** Account-wide deploy credential. It is passed to the runner only for a live deploy. */
	CLOUDFLARE_API_TOKEN?: string
	/**
	 * vozka-runner — the deploy EXECUTOR, over a service binding. Split into its own worker so a deploy
	 * of fabrika never resets the container running that deploy. OPTIONAL because it is declared
	 * off-local only (local dev has no runner worker, mirroring the IAM binding).
	 */
	RUNNER_SVC?: Service<VozkaRunner>
	/** IAM RPC and HTTP admin transport share one service binding. */
	IAM?: IamRpc & HttpService
	/** @deprecated Raw aliases accepted while existing Worker environments migrate to ADR-0018. */
	VOZKA_DOMAIN?: string
	VOZKA_BOOTSTRAP_ADMINS?: string
	VOZKA_VAULT_KEY?: string
	PROPUSTKA_URL?: string
	PROPUSTKA_PROVISIONING_KEY?: string
}

type ControlEnvironmentAliasSource = Pick<
	WorkerBindings,
	| 'FABRIKA_CONTROL_DOMAIN'
	| 'FABRIKA_CONTROL_BOOTSTRAP_ADMINS'
	| 'FABRIKA_CONTROL_VAULT_KEY'
	| 'FABRIKA_IAM_URL'
	| 'FABRIKA_IAM_PROVISIONING_KEY'
	| 'VOZKA_DOMAIN'
	| 'VOZKA_BOOTSTRAP_ADMINS'
	| 'VOZKA_VAULT_KEY'
	| 'PROPUSTKA_URL'
	| 'PROPUSTKA_PROVISIONING_KEY'
>

type ResolvedControlEnvironmentAliases = Pick<
	Env,
	| 'FABRIKA_CONTROL_DOMAIN'
	| 'FABRIKA_CONTROL_BOOTSTRAP_ADMINS'
	| 'FABRIKA_CONTROL_VAULT_KEY'
	| 'FABRIKA_IAM_URL'
	| 'FABRIKA_IAM_PROVISIONING_KEY'
>

/** Normalize raw Worker configuration before shared code or providers consume it. */
export function resolveControlEnvironmentAliases(source: ControlEnvironmentAliasSource): ResolvedControlEnvironmentAliases {
	const controlDomain = environmentAliases.read(source, { canonical: 'FABRIKA_CONTROL_DOMAIN', legacy: 'VOZKA_DOMAIN' })
	const bootstrapAdmins = environmentAliases.read(source, {
		canonical: 'FABRIKA_CONTROL_BOOTSTRAP_ADMINS',
		legacy: 'VOZKA_BOOTSTRAP_ADMINS',
	})
	const vaultKey = environmentAliases.read(source, { canonical: 'FABRIKA_CONTROL_VAULT_KEY', legacy: 'VOZKA_VAULT_KEY' })
	const iamUrl = environmentAliases.read(source, { canonical: 'FABRIKA_IAM_URL', legacy: 'PROPUSTKA_URL' })
	const iamProvisioningKey = environmentAliases.read(source, {
		canonical: 'FABRIKA_IAM_PROVISIONING_KEY',
		legacy: 'PROPUSTKA_PROVISIONING_KEY',
	})
	return {
		...(controlDomain === undefined ? {} : { FABRIKA_CONTROL_DOMAIN: controlDomain }),
		...(bootstrapAdmins === undefined ? {} : { FABRIKA_CONTROL_BOOTSTRAP_ADMINS: bootstrapAdmins }),
		...(vaultKey === undefined ? {} : { FABRIKA_CONTROL_VAULT_KEY: vaultKey }),
		...(iamUrl === undefined ? {} : { FABRIKA_IAM_URL: iamUrl }),
		...(iamProvisioningKey === undefined ? {} : { FABRIKA_IAM_PROVISIONING_KEY: iamProvisioningKey }),
	}
}

/** Provider options must come from the normalized environment, never the raw Worker bindings. */
export function cloudflareIamControlOptions(
	env: Pick<Env, 'FABRIKA_IAM_URL' | 'FABRIKA_IAM_PROVISIONING_KEY'>,
): { propustkaUrl?: string; propustkaProvisioningKey?: string } {
	return {
		...(env.FABRIKA_IAM_URL === undefined ? {} : { propustkaUrl: env.FABRIKA_IAM_URL }),
		...(env.FABRIKA_IAM_PROVISIONING_KEY === undefined
			? {}
			: { propustkaProvisioningKey: env.FABRIKA_IAM_PROVISIONING_KEY }),
	}
}

/** Present the Worker's bindings as the runtime-neutral `Env` the shared layer consumes. */
export function controlEnv(bindings: WorkerBindings, waitUntil: Env['WAIT_UNTIL']): Env {
	return {
		...bindings,
		DB: bindings.DB,
		REPOSITORIES: createControlRepositories(bindings.DB),
		ASSETS: bindings.ASSETS,
		RUN_LOGS: r2BlobStore(bindings.RUN_LOGS),
		DEPLOY_QUEUE: cfJobQueue(bindings.DEPLOY_QUEUE),
		WAIT_UNTIL: waitUntil,
		...(bindings.IAM === undefined ? {} : { IAM: bindings.IAM, IAM_ADMIN: bindings.IAM }),
		...resolveControlEnvironmentAliases(bindings),
	}
}

/** Present an R2 bucket as a `BlobStore` (the control plane reads run logs; vozka-runner writes them). */
export function r2BlobStore(bucket: R2Bucket): BlobStore {
	return {
		async put(key, value) {
			await bucket.put(key, value)
		},
		get(key) {
			return bucket.get(key)
		},
		async delete(key) {
			await bucket.delete(key)
		},
	}
}

/** Present a Cloudflare Queue producer as a `JobQueue`. `delaySeconds` maps straight onto CF's option. */
export function cfJobQueue<T>(queue: Queue<T>): JobQueue<T> {
	return {
		async send(message, options) {
			await queue.send(message, options)
		},
	}
}

const runner = (bindings: WorkerBindings): Service<VozkaRunner> => {
	if (bindings.RUNNER_SVC === undefined) {
		throw new Error('Cloudflare provider requires the RUNNER_SVC service binding')
	}
	return bindings.RUNNER_SVC
}

const required = (value: string | undefined, name: string): string => {
	if (value === undefined || value === '') {
		throw new Error(`Cloudflare provider requires ${name}`)
	}
	return value
}

const resolveSource = async (env: Env, source: ProviderSource) => {
	const target = await repoSource(env).clone(
		source.repoUrl,
		source.ref,
		source.githubInstallationId,
	)
	return { repoUrl: target.cloneUrl, ref: target.ref }
}

const startRun = async (
	bindings: WorkerBindings,
	job: CloudflareRunnerJob,
): Promise<ProviderTerminalOutcome> => {
	const result = await runner(bindings).startRun(job)
	const state = result.status.state === 'succeeded' ? 'succeeded' : 'failed'
	return {
		state,
		...(result.status.exitCode === undefined ? {} : { exitCode: result.status.exitCode }),
		...(result.status.artifactState === undefined ? {} : { artifactState: result.status.artifactState }),
	}
}

/** Compose the only provider available in the Cloudflare installation. */
export function cloudflareControlProvider(bindings: WorkerBindings, env: Env): ControlProvider {
	return createCloudflareControlProvider({
		accountId: bindings.CLOUDFLARE_ACCOUNT_ID ?? '',
		apiToken: bindings.CLOUDFLARE_API_TOKEN ?? '',
		...cloudflareIamControlOptions(env),
		resolveSource: (source) => resolveSource(env, source),
		startRun: (job) => {
			required(bindings.CLOUDFLARE_ACCOUNT_ID, 'CLOUDFLARE_ACCOUNT_ID')
			required(bindings.CLOUDFLARE_API_TOKEN, 'CLOUDFLARE_API_TOKEN')
			return startRun(bindings, job)
		},
		cancelRun: async (runId) => {
			await runner(bindings).cancelRun(runId)
		},
	})
}
