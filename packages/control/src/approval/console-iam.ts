// IAM's admin RPC as the person in the console: the console token the proxy injected and Control verified, sent as the
// bearer over the transport the console's IAM gateway uses (`IAM_ADMIN`), so IAM checks that person as it does for the
// console itself.

import { createRpcClient, type InferRpcClient } from '@fabrika/app'
import { PROXY_TOKEN_HEADER } from '@fabrika/auth'
import type { IamAdminRpcContract } from '@fabrika/iam-contract'
import type { HttpService } from '@fabrika/platform'

/** IAM's admin RPC with the console token `request` carries as the bearer; null without that token. */
export function consoleIamClient(gateway: HttpService, request: Request): InferRpcClient<IamAdminRpcContract> | null {
	const token = request.headers.get(PROXY_TOKEN_HEADER)?.trim() ?? ''
	if (token === '') return null
	return createRpcClient<IamAdminRpcContract>({
		baseUrl: new URL('/admin/rpc', request.url).toString(),
		bounceOnAuth: false,
		fetch: (input, init) => {
			const headers = new Headers(init?.headers)
			headers.set('authorization', `Bearer ${token}`)
			// The token must never reach a redirect target; the client reads a 3xx as a failed call.
			return gateway.fetch(new Request(input, { method: init?.method ?? 'POST', headers, body: init?.body ?? null, redirect: 'manual' }))
		},
	})
}
