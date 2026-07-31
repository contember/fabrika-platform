// The BUN entrypoint — the IAM service as a long-running process.
//
// The sibling of `src/index.ts`, not a fork of it. Both use the same application and jobs:
//
//   createIamApp  (src/app.ts)     — `/auth/*`, the JWKS, `/admin/*`, and optional Bun transports.
//   createIamRpc  (src/rpc.ts)     — the `IamRpc` object. A service binding on Workers; here it is
//                                    reached over HTTP via `handleRpcHttp`, which authenticates the
//                                    transport with a shared secret because HTTP has no equivalent of
//                                    a binding's unreachability. See the header of `rpc-http.ts`.
//   pruneAuthLog  (src/cron.ts)    — the `scheduled` handler's work. NOT scheduled from in here: the
//                                    platform cron drives it (`run.crontab` → `node/prune.ts`), which
//                                    is the same shape as `triggers.crons` driving `scheduled`.
//
// The shared application owns route order, including optional `/rpc/*` and `/healthz` routes.
//
// Run it: `bun src/node/server.ts` (see `zerops.yaml` → `run.start`).

import { createBunHandler } from '@fabrika/app/bun'
import { createIamApp } from '../app'
import { createRuntime, type Runtime } from './runtime'

/** Build the server's fetch handler for an assembled runtime. Exported so a test can drive it directly. */
export function createFetchHandler(runtime: Runtime): (request: Request) => Promise<Response> {
	const app = createIamApp({ rpcKey: runtime.config.rpcKey, proxyKey: runtime.config.proxyKey, health: true })
	return createBunHandler(app, runtime.env, { executionContext: runtime.ctx }).fetch
}

async function main(): Promise<void> {
	const runtime = createRuntime()
	const server = Bun.serve({
		port: runtime.config.port,
		// The project's L7 balancer terminates TLS and forwards plain HTTP on the private network, so
		// this listener speaks HTTP and holds no certificates. The session cookie is still marked
		// `Secure`: the auth handler decides that from the configured public origin (`ISSUER`), not from
		// the socket, precisely because behind a terminating balancer the socket is the wrong signal.
		fetch: createFetchHandler(runtime),
		// Backstop for anything raised outside the handler. The handler already catches its own throws
		// (see `createFetchHandler`); without this, Bun's default page would answer with source lines.
		error(err: unknown): Response {
			console.error('server error:', err instanceof Error ? err.message : 'unknown error')
			return new Response('internal error', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } })
		},
	})

	// Which surfaces are live, never the keys themselves — an operator needs to see that a missing
	// secret turned something off, which is otherwise only visible as a 404 at 3am.
	const state = (key: string): string => (key === '' ? 'disabled' : 'enabled')
	console.info(
		`iam listening on :${server.port} (env=${runtime.env.ENVIRONMENT}, rpc=${state(runtime.config.rpcKey)}, mint=${state(runtime.config.proxyKey)})`,
	)

	// SIGTERM is what the platform sends on redeploy/scale-down. Stop accepting, let in-flight requests
	// finish, then drain the supervised audit/auth-log writes before the pool closes.
	let stopping = false
	const stop = (signal: string): void => {
		if (stopping) {
			return
		}
		stopping = true
		console.info(`iam shutting down (${signal})`)
		void server.stop(false)
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
		console.error('iam failed to start:', err instanceof Error ? err.message : 'unknown error')
		process.exit(1)
	})
}
