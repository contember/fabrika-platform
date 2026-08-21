// The BUN entrypoint — the control plane as a long-running process.
//
// The sibling of `src/index.ts`, not a fork of it. Both use the same application and jobs:
//
//   controlApp    (src/app.ts)      — health, the webhook, `/api/*`, the SPA, and IAM middleware.
//   runControlJob (src/consumer.ts) — one queued job — a deploy or a namespace mutation — end to end.
//                                     On Workers the platform calls `queue()` with a batch; here
//                                     `PostgresJobConsumer` polls a table and calls the same function.
//                                     See below for the ack/retry mapping.
//   runMaintenance(src/cron.ts)     — the `scheduled` handler's work. NOT scheduled from in here: the
//                                     platform cron drives it (`run.crontab` → `node/cron.ts`), which
//                                     is the same shape as `triggers.crons` driving `scheduled`.
//
// The shared application owns route order, including process liveness before the SPA fallback.
// `/api/health` remains available on both platforms for existing monitors.
//
// Run it: `bun src/node/server.ts` (see `zerops.yaml` → `run.start`).

import { type BunHandler, createBunHandler } from '@fabrika/app/bun'
import { PostgresJobConsumer } from '@fabrika/platform-node'
import { controlApp } from '../app'
import { controlJobLogLine, decodeControlJobMessage, runControlJob } from '../consumer'
import type { Env } from '../env'
import { reconcileProviderRuns } from '../provider-reconcile'
import type { ControlJobMessage } from '../run-lifecycle'
import { DEPLOY_LOCK_TTL_MS, locks, operationsReleaseDeps, repositories } from '../services'
import type { SourceConnectionPort } from '../source-connection-port'
import { createRuntime, type Runtime } from './runtime'

/** Build the server's fetch handler for an assembled env. Exported so a test can drive it directly. */
export function createFetchHandler(
	env: Env,
	provider: Runtime['provider'],
	sourceConnection: SourceConnectionPort,
): (request: Request) => Promise<Response> {
	return createControlBunHandler(env, provider, sourceConnection).fetch
}

function createControlBunHandler(env: Env, provider: Runtime['provider'], sourceConnection: SourceConnectionPort): BunHandler {
	return createBunHandler(controlApp, { env, provider, sourceConnection }, {
		onBackgroundError() {
			console.error('control background task failed')
		},
	})
}

/**
 * Build the in-process control consumer — the replacement for the Worker's `queue()` handler.
 *
 * THE ACK/RETRY MAPPING, which is the whole reason this is three lines and not a loop: `runControlJob`
 * returns normally for every HANDLED message (including a `failed` run, a `failed` namespace and a
 * `deferred` one, whose re-enqueue it has already done) and throws only on something unexpected.
 * `PostgresJobConsumer` acks a handler that returns and reschedules one that throws, so the two
 * entrypoints agree without either of them knowing the other's protocol.
 *
 * ONE JOB AT A TIME (`batchSize: 1`, the default): a deploy and a namespace provision are both long,
 * serialized, low-volume operations, and their leases would defer a concurrent one anyway. The price is
 * that a namespace provision holds this loop for its duration; namespaces are provisioned a handful of
 * times per installation, so clarity beats throughput here.
 *
 * The visibility timeout is the DEPLOY LOCK's TTL on purpose: a redelivered deploy is already harmless
 * (`executeDeploy` is status-guarded), and matching the two windows means the message can only come back
 * once the app-env lease it would contend for is also stale. A NAMESPACE is the opposite case — a row
 * left `provisioning` is deliberately resumable, so nothing refuses the redelivery and the lease is the
 * only guard. That is why it runs on `NAMESPACE_LOCK_TTL_MS`, which outlives this window on purpose.
 */
export function createConsumer(runtime: Runtime): PostgresJobConsumer<ControlJobMessage> {
	return new PostgresJobConsumer(runtime.queue, {
		decode: decodeControlJobMessage,
		handler: async (job) => {
			// The lifecycle's answer is for the LOG, not for the consumer: every non-throwing outcome is a
			// handled message, so nothing here branches on it (see the contract in src/consumer.ts).
			console.info(controlJobLogLine(await runControlJob(runtime.env, runtime.provider, job.payload)))
		},
		visibilityTimeoutMs: DEPLOY_LOCK_TTL_MS,
		// Never log the error object: it can carry a clone URL with an embedded installation token.
		onError: (error, job) => {
			console.error(
				`control job ${job.id} failed (attempt ${job.attempts}/${job.maxAttempts}):`,
				error instanceof Error ? error.message : 'unknown error',
			)
		},
		onAbandoned: (job) => {
			// A run row is NOT left dangling: the cron sweep marks any run stuck in pending/running past its
			// max age as failed, the same backstop a lost Cloudflare message relies on. A namespace has no
			// such sweep — an operator re-enqueues it with `namespaces reconcile`.
			console.warn(`control job ${job.id} abandoned after ${job.attempts} attempt(s); a namespace is re-enqueued by \`namespaces reconcile\``)
		},
	})
}

async function main(): Promise<void> {
	const runtime = createRuntime()
	const consumer = createConsumer(runtime)
	const reconciliation = await reconcileProviderRuns({
		repositories: repositories(runtime.env),
		provider: runtime.provider,
		releaseLock: (key, holder) => locks(runtime.env).release(key, holder),
		operations: operationsReleaseDeps(runtime.env),
	})
	console.info(
		`Provider startup reconcile: checked=${reconciliation.checked} succeeded=${reconciliation.succeeded} `
			+ `failed=${reconciliation.failed} in-progress=${reconciliation.inProgress} waiting=${reconciliation.waiting}`,
	)
	consumer.start()
	const appHandler = createControlBunHandler(runtime.env, runtime.provider, runtime.sourceConnection)

	const server = Bun.serve({
		port: runtime.config.port,
		// Bun closes an idle socket after 10s by default, and a handler that is still working counts as
		// idle — a slow upstream answered as an unattributable 502 instead of its own error.
		idleTimeout: 255,
		// The project's L7 balancer terminates TLS and forwards plain HTTP on the private network, so this
		// listener speaks HTTP and holds no certificates. Nothing here reads the socket's scheme: the
		// proxy owns every cookie now, and `src/iam.ts` takes the console's own origin from the configured
		// public domain (`FABRIKA_CONTROL_DOMAIN`), because behind a terminating balancer the socket lies.
		fetch: appHandler.fetch,
		// Backstop for anything raised outside the handler. The handler already catches its own throws
		// (see `createFetchHandler`); without this, Bun's default page would answer with source lines.
		error(err: unknown): Response {
			console.error('server error:', err instanceof Error ? err.message : 'unknown error')
			return new Response('internal error', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } })
		},
	})

	// Which capabilities are live, never the values — an operator needs to see that a missing secret
	// turned something off, which is otherwise only visible as a 500 at 3am.
	const state = (on: boolean): string => (on ? 'enabled' : 'disabled')
	console.info(
		`vozka listening on :${server.port} (env=${runtime.env.ENVIRONMENT}, iam=${state(runtime.env.IAM !== undefined)}, `
			+ `vault=${state(runtime.env.FABRIKA_CONTROL_VAULT_KEY !== undefined)}, provider=${runtime.provider.id})`,
	)

	// SIGTERM is what the platform sends on redeploy/scale-down. Stop accepting, let in-flight requests
	// finish, then stop the consumer — `stop()` waits for the pass in flight, so a shutdown never
	// orphans a job it has already made invisible — and only then close the pool.
	let stopping = false
	const stop = (signal: string): void => {
		if (stopping) {
			return
		}
		stopping = true
		console.info(`vozka shutting down (${signal})`)
		void server.stop(false)
			.then(() => appHandler.drain())
			.then(() => consumer.stop())
			.then(() => runtime.shutdown())
			.then(() => process.exit(0))
			.catch((err: unknown) => {
				console.error('shutdown failed:', err instanceof Error ? err.message : 'unknown error')
				process.exit(1)
			})
	}
	process.on('SIGTERM', () => {
		stop('SIGTERM')
	})
	process.on('SIGINT', () => {
		stop('SIGINT')
	})
}

if (import.meta.main) {
	// Never log the error object: configuration errors can quote a connection string.
	main().catch((err: unknown) => {
		console.error('vozka failed to start:', err instanceof Error ? err.message : 'unknown error')
		process.exit(1)
	})
}
