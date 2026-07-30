import type { HttpService } from '@fabrika/platform'
import { error } from './http'

const PREFIX = '/iam/admin'
const STATE_CHANGING_METHODS = new Set(['POST', 'PATCH', 'DELETE'])

export interface IamAdminGatewayOptions {
	gateway: HttpService
	publicIamUrl?: string
}

/** Transport one same-origin console request to IAM without taking ownership of its authorization. */
export async function forwardIamAdmin(request: Request, options: IamAdminGatewayOptions): Promise<Response> {
	const url = new URL(request.url)
	if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) {
		return error(404, 'not found')
	}
	if (!sameOriginMutation(request, url)) {
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
	return Response.json(
		{ error: 'authentication required', loginUrl: login.toString() },
		{ status: 401, headers: { 'cache-control': 'no-store' } },
	)
}

function sameOriginMutation(request: Request, url: URL): boolean {
	if (!STATE_CHANGING_METHODS.has(request.method)) {
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
