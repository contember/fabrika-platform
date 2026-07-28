import type { RelayResult, RunnerJob } from '@fabrika/runner'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { runDeployJob } from './consumer'
import { runMaintenance } from './cron'
import type { RunRow } from './db'
import type { Env } from './env'
import { controlEnv, type WorkerBindings } from './platform-cf'
import { handleFetch } from './routes'
import type { DeployJobMessage } from './run-lifecycle'
import { cancelRun, startRun } from './services'

/**
 * The fabrika control plane — the CLOUDFLARE entrypoint, and nothing more. A single `WorkerEntrypoint`
 * carrying `startRun`/`cancelRun` (the RPC surface), `fetch`, `queue` (the deploy consumer) and
 * `scheduled` (the repo poll + stale-run sweep).
 *
 * There is no logic here. Every method delegates to a runtime-neutral function — `handleFetch`
 * (src/routes.ts), `runDeployJob` (src/consumer.ts), `runMaintenance` (src/cron.ts), `startRun` /
 * `cancelRun` (src/services.ts) — the same functions the Bun entrypoint (src/node/server.ts) calls.
 * This file's whole job is to bind `cloudflare:workers` to them, and it is the ONLY file in the
 * package that imports it: the Bun process must never load this module, and it must never load
 * `bun:*`/`node:*`. `src/__tests__/entrypoint-isolation.test.ts` walks both graphs and enforces that.
 *
 * `controlEnv` is what makes one `Env` serve both: it presents the raw bindings (`this.env`) as the
 * ports everything downstream is written against. Two of the five need no adapter at all.
 */
export class Vozka extends WorkerEntrypoint<WorkerBindings> {
	/** The runtime-neutral view of this Worker's bindings. Cheap — three closures and a spread. */
	private get control(): Env {
		return controlEnv(this.env)
	}

	/**
	 * Start one deploy run by handing it to vozka-runner (the deploy EXECUTOR) over the `RUNNER_SVC`
	 * service binding. The queue consumer drives this; it's also reachable via the M2 `POST /api/runs`
	 * compatibility route.
	 */
	startRun(job: RunnerJob): Promise<RelayResult> {
		return startRun(this.control, job)
	}

	/** Cancel an in-flight run: destroy its container, record it failed, free the per-app-env lock. */
	cancelRun(run: RunRow): Promise<void> {
		return cancelRun(this.control, run)
	}

	override fetch(request: Request): Promise<Response> {
		return handleFetch(request, this.control)
	}

	/**
	 * The deploy consumer. One run per message (maxBatchSize 1). ack on a handled run — including a
	 * `deferred` one, whose re-enqueue `runDeployJob` has already done; retry only on an unexpected
	 * throw (Cloudflare redelivers, bounded by the queue's maxRetries).
	 */
	override async queue(batch: MessageBatch<DeployJobMessage>): Promise<void> {
		const env = this.control
		for (const message of batch.messages) {
			try {
				await runDeployJob(env, message.body)
				message.ack()
			} catch (err) {
				console.error('deploy consumer error', err instanceof Error ? err.message : 'unknown error')
				message.retry()
			}
		}
	}

	/** The cron handler (`triggers.crons`, every 5 min): poll public repos, then sweep orphaned runs. */
	override async scheduled(_controller: ScheduledController): Promise<void> {
		await runMaintenance(this.control)
	}
}

export default Vozka
