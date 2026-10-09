import { PROXY_TOKEN_HEADER } from '@fabrika/auth'
import type { HttpService } from '@fabrika/platform'
import { z } from 'zod'
import { error } from './http'

const PREFIX = '/iam/admin'

export interface IamAdminGatewayOptions {
	gateway: HttpService
	publicIamUrl?: string
}

/**
 * Transport one console request to IAM without taking ownership of its authorization. The proxy admitted it: a
 * session's state change only from the console itself (ADR-0022).
 */
export async function forwardIamAdmin(request: Request, options: IamAdminGatewayOptions): Promise<Response> {
	const url = new URL(request.url)
	if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) {
		return error(404, 'not found')
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
