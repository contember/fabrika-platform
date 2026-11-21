import { hasUiCookie, jsonResponse, matchesCapability, UI_LINK_PATH, type UiCredential } from '@fabrika/daemon-kit'
import { BUILDER_CLI_TOKEN_HEADER, BUILDER_CLI_TOKEN_QUERY, BUILDER_DAEMON_HOST } from '../../shared/urls'
import { linkRequiredResponse } from './ui-credential'

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
 * Routes only the owner's CLI calls. They bind a session to a project root, consume what the dashboard submitted, wait
 * for it, or hand out a link that signs a browser in to the dashboard; WebSocket upgrades arrive as GET.
 */
const CLI_ROUTES: ReadonlyArray<{ method: string; pattern: URLPattern }> = [
	{ method: 'POST', pattern: new URLPattern({ pathname: '/api/session/:id/plan' }) },
	{ method: 'POST', pattern: new URLPattern({ pathname: '/api/session/:id/link' }) },
	{ method: 'POST', pattern: new URLPattern({ pathname: '/api/session/:id/feedback/consume' }) },
	{ method: 'POST', pattern: new URLPattern({ pathname: '/api/session/:id/gate/:name/consume' }) },
	{ method: 'POST', pattern: new URLPattern({ pathname: '/api/session/:id/reset' }) },
	{ method: 'POST', pattern: new URLPattern({ pathname: '/api/build/event' }) },
	{ method: 'GET', pattern: new URLPattern({ pathname: '/ws/wait/:id' }) },
]

/** Liveness, the dashboard's static assets, and a link, whose handler redeems its code. */
function isOpenToAnyone(req: Request, url: URL): boolean {
	if (req.method !== 'GET') return false
	return url.pathname === '/health' || url.pathname.startsWith('/assets/') || url.pathname === UI_LINK_PATH
}

export interface CredentialOptions {
	cliAuthToken: string
	/** The dashboard's cookie and the secret it carries (`ui-credential.ts`). */
	ui: UiCredential
}

/**
 * Any local process or OS user reaches the loopback port without browser headers, which `admitRequest` cannot tell from
 * the CLI or the dashboard. So a CLI route requires the CLI capability, and every other route but liveness, the assets
 * and the link requires the dashboard's cookie or the CLI capability. Returns the refusal, or null when admitted.
 */
export function admitCredential(req: Request, url: URL, options: CredentialOptions): Response | null {
	const isUpgrade = req.headers.get('upgrade')?.toLowerCase() === 'websocket'
	const presented = req.headers.get(BUILDER_CLI_TOKEN_HEADER) ?? (isUpgrade ? url.searchParams.get(BUILDER_CLI_TOKEN_QUERY) : null)
	const cli = matchesCapability(presented, options.cliAuthToken)
	if (cli) return null
	if (CLI_ROUTES.some((route) => route.method === req.method && route.pattern.test(url))) {
		return jsonResponse({ error: 'This endpoint is available only to the local CLI' }, 401)
	}
	if (isOpenToAnyone(req, url) || hasUiCookie(req, options.ui)) return null
	if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) {
		return jsonResponse({ error: 'Open the dashboard through a link the fabrika builder CLI prints' }, 401)
	}
	return linkRequiredResponse()
}
