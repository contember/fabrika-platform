import { jsonResponse, matchesCapability } from '@fabrika/daemon-kit'
import { cookieValue, linkRequiredResponse, UI_CODE_QUERY, uiCookieName } from './ui-credential'

/** The header the CLI sends its capability in; the daemon writes the capability to `CLI_AUTH_FILE`. */
export const CLI_TOKEN_HEADER = 'X-Agent-Canvas-CLI-Token'

/**
 * The query parameter a CLI WebSocket upgrade carries the capability in. Bun's client sends headers on an upgrade, but
 * the CLI is typed against the DOM `WebSocket`, whose constructor takes none.
 */
export const CLI_TOKEN_QUERY = 'cli_token'

const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]']

/** Routes only the daemon owner's CLI calls: they require the CLI capability. WebSocket upgrades arrive as GET. */
const CLI_ROUTES: ReadonlyArray<{ method: string; pattern: URLPattern }> = [
	{ method: 'POST', pattern: new URLPattern({ pathname: '/api/session/:id/plan' }) },
	{ method: 'POST', pattern: new URLPattern({ pathname: '/api/session/:id/link' }) },
	{ method: 'POST', pattern: new URLPattern({ pathname: '/api/session/:id/feedback/consume' }) },
	{ method: 'POST', pattern: new URLPattern({ pathname: '/api/session/:id/secrets/resolve' }) },
	{ method: 'POST', pattern: new URLPattern({ pathname: '/api/session/:id/threads/claim' }) },
	{ method: 'POST', pattern: new URLPattern({ pathname: '/api/session/:id/threads/:thread/reply' }) },
	{ method: 'GET', pattern: new URLPattern({ pathname: '/ws/wait/:id' }) },
	{ method: 'GET', pattern: new URLPattern({ pathname: '/ws/review-wait/:project' }) },
	{ method: 'POST', pattern: new URLPattern({ pathname: '/api/review/:project/claim' }) },
	{ method: 'POST', pattern: new URLPattern({ pathname: '/api/review/:project/proxy' }) },
	{ method: 'POST', pattern: new URLPattern({ pathname: '/api/review/:project/threads/:thread/reply' }) },
]

export interface AdmissionOptions {
	port: number
	cliAuthToken: string
	/** The browser UI's credential, presented as the daemon's cookie (`ui-credential.ts`). */
	uiToken: string
}

/**
 * The Host values a browser or the CLI sends to a loopback listener on `port`: this daemon, or a review proxy. Anything
 * else is a request for another name, e.g. a rebound one.
 */
export function allowedHosts(port: number): Set<string> {
	const hosts = new Set(LOOPBACK_HOSTNAMES.map((hostname) => `${hostname}:${port}`))
	if (port === 80) { for (const hostname of LOOPBACK_HOSTNAMES) hosts.add(hostname) }
	return hosts
}

/** The origins of the daemon's own browser UI, or of a review proxy's pages when `port` is the proxy's. */
export function daemonOrigins(port: number): Set<string> {
	return new Set(LOOPBACK_HOSTNAMES.map((hostname) => `http://${hostname}${port === 80 ? '' : `:${port}`}`))
}

export function hasCliToken(req: Request, cliAuthToken: string): boolean {
	return matchesCapability(req.headers.get(CLI_TOKEN_HEADER), cliAuthToken)
}

function isCliRoute(req: Request, url: URL): boolean {
	return CLI_ROUTES.some((route) => route.method === req.method && route.pattern.test(url))
}

/** Review mode answers browsers on other loopback ports (the application under review) and checks their origin itself. */
function isReviewPath(pathname: string): boolean {
	return pathname.startsWith('/api/review/') || pathname.startsWith('/ws/review/')
}

const SESSION_PAGE = new URLPattern({ pathname: '/s/:id' })

/**
 * What answers without a credential: liveness, the static assets (the review widget's script among them), review mode
 * and a session page that carries a link's code, which its handler redeems. Everything else needs one.
 */
function isOpenToAnyone(url: URL): boolean {
	const { pathname } = url
	if (pathname === '/health' || pathname.startsWith('/assets/') || isReviewPath(pathname)) return true
	return SESSION_PAGE.test(url) && url.searchParams.has(UI_CODE_QUERY)
}

/** Whether the request carries the UI cookie; the session page's handler asks too. */
export function hasUiCookie(req: Request, options: Pick<AdmissionOptions, 'port' | 'uiToken'>): boolean {
	return matchesCapability(cookieValue(req.headers.get('Cookie'), uiCookieName(options.port)), options.uiToken)
}

function credentialRequired(url: URL): Response {
	if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) {
		return jsonResponse({ error: 'Open the canvas through a link the agent-canvas CLI prints (agent-canvas open)' }, 401)
	}
	const page = SESSION_PAGE.exec(url)
	return linkRequiredResponse(page?.pathname.groups['id'] ?? null)
}

/**
 * Admission for every request the daemon receives, before any route or WebSocket upgrade:
 * - the Host must name the daemon on loopback, which refuses DNS-rebound pages;
 * - a request that changes state, and every WebSocket upgrade, must come from the daemon's own UI or from a client that
 *   sends no `Origin` (the CLI); browsers send `Origin` on such requests, so a cross-site page is refused whatever the
 *   content type;
 * - every API request and upgrade a browser sends must be same-origin (`Sec-Fetch-Site`), reads included;
 * - CLI routes require the CLI capability;
 * - every other route but `isOpenToAnyone`'s requires the UI cookie or the CLI capability, so a local client that sends
 *   no `Origin` (another process or OS user on this machine) reaches nothing of the UI's.
 *
 * Returns the refusal, or null when the request is admitted.
 */
export function admitRequest(req: Request, url: URL, options: AdmissionOptions): Response | null {
	const host = req.headers.get('Host')
	if (host === null || !allowedHosts(options.port).has(host.toLowerCase())) {
		return jsonResponse({ error: 'Host not allowed' }, 403)
	}

	const isUpgrade = req.headers.get('Upgrade')?.toLowerCase() === 'websocket' || url.pathname.startsWith('/ws/')
	const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')
	// A no-cors read (an <img> of /api/image) sends no Origin; from another port it is same-site, not same-origin.
	const fetchSite = req.headers.get('Sec-Fetch-Site')
	if (isApi && !isReviewPath(url.pathname) && fetchSite !== null && fetchSite !== 'same-origin' && fetchSite !== 'none') {
		return jsonResponse({ error: 'Origin not allowed' }, 403)
	}
	const changesState = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS'
	if ((changesState || isUpgrade) && !isReviewPath(url.pathname)) {
		const origin = req.headers.get('Origin')
		if (origin !== null && !daemonOrigins(options.port).has(origin)) return jsonResponse({ error: 'Origin not allowed' }, 403)
	}

	const presented = req.headers.get(CLI_TOKEN_HEADER) ?? (isUpgrade ? url.searchParams.get(CLI_TOKEN_QUERY) : null)
	const cli = matchesCapability(presented, options.cliAuthToken)
	if (isCliRoute(req, url) && !cli) {
		return jsonResponse({ error: 'This endpoint is available only to the local CLI' }, 401)
	}
	if (!cli && !isOpenToAnyone(url) && !hasUiCookie(req, options)) return credentialRequired(url)

	return null
}
