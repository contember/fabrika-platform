// The control CONSUMER's body — what happens to one queued message, shared by both entrypoints.
//
// The two runtimes disagree about the shape of a consumer, not about the work. On Workers the platform
// delivers a batch to an exported `queue()` handler and owns retries, batching and the ack protocol; in
// a process fabrika owns the loop, the visibility timeout and the retry policy (see the header of
// `@fabrika/platform-node`'s `job-queue-postgres.ts` for why the port models only `send()`). What is
// identical is everything below.
//
// ONE QUEUE CARRIES TWO KINDS OF WORK. A deploy job points at a run; a namespace job points at a
// deployment namespace whose provider mutation takes minutes and therefore cannot run inside the
// request that asked for it (backlog 74). A payload WITHOUT `kind` is a deploy job, which is what keeps
// messages enqueued before namespace jobs existed working across the upgrade.
//
// THE CONTRACT WITH THE CALLER, and both callers keep it:
//   * a NORMAL return means the message is handled — ACK it. That includes `failed`: `executeDeploy`
//     records an assembly/relay failure as a `failed` run and `runNamespaceJob` records a provider
//     refusal as a `failed` namespace, neither of which throws, because retrying an unrecoverable error
//     just burns the retry budget and re-fails.
//   * a `deferred` return is also handled and also acked — the re-enqueue already happened HERE (see
//     below), so a caller that retried instead would double-schedule the work.
//   * a THROW means something unexpected happened before/around the lifecycle — retry it.

import type { ControlProvider } from '@fabrika/provider-contract'
import { type NamespaceJobDeps, type NamespaceJobResult, runNamespaceJob } from './api/namespaces'
import type { Env } from './env'
import { type ControlJobMessage, type DeployJobMessage, executeDeploy, type NamespaceJobMessage } from './run-lifecycle'
import { buildRunDeps, DEPLOY_LOCK_REQUEUE_DELAY_S, DEPLOY_LOCK_TTL_MS, locks, repositories } from './services'

/** The lifecycle's terminal answer for one message — what the caller logs, and nothing it must act on. */
export type DeployJobResult = Awaited<ReturnType<typeof executeDeploy>>

/** The same answer for either kind of message, tagged so a caller can log it without re-deriving which. */
export type ControlJobResult =
	| ({ kind: 'deploy' } & DeployJobResult)
	| ({ kind: 'namespace' } & NamespaceJobResult)

/**
 * The namespace lease MUST outlive the queue's visibility timeout, which the deploy lease deliberately
 * matches. A redelivered deploy message is refused by `markRunStarted`'s status guard, but a namespace
 * left `provisioning` is deliberately RESUMABLE — so the lease is the only thing standing between a
 * redelivery and two workers mutating one namespace at once.
 */
export const NAMESPACE_LOCK_TTL_MS = 2 * DEPLOY_LOCK_TTL_MS

/** Namespace jobs take the same generic lease deploys do, keyed by namespace instead of by app-env. */
export function namespaceJobDeps(env: Env, provider: ControlProvider): NamespaceJobDeps {
	return {
		repositories: repositories(env),
		provider,
		lock: {
			acquire: (key, holder) => locks(env).acquire(key, holder, NAMESPACE_LOCK_TTL_MS),
			release: (key, holder) => locks(env).release(key, holder),
		},
	}
}

/**
 * Execute one queued message end to end, whichever kind it is.
 *
 * The re-enqueue on `deferred` lives here rather than in either caller because it is the same decision
 * on both platforms and for both kinds: someone else holds the lease, so the work stays where it is and
 * is re-delivered as a FRESH message after a short delay. Fresh, not a retry: lock contention is normal
 * and must not spend the retry budget reserved for genuine errors.
 */
export async function runControlJob(env: Env, provider: ControlProvider, message: ControlJobMessage): Promise<ControlJobResult> {
	if (message.kind === 'namespace') {
		const result = await runNamespaceJob(namespaceJobDeps(env, provider), message)
		if (result.status === 'deferred') {
			await env.DEPLOY_QUEUE.send(message, { delaySeconds: DEPLOY_LOCK_REQUEUE_DELAY_S })
		}
		return { kind: 'namespace', ...result }
	}
	return { kind: 'deploy', ...(await runDeployJob(env, provider, message)) }
}

/** One line an operator can read, identical on both entrypoints. */
export function controlJobLogLine(result: ControlJobResult): string {
	return result.kind === 'namespace' ? `namespace ${result.namespaceId}: ${result.status}` : `deploy run ${result.runId}: ${result.status}`
}

/** Execute one queued DEPLOY message end to end. */
export async function runDeployJob(
	env: Env,
	provider: ControlProvider,
	message: DeployJobMessage,
): Promise<DeployJobResult> {
	const deps = await buildRunDeps(env, provider)
	const result = await executeDeploy(deps, message)
	if (result.status === 'deferred') {
		await env.DEPLOY_QUEUE.send(message, { delaySeconds: DEPLOY_LOCK_REQUEUE_DELAY_S })
	}
	return result
}

/**
 * Narrow a queue payload back to a `ControlJobMessage`. Needed only off Cloudflare, where the message
 * comes back as JSON text from a table rather than as a typed batch — decoding at that boundary is what
 * keeps a row this consumer cannot understand from reaching the lifecycle as a half-typed object.
 *
 * A payload with no `kind` is a deploy job. That is the compatibility path, not a default: it is what
 * every message already in flight looks like when namespace jobs are deployed.
 */
export function decodeControlJobMessage(payload: unknown): ControlJobMessage {
	if (typeof payload !== 'object' || payload === null) {
		throw new Error('control job payload is not an object')
	}
	const kind: unknown = Reflect.get(payload, 'kind')
	if (kind === undefined) {
		return decodeDeployJobMessage(payload)
	}
	if (kind !== 'namespace') {
		throw new Error('control job payload has an unknown kind')
	}
	return decodeNamespaceJobMessage(payload)
}

/** Narrow a queue payload back to a `DeployJobMessage`. */
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

function decodeNamespaceJobMessage(payload: object): NamespaceJobMessage {
	const namespaceId: unknown = Reflect.get(payload, 'namespaceId')
	if (typeof namespaceId !== 'string' || namespaceId === '') {
		throw new Error('namespace job payload has no namespaceId')
	}
	const mutation: unknown = Reflect.get(payload, 'mutation')
	if (mutation !== 'provision' && mutation !== 'reconcile') {
		throw new Error('namespace job payload has no mutation')
	}
	return { kind: 'namespace', namespaceId, mutation }
}
