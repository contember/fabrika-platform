// The CLOUDFLARE side of the platform seam: the raw binding shape `wrangler` hands the Worker, and the
// adapters that present it as the runtime-neutral `Env` (src/env.ts) everything else is written against.
//
// This file is Cloudflare-only and is imported by `src/index.ts` alone. It lives HERE, with the worker
// that uses it, not in @fabrika/platform (which is types only) — the port declares the capability, the
// worker binds it to whatever the runtime actually offers.
//
// Two of the five handles need no adapter: `D1Database` satisfies `SqlDatabase` and `Fetcher` satisfies
// `AssetServer` structurally, because those ports were shaped from those bindings deliberately. The
// other three are pure shape-narrowing: R2, Queues and the runner service already do exactly what
// `BlobStore` / `JobQueue` / `RunnerGateway` describe, they just report richer results (`R2Object`,
// `QueueSendResponse`) than the ports promise, so the bindings do not satisfy them structurally.
// Awaiting and discarding those results is the whole adapter — there is no behaviour here to keep in
// sync with anything.

import type { BlobStore, JobQueue } from '@fabrika/platform'
import type { VozkaRunner } from '@fabrika/runner'
import type { Env, RunnerGateway } from './env'
import type { DeployJobMessage } from './run-lifecycle'

/**
 * The control-plane Worker's raw Cloudflare bindings + vars/secrets — what `WorkerEntrypoint` fills
 * `this.env` with. It differs from `Env` in exactly the five handles and in nothing else: every var and
 * secret is inherited, so there is one place to add one.
 */
export interface WorkerBindings extends Omit<Env, 'DB' | 'ASSETS' | 'RUN_LOGS' | 'DEPLOY_QUEUE' | 'RUNNER'> {
	/** Registry + run history + vault + deploy locks. Migrations in `./migrations` (SQLite dialect). */
	DB: D1Database
	/** Control-plane SPA static assets. */
	ASSETS: Fetcher
	/** R2 bucket run logs + terminal status are written into (by vozka-runner), keyed by run id. */
	RUN_LOGS: R2Bucket
	/** Deploy job queue — producer here, consumer via the Worker's `queue()` handler. */
	DEPLOY_QUEUE: Queue<DeployJobMessage>
	/**
	 * vozka-runner — the deploy EXECUTOR, over a service binding. Split into its own worker so a deploy
	 * of fabrika never resets the container running that deploy. OPTIONAL because it is declared
	 * off-local only (local dev has no runner worker, mirroring the IAM binding).
	 */
	RUNNER_SVC?: Service<VozkaRunner>
}

/** Present the Worker's bindings as the runtime-neutral `Env` the shared layer consumes. */
export function controlEnv(bindings: WorkerBindings): Env {
	return {
		...bindings,
		DB: bindings.DB,
		ASSETS: bindings.ASSETS,
		RUN_LOGS: r2BlobStore(bindings.RUN_LOGS),
		DEPLOY_QUEUE: cfJobQueue(bindings.DEPLOY_QUEUE),
		...(bindings.RUNNER_SVC !== undefined ? { RUNNER: serviceRunner(bindings.RUNNER_SVC) } : {}),
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

/** Present the vozka-runner service binding as the `RunnerGateway` port. */
export function serviceRunner(service: Service<VozkaRunner>): RunnerGateway {
	return {
		startRun(job) {
			return service.startRun(job)
		},
		async cancelRun(runId) {
			await service.cancelRun(runId)
		},
	}
}
