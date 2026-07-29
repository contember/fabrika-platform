/**
 * The `forward_auth` endpoint — a fetch-style `Request → Response` service, written the way
 * `@fabrika/iam` is so the same code runs on Bun, Node and Workers.
 *
 * Caddy's contract (verified against `modules/caddyhttp/reverseproxy/forwardauth/caddyfile.go`):
 *   - the subrequest is rewritten to `GET <verifyPath>` with the ORIGINAL headers, plus
 *     `X-Forwarded-Method` / `X-Forwarded-Uri`, plus reverse_proxy's `X-Forwarded-{For,Proto,Host}`;
 *   - a **2xx** response lets the request continue, and each `copy_headers` field is copied onto the
 *     UPSTREAM request — but ONLY when non-empty (Caddy guards each copy with a `not vars ""` matcher);
 *   - **any other status** is returned to the client verbatim, so a 302 to `/auth/login` just works.
 *
 * The two consequences that shape this file:
 *   1. the request being authorized is described ENTIRELY by the forwarded headers. Never look at
 *      this request's own method or path — a missing `X-Forwarded-Uri` must deny, not fall back;
 *   2. because an empty copy header is a no-op rather than a delete, the generated Caddy config
 *      strips the token header from the inbound request BEFORE `forward_auth` runs. Otherwise a
 *      client could present its own token header on a `public` path and have it reach the app.
 */

import { uuidv7 } from '@fabrika/auth-core'
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
import type { IamGateway } from './iam'
import { type LogFields, type ProxyLogger, redactPath, silentLogger } from './log'
import type { ProxyManifest } from './manifest'

export interface VerifyServiceConfig {
	manifest: ProxyManifest
	iam: IamGateway
	/** IAM's origin — token `iss` and the base of the login bounce. */
	issuer: string
	/** `null`/omitted disables the token cache. Same decisions, more IAM calls. */
	cache?: TokenCache | null
	logger?: ProxyLogger
	/** Must equal the `uri` in the generated Caddy config. Default `/verify`. */
	verifyPath?: string
	/** Liveness probe path on the auth service's own port. Default `/healthz`. */
	healthPath?: string
	/** Header the verified token is returned in for Caddy to copy upstream. */
	tokenHeader?: string
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
	const verifyPath = config.verifyPath ?? DEFAULT_VERIFY_PATH
	const healthPath = config.healthPath ?? DEFAULT_HEALTH_PATH
	const tokenHeader = config.tokenHeader ?? PROXY_TOKEN_HEADER

	const byId = new Map<string, ResolvedApp>()
	const byHost = new Map<string, ResolvedApp>()
	for (const app of config.manifest.apps) {
		const resolved: ResolvedApp = { app, gates: compileGates(app.gates) }
		byId.set(app.id, resolved)
		for (const host of app.hosts) {
			byHost.set(host.toLowerCase(), resolved)
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
		const suppliedRequestId = request.headers.get(REQUEST_ID_HEADER)
		const requestId = suppliedRequestId === null || suppliedRequestId === '' ? uuidv7() : suppliedRequestId
		try {
			const url = new URL(request.url)
			if (url.pathname === healthPath) {
				return new Response('ok', { status: 200, headers: { 'cache-control': 'no-store' } })
			}
			if (url.pathname !== verifyPath) {
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

			const decision = await authorizer.authorize(resolved, forwarded)
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
					headers.set(tokenHeader, decision.token)
				}
				return new Response(null, { status: 204, headers })
			}
			return denied(logger, fields, decision)
		} catch {
			// The last line of the fail-closed guarantee. No `err` is inspected or logged: a caught
			// error can stringify a URL, a header or a body, any of which may carry a credential.
			logger.error('verify failed', { requestId })
			return textResponse(403, 'forbidden')
		}
	}
}

/** Emit the log line for a refusal and render its response. The reason is logged, never returned. */
function denied(logger: ProxyLogger, fields: LogFields, decision: Extract<Decision, { outcome: 'deny' | 'login' }>): Response {
	const reason: DenyReason = decision.reason
	if (decision.outcome === 'login') {
		logger.info('login', { ...fields, reason })
		return new Response(null, {
			status: 302,
			headers: { location: decision.location, 'cache-control': 'no-store' },
		})
	}
	logger.warn('deny', { ...fields, reason, status: decision.status })
	return textResponse(decision.status, decision.status === 401 ? 'unauthorized' : decision.status === 503 ? 'unavailable' : 'forbidden')
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
 */
function selectApp(verifyUrl: URL, host: string, byId: Map<string, ResolvedApp>, byHost: Map<string, ResolvedApp>): ResolvedApp | null {
	const pinned = verifyUrl.searchParams.get(APP_QUERY_PARAM)
	if (pinned !== null) {
		return byId.get(pinned) ?? null
	}
	const hostname = host.toLowerCase().replace(/:\d+$/, '')
	return byHost.get(hostname) ?? null
}
