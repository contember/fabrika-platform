import { jsonResponse, matchesCapability } from '@fabrika/daemon-kit'
import { BUILDER_CLI_TOKEN_HEADER, BUILDER_CLI_TOKEN_QUERY, BUILDER_DAEMON_HOST } from '../../shared/urls'

export function admitRequest(req: Request, url: URL, port: number): Response | null {
	const authority = req.headers.get('host')
	// Bun ≥ 1.4 builds `url` from Host even for an absolute-form target (against RFC 9112 §3.2.2), so its authority is unseen.
	const allowedHostname = url.hostname === BUILDER_DAEMON_HOST || url.hostname === 'localhost'
	const allowedAuthority = authority === `${url.hostname}:${port}` || (port === 80 && authority === url.hostname)
	const expectedPort = port === 80 ? '' : String(port)
	const origin = req.headers.get('origin')
	const site = req.headers.get('sec-fetch-site')
	const safeNavigation = site === 'none' && (req.method === 'GET' || req.method === 'HEAD')

	if (
		!allowedHostname || !allowedAuthority || url.protocol !== 'http:' || url.port !== expectedPort || url.username !== '' || url.password !== ''
		|| (origin !== null && origin !== url.origin)
		|| (site !== null && site !== 'same-origin' && !safeNavigation)
	) {
		return new Response('Forbidden', { status: 403 })
	}

	return null
}

/**
 * Routes only the owner's CLI calls. They bind a session to a project root, consume what the dashboard submitted, or
 * wait for it; WebSocket upgrades arrive as GET.
 */
const CLI_ROUTES: ReadonlyArray<{ method: string; pattern: URLPattern }> = [
	{ method: 'POST', pattern: new URLPattern({ pathname: '/api/session/:id/plan' }) },
	{ method: 'POST', pattern: new URLPattern({ pathname: '/api/session/:id/feedback/consume' }) },
	{ method: 'POST', pattern: new URLPattern({ pathname: '/api/session/:id/gate/:name/consume' }) },
	{ method: 'POST', pattern: new URLPattern({ pathname: '/api/session/:id/reset' }) },
	{ method: 'POST', pattern: new URLPattern({ pathname: '/api/build/event' }) },
	{ method: 'GET', pattern: new URLPattern({ pathname: '/ws/wait/:id' }) },
]

/**
 * A CLI route requires the CLI capability: any local process or OS user reaches the loopback port without browser
 * headers, which `admitRequest` cannot tell from the CLI. Returns the refusal, or null when the request is admitted.
 */
export function admitCliRoute(req: Request, url: URL, cliAuthToken: string): Response | null {
	if (!CLI_ROUTES.some((route) => route.method === req.method && route.pattern.test(url))) return null
	const isUpgrade = req.headers.get('upgrade')?.toLowerCase() === 'websocket'
	const presented = req.headers.get(BUILDER_CLI_TOKEN_HEADER) ?? (isUpgrade ? url.searchParams.get(BUILDER_CLI_TOKEN_QUERY) : null)
	if (matchesCapability(presented, cliAuthToken)) return null
	return jsonResponse({ error: 'This endpoint is available only to the local CLI' }, 401)
}
