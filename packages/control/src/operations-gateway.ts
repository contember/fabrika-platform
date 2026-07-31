import type { HttpService } from '@fabrika/platform'
import { error } from './http'

const PREFIX = '/operations/api'
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const EXCLUDED_SEGMENTS = new Set(['ingest', 'envelope', 'artifacts', 'artifact', 'source-maps', 'source-map'])

export interface OperationsGatewayOptions {
	gateway: HttpService
	publicIamUrl?: string
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
	if (!sameOriginRequest(request, url)) {
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

function sameOriginRequest(request: Request, url: URL): boolean {
	if (SAFE_METHODS.has(request.method)) {
		return true
	}
	const origin = request.headers.get('origin')
	if (origin !== null) {
		return origin === url.origin
	}
	const referer = request.headers.get('referer')
	if (referer === null) {
		return false
	}
	try {
		return new URL(referer).origin === url.origin
	} catch {
		return false
	}
}
