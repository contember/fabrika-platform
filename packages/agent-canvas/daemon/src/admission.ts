import { jsonResponse } from '@fabrika/daemon-kit'
import { timingSafeEqual } from 'crypto'

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
	{ method: 'POST', pattern: new URLPattern({ pathname: '/api/session/:id/feedback/consume' }) },
	{ method: 'POST', pattern: new URLPattern({ pathname: '/api/session/:id/secrets/resolve' }) },
	{ method: 'GET', pattern: new URLPattern({ pathname: '/ws/wait/:id' }) },
	{ method: 'GET', pattern: new URLPattern({ pathname: '/ws/review-wait/:project' }) },
	{ method: 'POST', pattern: new URLPattern({ pathname: '/api/review/:project/claim' }) },
	{ method: 'POST', pattern: new URLPattern({ pathname: '/api/review/:project/proxy' }) },
	{ method: 'POST', pattern: new URLPattern({ pathname: '/api/review/:project/threads/:thread/reply' }) },
]

export interface AdmissionOptions {
	port: number
	cliAuthToken: string
}

/** The Host values a browser or the CLI sends to this daemon. Anything else is a request for another name, e.g. a rebound one. */
function allowedHosts(port: number): Set<string> {
	const hosts = new Set(LOOPBACK_HOSTNAMES.map((hostname) => `${hostname}:${port}`))
	if (port === 80) { for (const hostname of LOOPBACK_HOSTNAMES) hosts.add(hostname) }
	return hosts
}

/** The origins of the daemon's own browser UI. */
function daemonOrigins(port: number): Set<string> {
	return new Set(LOOPBACK_HOSTNAMES.map((hostname) => `http://${hostname}${port === 80 ? '' : `:${port}`}`))
}

export function hasCliToken(req: Request, cliAuthToken: string): boolean {
	return matchesToken(req.headers.get(CLI_TOKEN_HEADER), cliAuthToken)
}

function matchesToken(presented: string | null, cliAuthToken: string): boolean {
	if (presented === null) return false
	const expected = Buffer.from(cliAuthToken)
	const actual = Buffer.from(presented)
	return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function isCliRoute(req: Request, url: URL): boolean {
	return CLI_ROUTES.some((route) => route.method === req.method && route.pattern.test(url))
}

/** Review mode answers browsers on other loopback ports (the application under review) and checks their origin itself. */
function isReviewPath(pathname: string): boolean {
	return pathname.startsWith('/api/review/') || pathname.startsWith('/ws/review/')
}

/**
 * Admission for every request the daemon receives, before any route or WebSocket upgrade:
 * - the Host must name the daemon on loopback, which refuses DNS-rebound pages;
 * - a request that changes state, and every WebSocket upgrade, must come from the daemon's own UI or from a client that
 *   sends no `Origin` (the CLI); browsers send `Origin` on such requests, so a cross-site page is refused whatever the
 *   content type;
 * - CLI routes require the CLI capability.
 *
 * Returns the refusal, or null when the request is admitted.
 */
export function admitRequest(req: Request, url: URL, options: AdmissionOptions): Response | null {
	const host = req.headers.get('Host')
	if (host === null || !allowedHosts(options.port).has(host.toLowerCase())) {
		return jsonResponse({ error: 'Host not allowed' }, 403)
	}

	const isUpgrade = req.headers.get('Upgrade')?.toLowerCase() === 'websocket' || url.pathname.startsWith('/ws/')
	const changesState = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS'
	if ((changesState || isUpgrade) && !isReviewPath(url.pathname)) {
		const origin = req.headers.get('Origin')
		if (origin !== null && !daemonOrigins(options.port).has(origin)) return jsonResponse({ error: 'Origin not allowed' }, 403)
		if (origin === null && req.headers.get('Sec-Fetch-Site') === 'cross-site') return jsonResponse({ error: 'Origin not allowed' }, 403)
	}

	const presented = req.headers.get(CLI_TOKEN_HEADER) ?? (isUpgrade ? url.searchParams.get(CLI_TOKEN_QUERY) : null)
	if (isCliRoute(req, url) && !matchesToken(presented, options.cliAuthToken)) {
		return jsonResponse({ error: 'This endpoint is available only to the local CLI' }, 401)
	}

	return null
}
