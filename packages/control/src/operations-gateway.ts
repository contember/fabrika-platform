import type { HttpService } from '@fabrika/platform'
import { error } from './http'
import { isStateChanging, sameOrigin } from './origin-guard'

const RPC_PATH = '/operations/api/rpc'

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
	if (url.pathname !== RPC_PATH) {
		return error(404, 'not found')
	}
	// The deputy's half of the confused-deputy defense: a hostile page POSTing with the victim's cookies stops here.
	if (isStateChanging(request) && !sameOrigin(request, options.publicOrigin)) {
		return error(403, 'cross-origin request rejected')
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
