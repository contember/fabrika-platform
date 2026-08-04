import type { HttpService } from '@fabrika/platform'
import { error } from './http'

const PREFIX = '/operations/api'
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const EXCLUDED_SEGMENTS = new Set(['ingest', 'envelope', 'artifacts', 'artifact', 'source-maps', 'source-map'])

export interface OperationsGatewayOptions {
	gateway: HttpService
	publicIamUrl?: string
	/**
	 * The console's own public origin — what the browser typed. Compared against `Origin`, because the
	 * request URL cannot be: behind a TLS-terminating balancer the process is reached over plain HTTP,
	 * so `new URL(request.url).origin` is `http://host` while the browser truthfully sent
	 * `https://host`, and every genuine operator write was refused. Same defect and same fix as the IAM
	 * gateway's (backlog 50). Absent → no state-changing request passes.
	 */
	publicOrigin?: string
}

/**
 * Transport the console's operator API only. Operations retains authentication, authorization, and
 * audit ownership; direct telemetry ingest and release-artifact transfer never cross this gateway.
 */
export async function forwardOperationsApi(request: Request, options: OperationsGatewayOptions): Promise<Response> {
	const url = new URL(request.url)
	if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) {
		return error(404, 'not found')
	}
	const suffix = url.pathname.slice(PREFIX.length)
	if (excludedOperatorPath(suffix)) {
		return error(404, 'not found')
	}
	if (!sameOriginRequest(request, options.publicOrigin)) {
		return error(403, 'cross-origin request rejected')
	}

	const target = new URL(url)
	target.pathname = `/api${suffix}`
	let response: Response
	try {
		response = await options.gateway.fetch(new Request(target, request))
	} catch {
		return error(503, 'operations unavailable')
	}
	if (response.status !== 401 || options.publicIamUrl === undefined || options.publicIamUrl === '') {
		return response
	}

	const login = new URL('/auth/login', options.publicIamUrl)
	login.searchParams.set('redirect', url.origin)
	if (suffix === '/rpc') {
		return Response.json(
			{ error: { type: 'auth', message: 'authentication required', loginUrl: login.toString() } },
			{ status: 401, headers: { 'cache-control': 'no-store' } },
		)
	}
	return Response.json(
		{ error: 'authentication required', loginUrl: login.toString() },
		{ status: 401, headers: { 'cache-control': 'no-store' } },
	)
}

function excludedOperatorPath(path: string): boolean {
	return path.split('/').filter(Boolean).some((segment) => EXCLUDED_SEGMENTS.has(segment))
}

/**
 * The gateway's own CSRF check — the deputy's half of the confused-deputy defense. It is what stops a
 * hostile page POSTing to the console's own origin with the victim's cookies, before any of it
 * reaches Operations.
 */
function sameOriginRequest(request: Request, publicOrigin: string | undefined): boolean {
	if (SAFE_METHODS.has(request.method)) {
		return true
	}
	const expected = originOf(publicOrigin ?? '')
	if (expected === null) {
		return false
	}
	const origin = request.headers.get('origin')
	if (origin !== null) {
		return origin === expected
	}
	const referer = request.headers.get('referer')
	return referer === null ? false : originOf(referer) === expected
}

function originOf(value: string): string | null {
	try {
		return new URL(value).origin
	} catch {
		return null
	}
}
