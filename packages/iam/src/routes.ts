// The HTTP surface — one `Request → Response` function, shared by both entrypoints.
//
// This was the `fetch()` body of the Cloudflare `WorkerEntrypoint`. It moved here so the Bun server
// (`node/server.ts`) serves the SAME routing with the same handlers rather than a second copy that
// drifts: the Worker's `fetch()` is now a one-line delegation, and `Bun.serve` calls this directly.
// Nothing in this file (or anything it reaches) imports `cloudflare:workers`, `bun:*` or `node:*` —
// the whole layer was already written fetch-style, which is why the port is wiring and not a rewrite.

import { handleAdmin } from './admin/router'
import { handleAuth } from './auth/routes'
import type { Env, RequestContext } from './env'
import { buildServices } from './services'

/**
 * `/auth/*` + the JWKS → the public native-auth routes; any `/admin/*` path → the admin JSON router
 * (which resolves the admin from a `px_session` / `px_` bearer and gates on `iam.admin` in-process).
 * IAM has no user interface of its own; the control-plane console reaches this API over a private
 * binding or network.
 */
export async function handleFetch(request: Request, env: Env, ctx: RequestContext): Promise<Response> {
	const url = new URL(request.url)
	// propustka-native auth: public (no gate) — login/callback/logout + the JWKS.
	if (url.pathname === '/.well-known/jwks.json' || url.pathname === '/auth' || url.pathname.startsWith('/auth/')) {
		const services = buildServices(env)
		return handleAuth(request, services, env, ctx)
	}
	if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
		const services = buildServices(env)
		return handleAdmin(request, services, env, ctx)
	}
	return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}
