import { PROXY_TOKEN_HEADER } from '@fabrika/auth'
import type { HttpService } from '@fabrika/platform'
import { z } from 'zod'
import { error } from './http'
import { isStateChanging, sameOrigin } from './origin-guard'

const PREFIX = '/iam/admin'

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
	if (isStateChanging(request) && !bearerOnly(request) && !sameOrigin(request, options.publicOrigin)) {
		return error(403, 'cross-origin request rejected')
	}

	const target = new URL(url)
	target.pathname = `/admin${url.pathname.slice(PREFIX.length)}`
	const forwarded = new Request(target, request)
	const proxyToken = request.headers.get(PROXY_TOKEN_HEADER)
	if (proxyToken !== null && proxyToken !== '') {
		forwarded.headers.set('Authorization', `Bearer ${proxyToken}`)
	}
	// Keep console-host cookies at the gateway; IAM receives the verified short-lived token.
	forwarded.headers.delete('Cookie')
	const response = await options.gateway.fetch(forwarded)
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
		const parsed = rpcErrorSchema.safeParse(body)
		if (parsed.success) return parsed.data.error
	} catch {
		// The gateway supplies the structural fallback below.
	}
	return { message: 'authentication required' }
}

const rpcErrorSchema = z.object({
	error: z.preprocess(
		value => Array.isArray(value) ? { ...value } : value,
		z.object({ message: z.string().catch('authentication required') }).passthrough(),
	),
})

/**
 * A request with NO ambient credential at all — a bearer and not one cookie — is exempt from the
 * same-origin check: the browser never attaches a bearer on its own, so the check protects nothing there
 * and would block every machine caller. Testing for any cookie, not a named one, keeps this correct
 * without the gateway knowing which cookie authenticates the console.
 */
function bearerOnly(request: Request): boolean {
	return request.headers.get('authorization') !== null && request.headers.get('cookie') === null
}
