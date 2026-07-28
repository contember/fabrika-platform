// The deploy CONSUMER's body — what happens to one queued message, shared by both entrypoints.
//
// The two runtimes disagree about the shape of a consumer, not about the work. On Workers the platform
// delivers a batch to an exported `queue()` handler and owns retries, batching and the ack protocol; in
// a process fabrika owns the loop, the visibility timeout and the retry policy (see the header of
// `@fabrika/platform-node`'s `job-queue-postgres.ts` for why the port models only `send()`). What is
// identical is everything below: load the run, take the lock, assemble, execute, record.
//
// THE CONTRACT WITH THE CALLER, and both callers keep it:
//   * a NORMAL return means the message is handled — ACK it. That includes `failed`: `executeDeploy`
//     records an assembly/relay failure as a `failed` run and does not throw, because retrying an
//     unrecoverable assembly error just burns the retry budget and re-fails.
//   * a `deferred` return is also handled and also acked — the re-enqueue already happened HERE (see
//     below), so a caller that retried instead would double-schedule the run.
//   * a THROW means something unexpected happened before/around the lifecycle — retry it.

import type { Env } from './env'
import { type DeployJobMessage, executeDeploy } from './run-lifecycle'
import { buildRunDeps, DEPLOY_LOCK_REQUEUE_DELAY_S } from './services'

/** The lifecycle's terminal answer for one message — what the caller logs, and nothing it must act on. */
export type DeployJobResult = Awaited<ReturnType<typeof executeDeploy>>

/**
 * Execute one queued deploy message end to end.
 *
 * The re-enqueue on `deferred` lives here rather than in either caller because it is the same decision
 * on both platforms: another deploy of this app-env holds the lock, so the run stays `pending` and is
 * re-delivered as a FRESH message after a short delay. Fresh, not a retry: lock contention is normal
 * and must not spend the retry budget reserved for genuine errors.
 */
export async function runDeployJob(env: Env, message: DeployJobMessage): Promise<DeployJobResult> {
	const deps = await buildRunDeps(env)
	const result = await executeDeploy(deps, message)
	if (result.status === 'deferred') {
		await env.DEPLOY_QUEUE.send(message, { delaySeconds: DEPLOY_LOCK_REQUEUE_DELAY_S })
	}
	return result
}

/**
 * Narrow a queue payload back to a `DeployJobMessage`. Needed only off Cloudflare, where the message
 * comes back as JSON text from a table rather than as a typed batch — decoding at that boundary is what
 * keeps a row this consumer cannot understand from reaching the lifecycle as a half-typed object.
 */
export function decodeDeployJobMessage(payload: unknown): DeployJobMessage {
	if (typeof payload !== 'object' || payload === null) {
		throw new Error('deploy job payload is not an object')
	}
	const runId: unknown = Reflect.get(payload, 'runId')
	if (typeof runId !== 'string' || runId === '') {
		throw new Error('deploy job payload has no runId')
	}
	const dryRun: unknown = Reflect.get(payload, 'dryRun')
	return { runId, ...(dryRun === true ? { dryRun: true } : {}) }
}
