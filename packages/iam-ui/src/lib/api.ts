import { createRpcClient, RpcError } from '@fabrika/app'
import type { IamAdminRpcContract } from '@fabrika/iam-contract'

const LOGIN_BOUNCE_KEY = 'fabrika.access.login-bounce'

/** Same-origin typed IAM administration client. */
export const api = createRpcClient<IamAdminRpcContract>({
	baseUrl: '/iam/admin/rpc',
	bounceOnAuth: { sessionKey: LOGIN_BOUNCE_KEY, windowMs: 10_000 },
})

/** RPC failures retain the UI's existing error-boundary name. */
export { RpcError as ApiError }
