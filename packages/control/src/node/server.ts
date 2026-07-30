// The BUN entrypoint — the control plane as a long-running process.
//
// The sibling of `src/index.ts`, not a fork of it. Both call the same three functions:
//
//   handleFetch   (src/routes.ts)   — health, the webhook, `/api/*`, the SPA. Untouched by this file;
//                                     the layer was already `Request → Response`, so serving it from
//                                     `Bun.serve` instead of a Worker is wiring, not a rewrite.
//   runDeployJob  (src/consumer.ts) — one queued deploy, end to end. On Workers the platform calls
//                                     `queue()` with a batch; here `PostgresJobConsumer` polls a table
//                                     and calls the same function. See below for the ack/retry mapping.
//   runMaintenance(src/cron.ts)     — the `scheduled` handler's work. NOT scheduled from in here: the
//                                     platform cron drives it (`run.crontab` → `node/cron.ts`), which
//                                     is the same shape as `triggers.crons` driving `scheduled`.
//
// Route order matters and is the one thing this file decides: `/healthz` is claimed FIRST, before
// `handleFetch` can hand an unmatched path to the SPA fallback. Everything else is identical to the
// Worker, including `/api/health` — which `handleFetch` still serves, so an existing monitor keeps
// working on both platforms.
//
// Run it: `bun src/node/server.ts` (see `zerops.yaml` → `run.start`).

import { PostgresJobConsumer } from '@fabrika/platform-node'
import { decodeDeployJobMessage, runDeployJob } from '../consumer'
import type { Env } from '../env'
import { reconcileProviderRuns } from '../provider-reconcile'
import { handleFetch } from '../routes'
import { DEPLOY_LOCK_TTL_MS, locks, repositories } from '../services'
import { createRuntime, type Runtime } from './runtime'

/** Build the server's fetch handler for an assembled env. Exported so a test can drive it directly. */
export function createFetchHandler(
	env: Env,
	provider: Runtime['provider'],
): (request: Request) => Promise<Response> {
	return async (request: Request): Promise<Response> => {
		try {
			const url = new URL(request.url)
			// Liveness only, deliberately: it answers "is this process serving?", not "is Postgres
			// healthy?". Wiring the database into the health check would let one slow query make the
			// platform restart every container at once, turning a degraded dependency into an outage.
			if (url.pathname === '/healthz') {
				return Response.json({ status: 'ok' })
			}
			return await handleFetch(request, env, provider)
		} catch (err) {
			// NOT optional on this runtime. Bun's default error page embeds the exception AND the
			// surrounding SOURCE LINES in the response body; the Workers runtime returns an opaque 500
			// instead, so this is the one place the two entrypoints would have genuinely differed in what
			// they show an attacker. Log a short message only — an error object here can quote a clone URL
			// with an embedded token, or a connection string.
			console.error('unhandled request error:', err instanceof Error ? err.message : 'unknown error')
			return new Response('internal error', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } })
		}
	}
}

/**
 * Build the in-process deploy consumer — the replacement for the Worker's `queue()` handler.
 *
 * THE ACK/RETRY MAPPING, which is the whole reason this is three lines and not a loop: `runDeployJob`
 * returns normally for every HANDLED message (including a `failed` run and a `deferred` one, whose
 * re-enqueue it has already done) and throws only on something unexpected. `PostgresJobConsumer` acks
 * a handler that returns and reschedules one that throws, so the two entrypoints agree without either
 * of them knowing the other's protocol.
 *
 * ONE JOB AT A TIME (`batchSize: 1`, the default): a deploy is a long, serialized, low-volume
 * operation, and the per-app-env lock would defer a concurrent one anyway. Clarity over throughput.
 *
 * The visibility timeout is the DEPLOY LOCK's TTL on purpose. A redelivery while a handler is still
 * running is already harmless — `executeDeploy` is status-guarded, so it would skip — but matching the
 * two windows means a message can only come back once the lease it would contend for is also stale.
 */
export function createConsumer(runtime: Runtime): PostgresJobConsumer<{ runId: string; dryRun?: boolean }> {
	return new PostgresJobConsumer(runtime.queue, {
		decode: decodeDeployJobMessage,
		handler: async (job) => {
			// The lifecycle's answer is for the LOG, not for the consumer: every non-throwing outcome is a
			// handled message, so nothing here branches on it (see the contract in src/consumer.ts).
			const result = await runDeployJob(runtime.env, runtime.provider, job.payload)
			console.info(`deploy run ${result.runId}: ${result.status}`)
		},
		visibilityTimeoutMs: DEPLOY_LOCK_TTL_MS,
		// Never log the error object: it can carry a clone URL with an embedded installation token.
		onError: (error, job) => {
			console.error(
				`deploy job ${job.id} failed (attempt ${job.attempts}/${job.maxAttempts}):`,
				error instanceof Error ? error.message : 'unknown error',
			)
		},
		onAbandoned: (job) => {
			// The run row is NOT left dangling: the cron sweep marks any run stuck in pending/running past
			// its max age as failed, which is the same backstop a lost Cloudflare message relies on.
			console.warn(`deploy job ${job.id} abandoned after ${job.attempts} attempt(s)`)
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
	})
	console.info(
		`Provider startup reconcile: checked=${reconciliation.checked} succeeded=${reconciliation.succeeded} `
			+ `failed=${reconciliation.failed} in-progress=${reconciliation.inProgress} waiting=${reconciliation.waiting}`,
	)
	consumer.start()

	const server = Bun.serve({
		port: runtime.config.port,
		// The project's L7 balancer terminates TLS and forwards plain HTTP on the private network, so this
		// listener speaks HTTP and holds no certificates. The `px_token` cookie is still marked `Secure`:
		// `src/iam.ts` decides that from the configured public domain (`VOZKA_DOMAIN`), not from the
		// socket, precisely because behind a terminating balancer the socket is the wrong signal.
		fetch: createFetchHandler(runtime.env, runtime.provider),
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
			+ `vault=${state(runtime.env.VOZKA_VAULT_KEY !== undefined)}, provider=${runtime.provider.id})`,
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
