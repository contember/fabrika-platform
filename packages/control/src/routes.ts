// The HTTP surface — one `Request → Response` function, shared by both entrypoints.
//
// This was the `fetch()` body of the Cloudflare `WorkerEntrypoint`. It moved here so the Bun server
// (`node/server.ts`) serves the SAME routing with the same handlers rather than a second copy that
// drifts: the Worker's `fetch()` is now a one-line delegation, and `Bun.serve` calls this directly.
// Nothing in this file (or anything it reaches) imports `cloudflare:workers`, `bun:*` or `node:*` —
// the layer was already written fetch-style, which is why the port is wiring and not a rewrite.

import type { ControlProvider } from '@fabrika/provider-contract'
import { handleApi } from './api/router'
import type { Env } from './env'
import { forwardIamAdmin } from './iam-admin'
import { forwardOperationsApi } from './operations-gateway'
import { buildApiDeps, repositories, repoSource } from './services'
import { handleWebhook } from './webhook'

/**
 * `/api/health` → liveness · `POST /webhooks/github` → the HMAC-gated webhook (the ONE unauthenticated
 * route) · any `/api/*` → the ACL-gated control surface · everything else → dashboard SPA assets.
 */
export async function handleFetch(
	request: Request,
	env: Env,
	provider: ControlProvider,
): Promise<Response> {
	const url = new URL(request.url)

	// Liveness only, deliberately: it answers "is this process serving?", not "is the database healthy?".
	// Wiring the database in would let one slow query make a platform restart every container at once,
	// turning a degraded dependency into an outage.
	if (url.pathname === '/api/health') {
		return Response.json({ status: 'ok', service: 'vozka', milestone: 'M4' })
	}

	// The ONE unauthenticated route: the GitHub webhook (HMAC-gated, not ACL-gated).
	if (request.method === 'POST' && url.pathname === '/webhooks/github') {
		return handleWebhook(request, { repositories: repositories(env), repoSource: repoSource(env), queue: env.DEPLOY_QUEUE })
	}

	if (url.pathname === '/iam/admin' || url.pathname.startsWith('/iam/admin/')) {
		if (env.IAM_ADMIN === undefined) {
			return Response.json({ error: 'IAM admin gateway unavailable' }, { status: 503 })
		}
		return forwardIamAdmin(request, {
			gateway: env.IAM_ADMIN,
			...(env.PROPUSTKA_URL === undefined ? {} : { publicIamUrl: env.PROPUSTKA_URL }),
		})
	}

	if (url.pathname === '/operations/api' || url.pathname.startsWith('/operations/api/')) {
		if (env.OPERATIONS === undefined) {
			return Response.json({ error: 'operations unavailable' }, { status: 503 })
		}
		return forwardOperationsApi(request, {
			gateway: env.OPERATIONS,
			...(env.PROPUSTKA_URL === undefined ? {} : { publicIamUrl: env.PROPUSTKA_URL }),
		})
	}

	// The ACL-gated control surface (registry / runs / triggers / vault).
	if (url.pathname.startsWith('/api/')) {
		return handleApi(request, buildApiDeps(env, provider))
	}

	// Everything else: the dashboard SPA, served from the assets port.
	return env.ASSETS.fetch(request)
}
