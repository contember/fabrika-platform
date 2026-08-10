/**
 * The `forward_auth` endpoint — a fetch-style `Request → Response` service, written the way
 * `@fabrika/iam` is so the same code runs on Bun, Node and Workers.
 *
 * Caddy's contract (verified against `modules/caddyhttp/reverseproxy/forwardauth/caddyfile.go`):
 *   - the subrequest is rewritten to `GET /verify` with the ORIGINAL headers, plus
 *     `X-Forwarded-Method` / `X-Forwarded-Uri`, plus reverse_proxy's `X-Forwarded-{For,Proto,Host}`;
 *   - a **2xx** response lets the request continue, and each `copy_headers` field is copied onto the
 *     UPSTREAM request — but ONLY when non-empty (Caddy guards each copy with a `not vars ""` matcher);
 *   - **any other status** is returned to the client verbatim — status, headers AND body, verified
 *     against caddy 2.10.2 — so both a 302 to `/auth/login` and a 401 carrying a JSON login envelope
 *     reach the caller and neither reaches the app.
 *
 * The two consequences that shape this file:
 *   1. the request being authorized is described ENTIRELY by the forwarded headers. Never look at
 *      this request's own method or path — a missing `X-Forwarded-Uri` must deny, not fall back;
 *   2. because an empty copy header is a no-op rather than a delete, the generated Caddy config
 *      strips the token header AND the request id from the inbound request BEFORE `forward_auth`
 *      runs. Otherwise a client could present its own token header on a `public` path and have it
 *      reach the app, or choose the correlation id that lands in IAM's audit trail. Both are handed
 *      back on a 2xx, so the edge is the only thing that mints either.
 */

import { AUTH_CALLBACK_PATH, HANDOFF_COOKIE_TTL_SECONDS, SESSION_COOKIE, uuidv7 } from '@fabrika/auth-core'
import type { ProxyManifest } from '@fabrika/proxy-contract'
import { Authorizer, type AuthorizerOptions, type Decision, type DenyReason, type ForwardedRequest, type ResolvedApp } from './authorize'
import type { TokenCache } from './cache'
import {
	APP_QUERY_PARAM,
	DEFAULT_HEALTH_PATH,
	DEFAULT_VERIFY_PATH,
	FORWARDED_HOST_HEADER,
	FORWARDED_METHOD_HEADER,
	FORWARDED_PROTO_HEADER,
	FORWARDED_URI_HEADER,
	PROXY_TOKEN_HEADER,
	REQUEST_ID_HEADER,
} from './constants'
import { compileGates } from './gates'
import { type HandoffAttempt, handoffCookieName } from './handoff'
import type { IamGateway } from './iam'
import { type LogFields, type ProxyLogger, redactPath, silentLogger } from './log'

export interface VerifyServiceConfig {
	manifest: ProxyManifest
	iam: IamGateway
	/** IAM's origin — token `iss` and the base of the login bounce. */
	issuer: string
	/** `null`/omitted disables the token cache. Same decisions, more IAM calls. */
	cache?: TokenCache | null
	logger?: ProxyLogger
	/** Liveness probe path on the auth service's own port. Default `/healthz`. */
	healthPath?: string
	/** Unix seconds. Injectable for tests. */
	now?: () => number
}

export type VerifyService = (request: Request) => Promise<Response>

/** A hostname we are willing to build a URL from. Anything else is a malformed forward → deny. */
const HOST_PATTERN = /^[a-z0-9.\-[\]]+(:\d{1,5})?$/i

/**
 * Build the `/verify` service. Gates are compiled once here, not per request — the matcher is on the
 * hot path of every request to every app.
 */
export function createVerifyService(config: VerifyServiceConfig): VerifyService {
	const logger = config.logger ?? silentLogger
	const healthPath = config.healthPath ?? DEFAULT_HEALTH_PATH

	const byId = new Map<string, ResolvedApp>()
	const byHost = new Map<string, ResolvedApp>()
	for (const app of config.manifest.apps) {
		const resolved: ResolvedApp = { app, gates: compileGates(app.gates) }
		byId.set(app.id, resolved)
		for (const host of app.hosts) {
			// Normalized exactly as a forwarded host is, so the two sides cannot disagree about a port.
			byHost.set(normalizeHost(host), resolved)
		}
	}

	const authorizerOptions: AuthorizerOptions = { iam: config.iam, issuer: config.issuer }
	if (config.cache !== undefined) {
		authorizerOptions.cache = config.cache
	}
	if (config.now !== undefined) {
		authorizerOptions.now = config.now
	}
	const authorizer = new Authorizer(authorizerOptions)

	return async (request: Request): Promise<Response> => {
		// Only the edge may supply this: it is written to IAM's `auth_log` and `audit_events`, and the
		// generated Caddy route (and the Cloudflare Worker) delete a client-supplied one before we run.
		const suppliedRequestId = request.headers.get(REQUEST_ID_HEADER)
		const requestId = suppliedRequestId === null || suppliedRequestId === '' ? uuidv7() : suppliedRequestId
		try {
			const url = new URL(request.url)
			if (url.pathname === healthPath) {
				return new Response('ok', { status: 200, headers: { 'cache-control': 'no-store' } })
			}
			if (url.pathname !== DEFAULT_VERIFY_PATH) {
				return textResponse(404, 'not found')
			}
			if (request.method !== 'GET' && request.method !== 'HEAD') {
				// `forward_auth` always rewrites to GET; anything else did not come from our config.
				return textResponse(405, 'method not allowed')
			}

			const forwarded = readForwardedRequest(request, requestId)
			if (forwarded === null) {
				return denied(logger, { requestId }, { outcome: 'deny', status: 403, reason: 'bad_forward' })
			}

			const resolved = selectApp(url, forwarded.url.host, byId, byHost)
			if (resolved === null) {
				return denied(logger, { requestId, host: forwarded.url.host, path: redactPath(forwarded.url.pathname) }, {
					outcome: 'deny',
					status: 403,
					reason: 'no_app',
				})
			}

			// The handoff callback is checked BEFORE the gates: it is how a browser becomes able to
			// satisfy one, so it cannot itself be behind one. Because Caddy returns a non-2xx auth
			// response verbatim, answering 302 + Set-Cookie here reaches the client and never the app.
			const isCallback = forwarded.url.pathname === AUTH_CALLBACK_PATH
			const decision = isCallback
				? await authorizer.authorizeCallback(resolved, forwarded)
				: await authorizer.authorize(resolved, forwarded)
			const fields: LogFields = {
				requestId,
				app: resolved.app.id,
				host: forwarded.url.host,
				method: forwarded.method,
				path: redactPath(forwarded.url.pathname),
			}
			if (decision.outcome === 'allow') {
				logger.info('allow', { ...fields, gate: decision.gate, subject: decision.subject })
				const headers = new Headers({ 'cache-control': 'no-store', [REQUEST_ID_HEADER]: requestId })
				if (decision.token !== null) {
					headers.set(PROXY_TOKEN_HEADER, decision.token)
				}
				return new Response(null, { status: 204, headers })
			}
			if (decision.outcome === 'handoff') {
				logger.info('handoff', fields)
				return handoffResponse(decision)
			}
			return denied(logger, fields, decision, isCallback)
		} catch {
			// The last line of the fail-closed guarantee. No `err` is inspected or logged: a caught
			// error can stringify a URL, a header or a body, any of which may carry a credential.
			logger.error('verify failed', { requestId })
			return textResponse(403, 'forbidden')
		}
	}
}

/**
 * Render a redeemed handoff: set the app session on THIS host and send the browser where IAM said.
 *
 * This is the ONE place the proxy writes the long-lived app session. It separately writes a
 * short-lived handoff verifier when starting login, then clears that verifier here.
 *
 * Every attribute is fixed by `SESSION_COOKIE`'s `__Host-` prefix: `Secure`, `Path=/`, and no
 * `Domain`. The absent `Domain` is the substance — the session belongs to this app's host and no
 * sibling can read it — and the prefix is the browser-enforced restatement, which additionally stops a
 * sibling under a shared registrable domain from planting a second cookie of this name. `Secure` is
 * unconditional rather than following the manifest's scheme: the prefix requires it, so a conditional
 * could only produce a cookie the browser discards. It stays correct behind a terminating balancer
 * (the socket is plain HTTP, the browser spoke HTTPS) and on `*.localhost`, which browsers treat as
 * potentially trustworthy.
 */
function handoffResponse(decision: Extract<Decision, { outcome: 'handoff' }>): Response {
	const maxAge = Math.max(0, decision.expiresAt - Math.floor(Date.now() / 1000))
	const headers = new Headers({ location: decision.location, 'cache-control': 'no-store' })
	headers.append('set-cookie', secureCookie(SESSION_COOKIE, decision.session, maxAge))
	headers.append('set-cookie', clearHandoffCookie(decision.handoffState))
	return new Response(null, {
		status: 302,
		headers,
	})
}

/** Emit the log line for a refusal and render its response. The reason is logged, never returned. */
function denied(
	logger: ProxyLogger,
	fields: LogFields,
	decision: Extract<Decision, { outcome: 'deny' | 'login' }>,
	isCallback = false,
): Response {
	const reason: DenyReason = decision.reason
	if (decision.outcome === 'login') {
		logger.info('login', { ...fields, reason, status: decision.status })
		return decision.status === 302
			? loginRedirect(decision.location, decision.handoff)
			: loginRequired(decision.location, decision.handoff)
	}
	logger.warn('deny', { ...fields, reason, status: decision.status })
	const response = isCallback
		? callbackFailure(decision.status)
		: textResponse(decision.status, decision.status === 401 ? 'unauthorized' : decision.status === 503 ? 'unavailable' : 'forbidden')
	if (decision.clearHandoffState !== undefined) {
		response.headers.append('set-cookie', clearHandoffCookie(decision.clearHandoffState))
	}
	return response
}

/**
 * The callback refusal is the one denial a person reads. Every other one answers a program — an XHR,
 * an app request, Caddy itself — but this path is only ever reached by a browser following IAM's
 * redirect, and a viewport containing `forbidden` describes nothing the reader can act on.
 *
 * It deliberately does NOT bounce back into login. A browser that dropped the handoff cookie on this
 * host while keeping IAM's session would be sent straight back here, and the automatic retry becomes
 * an endless loop; a link someone has to click cannot loop on its own.
 *
 * The text is fixed per status and names no reason, because the reasons are not distinguishable from
 * out here anyway: `invalid_session` covers an expired verifier and a code IAM refused alike. Coarse
 * deny reasons stay in the log (`../proxy/CLAUDE.md`).
 */
function callbackFailure(status: number): Response {
	const [title, detail] = status === 503
		? ['Sign-in is unavailable', 'The sign-in service could not be reached. Please try again in a moment.']
		: ['Sign-in did not complete', 'The sign-in link has expired or has already been used. Signing in again will issue a new one.']
	// No script and no external reference: this page is served on the application's own origin, and a
	// deployment may sit behind a strict CSP that would blank anything else.
	const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #f4f4f5; color: #18181b;
	font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 27rem; padding: 2rem; }
h1 { margin: 0 0 .5rem; font-size: 1.25rem; }
p { margin: 0 0 1.5rem; color: #52525b; }
a { display: inline-block; padding: .55rem 1.1rem; border-radius: .375rem; background: #18181b; color: #fafafa; text-decoration: none; }
@media (prefers-color-scheme: dark) {
	body { background: #18181b; color: #fafafa; }
	p { color: #a1a1aa; }
	a { background: #fafafa; color: #18181b; }
}
</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p>${detail}</p>
<a href="/">Start again</a>
</main>
</body>
</html>
`
	return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
}

/** The bounce a document navigation gets: the browser follows it and comes back signed in. */
function loginRedirect(location: string, handoff: HandoffAttempt): Response {
	return new Response(null, {
		status: 302,
		headers: { location, 'cache-control': 'no-store', 'set-cookie': handoffCookie(handoff) },
	})
}

/**
 * The answer everything else gets — an XHR, a `fetch`, the console's own RPC POST. The envelope is
 * the one `@fabrika/app`'s browser client already parses (`bounceOnAuth` acts on a 401 whose
 * `error.type` is `auth` and which carries a `loginUrl`), so an expired console session becomes a
 * sign-in rather than a redirect `fetch` cannot follow.
 *
 * The message is a fixed string: the deny REASON stays coarse and stays in the log. The login URL
 * now rides in a body as well as in `Location`, which adds no way for a credential to reach a log —
 * Caddy logs request URIs and response headers, never bodies, and the access log already redacts
 * `?redirect=` out of both.
 */
function loginRequired(loginUrl: string, handoff: HandoffAttempt): Response {
	return new Response(JSON.stringify({ error: { type: 'auth', message: 'Authentication required', loginUrl } }), {
		status: 401,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'set-cookie': handoffCookie(handoff) },
	})
}

function handoffCookie(handoff: HandoffAttempt): string {
	const name = handoffCookieName(handoff.state)
	if (name === null) throw new Error('generated invalid handoff state')
	return secureCookie(name, handoff.verifier, HANDOFF_COOKIE_TTL_SECONDS)
}

function clearHandoffCookie(state: string): string {
	const name = handoffCookieName(state)
	if (name === null) throw new Error('invalid handoff state')
	return secureCookie(name, '', 0)
}

function secureCookie(name: string, value: string, maxAge: number): string {
	return [`${name}=${value}`, 'Path=/', `Max-Age=${maxAge}`, 'HttpOnly', 'SameSite=Lax', 'Secure'].join('; ')
}

function textResponse(status: number, body: string): Response {
	return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
}

/**
 * Rebuild the original request from the forwarded headers. Returns null — a DENY — whenever the
 * description is incomplete or suspicious, because a proxy that guesses what was asked for is a proxy
 * that authorizes the wrong thing.
 *
 * The URL is assembled by assignment rather than by `new URL(uri, base)`: a request line of
 * `GET //evil.example/x` is a legal path, and relative resolution would read it as a protocol-relative
 * URL, silently changing the host — which would both mis-match the gates and turn the login bounce
 * into an open redirect.
 */
function readForwardedRequest(request: Request, requestId: string): ForwardedRequest | null {
	const uri = request.headers.get(FORWARDED_URI_HEADER)
	if (uri === null || !uri.startsWith('/')) {
		return null
	}
	const host = request.headers.get(FORWARDED_HOST_HEADER) ?? request.headers.get('Host')
	if (host === null || !HOST_PATTERN.test(host)) {
		return null
	}
	const proto = request.headers.get(FORWARDED_PROTO_HEADER) === 'http' ? 'http' : 'https'

	const query = uri.indexOf('?')
	const url = new URL(`${proto}://${host}`)
	url.pathname = query === -1 ? uri : uri.slice(0, query)
	url.search = query === -1 ? '' : uri.slice(query)
	if (url.host.toLowerCase() !== host.toLowerCase()) {
		// Defensive: the assignment above must not have been able to move the host.
		return null
	}

	return {
		method: request.headers.get(FORWARDED_METHOD_HEADER) ?? 'GET',
		url,
		headers: request.headers,
		requestId,
	}
}

/**
 * Which app is this? The generated Caddy route pins `?app=<id>`, because the route already knows.
 * Host lookup is the fallback for hand-written configs. Neither resolving is a deny — there is no
 * "default app".
 *
 * A PINNED app is still cross-checked against the forwarded host. `X-Forwarded-Host` is
 * client-controllable once `trusted_proxies` is set (ADR-0010), and the pin is what stops it choosing
 * the app — but the same header then builds the login bounce and the handoff callback, so a request
 * pinned to app A claiming app B's host would send the browser somewhere the manifest never declared.
 * The authoritative host list is right here; use it.
 */
function selectApp(verifyUrl: URL, host: string, byId: Map<string, ResolvedApp>, byHost: Map<string, ResolvedApp>): ResolvedApp | null {
	const hostname = normalizeHost(host)
	const pinned = verifyUrl.searchParams.get(APP_QUERY_PARAM)
	if (pinned !== null) {
		const resolved = byId.get(pinned)
		if (resolved === undefined || !resolved.app.hosts.some((declared) => normalizeHost(declared) === hostname)) {
			return null
		}
		return resolved
	}
	return byHost.get(hostname) ?? null
}

/** Lower-case, port stripped — the one normalization every host comparison in this file uses. */
function normalizeHost(host: string): string {
	return host.toLowerCase().replace(/:\d+$/, '')
}
