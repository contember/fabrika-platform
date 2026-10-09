import type { HttpService } from '@fabrika/platform'
import { error } from './http'

const RPC_PATH = '/operations/api/rpc'

export interface OperationsGatewayOptions {
	gateway: HttpService
	publicIamUrl?: string
}

/**
 * Transport the console's operator API only. Operations retains authentication, authorization, and
 * audit ownership; direct telemetry ingest and release-artifact transfer never cross this gateway. The proxy
 * admitted the request: a session's state change only from the console itself (ADR-0022).
 */
export async function forwardOperationsApi(request: Request, options: OperationsGatewayOptions): Promise<Response> {
	const url = new URL(request.url)
	if (url.pathname !== RPC_PATH) {
		return error(404, 'not found')
	}
	const target = new URL(url)
	target.pathname = '/api/rpc'
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
	return Response.json(
		{ error: { type: 'auth', message: 'authentication required', loginUrl: login.toString() } },
		{ status: 401, headers: { 'cache-control': 'no-store' } },
	)
}
