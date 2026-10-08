import { createRpcClient, type RpcFetch } from '@fabrika/app'
import type { OperationsRpcContract } from '@fabrika/operations-contract/rpc'

const RPC_BASE = '/operations/api/rpc'
const LOGIN_BOUNCE_KEY = 'fabrika.operations.auth.login-bounce'
const LOGIN_BOUNCE_WINDOW_MS = 10_000

/** Same-origin typed Operations client, through control's `/operations/api/rpc` gateway. */
export function createOperationsClient(fetcher: RpcFetch = fetch) {
	return createRpcClient<OperationsRpcContract>({
		baseUrl: RPC_BASE,
		fetch: fetcher,
		bounceOnAuth: { sessionKey: LOGIN_BOUNCE_KEY, windowMs: LOGIN_BOUNCE_WINDOW_MS },
	})
}

export const operationsClient = createOperationsClient()
