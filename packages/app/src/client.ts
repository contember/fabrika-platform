// ─── RPC client ──────────────────────────────────────────────────────
//
// A typed proxy: `client.a.b.c(input)` POSTs `{ method: 'a.b.c', input }` to the
// configured endpoint and unwraps `{ result }` / `{ error }`. Errors surface as
// `RpcError` (carrying `type`, `loginUrl`, … off the error envelope).
//
// `bounceOnAuth` folds the SSO redirect every SPA needs into the client: on a
// human-gated 401 (`type: 'auth'` + `loginUrl`) it redirects the browser to the
// login URL (returning the current page) instead of throwing, with a short
// re-entry guard so an unprovisioned identity can't loop forever.

import type { InferRouterClient } from './rpc/types.js'

export class RpcError extends Error {
	readonly type: string
	readonly issues?: unknown
	readonly loginUrl?: string
	readonly httpStatus?: number
	constructor(payload: { type: string; message: string; issues?: unknown; loginUrl?: string; httpStatus?: number }) {
		super(payload.message)
		this.name = 'RpcError'
		this.type = payload.type
		if (payload.issues !== undefined) this.issues = payload.issues
		if (payload.loginUrl !== undefined) this.loginUrl = payload.loginUrl
		if (payload.httpStatus !== undefined) this.httpStatus = payload.httpStatus
	}
}

interface BounceConfig {
	readonly sessionKey: string
	readonly windowMs: number
}

export interface RpcClientOptions {
	/** Endpoint the RPC proxy POSTs to (e.g. `/rpc`). */
	readonly baseUrl: string
	/**
	 * Auto-redirect to SSO on a human-gated 401 (`type: 'auth'` + `loginUrl`) instead of throwing.
	 * `true` uses sane defaults; pass `{ sessionKey, windowMs }` to tune the re-entry guard.
	 */
	readonly bounceOnAuth?: boolean | { sessionKey?: string; windowMs?: number }
	/** Override `fetch` (tests / non-browser). Defaults to the global `fetch`. */
	readonly fetch?: typeof fetch
}

function resolveBounce(baseUrl: string, opt: RpcClientOptions['bounceOnAuth']): BounceConfig | null {
	if (!opt) return null
	const tuning = opt === true ? {} : opt
	return { sessionKey: tuning.sessionKey ?? `fabrika:login-bounce:${baseUrl}`, windowMs: tuning.windowMs ?? 10_000 }
}

/** Guarded SSO redirect. Returns true if it navigated (caller should hang), false if guarded/non-browser. */
function bounceToLogin(loginUrl: string, cfg: BounceConfig): boolean {
	if (typeof window === 'undefined') return false
	const now = Date.now()
	const last = Number(sessionStorage.getItem(cfg.sessionKey) ?? '0')
	if (Number.isFinite(last) && now - last < cfg.windowMs) return false
	sessionStorage.setItem(cfg.sessionKey, String(now))
	const target = new URL(loginUrl)
	target.searchParams.set('redirect', window.location.href)
	window.location.assign(target.toString())
	return true
}

function clearBounce(cfg: BounceConfig | null): void {
	if (cfg && typeof window !== 'undefined') sessionStorage.removeItem(cfg.sessionKey)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object'
}

function normalizeError(
	raw: unknown,
	httpStatus: number,
): { type: string; message: string; issues?: unknown; loginUrl?: string; httpStatus: number } {
	if (typeof raw === 'string') {
		return { type: httpStatus === 401 ? 'auth' : 'error', message: raw, httpStatus }
	}
	if (isRecord(raw)) {
		const type = typeof raw['type'] === 'string' ? raw['type'] : 'error'
		const message = typeof raw['message'] === 'string' ? raw['message'] : 'Unknown error'
		const issues = raw['issues']
		const loginUrl = typeof raw['loginUrl'] === 'string' ? raw['loginUrl'] : undefined
		return { type, message, httpStatus, ...(issues !== undefined ? { issues } : {}), ...(loginUrl !== undefined ? { loginUrl } : {}) }
	}
	return { type: 'error', message: `HTTP ${httpStatus}`, httpStatus }
}

async function callRpc(opts: RpcClientOptions, bounce: BounceConfig | null, method: string, input: unknown): Promise<unknown> {
	const doFetch = opts.fetch ?? fetch
	const response = await doFetch(opts.baseUrl, {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ method, input: input ?? null }),
	})
	let data: { result?: unknown; error?: unknown }
	try {
		data = await response.json()
	} catch {
		// Non-JSON response (proxy error, HTML error page, etc.) — surface the HTTP status.
		throw new RpcError({ type: 'transport', message: `${response.status} ${response.statusText}`, httpStatus: response.status })
	}
	if (data.error !== undefined) {
		const normalized = normalizeError(data.error, response.status)
		if (bounce && normalized.type === 'auth' && normalized.loginUrl !== undefined && bounceToLogin(normalized.loginUrl, bounce)) {
			// Navigation is in flight — never resolve, so the caller (a route loader) stays pending.
			return new Promise<never>(() => {})
		}
		throw new RpcError(normalized)
	}
	clearBounce(bounce)
	return data.result
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

function isClient<TRouter>(value: unknown): value is InferRouterClient<TRouter> {
	return typeof value === 'function'
}

export function createRpcClient<TRouter>(opts: RpcClientOptions): InferRouterClient<TRouter> {
	const proxy = makeProxy(opts, resolveBounce(opts.baseUrl, opts.bounceOnAuth), '')
	if (!isClient<TRouter>(proxy)) throw new Error('unreachable')
	return proxy
}
