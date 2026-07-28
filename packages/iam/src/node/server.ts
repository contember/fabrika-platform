// The BUN entrypoint — the IAM service as a long-running process.
//
// The sibling of `src/index.ts`, not a fork of it. Both call the same three functions:
//
//   handleFetch   (src/routes.ts)  — `/auth/*`, the JWKS, `/admin/*`, and the SPA. Untouched by this
//                                    file; the layer was already `Request → Response`, so serving it
//                                    from `Bun.serve` instead of a Worker is wiring, not a rewrite.
//   createIamRpc  (src/rpc.ts)     — the `IamRpc` object. A service binding on Workers; here it is
//                                    reached over HTTP via `handleRpcHttp`, which authenticates the
//                                    transport with a shared secret because HTTP has no equivalent of
//                                    a binding's unreachability. See the header of `rpc-http.ts`.
//   pruneAuthLog  (src/cron.ts)    — the `scheduled` handler's work. NOT scheduled from in here: the
//                                    platform cron drives it (`run.crontab` → `node/prune.ts`), which
//                                    is the same shape as `triggers.crons` driving `scheduled`.
//
// Route order matters and is the one thing this file decides: `/rpc/*` and `/healthz` are claimed
// FIRST, before `handleFetch` can hand an unmatched path to the SPA fallback. Everything else is
// identical to the Worker.
//
// Run it: `bun src/node/server.ts` (see `zerops.yaml` → `run.start`).

import { handleFetch } from '../routes'
import { createIamRpc } from '../rpc'
import { handleMintHttp, handleRpcHttp, isMintPath, isRpcPath } from '../rpc-http'
import { createRuntime, type Runtime } from './runtime'

/** Build the server's fetch handler for an assembled runtime. Exported so a test can drive it directly. */
export function createFetchHandler(runtime: Runtime): (request: Request) => Promise<Response> {
	const route = createRouter(runtime)
	return async (request: Request): Promise<Response> => {
		try {
			return await route(request)
		} catch (err) {
			// NOT optional on this runtime. Bun's default error page embeds the exception AND the
			// surrounding SOURCE LINES in the response body — verified against `/auth/login` with a
			// broken OIDC issuer. The Workers runtime returns an opaque 500 instead, so this is the one
			// place the two entrypoints would have genuinely differed in what they show an attacker.
			// Log a short message only; an error object here can quote a token that came off the wire.
			console.error('unhandled request error:', err instanceof Error ? err.message : 'unknown error')
			return new Response('internal error', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } })
		}
	}
}

function createRouter(runtime: Runtime): (request: Request) => Promise<Response> {
	const rpc = createIamRpc(runtime.env, runtime.ctx)
	return async (request: Request): Promise<Response> => {
		const url = new URL(request.url)
		// Liveness only, deliberately: it answers "is this process serving?", not "is Postgres healthy?".
		// Wiring the database into the health check would let one slow query make the platform restart
		// every container at once, turning a degraded dependency into an outage.
		if (url.pathname === '/healthz') {
			return Response.json({ status: 'ok' })
		}
		if (isRpcPath(url.pathname)) {
			return handleRpcHttp(request, rpc, runtime.config.rpcKey)
		}
		// BEFORE `handleFetch`, which owns the rest of `/auth/*` and would 404 these. The two mint paths
		// are the auth proxy's cold path and carry their own key — see `rpc-http.ts`.
		if (isMintPath(url.pathname)) {
			return handleMintHttp(request, rpc, runtime.config.proxyKey)
		}
		return handleFetch(request, runtime.env, runtime.ctx)
	}
}

async function main(): Promise<void> {
	const runtime = createRuntime()
	const server = Bun.serve({
		port: runtime.config.port,
		// The project's L7 balancer terminates TLS and forwards plain HTTP on the private network, so
		// this listener speaks HTTP and holds no certificates. The session cookie is still marked
		// `Secure`: `auth/routes.ts` decides that from the configured public origin (`ISSUER`), not from
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
