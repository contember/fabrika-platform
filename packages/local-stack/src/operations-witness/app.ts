// The Operations browser SDK witness of the local composition: one page that sends a marked exception through the
// application environment's managed DSN. A contract application has no way yet to hand its browser the DSN (backlog
// 102), so this stand-in serves the page itself, behind its contract's endpoint table, and checks what the proxy sends.

import type { FetchService } from '@fabrika/app'
import { PROXY_SECRET_HEADER, PROXY_TOKEN_HEADER } from '@fabrika/auth-core'
import { createHash, timingSafeEqual } from 'node:crypto'

export interface WitnessDeps {
	/** Whether the proxy-injected token verifies for this application. */
	readonly verified: (token: string) => Promise<boolean>
	/** The proxy secret the apps proxy sends this application (ADR-0022 rule 5). */
	readonly proxySecret: string
	/** The two browser-safe managed values, and the bundled SDK script that reads them. */
	readonly fixture: { readonly dsn: string; readonly release: string; readonly script: string }
}

const json = (body: unknown, status = 200): Response => Response.json(body, { status })

const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Operations SDK witness</title></head>'
	+ '<body><main><h1>Operations SDK witness</h1><label>Error marker <input id="error-marker" readonly></label>'
	+ '<button type="button" id="capture-error">Capture managed error</button>'
	+ '<p id="capture-status" role="status">Ready</p></main><script type="module" src="/operations-sdk.js"></script></body></html>'

const PAGES: Readonly<Record<string, (deps: WitnessDeps) => Response>> = {
	// The host's sign-in lands here: the browser suite starts one handoff per application host.
	'/': () => json({ app: 'operations-witness' }),
	'/operations-sdk': () => new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
	'/operations-sdk/config': (deps) => json({ dsn: deps.fixture.dsn, release: deps.fixture.release }),
	'/operations-sdk.js': (deps) => new Response(deps.fixture.script, { headers: { 'content-type': 'text/javascript; charset=utf-8' } }),
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest()

const fromProxy = (request: Request, deps: WitnessDeps): boolean => {
	const presented = request.headers.get(PROXY_SECRET_HEADER) ?? ''
	return presented !== '' && timingSafeEqual(digest(presented), digest(deps.proxySecret))
}

export const witnessApp: FetchService<WitnessDeps> = {
	async fetch(request, deps) {
		const path = new URL(request.url).pathname
		if (request.method === 'GET' && path === '/healthz') return json({ status: 'ok' })
		const page = request.method === 'GET' && Object.hasOwn(PAGES, path) ? PAGES[path] : undefined
		if (page === undefined) return json({ error: 'not found' }, 404)
		const token = request.headers.get(PROXY_TOKEN_HEADER)
		if (!fromProxy(request, deps) || token === null || token === '' || !(await deps.verified(token))) {
			return json({ error: 'unauthenticated' }, 401)
		}
		return page(deps)
	},
}
