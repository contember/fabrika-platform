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
import { type AppEnvironment, readEnvironmentName } from '@fabrika/auth-core'
import { pickEmailEnvironment } from '@fabrika/email'
import { builtinEmailProviders } from '@fabrika/email/providers'
import type { GitHubAppFetch } from '@fabrika/github-app'
import type { BlobStore, HttpService, JobQueue } from '@fabrika/platform'
import {
	type CloudflareControlOptions,
	type CloudflareRunnerJob,
	type CloudflareRunOutcome,
	type CloudflareRunRecovery,
	createCloudflareControlProvider,
} from '@fabrika/provider-cloudflare/runner'
import type { ControlProvider, ProviderSourceBinding } from '@fabrika/provider-contract'
import { type RelayResult, type RunnerStatus, runnerStatusSchema, type VozkaRunner } from '@fabrika/runner-cloudflare'
import { z } from 'zod'
import { type ControlRepositories, createControlRepositories } from './db'
import type { Env } from './env'
import { gitHubAppClientFactory, vaultGitHubCredentials } from './github/connections/credentials'
import { gitHubCommitSource } from './github/source/commit-files'
import { SourceFailure } from './github/source/failure'
import { GitHubMetadataClient, type GitHubMetadataFetch } from './github/source/metadata'
import type { SourceRepository } from './github/source/types'
import { controlPublicOrigin } from './iam'
import { CLOUDFLARE_MAIL_REMEDY, readInstallationMail } from './mail-transport'
import type { ControlJobMessage } from './run-lifecycle'

/** The control-plane Worker's raw Cloudflare bindings + vars/secrets — what `WorkerEntrypoint` fills `this.env` with. */
export interface WorkerBindings
	extends Omit<Env, 'DB' | 'REPOSITORIES' | 'ASSETS' | 'RUN_LOGS' | 'DEPLOY_QUEUE' | 'WAIT_UNTIL' | 'IAM' | 'IAM_ADMIN' | 'MAIL_TRANSPORT'>
{
	/**
	 * The installation's mail transport: these Worker vars and the provider's own `FABRIKA_EMAIL_*` (its credentials as
	 * Worker secrets), all written by Control's own deploy from the installation's GitHub Environment (`fabrika.config.ts`).
	 * The provider's variables belong to an open registry, so `controlEnv` reads them by prefix (`pickEmailEnvironment`).
	 */
	FABRIKA_EMAIL_PROVIDER?: string
	FABRIKA_EMAIL_FROM?: string
	FABRIKA_EMAIL_FROM_NAME?: string
	/** Registry + run history + vault + deploy locks. Migrations in `./migrations` (SQLite dialect). */
	DB: D1Database
	/** Control-plane SPA static assets. */
	ASSETS: Fetcher
	/** R2 bucket vozka-runner writes run logs + terminal status into, keyed by run id. */
	RUN_LOGS: R2Bucket
	/** Deploy job queue — producer here, consumer via the Worker's `queue()` handler. */
	DEPLOY_QUEUE: Queue<ControlJobMessage>
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
}

/** Present the Worker's bindings as the runtime-neutral `Env` the shared layer consumes. */
export function controlEnv(bindings: WorkerBindings, waitUntil: Env['WAIT_UNTIL']): Env {
	const env: Env = {
		...bindings,
		// The Worker's equivalent of the process's boot check: a Worker has no boot, so the first request
		// is where a `local` claim from a publicly-served console fails. Same shape as IAM's `buildOidc`.
		ENVIRONMENT: readEnvironmentName(bindings.ENVIRONMENT, controlPublicOrigin(bindings)),
		DB: bindings.DB,
		REPOSITORIES: createControlRepositories(bindings.DB),
		ASSETS: bindings.ASSETS,
		RUN_LOGS: r2BlobStore(bindings.RUN_LOGS),
		DEPLOY_QUEUE: cfJobQueue(bindings.DEPLOY_QUEUE),
		WAIT_UNTIL: waitUntil,
		...(bindings.IAM === undefined ? {} : { IAM: bindings.IAM, IAM_ADMIN: bindings.IAM }),
		// A Worker has no boot to log an invalid transport at: the deploys that need it are refused, naming the variables.
		MAIL_TRANSPORT: readInstallationMail(pickEmailEnvironment(bindings), builtinEmailProviders, CLOUDFLARE_MAIL_REMEDY),
	}
	return { ...env, COMMITS: gitHubCommitSource(new GitHubMetadataClient({}), vaultGitHubCredentials(env, { createClient: gitHubAppClientFactory() })) }
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
	recoverRun(runId: string, runnerKey: string): Promise<RunnerStatus | null>
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

// Checked before external acceptance: a run accepted without a reachable runner could never settle.
const requireRunner = (bindings: WorkerBindings, env: Env): CloudflareRunnerService => {
	required(bindings.CLOUDFLARE_ACCOUNT_ID, 'CLOUDFLARE_ACCOUNT_ID')
	required(bindings.CLOUDFLARE_API_TOKEN, 'CLOUDFLARE_API_TOKEN')
	required(env.FABRIKA_RUNNER_KEY, 'FABRIKA_RUNNER_KEY')
	return runner(bindings)
}

// The runner is a separately deployed Worker: parse what its RPC returns rather than trust the type.
const relayResultSchema = z.object({ status: runnerStatusSchema })
const recoveredStatusSchema = runnerStatusSchema.nullable()

/** The executor's IAM reconcile rides back on the outcome: the container compiles the schema, the control plane applies it. */
const runOutcome = (status: RunnerStatus): CloudflareRunRecovery => {
	if (status.state !== 'succeeded' && status.state !== 'failed') return { state: 'running' }
	return {
		state: status.state,
		...(status.exitCode === undefined ? {} : { exitCode: status.exitCode }),
		...(status.artifactState === undefined ? {} : { artifactState: status.artifactState }),
		...(status.iamReconcile === undefined ? {} : { iamReconcile: status.iamReconcile }),
		...(status.dryRun === true ? { dryRun: true } : {}),
	}
}

export const startRunOnRunner = async (
	svc: CloudflareRunnerService,
	job: CloudflareRunnerJob,
): Promise<CloudflareRunOutcome> => {
	const parsed = relayResultSchema.safeParse(await svc.startRun(job))
	if (!parsed.success) throw new Error('Cloudflare runner returned a malformed run result')
	const outcome = runOutcome(parsed.data.status)
	if (outcome.state === 'running') throw new Error('Cloudflare runner returned a non-terminal run result')
	return outcome
}

/** After a control-plane restart the runner's persisted status is the run's outcome; null means still in flight. */
export const recoverRunOnRunner = async (
	svc: CloudflareRunnerService,
	runId: string,
	runnerKey: string | undefined,
): Promise<CloudflareRunRecovery> => {
	const parsed = recoveredStatusSchema.safeParse(await svc.recoverRun(runId, required(runnerKey, 'FABRIKA_RUNNER_KEY')))
	if (!parsed.success) throw new Error('Cloudflare runner returned a malformed recovery status')
	return parsed.data === null ? { state: 'running' } : runOutcome(parsed.data)
}

/** A cancel destroys a container and fails a run, so it presents the same key a job carries — and refuses without one. */
export const cancelRunOnRunner = async (
	svc: CloudflareRunnerService,
	runId: string,
	runnerKey: string | undefined,
): Promise<void> => {
	await svc.cancelRun(runId, required(runnerKey, 'FABRIKA_RUNNER_KEY'))
}

/** Transport seams only tests inject; the GitHub origins stay fixed (ADR-0029). */
export interface CloudflareSourceSeams {
	readonly metadataFetch?: GitHubMetadataFetch
	readonly githubAppFetch?: GitHubAppFetch
}

/**
 * Exact-commit resolution and the runner's clone URL. A private source mints a repository-scoped
 * installation token from its bound connection's vault-held App key; a public one stays anonymous.
 */
export function cloudflareGitHubSource(
	env: Env,
	seams: CloudflareSourceSeams = {},
): Pick<CloudflareControlOptions, 'resolveSource' | 'prepareClone'> {
	const credentials = vaultGitHubCredentials(env, { createClient: gitHubAppClientFactory(seams.githubAppFetch) })
	const metadata = new GitHubMetadataClient(seams.metadataFetch === undefined ? {} : { fetch: seams.metadataFetch })
	const repositoryToken = (repository: SourceRepository, binding: ProviderSourceBinding | undefined, signal: AbortSignal) =>
		binding === undefined
			? credentials.ownerConnectionToken({ repository, signal })
			: credentials.repositoryToken({ connectionId: binding.connectionId, installationId: binding.installationId, repository, signal })
	return {
		resolveSource: async (input) => {
			input.signal.throwIfAborted()
			const repository = canonicalRepository(input.app.source.repoUrl)
			try {
				const pushedBranch = input.expectedCommitSha !== undefined && input.app.source.ref.startsWith('refs/heads/')
					&& (await branchTriggered(env.REPOSITORIES, input.runId))
				const token = await repositoryToken(repository, input.sourceBinding, input.signal)
				if (pushedBranch) {
					// The branch must still point at the pushed commit, as Zerops checks: else a newer push has a run of its own.
					const head = await metadata.commit(repository, input.app.source.ref, token, input.signal, 'resolve')
					if (head !== input.expectedCommitSha) throw new SourceFailure('commit_mismatch', 'resolve')
					return { commitSha: head }
				}
				const commitSha = await metadata.commit(repository, input.expectedCommitSha ?? input.app.source.ref, token, input.signal, 'resolve')
				return { commitSha }
			} catch (error) {
				// The deployment's own abort reason (lease lost, cancel requested) outranks the source's `cancelled`.
				input.signal.throwIfAborted()
				throw error
			}
		},
		prepareClone: async (source, signal, binding) => {
			signal.throwIfAborted()
			const repository = canonicalRepository(source.repoUrl)
			const cloneUrl = new URL(`https://github.com/${repository.owner}/${repository.name}`)
			try {
				const token = await repositoryToken(repository, binding, signal)
				if (token !== undefined) {
					// x-access-token is GitHub's documented installation-token clone scheme.
					cloneUrl.username = 'x-access-token'
					cloneUrl.password = token
				}
			} catch (error) {
				signal.throwIfAborted()
				throw error
			}
			return { repoUrl: cloneUrl.toString() }
		},
	}
}

/** A webhook or poll run recorded the commit a push left on its branch; a manual run pins the commit it names. */
async function branchTriggered(repositories: Pick<ControlRepositories, 'runs'>, runId: string): Promise<boolean> {
	const run = await repositories.runs.getRun(runId)
	return run?.trigger === 'webhook' || run?.trigger === 'poll'
}

/** The registry stores `github.com/<owner>/<repo>`; anything else never becomes a clone destination. */
function canonicalRepository(repoUrl: string): SourceRepository {
	const match = /^github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?$/.exec(repoUrl)
	const owner = match?.[1]
	const name = match?.[2]
	if (owner === undefined || name === undefined || owner === '.' || owner === '..' || name === '.' || name === '..') {
		throw new Error('invalid canonical GitHub repository')
	}
	return { owner, name }
}

/** Every Cloudflare deployment in the registry. A deploy refuses the names of every other application among them (ADR-0048). */
export async function cloudflareDeployments(repositories: Pick<ControlRepositories, 'registry'>): Promise<AppEnvironment[]> {
	const rows = await repositories.registry.listAppEnvsByProvider('cloudflare')
	return rows.map((row) => ({ app: row.app_id, env: row.env }))
}

/** Compose the only provider available in the Cloudflare installation. */
export function cloudflareControlProvider(bindings: WorkerBindings, env: Env, seams: CloudflareSourceSeams = {}): ControlProvider {
	const source = cloudflareGitHubSource(env, seams)
	return createCloudflareControlProvider({
		accountId: bindings.CLOUDFLARE_ACCOUNT_ID ?? '',
		apiToken: bindings.CLOUDFLARE_API_TOKEN ?? '',
		runnerKey: env.FABRIKA_RUNNER_KEY ?? '',
		installationApps: () => cloudflareDeployments(env.REPOSITORIES),
		resolveSource: source.resolveSource,
		prepareClone: async (selected, signal, sourceBinding) => {
			const clone = await source.prepareClone(selected, signal, sourceBinding)
			requireRunner(bindings, env)
			return clone
		},
		startRun: (job) => startRunOnRunner(requireRunner(bindings, env), job),
		cancelRun: (runId) => cancelRunOnRunner(runner(bindings), runId, env.FABRIKA_RUNNER_KEY),
		recoverRun: (runId) => recoverRunOnRunner(runner(bindings), runId, env.FABRIKA_RUNNER_KEY),
	})
}
