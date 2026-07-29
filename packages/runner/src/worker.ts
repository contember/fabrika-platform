// The vozka-runner Worker — the deploy EXECUTOR, split out of the fabrika control plane.
//
// WHY IT'S SEPARATE: a deploy's final step is `wrangler deploy` of the target worker, run INSIDE the
// per-run container. When the target is fabrika itself, that resets fabrika's Durable Objects — and the
// container is a DO. So a fabrika self-deploy used to reset the very container running it, killing the
// relay and orphaning the run. Hosting the container DO + relay in this SEPARATE worker means a deploy
// of fabrika never touches vozka-runner: the container survives, the relay finishes, the status lands.
//
// SURFACE: two RPC methods invoked by the control plane over a service binding (`RUNNER_SVC`) —
// `startRun(job)` boots a fresh container, relays its logs → R2, and writes the terminal status → D1
// itself (the backstop that records the run even if the caller was reset — see finish-run.ts); and
// `cancelRun(runId)` destroys an in-flight run's container and records it failed. There is no HTTP
// surface; vozka-runner has no public route and is reachable ONLY via the binding.

import type { CloudflareRunnerJob } from '@fabrika/provider-cloudflare'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { finishRun } from './finish-run'
import { type ContainerLike, type RelayResult, relayRun } from './relay'
import type { Env } from './worker-env'

export { RunnerContainer } from './RunnerContainer'

export class VozkaRunner extends WorkerEntrypoint<Env> {
	/**
	 * Execute one deploy run: address a fresh container instance for this `runId`, wait for its server
	 * to come up, relay the job through it (logs + status → R2), then record the terminal status → D1.
	 * Returns the terminal status to the caller — best-effort, since the caller may have been reset
	 * mid-deploy; the D1 write is what guarantees the run is recorded regardless.
	 */
	async startRun(job: CloudflareRunnerJob): Promise<RelayResult> {
		const id = this.env.RUNNER.idFromName(job.runId)
		const container = this.env.RUNNER.get(id)
		await container.startAndWaitForPorts()
		// Arm the backstop BEFORE the long relay: the container DO will record the terminal status on its
		// own (caller-independent) schedule if this RPC is aborted mid-deploy — which is exactly what a
		// fabrika self-deploy does (it resets fabrika, killing this RPC). The relay's fast path still wins when
		// it survives; the backstop's write is idempotent (see RunnerContainer.armBackstop / finish-run).
		await container.armBackstop(job.runId)
		const relayable: ContainerLike = {
			containerFetch: (input, init) => container.containerFetch(input, init),
			heartbeat: () => container.heartbeat(),
		}
		const result = await relayRun(relayable, this.env.RUN_LOGS, job)

		// Persist the terminal outcome to D1 directly. The guarded UPDATE is idempotent, so if the
		// control plane is still alive and also records it, whichever writes first wins and the other
		// no-ops. Never log the error object on failure — a job/clone URL could carry a token.
		const state = result.status.state === 'succeeded' ? 'succeeded' : 'failed'
		try {
			await finishRun(this.env.DB, job.runId, state, result.status.exitCode ?? null)
		} catch (err) {
			console.error('vozka-runner: failed to record terminal run status', err instanceof Error ? err.message : 'unknown error')
		}
		return result
	}

	/**
	 * Cancel an in-flight run: DESTROY its container (kills the deploy child mid-flight — the in-flight
	 * `startRun` relay then errors out and its `finishRun` no-ops on the guard) and record the run failed.
	 * Idempotent — a run already terminal stays as-is (finishRun's `WHERE status IN ('pending','running')`).
	 * Invoked by the control plane over `RUNNER_SVC` when an operator cancels a run. Returns whether THIS
	 * call recorded the terminal status (false if the run was already finished).
	 */
	async cancelRun(runId: string): Promise<boolean> {
		const container = this.env.RUNNER.get(this.env.RUNNER.idFromName(runId))
		try {
			await container.destroy()
		} catch (err) {
			// The container may already be gone (hard-killed / never booted) — cancel still records the run.
			console.error('vozka-runner: cancel destroy failed', err instanceof Error ? err.message : 'unknown error')
		}
		return finishRun(this.env.DB, runId, 'failed', null)
	}

	// vozka-runner is RPC-only (invoked via the RUNNER_SVC service binding). It has no public route;
	// a stray direct request just gets a 404 rather than crashing the worker.
	override fetch(): Response {
		return new Response('vozka-runner: rpc only', { status: 404 })
	}
}

export default VozkaRunner
