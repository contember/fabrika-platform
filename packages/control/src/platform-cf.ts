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
import { readEnvironmentName } from '@fabrika/auth-core'
import type { BlobStore, HttpService, JobQueue } from '@fabrika/platform'
import { type CloudflareRunnerJob, createCloudflareControlProvider } from '@fabrika/provider-cloudflare'
import type { CloudflareRunOutcome } from '@fabrika/provider-cloudflare/runner'
import type { ControlProvider, ProviderSource } from '@fabrika/provider-contract'
import type { RelayResult, VozkaRunner } from '@fabrika/runner-cloudflare'
import { createControlRepositories } from './db'
import type { Env } from './env'
import { controlPublicOrigin } from './iam'
import { GitHubAppRepoSource, type RepoSource } from './repo-source'
import type { ControlJobMessage } from './run-lifecycle'

/**
 * The control-plane Worker's raw Cloudflare bindings + vars/secrets — what `WorkerEntrypoint` fills
 * `this.env` with. GitHub App credentials stay in this adapter and are never copied into shared `Env`.
 */
export interface WorkerBindings
	extends Omit<Env, 'DB' | 'REPOSITORIES' | 'ASSETS' | 'RUN_LOGS' | 'DEPLOY_QUEUE' | 'WAIT_UNTIL' | 'REPO_EVENTS' | 'IAM' | 'IAM_ADMIN'>
{
	/** Registry + run history + vault + deploy locks. Migrations in `./migrations` (SQLite dialect). */
	DB: D1Database
	/** Control-plane SPA static assets. */
	ASSETS: Fetcher
	/** R2 bucket run logs + terminal status are written into (by vozka-runner), keyed by run id. */
	RUN_LOGS: R2Bucket
	/** Deploy job queue — producer here, consumer via the Worker's `queue()` handler. */
	DEPLOY_QUEUE: Queue<ControlJobMessage>
	/** The single Cloudflare account selected by this composition root. */
	CLOUDFLARE_ACCOUNT_ID?: string
	/** Account-wide deploy credential. It is passed to the runner only for a live deploy. */
	CLOUDFLARE_API_TOKEN?: string
	/** GitHub App webhook secret — HMAC-verifies inbound deliveries. */
	GITHUB_WEBHOOK_SECRET?: string
	/** GitHub App id used only by the Cloudflare source adapter. */
	GITHUB_APP_ID?: string
	/** GitHub App private key used only by the Cloudflare source adapter. */
	GITHUB_APP_PRIVATE_KEY?: string
	/**
	 * vozka-runner — the deploy EXECUTOR, over a service binding. Split into its own worker so a deploy
	 * of fabrika never resets the container running that deploy. OPTIONAL because it is declared
	 * off-local only (local dev has no runner worker, mirroring the IAM binding).
	 */
	RUNNER_SVC?: Service<VozkaRunner>
	/** IAM RPC and HTTP admin transport share one service binding. */
	IAM?: IamRpc & HttpService
}

/** Provider options must come from the `Env` the shared layer consumes, never the raw Worker bindings. */
export function cloudflareIamControlOptions(
	env: Pick<Env, 'FABRIKA_IAM_ISSUER' | 'FABRIKA_IAM_PROVISIONING_KEY'>,
): { propustkaUrl?: string; propustkaProvisioningKey?: string } {
	return {
		...(env.FABRIKA_IAM_ISSUER === undefined ? {} : { propustkaUrl: env.FABRIKA_IAM_ISSUER }),
		...(env.FABRIKA_IAM_PROVISIONING_KEY === undefined
			? {}
			: { propustkaProvisioningKey: env.FABRIKA_IAM_PROVISIONING_KEY }),
	}
}

/** Present the Worker's bindings as the runtime-neutral `Env` the shared layer consumes. */
export function controlEnv(bindings: WorkerBindings, waitUntil: Env['WAIT_UNTIL']): Env {
	const { GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET, ...sharedBindings } = bindings
	return {
		...sharedBindings,
		// The Worker's equivalent of the process's boot check: a Worker has no boot, so the first request
		// is where a `local` claim from a publicly-served console fails. Same shape as IAM's `buildOidc`.
		ENVIRONMENT: readEnvironmentName(bindings.ENVIRONMENT, controlPublicOrigin(bindings)),
		DB: bindings.DB,
		REPOSITORIES: createControlRepositories(bindings.DB),
		ASSETS: bindings.ASSETS,
		RUN_LOGS: r2BlobStore(bindings.RUN_LOGS),
		DEPLOY_QUEUE: cfJobQueue(bindings.DEPLOY_QUEUE),
		WAIT_UNTIL: waitUntil,
		REPO_EVENTS: cloudflareRepoSource({ GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET }),
		...(bindings.IAM === undefined ? {} : { IAM: bindings.IAM, IAM_ADMIN: bindings.IAM }),
	}
}

function cloudflareRepoSource(bindings: Pick<WorkerBindings, 'GITHUB_APP_ID' | 'GITHUB_APP_PRIVATE_KEY' | 'GITHUB_WEBHOOK_SECRET'>): RepoSource {
	return new GitHubAppRepoSource({
		appId: bindings.GITHUB_APP_ID ?? '',
		privateKeyPem: bindings.GITHUB_APP_PRIVATE_KEY ?? '',
		webhookSecret: bindings.GITHUB_WEBHOOK_SECRET ?? '',
	})
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

/**
 * The slice of vozka-runner the control plane calls. A real `Service<VozkaRunner>` satisfies it
 * structurally; naming it keeps the two adapters below reachable without a Workers RPC stub.
 */
export interface CloudflareRunnerService {
	startRun(job: CloudflareRunnerJob): Promise<RelayResult>
	cancelRun(runId: string, runnerKey: string): Promise<unknown>
}

const runner = (bindings: WorkerBindings): CloudflareRunnerService => {
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

const resolveSource = async (bindings: WorkerBindings, source: ProviderSource, signal: AbortSignal) => {
	const target = await cloudflareRepoSource(bindings).clone(
		source.repoUrl,
		source.ref,
		source.githubInstallationId,
		signal,
	)
	return { repoUrl: target.cloneUrl, ref: target.ref }
}

/** The executor's IAM reconcile rides back on the outcome: the container compiles the schema, the control plane applies it. */
export const startRunOnRunner = async (
	svc: CloudflareRunnerService,
	job: CloudflareRunnerJob,
): Promise<CloudflareRunOutcome> => {
	const result = await svc.startRun(job)
	const state = result.status.state === 'succeeded' ? 'succeeded' : 'failed'
	return {
		state,
		...(result.status.exitCode === undefined ? {} : { exitCode: result.status.exitCode }),
		...(result.status.artifactState === undefined ? {} : { artifactState: result.status.artifactState }),
		...(result.status.iamReconcile === undefined ? {} : { iamReconcile: result.status.iamReconcile }),
	}
}

/** A cancel destroys a container and fails a run, so it presents the same key a job carries — and refuses without one. */
export const cancelRunOnRunner = async (
	svc: CloudflareRunnerService,
	runId: string,
	runnerKey: string | undefined,
): Promise<void> => {
	await svc.cancelRun(runId, required(runnerKey, 'FABRIKA_RUNNER_KEY'))
}

/** Compose the only provider available in the Cloudflare installation. */
export function cloudflareControlProvider(bindings: WorkerBindings, env: Env): ControlProvider {
	return createCloudflareControlProvider({
		accountId: bindings.CLOUDFLARE_ACCOUNT_ID ?? '',
		apiToken: bindings.CLOUDFLARE_API_TOKEN ?? '',
		...cloudflareIamControlOptions(env),
		runnerKey: env.FABRIKA_RUNNER_KEY ?? '',
		resolveSource: (source, signal) => resolveSource(bindings, source, signal),
		startRun: (job) => {
			required(bindings.CLOUDFLARE_ACCOUNT_ID, 'CLOUDFLARE_ACCOUNT_ID')
			required(bindings.CLOUDFLARE_API_TOKEN, 'CLOUDFLARE_API_TOKEN')
			required(env.FABRIKA_RUNNER_KEY, 'FABRIKA_RUNNER_KEY')
			return startRunOnRunner(runner(bindings), job)
		},
		cancelRun: (runId) => cancelRunOnRunner(runner(bindings), runId, env.FABRIKA_RUNNER_KEY),
	})
}
