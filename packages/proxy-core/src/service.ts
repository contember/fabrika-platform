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

import {
	answersFile,
	AUTH_CALLBACK_PATH,
	compileEndpointTable,
	DELEGATION_HEADER,
	ENDPOINT_HEADER,
	HANDOFF_COOKIE_TTL_SECONDS,
	isCanonicalPath,
	planEndpoint,
	SESSION_COOKIE,
	splitRequestTarget,
} from '@fabrika/auth-core'
import { uuidv7 } from '@fabrika/platform'
import { Authorizer, type AuthorizerOptions, type Decision, type DenyReason, type ForwardedRequest, type ResolvedApp } from './authorize'
import type { InstallationBrand } from './brand'
import type { TokenCache } from './cache'
import {
	APP_QUERY_PARAM,
	AUTH_SIGNOUT_PATH,
	DEFAULT_HEALTH_PATH,
	DEFAULT_VERIFY_PATH,
	FORWARD_AUTHORIZATION_HEADER,
	FORWARDED_HOST_HEADER,
	FORWARDED_METHOD_HEADER,
	FORWARDED_PROTO_HEADER,
	FORWARDED_URI_HEADER,
	PREFLIGHT_HEADER,
	PROXY_TOKEN_HEADER,
	REQUEST_ID_HEADER,
} from './constants'
import { type HandoffAttempt, handoffCookieName } from './handoff'
import {
	appFileTreatment,
	appHeaderPolicy,
	applyCrossOriginHeaders,
	applyFileTreatment,
	applyHeaderPolicy,
	BASE_HEADER_POLICY,
	crossOriginHeaders,
	type HeaderPolicy,
	preflightHeaders,
	transportPolicy,
} from './headers'
import type { DelegationIssuer, IamGateway } from './iam'
import { type LogFields, type ProxyLogger, redactPath, silentLogger } from './log'
import { formatOAuthBearerChallenge, isApplicationEntry, type ManifestEndpointRow, type ProxyApp, type ProxyManifest } from './manifest'
import { findOAuthMetadata, OAUTH_METADATA_VERIFY_PATH, oauthMetadataResponse } from './oauth'
import { errorAnswer, isPageNavigation, type PageContent, pageResponse, renderPage } from './pages'

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
	/** Issues delegation grants for membership and scope-creating endpoints; see `AuthorizerOptions.delegations`. */
	delegations?: DelegationIssuer | null
}

export type VerifyService = (request: Request) => Promise<Response>

/** A hostname we are willing to build a URL from. Anything else is a malformed forward → deny. */
const HOST_PATTERN = /^[a-z0-9.\-[\]]+(:\d{1,5})?$/i

/**
 * Build the `/verify` service. Endpoint tables are compiled once here, not per request — the planner is
 * on the hot path of every request to every app.
 */
export function createVerifyService(config: VerifyServiceConfig): VerifyService {
	const logger = config.logger ?? silentLogger
	const healthPath = config.healthPath ?? DEFAULT_HEALTH_PATH

	const byId = new Map<string, ResolvedApp>()
	const byHost = new Map<string, ResolvedApp>()
	const policies = new Map<string, HeaderPolicy>()
	// The client's logo on every page this service answers with (ADR-0066); the fabrika mark without one.
	const brand = config.manifest.brand ?? null
	for (const app of config.manifest.apps) {
		const resolved = resolveApp(app)
		byId.set(app.id, resolved)
		policies.set(app.id, isApplicationEntry(app) ? appHeaderPolicy(app) : BASE_HEADER_POLICY)
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
	if (config.delegations !== undefined) {
		authorizerOptions.delegations = config.delegations
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
			if (url.pathname !== DEFAULT_VERIFY_PATH && url.pathname !== OAUTH_METADATA_VERIFY_PATH) {
				return withPolicy(textResponse(404, 'not found'), BASE_HEADER_POLICY)
			}
			if (request.method !== 'GET' && request.method !== 'HEAD') {
				// `forward_auth` always rewrites to GET; anything else did not come from our config.
				return withPolicy(textResponse(405, 'method not allowed'), BASE_HEADER_POLICY)
			}

			// The forwarded request's headers are this request's: `forward_auth` and the Worker copy the original ones.
			const asPage = isPageNavigation(request.headers)
			const read = readForwardedRequest(request, requestId)
			if (!read.ok) {
				const status = read.reason === 'non_canonical_path' ? 400 : 403
				return withPolicy(denied(logger, { requestId }, { outcome: 'deny', status, reason: read.reason }, { asPage, brand }), earlyPolicy(request, url))
			}
			const forwarded = read.request

			const resolved = selectApp(url, forwarded.url.host, byId, byHost)
			if (resolved === null) {
				const fields = { requestId, host: forwarded.url.host, path: redactPath(forwarded.url.pathname) }
				return withPolicy(denied(logger, fields, { outcome: 'deny', status: 403, reason: 'no_app' }, { asPage, brand }), BASE_HEADER_POLICY)
			}

			if (url.pathname === OAUTH_METADATA_VERIFY_PATH) {
				const metadata = findOAuthMetadata(resolved.app, forwarded.url)
				return metadata === null
					? withPolicy(textResponse(404, 'not found'), policies.get(resolved.app.id) ?? BASE_HEADER_POLICY)
					: oauthMetadataResponse(metadata, forwarded.method)
			}

			// The handoff callback is checked BEFORE the endpoint table: it is how a browser obtains a
			// session, so it cannot itself be behind an endpoint. Because Caddy returns a non-2xx auth
			// response verbatim, answering 302 + Set-Cookie here reaches the client and never the app.
			// The sign-out is answered here for the same reason: a browser whose session is gone must still reach it.
			const isCallback = forwarded.url.pathname === AUTH_CALLBACK_PATH
			const decision = isCallback
				? await authorizer.authorizeCallback(resolved, forwarded)
				: forwarded.url.pathname === AUTH_SIGNOUT_PATH
				? authorizer.signOut(resolved, forwarded)
				: await authorizer.authorize(resolved, forwarded)
			const fields: LogFields = {
				requestId,
				app: resolved.app.id,
				host: forwarded.url.host,
				method: forwarded.method,
				path: redactPath(forwarded.url.pathname),
			}
			if (decision.outcome === 'allow') {
				logger.info('allow', { ...fields, subject: decision.subject, endpoint: decision.endpoint })
				const headers = new Headers({ 'cache-control': 'no-store', [REQUEST_ID_HEADER]: requestId })
				if (decision.token !== null) {
					headers.set(PROXY_TOKEN_HEADER, decision.token)
				}
				if (decision.endpoint !== null) {
					headers.set(ENDPOINT_HEADER, decision.endpoint)
				}
				if (decision.delegation !== null) {
					headers.set(DELEGATION_HEADER, decision.delegation)
				}
				if (decision.forwardsAuthorization) {
					headers.set(FORWARD_AUTHORIZATION_HEADER, '1')
				}
				// The composition writes it onto the application's answer, after the policy deleted the application's own.
				if (decision.crossOrigin !== null) {
					applyCrossOriginHeaders(headers, crossOriginHeaders(decision.crossOrigin))
				}
				return new Response(null, { status: 204, headers })
			}
			const policy = policies.get(resolved.app.id) ?? BASE_HEADER_POLICY
			if (decision.outcome === 'preflight') {
				logger.info('preflight', fields)
				// A 2xx the composition answers as-is, so the preflight never reaches the application.
				const answer = withPolicy(new Response(null, { status: 204, headers: { 'cache-control': 'no-store', [PREFLIGHT_HEADER]: '1' } }), policy)
				applyCrossOriginHeaders(answer.headers, preflightHeaders(decision.allowOrigin, decision.method))
				return answer
			}
			// A download's every answer is an attachment, so its refusal stays the text: a page would be saved, not shown.
			const download = isDownload(resolved, forwarded)
			const answer = decision.outcome === 'handoff'
				? handoff(logger, fields, decision)
				: decision.outcome === 'signout'
				? signedOut(logger, fields, decision)
				: denied(logger, fields, decision, { isCallback, asPage: asPage && !download, brand })
			const treated = download ? withFileTreatment(answer, appFileTreatment(resolved.app)) : withPolicy(answer, policy)
			if (decision.outcome === 'deny' && decision.crossOrigin !== undefined) {
				applyCrossOriginHeaders(treated.headers, crossOriginHeaders(decision.crossOrigin))
			}
			return treated
		} catch {
			// The last line of the fail-closed guarantee. No `err` is inspected or logged: a caught
			// error can stringify a URL, a header or a body, any of which may carry a credential.
			logger.error('verify failed', { requestId })
			return withPolicy(errorAnswer(403, DENY_TEXT[403], isPageNavigation(request.headers), brand), earlyPolicy(request, null))
		}
	}

	/**
	 * A refusal before the request is read: the base policy, plus the transport header of the application host it
	 * names, when the forwarded host (and the pinned app) resolves to one. Nothing of the host decides anything else.
	 */
	function earlyPolicy(request: Request, verifyUrl: URL | null): HeaderPolicy {
		try {
			const host = request.headers.get(FORWARDED_HOST_HEADER) ?? request.headers.get('Host') ?? ''
			const resolved = selectApp(verifyUrl ?? new URL(request.url), host, byId, byHost)
			return resolved === null || !isApplicationEntry(resolved.app)
				? BASE_HEADER_POLICY
				: [...BASE_HEADER_POLICY, ...transportPolicy(resolved.app.scheme)]
		} catch {
			return BASE_HEADER_POLICY
		}
	}
}

function handoff(logger: ProxyLogger, fields: LogFields, decision: Extract<Decision, { outcome: 'handoff' }>): Response {
	logger.info('handoff', fields)
	return handoffResponse(decision)
}

/**
 * Clear the app session with the attributes it was set with, so the browser matches and drops it. The cookie is
 * cleared whether or not the request carried one: the answer is the same for a browser already signed out.
 */
function signedOut(logger: ProxyLogger, fields: LogFields, decision: Extract<Decision, { outcome: 'signout' }>): Response {
	logger.info('signout', fields)
	const headers = new Headers({ location: decision.location, 'cache-control': 'no-store' })
	headers.append('set-cookie', secureCookie(SESSION_COOKIE, '', 0))
	return new Response(null, { status: 302, headers })
}

/** An answer the proxy writes reaches the client as-is, so it carries the policy the application's own answers do. */
function withPolicy(response: Response, policy: HeaderPolicy): Response {
	applyHeaderPolicy(response.headers, policy)
	return response
}

function withFileTreatment(response: Response, treatment: HeaderPolicy): Response {
	applyFileTreatment(response.headers, treatment)
	return response
}

/**
 * Whether the request selects a download endpoint or a procedure that answers a stored file, whose every answer gets
 * the file treatment instead of the policy.
 */
function isDownload(resolved: ResolvedApp, forwarded: ForwardedRequest): boolean {
	const plan = planEndpoint(resolved.table, forwarded.method, forwarded.rawPath)
	return plan.outcome === 'endpoint' && answersFile(plan.endpoint)
}

/**
 * Render a redeemed handoff: set the app session on THIS host and send the browser where IAM said.
 *
 * This is the ONE place the proxy writes the long-lived app session. It separately writes a
 * short-lived handoff verifier when starting login, then clears that verifier here. The sign-out clears the session.
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

/**
 * Emit the log line for a refusal and render its response. The reason is logged, never returned. `asPage` is a
 * navigation that is not a download (`./pages`), which reads the status's page in place of its text.
 */
function denied(
	logger: ProxyLogger,
	fields: LogFields,
	decision: Extract<Decision, { outcome: 'deny' | 'login' }>,
	{ isCallback = false, asPage, brand }: { isCallback?: boolean; asPage: boolean; brand: InstallationBrand | null },
): Response {
	const reason: DenyReason = decision.reason
	if (decision.outcome === 'login') {
		logger.info('login', { ...fields, reason, status: decision.status })
		return decision.status === 302
			? loginRedirect(decision.location, decision.handoff)
			: loginRequired(decision.location, decision.handoff)
	}
	logger.warn('deny', { ...fields, reason, status: decision.status })
	const response = isCallback ? callbackFailure(decision.status, brand) : errorAnswer(decision.status, DENY_TEXT[decision.status], asPage, brand)
	if (decision.clearHandoffState !== undefined) {
		response.headers.append('set-cookie', clearHandoffCookie(decision.clearHandoffState))
	}
	if (decision.challenge !== undefined) {
		response.headers.set('WWW-Authenticate', formatOAuthBearerChallenge(decision.challenge))
	}
	return response
}

/**
 * The callback refusal is always a page, also without `Sec-Fetch-Mode`: this path is only ever reached by
 * a browser following IAM's redirect, and its text says what the sign-in did rather than the status's.
 *
 * It deliberately does NOT bounce back into login. A browser that dropped the handoff cookie on this
 * host while keeping IAM's session would be sent straight back here, and the automatic retry becomes
 * an endless loop; a link someone has to click cannot loop on its own.
 *
 * The text is fixed per status and names no reason, because the reasons are not distinguishable from
 * out here anyway: `invalid_session` covers an expired verifier and a code IAM refused alike. Coarse
 * deny reasons stay in the log (`../proxy/CLAUDE.md`).
 */
function callbackFailure(status: number, brand: InstallationBrand | null): Response {
	const content: Omit<PageContent, 'action'> = status === 503
		? { title: 'Sign-in is unavailable', detail: 'The sign-in service could not be reached. Please try again in a moment.' }
		: {
			title: 'Sign-in did not complete',
			detail: 'The sign-in link has expired or has already been used. Signing in again will issue a new one.',
		}
	return pageResponse(status, renderPage({ ...content, action: { href: '/', label: 'Start again' } }, String(status), brand))
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

const DENY_TEXT: Record<Extract<Decision, { outcome: 'deny' }>['status'], string> = {
	400: 'bad request',
	401: 'unauthorized',
	403: 'forbidden',
	503: 'unavailable',
}

function textResponse(status: number, body: string): Response {
	return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
}

type ForwardedRead = { ok: true; request: ForwardedRequest } | { ok: false; reason: 'bad_forward' | 'non_canonical_path' }

/**
 * Rebuild the original request from the forwarded headers. Refuses — a DENY — whenever the
 * description is incomplete or suspicious, because a proxy that guesses what was asked for is a proxy
 * that authorizes the wrong thing. That includes a missing method: there is no default to guess.
 *
 * The path is checked RAW, before any URL is built: assigning a pathname resolves `..` and `%2e%2e`, so
 * `/a/../admin` would otherwise be matched as `/admin` while the upstream receives the original.
 *
 * The URL is assembled by assignment rather than by `new URL(uri, base)`: a request line of
 * `GET //evil.example/x` is a legal path, and relative resolution would read it as a protocol-relative
 * URL, silently changing the host — which would both select the wrong app and turn the login bounce
 * into an open redirect.
 */
function readForwardedRequest(request: Request, requestId: string): ForwardedRead {
	const uri = request.headers.get(FORWARDED_URI_HEADER)
	const method = request.headers.get(FORWARDED_METHOD_HEADER)
	if (uri === null || !uri.startsWith('/') || method === null || method === '') {
		return { ok: false, reason: 'bad_forward' }
	}
	const target = splitRequestTarget(uri)
	if (!isCanonicalPath(target.pathname)) {
		return { ok: false, reason: 'non_canonical_path' }
	}
	const host = request.headers.get(FORWARDED_HOST_HEADER) ?? request.headers.get('Host')
	if (host === null || !HOST_PATTERN.test(host)) {
		return { ok: false, reason: 'bad_forward' }
	}
	const proto = request.headers.get(FORWARDED_PROTO_HEADER) === 'http' ? 'http' : 'https'

	const url = new URL(`${proto}://${host}`)
	url.pathname = target.pathname
	url.search = target.search
	if (url.host.toLowerCase() !== host.toLowerCase()) {
		// Defensive: the assignment above must not have been able to move the host.
		return { ok: false, reason: 'bad_forward' }
	}

	return { ok: true, request: { method, url, rawPath: target.pathname, headers: request.headers, requestId } }
}

/**
 * Which app is this? The generated Caddy route pins `?app=<id>`, because the route already knows.
 * Host lookup is the fallback for hand-written configs. Neither resolving is a deny — there is no
 * "default app".
 *
 * A PINNED app is still cross-checked against the forwarded host. `X-Forwarded-Host` is
 * client-controllable once `trusted_proxies` is set (ADR-0022), and the pin is what stops it choosing
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

/** The compiled table an app is protected by. The manifest parser already refused an ambiguous table. */
function resolveApp(app: ProxyApp): ResolvedApp {
	return { app, table: compileEndpointTable<ManifestEndpointRow>(app) }
}

/** Lower-case, port stripped — the one normalization every host comparison in this file uses. */
function normalizeHost(host: string): string {
	return host.toLowerCase().replace(/:\d+$/, '')
}
