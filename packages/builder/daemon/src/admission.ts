import { BUILDER_DAEMON_HOST } from '../../shared/urls'

export function admitRequest(req: Request, url: URL, port: number): Response | null {
	const authority = req.headers.get('host')
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
