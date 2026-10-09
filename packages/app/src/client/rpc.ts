// The RPC client of the `{ method, input }` wire protocol that `dispatchRpcRequest` serves, a typed proxy:
// `client.a.b.c(input)` POSTs `{ method: 'a.b.c', input }` to the configured endpoint and unwraps `{ result }` /
// `{ error }`. Errors surface as `RpcError` (carrying `type`, `loginUrl`, … off the error envelope).

import type { InferRpcClient } from '../rpc/contract.js'
import { type BounceConfig, type BounceOption, exchange, resolveBounce, type RpcFetch } from './transport.js'

export interface RpcClientOptions {
	/** Endpoint the RPC proxy POSTs to (e.g. `/rpc`). */
	readonly baseUrl: string
	/**
	 * Auto-redirect to SSO on a sign-in 401 (`type: 'auth'` + `loginUrl`) instead of throwing.
	 * `true` uses sane defaults; pass `{ sessionKey, windowMs }` to tune the re-entry guard.
	 */
	readonly bounceOnAuth?: BounceOption
	/** Override `fetch` (tests / non-browser). Defaults to the global `fetch`. */
	readonly fetch?: RpcFetch
}

function callRpc(opts: RpcClientOptions, bounce: BounceConfig | null, method: string, input: unknown): Promise<unknown> {
	return exchange(opts.fetch ?? fetch, opts.baseUrl, () => ({
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ method, input: input ?? null }),
	}), bounce)
}

function makeProxy(opts: RpcClientOptions, bounce: BounceConfig | null, path: string): unknown {
	const fn = (input: unknown) => callRpc(opts, bounce, path, input)
	return new Proxy(fn, {
		get(_target, prop) {
			if (typeof prop !== 'string') return undefined
			return makeProxy(opts, bounce, path ? `${path}.${prop}` : prop)
		},
	})
}

function isClient<TApi>(value: unknown): value is InferRpcClient<TApi> {
	return typeof value === 'function'
}

export function createRpcClient<TApi>(opts: RpcClientOptions): InferRpcClient<TApi> {
	const proxy = makeProxy(opts, resolveBounce(opts.baseUrl, opts.bounceOnAuth), '')
	if (!isClient<TApi>(proxy)) throw new Error('unreachable')
	return proxy
}
