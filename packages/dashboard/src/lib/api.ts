// Typed fetch helper for the fabrika control-plane JSON API (`/api/*`), plus the API DTO contract.
//
// Same-origin (`/api/...`), `credentials: 'include'`, JSON in/out. Non-2xx maps to a typed
// `ApiError`. Auth is propustka-native (no Cloudflare Access edge): a missing/expired session
// gets a JSON 401 carrying a `loginUrl`, so we bounce the browser to propustka's SSO login and
// return to the current page afterwards (a blind reload would just loop — there's no edge to
// re-challenge anymore). A short bounce guard breaks the loop if we come back still-unauthorized.
//
export type * from '@fabrika/control-contract'

// ── Typed fetch ─────────────────────────────────────────────────────────────────

/** A typed non-2xx API failure surfaced to pages / the route error boundary. */
export class ApiError extends Error {
	readonly status: number
	/** propustka SSO login URL — present only on a human-gated 401 (where the caller may bounce to login). */
	readonly loginUrl?: string

	constructor(status: number, message: string, loginUrl?: string) {
		super(message)
		this.name = 'ApiError'
		this.status = status
		if (loginUrl !== undefined) this.loginUrl = loginUrl
	}
}

const BASE = '/api'

// ── Auth-redirect (human SSO) ────────────────────────────────────────────────
//
// On a 401 carrying a `loginUrl`, send the browser to propustka's SSO login and return to the
// CURRENT page afterwards (the worker's `loginUrl` points back at the API path, so we rewrite its
// `redirect` to `window.location.href`). Bounce guard: if we come back STILL unauthorized within a
// short window (e.g. a Google identity not provisioned for fabrika), stop redirecting and surface the
// error — otherwise the page flickers through login forever.
const LOGIN_BOUNCE_KEY = 'vozka.auth.login-bounce'
const LOGIN_BOUNCE_WINDOW_MS = 10_000

function redirectToLogin(loginUrl: string): boolean {
	const now = Date.now()
	const last = Number(sessionStorage.getItem(LOGIN_BOUNCE_KEY) ?? '0')
	if (Number.isFinite(last) && now - last < LOGIN_BOUNCE_WINDOW_MS) return false
	sessionStorage.setItem(LOGIN_BOUNCE_KEY, String(now))
	const target = new URL(loginUrl)
	target.searchParams.set('redirect', window.location.href)
	window.location.assign(target.toString())
	return true
}

async function readError(res: Response): Promise<ApiError> {
	let message = `Request failed (${res.status})`
	let loginUrl: string | undefined
	try {
		const contentType = res.headers.get('content-type') ?? ''
		if (contentType.includes('application/json')) {
			const body: unknown = await res.json()
			// The worker's `error()` helper returns `{ error: string, loginUrl?: string }`.
			if (body !== null && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
				message = body.error
			} else if (body !== null && typeof body === 'object' && 'message' in body && typeof body.message === 'string') {
				message = body.message
			}
			if (body !== null && typeof body === 'object' && 'loginUrl' in body && typeof body.loginUrl === 'string') {
				loginUrl = body.loginUrl
			}
		} else {
			const text = await res.text()
			if (text.trim().length > 0 && text.length < 500) message = text
		}
	} catch {
		// Keep the default message.
	}
	return new ApiError(res.status, message, loginUrl)
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
	const headers: Record<string, string> = { accept: 'application/json' }
	if (body !== undefined) headers['content-type'] = 'application/json'

	let res: Response
	try {
		res = await fetch(`${BASE}${path}`, {
			method,
			headers,
			credentials: 'include',
			body: body === undefined ? undefined : JSON.stringify(body),
		})
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : 'Network request failed'
		throw new ApiError(0, message)
	}

	if (!res.ok) {
		const err = await readError(res)
		// A human-gated 401 (no/expired propustka session) → bounce to SSO and return here after.
		// Hang the promise while the navigation is in flight so no auth error flashes in the route.
		if (res.status === 401 && err.loginUrl !== undefined && redirectToLogin(err.loginUrl)) {
			return await new Promise<never>(() => {})
		}
		throw err
	}
	sessionStorage.removeItem(LOGIN_BOUNCE_KEY)

	// Read the body as text and parse it. An empty body (204 / no content) normalizes to `null` so
	// mutation callers that ignore the result get a defined value. `JSON.parse` returns `any`, so the
	// caller's generic `T` applies at this boundary without a cast.
	const text = await res.text()
	return JSON.parse(text.trim() === '' ? 'null' : text)
}

export const api = {
	get<T>(path: string): Promise<T> {
		return request<T>('GET', path)
	},
	post<T = unknown>(path: string, body?: unknown): Promise<T> {
		return request<T>('POST', path, body ?? {})
	},
	put<T = unknown>(path: string, body?: unknown): Promise<T> {
		return request<T>('PUT', path, body ?? {})
	},
	patch<T = unknown>(path: string, body?: unknown): Promise<T> {
		return request<T>('PATCH', path, body ?? {})
	},
	del<T = unknown>(path: string): Promise<T> {
		return request<T>('DELETE', path)
	},
}
