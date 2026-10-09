// The Operations browser SDK witness of the local composition: one page that sends a marked exception through the
// application environment's managed DSN. A contract application has no way yet to hand its browser the DSN, so this
// stays an application without a contract, behind the `human` gate of `WITNESS_GATES`, and verifies the injected token.

import { defineApp, type Middleware, route } from '@fabrika/app'
import { PROXY_TOKEN_HEADER } from '@fabrika/auth-core'

export interface WitnessDeps {
	/** Whether the proxy-injected token verifies for this application. */
	readonly verified: (token: string) => Promise<boolean>
	/** The two browser-safe managed values, and the bundled SDK script that reads them. */
	readonly fixture: { readonly dsn: string; readonly release: string; readonly script: string }
}

interface WitnessContext {
	readonly deps: WitnessDeps
}

const json = (body: unknown, status = 200): Response => Response.json(body, { status })

const authenticate: Middleware<WitnessContext> = async (request, ctx, next) => {
	const token = request.headers.get(PROXY_TOKEN_HEADER)
	return token !== null && token !== '' && await ctx.deps.verified(token) ? next() : json({ error: 'unauthenticated' }, 401)
}

const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Operations SDK witness</title></head>'
	+ '<body><main><h1>Operations SDK witness</h1><label>Error marker <input id="error-marker" readonly></label>'
	+ '<button type="button" id="capture-error">Capture managed error</button>'
	+ '<p id="capture-status" role="status">Ready</p></main><script type="module" src="/operations-sdk.js"></script></body></html>'

export const witnessApp = defineApp<WitnessDeps, WitnessContext>({
	context: (deps) => ({ deps }),
	routes: [
		route.get('/healthz', () => json({ status: 'ok' })),
		// The host's sign-in lands here: the browser suite starts one handoff per application host.
		route.get('/', () => json({ app: 'operations-witness' }), { use: [authenticate] }),
		route.get('/operations-sdk', () => new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } }), { use: [authenticate] }),
		route.get('/operations-sdk/config', (ctx) => json({ dsn: ctx.deps.fixture.dsn, release: ctx.deps.fixture.release }), { use: [authenticate] }),
		route.get(
			'/operations-sdk.js',
			(ctx) => new Response(ctx.deps.fixture.script, { headers: { 'content-type': 'text/javascript; charset=utf-8' } }),
			{ use: [authenticate] },
		),
	],
	onError: () => json({ error: 'internal error' }, 500),
})
