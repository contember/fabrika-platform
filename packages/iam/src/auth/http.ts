import { type Config } from '../services'

/**
 * Open-redirect guard for a `?redirect=` that stays on IAM: accept only an absolute URL on IAM's OWN
 * origin, and fall back to the issuer for anything else. Prevents
 * `/auth/login?redirect=https://evil.example` from bouncing a logged-in user out.
 *
 * It used to also admit the configured session-cookie domain and, locally, any `*.localhost` — the
 * allowlist for the shared cookie's reach. ADR-0023 retired that cookie, so **the return-origin
 * registry is now the only authority on sending a browser to another host**, and it is consulted by
 * `readHandoff` before this function is ever reached. Widening this back would be a second, weaker
 * answer to the same question.
 *
 * The comparison is the whole origin, not the hostname: the issuer already fixes the scheme and port,
 * so there is nothing left for a special case to decide.
 */
export function safeRedirect(raw: string | null, config: Config): string {
	if (!raw) {
		return config.issuer
	}
	try {
		const target = new URL(raw)
		return target.origin === new URL(config.issuer).origin ? target.toString() : config.issuer
	} catch {
		return config.issuer
	}
}

export function sameOrigin(request: Request, config: Config): boolean {
	const fetchSite = request.headers.get('Sec-Fetch-Site')
	if (fetchSite !== null && fetchSite !== 'same-origin') return false
	const originHeader = request.headers.get('Origin')
	// `Origin: null` is what a real browser sends here, and it is not an attack. Every page these
	// forms live on carries `Referrer-Policy: no-referrer`, and Fetch's "append a request Origin
	// header" serializes the origin as `null` under that policy — so a same-origin form POST arrives
	// with `Origin: null` and no `Referer` at all. `Sec-Fetch-Site` is then the only same-origin proof
	// left, and it is the one a page cannot forge: `Sec-` is a forbidden header prefix, so the browser
	// is its only writer, and a cross-site post is already refused above. Measured in Chromium 149,
	// not assumed.
	if (originHeader === 'null') return fetchSite === 'same-origin'
	const origin = originHeader ?? originOf(request.headers.get('Referer'))
	if (origin === null) return false
	try {
		return new URL(origin).origin === new URL(config.issuer).origin
	} catch {
		return false
	}
}

function originOf(value: string | null): string | null {
	if (value === null) return null
	try {
		return new URL(value).origin
	} catch {
		return null
	}
}

export async function readForm(request: Request): Promise<URLSearchParams | null> {
	const contentLength = Number(request.headers.get('Content-Length') ?? '0')
	if (Number.isFinite(contentLength) && contentLength > 16_384) return null
	const contentType = request.headers.get('Content-Type') ?? ''
	if (!contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) return null
	if (request.body === null) return new URLSearchParams()
	const reader = request.body.getReader()
	const decoder = new TextDecoder()
	let body = ''
	let bytes = 0
	try {
		while (true) {
			const chunk = await reader.read()
			if (chunk.done) break
			bytes += chunk.value.byteLength
			if (bytes > 16_384) {
				await reader.cancel()
				return null
			}
			body += decoder.decode(chunk.value, { stream: true })
		}
		body += decoder.decode()
		return new URLSearchParams(body)
	} catch {
		return null
	}
}

export function stringValue(value: string | null): string | null {
	return typeof value === 'string' ? value : null
}

export function methodNotAllowed(): Response {
	return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } })
}

/**
 * Headers for a 302 out of this surface. `no-store` belongs on every one of them, not just the
 * password pages: these are the responses that carry the 30-day session cookie and, on the handoff
 * path, the single-use code in the `Location` itself.
 */
export function redirectHeaders(location: string): Headers {
	return new Headers({ location, 'cache-control': 'no-store' })
}

/** A minimal error page for the browser-facing auth flow (the happy path always redirects). */
export function authError(message: string, status: number): Response {
	return new Response(`Authentication error: ${message}`, {
		status,
		headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
	})
}

/** Keep an untrusted value fit for a plain-text error body: printable ASCII, bounded. */
export function printable(value: string): string {
	return value.replace(/[^\x20-\x7e]/g, '').slice(0, 120)
}
