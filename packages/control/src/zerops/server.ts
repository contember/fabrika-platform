// The BUN entrypoint — the control plane as a long-running process.
//
// The sibling of `src/index.ts`, not a fork of it. Both use the same application and jobs:
//
//   createControlApp (src/app.ts)   — the console's service table: health, the webhook, `/api/*`, the
//                                     gateways, the SPA, and `/mcp` when the published table carries it.
//   runControlJob (src/consumer.ts) — one queued job — a deploy or a namespace mutation — end to end.
//                                     On Workers the platform calls `queue()` with a batch; here
//                                     `PostgresJobConsumer` polls a table and calls the same function.
//                                     See below for the ack/retry mapping.
//   dispatchMail (src/mail-relay/)  — one relayed message from the `vozka-mail` queue; only this process has one.
//   runMaintenance(src/cron.ts)     — the `scheduled` handler's work. NOT scheduled from in here: the
//                                     platform cron drives it (`run.crontab` → `zerops/cron.ts`), which
//                                     is the same shape as `triggers.crons` driving `scheduled`.
//
// The shared service owns selection (`planEndpoint` over `fabrika.service.ts`); there is no route order.
// `/api/health` remains available on both platforms for existing monitors.
//
// Run it: `bun src/zerops/server.ts` (see `zerops.yaml` → `run.start`).

import { type BunHandler, createBunHandler } from '@fabrika/app/bun'
import { PostgresJobConsumer, type PostgresJobQueue } from '@fabrika/platform-node'
import { createControlApp, type McpRoute } from '../app'
import { controlJobLogLine, decodeControlJobMessage, runControlJob } from '../consumer'
import type { Env } from '../env'
import type { SourceConnectionPort } from '../github/connections/port'
import { dispatchMail } from '../mail-relay/dispatch'
import { decodeMailDispatchMessage, type MailDispatchMessage } from '../mail-relay/queue'
import { closeCatalogProjection, releaseHeldCatalogLeases } from '../operations-catalog'
import { reconcileProviderRuns } from '../provider-reconcile'
import type { ControlJobMessage } from '../run-lifecycle'
import { locks, operationsReleaseDeps, repositories } from '../services'
import { createRuntime, type Runtime } from './runtime'

/** Build the server's fetch handler for an assembled env. Exported so a test can drive it directly. */
export function createFetchHandler(
	env: Env,
	provider: Runtime['provider'],
	sourceConnection: SourceConnectionPort,
	mcp: McpRoute | null = null,
): (request: Request) => Promise<Response> {
	return createControlBunHandler(env, provider, sourceConnection, mcp).fetch
}

function createControlBunHandler(
	env: Env,
	provider: Runtime['provider'],
	sourceConnection: SourceConnectionPort,
	mcp: McpRoute | null,
): BunHandler {
	return createBunHandler(createControlApp(mcp), { env, provider, sourceConnection }, {
		onBackgroundError() {
			console.error('control background task failed')
		},
	})
}

const CONTROL_JOB_VISIBILITY_TIMEOUT_MS = 30 * 60 * 1000
// The Zerops SIGTERM-to-SIGKILL grace is unrecorded; 10 s outlasts a normal flush and likely fits inside it.
const CATALOG_SHUTDOWN_GRACE_MS = 10_000

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
 * A redelivery while the handler still runs is harmless: the renewed lease, not visibility, provides exclusion.
 */
export function createConsumer(runtime: Runtime): PostgresJobConsumer<ControlJobMessage> {
	return new PostgresJobConsumer(runtime.queue, {
		decode: decodeControlJobMessage,
		handler: async (job) => {
			// The lifecycle's answer is for the LOG, not for the consumer: every non-throwing outcome is a
			// handled message, so nothing here branches on it (see the contract in src/consumer.ts).
			console.info(controlJobLogLine(await runControlJob(runtime.env, runtime.provider, job.payload)))
		},
		visibilityTimeoutMs: CONTROL_JOB_VISIBILITY_TIMEOUT_MS,
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

// Outlasts the dispatcher's 30 s send deadline and its row writes.
const MAIL_JOB_VISIBILITY_TIMEOUT_MS = 2 * 60 * 1000

/**
 * The mail relay's dispatcher: one job per queued message, on its own loop so a long deploy never delays a sign-in
 * link. Every send failure settles or requeues the row and returns; only an unexpected throw is retried here.
 */
export function createMailConsumer(env: Env, queue: PostgresJobQueue<MailDispatchMessage>): PostgresJobConsumer<MailDispatchMessage> {
	return new PostgresJobConsumer(queue, {
		decode: decodeMailDispatchMessage,
		handler: async (job) => {
			await dispatchMail({
				messages: repositories(env).mailMessages,
				queue,
				sender: env.MAIL_RELAY?.sender ?? null,
				now: () => Math.floor(Date.now() / 1000),
			}, job.payload)
		},
		visibilityTimeoutMs: MAIL_JOB_VISIBILITY_TIMEOUT_MS,
		onError: (error, job) => {
			console.error(`mail job ${job.id} failed (attempt ${job.attempts}/${job.maxAttempts}):`, error instanceof Error ? error.message : 'unknown error')
		},
		onAbandoned: (job) => {
			console.warn(`mail job ${job.id} abandoned after ${job.attempts} attempt(s); maintenance re-enqueues its message`)
		},
	})
}

/** Serve an assembled runtime until SIGTERM/SIGINT. The local stack calls this with its fixture source transports. */
export async function startControlServer(runtime: Runtime): Promise<void> {
	const deployConsumer = createConsumer(runtime)
	const mailConsumer = createMailConsumer(runtime.env, runtime.mailQueue)
	// One stop for both loops: each waits for the pass it has in flight.
	const consumer = {
		stop: async (): Promise<void> => {
			await Promise.all([deployConsumer.stop(), mailConsumer.stop()])
		},
	}
	const reconciliation = await reconcileProviderRuns({
		repositories: repositories(runtime.env),
		provider: runtime.provider,
		runLogs: runtime.env.RUN_LOGS,
		lock: locks(runtime.env),
		operations: operationsReleaseDeps(runtime.env),
	})
	console.info(
		`Provider startup reconcile: checked=${reconciliation.checked} succeeded=${reconciliation.succeeded} `
			+ `failed=${reconciliation.failed} in-progress=${reconciliation.inProgress} waiting=${reconciliation.waiting}`,
	)
	deployConsumer.start()
	mailConsumer.start()
	const appHandler = createControlBunHandler(runtime.env, runtime.provider, runtime.sourceConnection, runtime.mcp)

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

	let stopping = false
	const stop = (signal: string): void => {
		if (stopping) {
			return
		}
		stopping = true
		console.info(`vozka shutting down (${signal})`)
		void stopControlServer({ server, requests: appHandler, consumer, runtime })
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

export interface StoppingControlServer {
	server: { stop(closeActiveConnections: boolean): Promise<void> }
	requests: Pick<BunHandler, 'drain'>
	consumer: Pick<PostgresJobConsumer<ControlJobMessage>, 'stop'>
	runtime: { readonly env: Pick<Env, 'WAIT_UNTIL'>; shutdown(): Promise<void> }
}

/**
 * The SIGTERM sequence (redeploy/scale-down). Stop accepting, let in-flight requests finish, then stop
 * the consumer — `stop()` waits for the pass in flight, so a shutdown never orphans a job it has already
 * made invisible — and only then close the pool. The catalog takes no new lease meanwhile, and a flush
 * still running after the grace is interrupted and its lease released, so a kill leaves nothing to wait out.
 */
export async function stopControlServer(parts: StoppingControlServer, catalogGraceMs = CATALOG_SHUTDOWN_GRACE_MS): Promise<void> {
	closeCatalogProjection()
	// A background task, so the pool closes only after the release it makes.
	const catalogGrace = setTimeout(() => parts.runtime.env.WAIT_UNTIL(releaseHeldCatalogLeases()), catalogGraceMs)
	try {
		await parts.server.stop(false)
		await parts.requests.drain()
		await parts.consumer.stop()
		await parts.runtime.shutdown()
	} finally {
		clearTimeout(catalogGrace)
	}
}

if (import.meta.main) {
	// Never log the error object: configuration errors can quote a connection string.
	Promise.resolve().then(() => startControlServer(createRuntime())).catch((err: unknown) => {
		console.error('vozka failed to start:', err instanceof Error ? err.message : 'unknown error')
		process.exit(1)
	})
}
