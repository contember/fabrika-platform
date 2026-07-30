// Typed fetch helper for the admin JSON API.
//
// Same-origin through the control plane (`/iam/admin/...`), `credentials: 'include'`,
// JSON in/out. Non-2xx maps to a typed `ApiError`. A 401 may carry the public IAM login
// URL, which returns the user to the current console page after OIDC.

/** A typed non-2xx API failure surfaced to pages / error boundaries. */
export class ApiError extends Error {
	readonly status: number
	readonly loginUrl?: string

	constructor(status: number, message: string, loginUrl?: string) {
		super(message)
		this.name = 'ApiError'
		this.status = status
		if (loginUrl !== undefined) this.loginUrl = loginUrl
	}
}

const BASE = '/iam/admin'
const LOGIN_BOUNCE_KEY = 'fabrika.access.login-bounce'
const LOGIN_BOUNCE_WINDOW_MS = 10_000

function redirectToLogin(loginUrl: string): boolean {
	const now = Date.now()
	const last = Number(sessionStorage.getItem(LOGIN_BOUNCE_KEY) ?? '0')
	if (Number.isFinite(last) && now - last < LOGIN_BOUNCE_WINDOW_MS) return false
	sessionStorage.setItem(LOGIN_BOUNCE_KEY, String(now))
	const target = new URL(loginUrl)
	target.searchParams.set('redirect', location.href)
	location.assign(target.toString())
	return true
}

async function readError(res: Response): Promise<ApiError> {
	let message = `Request failed (${res.status})`
	let loginUrl: string | undefined
	try {
		const contentType = res.headers.get('content-type') ?? ''
		if (contentType.includes('application/json')) {
			const body: unknown = await res.json()
			if (
				body !== null
				&& typeof body === 'object'
				&& 'message' in body
				&& typeof body.message === 'string'
			) {
				message = body.message
			} else if (
				body !== null
				&& typeof body === 'object'
				&& 'error' in body
				&& typeof body.error === 'string'
			) {
				message = body.error
			}
			if (
				body !== null
				&& typeof body === 'object'
				&& 'loginUrl' in body
				&& typeof body.loginUrl === 'string'
			) {
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
			redirect: 'manual',
			body: body === undefined ? undefined : JSON.stringify(body),
		})
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : 'Network request failed'
		throw new ApiError(0, message)
	}

	if (!res.ok) {
		const error = await readError(res)
		if (error.status === 401 && error.loginUrl !== undefined && redirectToLogin(error.loginUrl)) {
			throw new ApiError(401, 'Session expired — redirecting to sign in.')
		}
		throw error
	}

	// Read the body as text and parse it. An empty body (204 / no content) normalizes to
	// `null` so mutation callers that ignore the result get a defined value. `JSON.parse`
	// returns `any`, so the caller's generic `T` applies at this boundary without a cast.
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
