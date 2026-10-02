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
// `cancelRun(runId, runnerKey)` destroys an in-flight run's container and records it failed. There is
// no HTTP surface; vozka-runner has no public route and is reachable ONLY via the binding — but the
// binding is not a credential, so BOTH methods verify `FABRIKA_RUNNER_KEY` first (see runner-key.ts).

import { type CloudflareRunnerJob, isCloudflareRunnerJob } from '@fabrika/provider-cloudflare/runner'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { finishRun } from './finish-run'
import { type ContainerLike, type RelayResult, relayRun } from './relay'
import { assertRunnerKey } from './runner-key'
import type { Env } from './worker-env'

export { RunnerContainer } from './RunnerContainer'

/** The same run-id shape `isCloudflareRunnerJob` enforces — a cancel addresses a container by it too. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class VozkaRunner extends WorkerEntrypoint<Env> {
	/**
	 * Execute one deploy run: address a fresh container instance for this `runId`, wait for its server
	 * to come up, relay the job through it (logs + status → R2), then record the terminal status → D1.
	 * Returns the terminal status to the caller — best-effort, since the caller may have been reset
	 * mid-deploy; the D1 write is what guarantees the run is recorded regardless.
	 *
	 * The shape check comes first because RPC delivers a structured clone: the argument is typed here
	 * but arrives as whatever the caller sent, and `job.runnerKey` must be a string to be compared.
	 */
	async startRun(job: CloudflareRunnerJob): Promise<RelayResult> {
		if (!isCloudflareRunnerJob(job)) {
			throw new Error('runner: invalid job')
		}
		// The key is OPTIONAL to the validator, because the relay strips it before the container hop.
		// It is not optional here: this is the hop it authenticates.
		if (typeof job.runnerKey !== 'string') {
			throw new Error('runner: unauthorized')
		}
		await assertRunnerKey(this.env.FABRIKA_RUNNER_KEY, job.runnerKey)

		const id = this.env.RUNNER.idFromName(job.runId)
		const container = this.env.RUNNER.get(id)
		await container.startDeploy(job.runId)
		const relayable: ContainerLike = {
			containerFetch: (input, init) => container.deployFetch(input, init),
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
	 * call recorded the terminal status (false if the run was already finished). `runnerKey` is the same
	 * shared secret a job carries — a cancel destroys a container and fails a run, so it is not weaker.
	 */
	async cancelRun(runId: string, runnerKey: string): Promise<boolean> {
		await assertRunnerKey(this.env.FABRIKA_RUNNER_KEY, runnerKey)
		if (typeof runId !== 'string' || !UUID.test(runId)) {
			throw new Error('runner: invalid run id')
		}

		const container = this.env.RUNNER.get(this.env.RUNNER.idFromName(runId))
		await container.cancelDeploy()
		return finishRun(this.env.DB, runId, 'failed', null)
	}

	async recoverRun(runId: string, runnerKey: string): Promise<'running' | 'failed'> {
		await assertRunnerKey(this.env.FABRIKA_RUNNER_KEY, runnerKey)
		if (typeof runId !== 'string' || !UUID.test(runId)) throw new Error('runner: invalid run id')
		return this.env.RUNNER.get(this.env.RUNNER.idFromName(runId)).recoverDeploy()
	}

	// vozka-runner is RPC-only (invoked via the RUNNER_SVC service binding). It has no public route;
	// a stray direct request just gets a 404 rather than crashing the worker.
	override fetch(): Response {
		return new Response('vozka-runner: rpc only', { status: 404 })
	}
}

export default VozkaRunner
