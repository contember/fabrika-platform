// What both browser clients share: the error type, the login bounce, and reading the `{ result }` / `{ error }`
// envelope off a response.
//
// `bounceOnAuth` folds the SSO redirect every SPA needs into the client: on a 401 for a person who must sign in (`type: 'auth'` +
// `loginUrl`) it redirects the browser to the login URL (returning the current page) instead of throwing, with a
// short re-entry guard so an unprovisioned identity can't loop forever.

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

/** Minimal Fetch API surface required by the RPC client. */
export type RpcFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * Auto-redirect to SSO on a sign-in 401 (`type: 'auth'` + `loginUrl`) instead of throwing.
 * `true` uses sane defaults; pass `{ sessionKey, windowMs }` to tune the re-entry guard.
 */
export type BounceOption = boolean | { sessionKey?: string; windowMs?: number }

export interface BounceConfig {
	readonly sessionKey: string
	readonly windowMs: number
}

export function resolveBounce(scope: string, opt: BounceOption | undefined): BounceConfig | null {
	if (!opt) return null
	const tuning = opt === true ? {} : opt
	return { sessionKey: tuning.sessionKey ?? `fabrika:login-bounce:${scope}`, windowMs: tuning.windowMs ?? 10_000 }
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

/** Sends one request; a network failure, or an input `init` cannot serialize, is an `RpcError`. */
async function send(doFetch: RpcFetch, url: string, init: () => RequestInit): Promise<Response> {
	try {
		return await doFetch(url, init())
	} catch {
		throw new RpcError({ type: 'transport', message: 'Network request failed', httpStatus: 0 })
	}
}

/** The `{ error }` envelope as an `RpcError`, or a sign-in redirect that never settles. */
function refused(raw: unknown, response: Response, bounce: BounceConfig | null): Promise<never> {
	const normalized = normalizeError(raw, response.status)
	if (bounce && normalized.type === 'auth' && normalized.loginUrl !== undefined && bounceToLogin(normalized.loginUrl, bounce)) {
		// Navigation is in flight — never resolve, so the caller (a route loader) stays pending.
		return new Promise<never>(() => {})
	}
	throw new RpcError(normalized)
}

async function envelope(response: Response): Promise<{ result?: unknown; error?: unknown }> {
	try {
		return await response.json()
	} catch {
		// Non-JSON response (proxy error, HTML error page, etc.) — surface the HTTP status.
		throw new RpcError({ type: 'transport', message: `${response.status} ${response.statusText}`, httpStatus: response.status })
	}
}

/**
 * Sends one request and answers the envelope's `result`; every failure is an `RpcError`. `init` builds the request
 * inside the guard, so an input that does not serialize rejects like a failed request instead of throwing.
 */
export async function exchange(doFetch: RpcFetch, url: string, init: () => RequestInit, bounce: BounceConfig | null): Promise<unknown> {
	const response = await send(doFetch, url, init)
	const data = await envelope(response)
	if (data.error !== undefined) {
		return await refused(data.error, response, bounce)
	}
	clearBounce(bounce)
	return data.result
}

/**
 * Sends one request whose success is a file and answers its bytes and its `Content-Disposition`; a failure is read from
 * its `{ error }` envelope.
 */
export async function exchangeFile(
	doFetch: RpcFetch,
	url: string,
	init: () => RequestInit,
	bounce: BounceConfig | null,
): Promise<{ readonly body: Blob; readonly disposition: string | null }> {
	const response = await send(doFetch, url, init)
	if (!response.ok) {
		const data = await envelope(response)
		return await refused(data.error ?? `HTTP ${response.status}`, response, bounce)
	}
	clearBounce(bounce)
	return { body: await response.blob(), disposition: response.headers.get('Content-Disposition') }
}
