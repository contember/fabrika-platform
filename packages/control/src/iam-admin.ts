import type { HttpService } from '@fabrika/platform'
import { error } from './http'

const PREFIX = '/iam/admin'
const STATE_CHANGING_METHODS = new Set(['POST', 'PATCH', 'DELETE'])

export interface IamAdminGatewayOptions {
	gateway: HttpService
	publicIamUrl?: string
	/**
	 * The console's own public origin — what the browser typed. Compared against `Origin`, because the
	 * request URL cannot be: behind a TLS-terminating balancer the process is reached over plain HTTP
	 * and would reject every genuine write (backlog 50). Absent → no state-changing request passes.
	 */
	publicOrigin?: string
}

/** Transport one same-origin console request to IAM without taking ownership of its authorization. */
export async function forwardIamAdmin(request: Request, options: IamAdminGatewayOptions): Promise<Response> {
	const url = new URL(request.url)
	if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) {
		return error(404, 'not found')
	}
	if (!sameOriginMutation(request, options.publicOrigin)) {
		return error(403, 'cross-origin request rejected')
	}

	const target = new URL(url)
	target.pathname = `/admin${url.pathname.slice(PREFIX.length)}`
	const response = await options.gateway.fetch(new Request(target, request))
	if (response.status !== 401 || options.publicIamUrl === undefined || options.publicIamUrl === '') {
		return response
	}

	const login = new URL('/auth/login', options.publicIamUrl)
	login.searchParams.set('redirect', url.origin)
	if (url.pathname === `${PREFIX}/rpc`) {
		const upstreamError = await readRpcError(response)
		return Response.json(
			{ error: { ...upstreamError, type: 'auth', loginUrl: login.toString() } },
			{ status: 401, headers: { 'cache-control': 'no-store' } },
		)
	}
	return Response.json(
		{ error: 'authentication required', loginUrl: login.toString() },
		{ status: 401, headers: { 'cache-control': 'no-store' } },
	)
}

async function readRpcError(response: Response): Promise<Record<string, unknown>> {
	try {
		const body: unknown = await response.json()
		if (isRecord(body) && isRecord(body['error'])) {
			const message = typeof body['error']['message'] === 'string' ? body['error']['message'] : 'authentication required'
			return { ...body['error'], message }
		}
	} catch {
		// The gateway supplies the structural fallback below.
	}
	return { message: 'authentication required' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object'
}

/**
 * The gateway's own CSRF check, mirroring IAM's (`packages/iam/src/admin/router.ts`).
 *
 * A request authenticated solely by `Authorization` is exempt for the same reason: a bearer is never
 * attached by the browser on its own, so the check protects nothing there and would block every
 * machine caller. Anything carrying the console's session cookie is checked.
 */
function sameOriginMutation(request: Request, publicOrigin: string | undefined): boolean {
	if (!STATE_CHANGING_METHODS.has(request.method)) {
		return true
	}
	// Exempt only a request with NO ambient credential at all: a bearer and not one cookie. Testing for
	// the absence of any cookie rather than for a named one keeps this correct without the gateway
	// having to know which cookie authenticates the console.
	if (request.headers.get('authorization') !== null && request.headers.get('cookie') === null) {
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
