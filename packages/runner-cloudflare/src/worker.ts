// The runner Worker — the deploy EXECUTOR, split out of the fabrika control plane.
//
// WHY IT'S SEPARATE: a deploy's final step is `wrangler deploy` of the target worker, run INSIDE the
// per-run container. When the target is fabrika itself, that resets fabrika's Durable Objects — and the
// container is a DO. So a fabrika self-deploy used to reset the very container running it, killing the
// relay and orphaning the run. Hosting the container DO + relay in this SEPARATE worker means a deploy
// of fabrika never touches the runner Worker: the container survives, the relay finishes, the status lands.
//
// The control plane calls authenticated RPC methods over the `RUNNER_SVC` service binding:
// `startRun(job)` boots a fresh container, relays its logs and terminal status → R2, and returns the
// status; `recoverRun(runId, runnerKey)` reads that persisted status back after a control-plane restart;
// `cancelRun(runId, runnerKey)` destroys an in-flight run's container. The control plane is the only
// writer of the run's database row. There is no HTTP surface; the runner Worker has no public route and is
// reachable ONLY via the binding — but the binding is not a credential, so every method verifies
// `FABRIKA_RUNNER_KEY` first (see runner-key.ts).

import { type CloudflareRunnerJob, cloudflareRunnerJobSchema, type RunnerStatus } from '@fabrika/provider-cloudflare/runner'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { type ContainerLike, type RelayResult, relayRun } from './relay'
import { readTerminalStatus } from './run-outcome'
import { assertRunnerKey, runnerInstanceId } from './runner-key'
import type { RunnerContainer } from './RunnerContainer'
import type { Env } from './worker-env'

export { RunnerContainer } from './RunnerContainer'

/** The same run-id shape `cloudflareRunnerJobSchema` enforces — a cancel addresses a container by it too. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// A module function, not a method: workerd's RPC reaches every method of an entrypoint, private ones included.
const runContainer = async (env: Env, runId: string): Promise<DurableObjectStub<RunnerContainer>> =>
	env.RUNNER.get(await runnerInstanceId(env.RUNNER, env.FABRIKA_RUNNER_KEY, runId))

export class VozkaRunner extends WorkerEntrypoint<Env> {
	/**
	 * Execute one deploy run: address the container instance keyed to this `runId`, wait for its server
	 * to come up, relay the job through it (logs + status → R2), and return the terminal status. The
	 * caller may have been reset mid-deploy; the persisted status and the container's backstop are what
	 * let the control plane settle the run on its next reconcile.
	 *
	 * The shape check comes first because RPC delivers a structured clone: the argument is typed here
	 * but arrives as whatever the caller sent, and `job.runnerKey` must be a string to be compared.
	 */
	async startRun(input: CloudflareRunnerJob): Promise<RelayResult> {
		const parsed = cloudflareRunnerJobSchema.safeParse(input)
		if (!parsed.success) {
			throw new Error('runner: invalid job')
		}
		const job = parsed.data
		// The key is OPTIONAL to the validator, because the relay strips it before the container hop.
		// It is not optional here: this is the hop it authenticates.
		if (typeof job.runnerKey !== 'string') {
			throw new Error('runner: unauthorized')
		}
		await assertRunnerKey(this.env.FABRIKA_RUNNER_KEY, job.runnerKey)

		const container = await runContainer(this.env, job.runId)
		await container.startDeploy(job.runId, job.dryRun === true)
		const relayable: ContainerLike = {
			containerFetch: (input, init) => container.deployFetch(input, init),
			heartbeat: () => container.heartbeat(),
		}
		return relayRun(relayable, this.env.RUN_LOGS, job)
	}

	/**
	 * Cancel an in-flight run: DESTROY its container (kills the deploy child mid-flight — the in-flight
	 * `startRun` relay then errors out). Idempotent. The control plane records the cancellation itself.
	 * `runnerKey` is the same shared secret a job carries — a cancel destroys a container, so it is not weaker.
	 */
	async cancelRun(runId: string, runnerKey: string): Promise<void> {
		await assertRunnerKey(this.env.FABRIKA_RUNNER_KEY, runnerKey)
		if (typeof runId !== 'string' || !UUID.test(runId)) {
			throw new Error('runner: invalid run id')
		}

		const container = await runContainer(this.env, runId)
		await container.cancelDeploy()
	}

	/**
	 * The run's persisted terminal status, or null while it is still in flight. Otherwise the run's DO
	 * settles it itself: a never-dispatched job is fenced and persisted failed, a terminal container status
	 * is persisted, and a run past its deadline is persisted failed — so recovery does not depend on the backstop.
	 */
	async recoverRun(runId: string, runnerKey: string): Promise<RunnerStatus | null> {
		await assertRunnerKey(this.env.FABRIKA_RUNNER_KEY, runnerKey)
		if (typeof runId !== 'string' || !UUID.test(runId)) throw new Error('runner: invalid run id')
		const persisted = await readTerminalStatus(this.env.RUN_LOGS, runId, Date.now())
		if (persisted !== null) return persisted
		return (await runContainer(this.env, runId)).recoverDeploy(runId)
	}

	// The runner Worker is RPC-only (invoked via the RUNNER_SVC service binding). It has no public route;
	// a stray direct request just gets a 404 rather than crashing the worker.
	override fetch(): Response {
		return new Response('runner: rpc only', { status: 404 })
	}
}

export default VozkaRunner
