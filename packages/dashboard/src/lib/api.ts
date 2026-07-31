import { createRpcClient, RpcError, type RpcFetch } from '@fabrika/app'
import type { ControlRpcContract } from '@fabrika/control-contract'

export type * from '@fabrika/control-contract'

const RPC_BASE = '/api/rpc'
const LOGIN_BOUNCE_KEY = 'fabrika.delivery.auth.login-bounce'
const LOGIN_BOUNCE_WINDOW_MS = 10_000

export type ControlFetch = RpcFetch

/** Same-origin typed Delivery client with the console's guarded SSO bounce. */
export function createControlClient(fetcher: ControlFetch = fetch) {
	return createRpcClient<ControlRpcContract>({
		baseUrl: RPC_BASE,
		fetch: fetcher,
		bounceOnAuth: { sessionKey: LOGIN_BOUNCE_KEY, windowMs: LOGIN_BOUNCE_WINDOW_MS },
	})
}

export const api = createControlClient()

/** RPC failures retain the route error-boundary name used throughout the dashboard. */
export { RpcError as ApiError }
