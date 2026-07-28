// The HTTP surface — one `Request → Response` function, shared by both entrypoints.
//
// This was the `fetch()` body of the Cloudflare `WorkerEntrypoint`. It moved here so the Bun server
// (`node/server.ts`) serves the SAME routing with the same handlers rather than a second copy that
// drifts: the Worker's `fetch()` is now a one-line delegation, and `Bun.serve` calls this directly.
// Nothing in this file (or anything it reaches) imports `cloudflare:workers`, `bun:*` or `node:*` —
// the layer was already written fetch-style, which is why the port is wiring and not a rewrite.

import { isRunnerJob } from '@fabrika/runner'
import { handleApi } from './api/router'
import type { Env } from './env'
import { buildApiDeps, db, repoSource, startRun } from './services'
import { handleWebhook } from './webhook'

/**
 * `/api/health` → liveness · `POST /webhooks/github` → the HMAC-gated webhook (the ONE unauthenticated
 * route) · `POST /api/runs` → the M2 raw-relay compatibility entry · any other `/api/*` → the ACL-gated
 * control surface · everything else → the dashboard SPA assets.
 */
export async function handleFetch(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url)

	// Liveness only, deliberately: it answers "is this process serving?", not "is the database healthy?".
	// Wiring the database in would let one slow query make a platform restart every container at once,
	// turning a degraded dependency into an outage.
	if (url.pathname === '/api/health') {
		return Response.json({ status: 'ok', service: 'vozka', milestone: 'M4' })
	}

	// The ONE unauthenticated route: the GitHub webhook (HMAC-gated, not ACL-gated).
	if (request.method === 'POST' && url.pathname === '/webhooks/github') {
		return handleWebhook(request, { db: db(env), repoSource: repoSource(env), queue: env.DEPLOY_QUEUE })
	}

	// M2 compatibility: the raw `POST /api/runs` relay entry (a RunnerJob straight to startRun). Kept so
	// the M2 path still works; the M3a control surface is everything else under /api/.
	if (request.method === 'POST' && url.pathname === '/api/runs') {
		let job: unknown
		try {
			job = await request.json()
		} catch {
			return Response.json({ error: 'invalid JSON body' }, { status: 400 })
		}
		if (!isRunnerJob(job)) {
			return Response.json({ error: 'body is not a valid RunnerJob' }, { status: 400 })
		}
		return Response.json(await startRun(env, job))
	}

	// The ACL-gated control surface (registry / runs / triggers / vault).
	if (url.pathname.startsWith('/api/')) {
		return handleApi(request, buildApiDeps(env))
	}

	// Everything else: the dashboard SPA, served from the assets port.
	return env.ASSETS.fetch(request)
}
