// Reading the fabrika-native credential off the incoming Request, to forward to the IAM service's
// management RPCs (issueKey / issueJwt / revokeKey / listPrincipals). Precedence: the token the PROXY
// injected (the one it already verified), then an `Authorization: Bearer` (a machine `px_` key or a
// passthrough JWT), then the browser's `px_token` access cookie. None of this is a security boundary —
// IAM re-resolves and re-authorizes the caller server-side from this credential.

import { PROXY_TOKEN_HEADER, TOKEN_COOKIE } from '@fabrika/auth-core'

/** Cloudflare's per-request ray id; we use it as the correlation request id. */
const RAY_HEADER = 'cf-ray'

export interface ForwardedCredentials {
	/** The native credential (a `px_` key / passthrough JWT / `px_token`), or null when absent. */
	credential: string | null
	/** cf-ray, or a fresh UUID when absent (e.g. local dev). */
	requestId: string
}

/** The correlation id for this request: cf-ray when the platform supplies one, else a fresh UUID. */
export function readRequestId(req: Request): string {
	return req.headers.get(RAY_HEADER) ?? crypto.randomUUID()
}

/** Pull the native credential and a correlation id off the request. `credential` may be null. */
export function readCredentials(req: Request): ForwardedCredentials {
	return {
		credential: nonEmpty(req.headers.get(PROXY_TOKEN_HEADER))
			?? readBearer(req.headers.get('Authorization'))
			?? parseCookie(req.headers.get('Cookie'), TOKEN_COOKIE),
		requestId: readRequestId(req),
	}
}

function nonEmpty(value: string | null): string | null {
	if (value === null) {
		return null
	}
	const trimmed = value.trim()
	return trimmed === '' ? null : trimmed
}

/** Read the token out of an `Authorization: Bearer <token>` header. Null when absent/non-bearer. */
function readBearer(header: string | null): string | null {
	if (header === null) {
		return null
	}
	const match = /^Bearer\s+(.+)$/i.exec(header.trim())
	return match ? (match[1]?.trim() ?? null) : null
}

/** Read a single cookie value out of a raw Cookie header. Returns null when absent. */
function parseCookie(header: string | null, name: string): string | null {
	if (!header) {
		return null
	}
	for (const part of header.split(';')) {
		const eq = part.indexOf('=')
		if (eq === -1) {
			continue
		}
		if (part.slice(0, eq).trim() === name) {
			return part.slice(eq + 1).trim()
		}
	}
	return null
}
