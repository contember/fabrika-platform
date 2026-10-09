/**
 * The proxy authorization core ([ADR-0022](../../../docs/decisions/0022-the-proxy-is-the-only-enforcement-point.md)).
 *
 * Every entry — a contract application or an installation service — is protected by its endpoint table, in one pass
 * over ONE selected endpoint: `planEndpoint` → a `px_` key whose caller kind the endpoint admits, or else the session
 * when `human` may call → the requirement (`satisfies`) → admission → the delegation grant. There is no fall-through
 * to another endpoint. On an installation row that admits `oauth`, a bearer that is not a `px_` key is an OAuth
 * resource token, verified locally. A key or a session is exchanged with IAM once, cached, and thereafter verified
 * LOCALLY against the JWKS.
 *
 * A human miss becomes a bounce to IAM's `/auth/login`, in whichever shape the caller can act on: a
 * 302 for a document navigation, a 401 carrying the same URL in a JSON body for everything else (see
 * `isDocumentNavigation`). Caddy returns a non-2xx auth response — status, headers and body — to the
 * client verbatim, so both reach the caller and neither reaches the app. A request with no session
 * cookie needs no IAM call.
 *
 * NOTHING here returns an allow on an unexpected condition. Every `catch` maps to a deny.
 */

import {
	type AccessTokenClaims,
	API_KEY_PREFIX,
	AUTH_CODE_PARAM,
	AUTH_HANDOFF_STATE_PARAM,
	callerAdmittedAt,
	callerOf,
	type CompiledEndpointTable,
	formatEndpointHeader,
	planEndpoint,
	satisfies,
	SESSION_COOKIE,
	TOKEN_REFRESH_SKEW_SECONDS,
	type TokenCaller,
} from '@fabrika/auth-core'
import { cacheKey, type TokenCache } from './cache'
import { LOGIN_REDIRECT_PARAM } from './constants'
import { readBearer, readCookie } from './credentials'
import { createHandoffAttempt, type HandoffAttempt, handoffCookieName, setHandoffParams } from './handoff'
import { type DelegationIssuer, type IamGateway, IamUnavailableError } from './iam'
import { type ManifestEndpointRow, type OAuthBearerChallenge, type OAuthProtectedResource, oauthResourceOfRow, type ProxyApp } from './manifest'
import { TokenVerifier } from './verifier'

/** Every way a request can be refused. Coarse on purpose — these are logged, not returned to clients. */
export type DenyReason =
	/** The endpoint admits no person, and no credential was presented. */
	| 'no_credential'
	/** A bearer was presented and is not a valid `px_` key. */
	| 'invalid_key'
	/** An `oauth` row's bearer is malformed, unverifiable, or minted for another resource or app. */
	| 'invalid_token'
	/** An `oauth` row's bearer verified but lacks a required scope. */
	| 'insufficient_scope'
	| 'no_session'
	| 'invalid_session'
	| 'unknown_principal'
	| 'disabled'
	/** IAM refused to sign a token above its size bound: the principal holds more than fits in a header. */
	| 'token_too_large'
	/** The entry's table has no endpoint for the method and path. The fail-closed default; no fall-through. */
	| 'no_endpoint'
	/**
	 * The credential's caller kind is not one of the endpoint's callers, is no caller kind at all (a job or a webhook
	 * key), or is a connector caller off an export path.
	 */
	| 'caller_kind'
	/** The token does not satisfy the endpoint's requirement. */
	| 'insufficient_permission'
	/** A session request that is not a `GET` did not come from the app's own origin. */
	| 'cross_site'
	/** The request's `Content-Type` is not one the endpoint admits. */
	| 'content_type'
	/** IAM refused the delegation grant a membership or scope-creating endpoint needs. */
	| 'delegation_refused'
	/** The `Host` maps to no app in the manifest. */
	| 'no_app'
	/** The forwarded-request headers are missing or malformed — we cannot know what was asked for. */
	| 'bad_forward'
	/** The forwarded path is not canonical (`isCanonicalPath`); refused before any endpoint is planned. */
	| 'non_canonical_path'
	/** IAM could not be consulted, or its keys could not be fetched. We do not know; we refuse. */
	| 'iam_unavailable'
	/** Anything that escaped. Always a deny. */
	| 'internal_error'

export type Decision =
	| {
		outcome: 'allow'
		/** The verified token to inject upstream. `null` on an anonymous endpoint — no credential, no token. */
		token: string | null
		/** Principal id (or credential id) for the log line. Never a secret. */
		subject: string | null
		/** `<id>@<digest>` of the selected endpoint, for `X-Fabrika-Endpoint`. */
		endpoint: string
		/** The single-use delegation grant for `X-Fabrika-Delegation`, when the endpoint spends one. */
		delegation: string | null
	}
	| {
		outcome: 'deny'
		status: 400 | 401 | 403 | 503
		reason: DenyReason
		clearHandoffState?: string
		/** Set on an `oauth` row's 401/403: rendered as the RFC 6750 `WWW-Authenticate` challenge. */
		challenge?: OAuthBearerChallenge
	}
	/**
	 * A human reached an endpoint `human` may call without a usable session. `location` is where they must go to sign
	 * in; `status` is only how they are TOLD — 302 for a document navigation, 401 for anything else,
	 * whose body carries the same URL. See `isDocumentNavigation` for why the two differ.
	 */
	| { outcome: 'login'; status: 302 | 401; location: string; reason: DenyReason; handoff: HandoffAttempt }
	/**
	 * A handoff code was redeemed (ADR-0022). The only outcome that writes the long-lived app
	 * session: `session` is host-only on this app's host, and `location` is where IAM said the browser
	 * was going — read from the code server-side, never from the request.
	 */
	| { outcome: 'handoff'; status: 302; location: string; session: string; expiresAt: number; handoffState: string }

/** The original request, reconstructed from what `forward_auth` forwarded. */
export interface ForwardedRequest {
	/** Original method; the endpoint table selects by it. */
	method: string
	/** Original absolute URL; the whole URL is the login return. */
	url: URL
	/** The forwarded path exactly as the upstream receives it, already checked by `isCanonicalPath`. */
	rawPath: string
	/** The original request's headers, forwarded verbatim by Caddy. */
	headers: Headers
	requestId: string
}

/** An entry plus its precompiled endpoint table, built once at startup. */
export interface ResolvedApp {
	readonly app: ProxyApp
	readonly table: CompiledEndpointTable<ManifestEndpointRow>
}

export interface AuthorizerOptions {
	iam: IamGateway
	/** IAM's origin — verifies the token `iss` and is the base for the `/auth/login` bounce. */
	issuer: string
	/** `null` disables caching entirely. Decisions are identical either way; only the IAM call count changes. */
	cache?: TokenCache | null
	/** Unix seconds. Injectable for tests. */
	now?: () => number
	/**
	 * Issues the single-use grant a membership or scope-creating endpoint spends at IAM. Unset, such a request is
	 * forwarded without one and IAM refuses the membership operation unless the framework obtained a grant itself.
	 */
	delegations?: DelegationIssuer | null
}

/**
 * The browser's own description of what issued the request. Read from the FORWARDED headers like
 * everything else a decision depends on — verified against caddy 2.10.2, whose `forward_auth`
 * subrequest carries the original `Sec-Fetch-*` verbatim.
 */
const FETCH_MODE_HEADER = 'Sec-Fetch-Mode'

/** Fetch metadata the browser writes and page script cannot: `same-origin` only for a request from this origin. */
const FETCH_SITE_HEADER = 'Sec-Fetch-Site'

/** Why a session attempt failed — mirrors `mintToken`'s reasons. */
type SessionFailureReason = 'no_session' | 'invalid_session' | 'unknown_principal' | 'disabled'

type Denial = Extract<Decision, { outcome: 'deny' }>

/** A `px_` key exchanged and verified, or the denial that ends the request. */
type KeyAttempt = { ok: true; token: string; claims: AccessTokenClaims } | { ok: false; denial: Denial }

/** An OAuth resource token verified for a resource and its scopes, or the challenge that ends the request. */
type OAuthAttempt = { ok: true; token: string; claims: AccessTokenClaims } | { ok: false; denial: Denial }

/** The resource a row that admits `oauth` is bound to, and the scopes the row requires. */
interface OAuthBinding {
	readonly resource: OAuthProtectedResource
	readonly scopes: readonly string[]
}

/** Who is behind a request to a credentialed endpoint, or the decision that ends it (a denial or the login bounce). */
type EndpointCaller =
	| { ok: true; token: string; claims: AccessTokenClaims; session: boolean }
	| { ok: false; decision: Extract<Decision, { outcome: 'deny' | 'login' }> }

/**
 * The outcome of resolving the human behind a request. Three arms, not two: "there is no usable
 * session" bounces the browser to login, but "we could not check" must NOT — an unreachable IAM would
 * otherwise look like an expired session and put the user in a login loop instead of showing an
 * incident.
 */
type SessionAttempt =
	| { ok: true; token: string; claims: AccessTokenClaims }
	| { ok: false; status: 'miss'; reason: SessionFailureReason }
	| { ok: false; status: 'refused'; reason: 'token_too_large' }
	| { ok: false; status: 'unavailable' }

export class Authorizer {
	private readonly verifier: TokenVerifier
	private readonly cache: TokenCache | null
	private readonly now: () => number

	constructor(private readonly options: AuthorizerOptions) {
		this.now = options.now ?? (() => Math.floor(Date.now() / 1000))
		this.cache = options.cache ?? null
		this.verifier = new TokenVerifier(() => options.iam.getJwks(), options.issuer, this.now)
	}

	/**
	 * Decide one request. NEVER throws and NEVER returns an allow it did not derive from a verified
	 * token — the outer `catch` is the last line of the fail-closed guarantee.
	 */
	async authorize(resolved: ResolvedApp, request: ForwardedRequest): Promise<Decision> {
		try {
			return await this.decideEndpoint(resolved.app, resolved.table, request)
		} catch (err) {
			if (err instanceof IamUnavailableError) {
				return { outcome: 'deny', status: 503, reason: 'iam_unavailable' }
			}
			return { outcome: 'deny', status: 403, reason: 'internal_error' }
		}
	}

	/**
	 * One pass over the endpoint `planEndpoint` selects (ADR-0022 rule 3). An anonymous kind reads no credential and
	 * mints no token. A credentialed one takes a `px_` key when one is presented — terminal, whatever its verdict —
	 * an OAuth resource token on a row that admits `oauth`, and the session only when `human` may call; then the
	 * requirement, then admission.
	 */
	private async decideEndpoint(
		app: ProxyApp,
		table: CompiledEndpointTable<ManifestEndpointRow>,
		request: ForwardedRequest,
	): Promise<Decision> {
		const plan = planEndpoint(table, request.method, request.rawPath)
		if (plan.outcome === 'non-canonical') {
			return { outcome: 'deny', status: 400, reason: 'non_canonical_path' }
		}
		if (plan.outcome === 'no-endpoint') {
			return { outcome: 'deny', status: 403, reason: 'no_endpoint' }
		}
		const row = plan.endpoint
		const endpoint = formatEndpointHeader(row.id, row.digest)
		if (row.requirement === null) {
			return admitBody(row, request.headers) ?? { outcome: 'allow', token: null, subject: null, endpoint, delegation: null }
		}
		const oauth = oauthBindingOf(app, row)
		if (oauth === 'unregistered') {
			// The manifest parser refuses an `oauth` row without its resource; reaching this is a composition bug.
			return { outcome: 'deny', status: 403, reason: 'internal_error' }
		}
		const callers: readonly TokenCaller[] = row.callers
		const caller = await this.endpointCaller(app, oauth, callers, request)
		if (!caller.ok) {
			return caller.decision
		}
		const kind = callerOf(caller.claims)
		if (kind === null || !callers.includes(kind) || !callerAdmittedAt(kind, row.path)) {
			return withBearerChallenge({ outcome: 'deny', status: 403, reason: 'caller_kind' }, oauth)
		}
		if (!satisfies(row.requirement, caller.claims.perms)) {
			return { outcome: 'deny', status: 403, reason: 'insufficient_permission' }
		}
		if (caller.session && request.method !== 'GET' && request.headers.get(FETCH_SITE_HEADER) !== 'same-origin') {
			return { outcome: 'deny', status: 403, reason: 'cross_site' }
		}
		const refused = admitBody(row, request.headers)
		if (refused !== null) {
			return refused
		}
		const delegation = row.delegation === null ? null : await this.obtainDelegation(app, row.id, caller.token, request.requestId)
		if (delegation !== null && !delegation.ok) {
			return delegation.denial
		}
		return {
			outcome: 'allow',
			token: caller.token,
			subject: caller.claims.sub,
			endpoint,
			delegation: delegation?.grant ?? null,
		}
	}

	/**
	 * A `px_` key wherever the request carries an `Authorization` header, and on a row that admits `oauth` any other
	 * credential there as an OAuth resource token; otherwise the session, if `human` may call.
	 */
	private async endpointCaller(
		app: ProxyApp,
		oauth: OAuthBinding | null,
		callers: readonly TokenCaller[],
		request: ForwardedRequest,
	): Promise<EndpointCaller> {
		const authorization = request.headers.get('Authorization')
		if (authorization !== null && authorization.trim() !== '') {
			const bearer = readBearer(authorization)
			if (oauth !== null && (bearer === null || !bearer.startsWith(API_KEY_PREFIX))) {
				const verified = await this.verifyOAuthBearer(app, oauth, bearer)
				return verified.ok ? { ok: true, token: verified.token, claims: verified.claims, session: false } : { ok: false, decision: verified.denial }
			}
			const key = bearer === null ? { ok: false, denial: invalidKey() } satisfies KeyAttempt : await this.exchangeKey(app, bearer, request.requestId)
			return key.ok
				? { ok: true, token: key.token, claims: key.claims, session: false }
				: { ok: false, decision: withBearerChallenge(key.denial, oauth) }
		}
		if (!callers.includes('human')) {
			// No session reaches an endpoint a person may not call, so there is nothing to sign in to.
			const denial: Denial = { outcome: 'deny', status: 401, reason: 'no_credential' }
			return { ok: false, decision: oauth === null ? denial : { ...denial, challenge: { resource_metadata: oauth.resource.resourceMetadata } } }
		}
		const session = await this.authorizeSession(app, request)
		if (session.ok) {
			return { ok: true, token: session.token, claims: session.claims, session: true }
		}
		if (session.status === 'unavailable') {
			return { ok: false, decision: { outcome: 'deny', status: 503, reason: 'iam_unavailable' } }
		}
		if (session.status === 'refused') {
			return { ok: false, decision: { outcome: 'deny', status: 403, reason: session.reason } }
		}
		return { ok: false, decision: await this.loginDecision(app, request, session.reason) }
	}

	/** A fresh grant for every request, never cached: IAM spends it once, for this request id. */
	private async obtainDelegation(
		app: ProxyApp,
		endpoint: string,
		token: string,
		requestId: string,
	): Promise<{ ok: true; grant: string | null } | { ok: false; denial: Denial }> {
		const issuer = this.options.delegations
		if (issuer === undefined || issuer === null) {
			return { ok: true, grant: null }
		}
		const result = await this.callIam('requestDelegation', () => issuer.requestDelegation({ app: app.id, credential: token, requestId, endpoint }))
		return result.ok && result.grant !== ''
			? { ok: true, grant: result.grant }
			: { ok: false, denial: { outcome: 'deny', status: 403, reason: 'delegation_refused' } }
	}

	/**
	 * An OAuth resource token for one registered resource of this app, carrying every scope required. Verified
	 * locally — no IAM call, no cache. RFC 6750 §3.1: a request without a bearer (none, or another scheme) gets a
	 * challenge with no error code.
	 */
	private async verifyOAuthBearer(app: ProxyApp, binding: OAuthBinding, bearer: string | null): Promise<OAuthAttempt> {
		const challenge: OAuthBearerChallenge = { resource_metadata: binding.resource.resourceMetadata }
		if (bearer === null) {
			return { ok: false, denial: { outcome: 'deny', status: 401, reason: 'no_credential', challenge } }
		}
		const verified = await this.verifier.verify(bearer, { kind: 'resource', app: app.id, resource: binding.resource.resource })
		if (!verified.ok) {
			return verified.reason === 'unavailable'
				? { ok: false, denial: { outcome: 'deny', status: 503, reason: 'iam_unavailable' } }
				: { ok: false, denial: { outcome: 'deny', status: 401, reason: 'invalid_token', challenge: { ...challenge, error: 'invalid_token' } } }
		}
		const granted = verified.claims.oauth?.scopes ?? []
		if (!binding.scopes.every((scope) => granted.includes(scope))) {
			const scope = binding.scopes.join(' ')
			return {
				ok: false,
				denial: { outcome: 'deny', status: 403, reason: 'insufficient_scope', challenge: { ...challenge, error: 'insufficient_scope', scope } },
			}
		}
		return { ok: true, token: bearer, claims: verified.claims }
	}

	/** Exchange a `px_` key for a verified token, through the cache. A non-`px_` bearer is refused with no IAM call. */
	private async exchangeKey(app: ProxyApp, bearer: string, requestId: string): Promise<KeyAttempt> {
		if (!bearer.startsWith(API_KEY_PREFIX)) {
			return { ok: false, denial: invalidKey() }
		}

		const key = cacheKey(app.id, 'key', bearer)
		const cached = this.cache?.get(key)
		if (cached !== undefined && cached.expiresAt - this.now() > TOKEN_REFRESH_SKEW_SECONDS) {
			const verified = await this.verifier.verify(cached.token, app.id)
			if (verified.ok) {
				return { ok: true, token: cached.token, claims: verified.claims }
			}
			if (verified.reason === 'unavailable') {
				// Nothing is wrong with the entry — we simply cannot check it. Keep it; a re-mint could
				// not be verified either, so it would only add an IAM call to the same 503.
				return { ok: false, denial: { outcome: 'deny', status: 503, reason: 'iam_unavailable' } }
			}
			// A cached entry that PROVED bad (rotated key, revoked issuer) is dropped, and we fall
			// through to a fresh mint rather than trusting it.
			this.cache?.delete(key)
		}

		const minted = await this.callIam('mintFromKey', () => this.options.iam.mintFromKey({ app: app.id, key: bearer, requestId }))
		if (!minted.ok) {
			return { ok: false, denial: { outcome: 'deny', status: minted.reason === 'invalid_key' ? 401 : 403, reason: minted.reason } }
		}
		const verified = await this.verifier.verify(minted.token, app.id)
		if (!verified.ok) {
			// We just minted it, so a verification miss is a config/clock/key problem — not a client
			// error. Either way: deny.
			return { ok: false, denial: verified.reason === 'unavailable' ? { outcome: 'deny', status: 503, reason: 'iam_unavailable' } : invalidKey() }
		}
		this.cache?.set(key, { token: minted.token, expiresAt: minted.expiresAt })
		return { ok: true, token: minted.token, claims: verified.claims }
	}

	/**
	 * Resolve a human. Two tiers, cheapest first:
	 *   1. a cached token minted earlier from the SAME session — no IAM call;
	 *   2. exchange the `px_session` SSO cookie via `mintToken`.
	 *
	 * Every tier additionally requires `ptype: 'user'`: a session asserts that a resolved USER principal
	 * exists. Without the check a broken IAM could turn a service token into a human allow.
	 */
	private async authorizeSession(app: ProxyApp, request: ForwardedRequest): Promise<SessionAttempt> {
		const cookieHeader = request.headers.get('Cookie')
		const now = this.now()

		const session = readCookie(cookieHeader, SESSION_COOKIE)
		if (session === null) {
			// DIVERGENCE from the SDK, which calls `mintToken({ session: null })` and lets IAM answer
			// `no_session`. The proxy sits in front of EVERY request to every app, so an anonymous
			// flood would otherwise become an IAM flood. The answer is knowable locally; take it.
			return { ok: false, status: 'miss', reason: 'no_session' }
		}

		const key = cacheKey(app.id, 'session', session)
		const cached = this.cache?.get(key)
		if (cached !== undefined && cached.expiresAt - now > TOKEN_REFRESH_SKEW_SECONDS) {
			const verified = await this.verifier.verify(cached.token, app.id)
			if (verified.ok && verified.claims.ptype === 'user') {
				return { ok: true, token: cached.token, claims: verified.claims }
			}
			if (!verified.ok && verified.reason === 'unavailable') {
				// Nothing is wrong with the entry — we simply cannot check it. Keep it and say so.
				return { ok: false, status: 'unavailable' }
			}
			// Only a token that PROVED bad is dropped (rotated key, revoked issuer, wrong principal).
			this.cache?.delete(key)
		}

		const minted = await this.callIam('mintToken', () => this.options.iam.mintToken({ app: app.id, session, requestId: request.requestId }))
		if (!minted.ok) {
			return minted.reason === 'token_too_large'
				? { ok: false, status: 'refused', reason: minted.reason }
				: { ok: false, status: 'miss', reason: minted.reason }
		}
		const verified = await this.verifier.verify(minted.token, app.id)
		if (!verified.ok) {
			// We just minted it, so this is a config/clock/key problem, not a bad session — and if the
			// key set is unreachable it is an incident, not a reason to bounce the browser to login.
			return verified.reason === 'unavailable' ? { ok: false, status: 'unavailable' } : { ok: false, status: 'miss', reason: 'invalid_session' }
		}
		if (verified.claims.ptype !== 'user') {
			// `mintToken` always signs `type: 'user'`; anything else means IAM is not what we think.
			return { ok: false, status: 'miss', reason: 'invalid_session' }
		}
		this.cache?.set(key, { token: minted.token, expiresAt: minted.expiresAt })
		return { ok: true, token: minted.token, claims: verified.claims }
	}

	/**
	 * Every IAM call goes through here, so ANY failure — a rejected fetch, a Workers RPC error, a
	 * gateway that does not honour the `IamUnavailableError` contract — becomes the same deny. The
	 * gateway is an injected interface; the fail-closed guarantee must not depend on its manners.
	 */
	private async callIam<T>(operation: string, call: () => Promise<T>): Promise<T> {
		try {
			return await call()
		} catch (err) {
			// Never inspect or re-wrap the cause: it can stringify a request URL or a body.
			throw err instanceof IamUnavailableError ? err : new IamUnavailableError(operation)
		}
	}

	/**
	 * Redeem a handoff code (ADR-0022). Called for the reserved callback path only, BEFORE the endpoint
	 * is planned — the callback is how a browser obtains a session, so it cannot be behind an endpoint.
	 *
	 * A failed redemption is an ordinary deny with no cookie. It is deliberately not a fresh bounce to
	 * IAM: a code that will not redeem twice would turn a retry into a loop.
	 */
	async authorizeCallback(resolved: ResolvedApp, request: ForwardedRequest): Promise<Decision> {
		const state = request.url.searchParams.get(AUTH_HANDOFF_STATE_PARAM)
		if (handoffCookieName(state) === null || state === null) {
			return { outcome: 'deny', status: 403, reason: 'no_credential' }
		}
		try {
			return await this.redeem(resolved, request, state)
		} catch (err) {
			if (err instanceof IamUnavailableError) {
				return { outcome: 'deny', status: 503, reason: 'iam_unavailable', clearHandoffState: state }
			}
			return { outcome: 'deny', status: 403, reason: 'internal_error', clearHandoffState: state }
		}
	}

	private async redeem(resolved: ResolvedApp, request: ForwardedRequest, state: string): Promise<Decision> {
		const code = request.url.searchParams.get(AUTH_CODE_PARAM)
		if (code === null || code === '') {
			return { outcome: 'deny', status: 403, reason: 'no_credential', clearHandoffState: state }
		}
		const cookieName = handoffCookieName(state)
		const verifier = cookieName === null ? null : readCookie(request.headers.get('Cookie'), cookieName)
		if (verifier === null) {
			return { outcome: 'deny', status: 403, reason: 'invalid_session', clearHandoffState: state }
		}
		// Through `callIam` like every other IAM call, so an unreachable service is a 503 whatever kind
		// of error the injected gateway happened to throw. `authorize`'s outer catch maps the rest.
		const result = await this.callIam(
			'exchangeAuthCode',
			() => this.options.iam.exchangeAuthCode({ app: resolved.app.id, code, verifier, requestId: request.requestId }),
		)
		if (!result.ok) {
			return { outcome: 'deny', status: 403, reason: 'invalid_session', clearHandoffState: state }
		}
		return { outcome: 'handoff', status: 302, location: result.returnUrl, session: result.session, expiresAt: result.expiresAt, handoffState: state }
	}

	private async loginDecision(
		app: ProxyApp,
		request: ForwardedRequest,
		reason: SessionFailureReason,
	): Promise<Extract<Decision, { outcome: 'login' }>> {
		const handoff = await createHandoffAttempt()
		return {
			outcome: 'login',
			status: isDocumentNavigation(request.headers) ? 302 : 401,
			location: this.loginUrl(app, request.url, handoff),
			reason,
			handoff,
		}
	}

	/**
	 * Where to send the browser to log in, returning to the originally requested URL afterwards.
	 *
	 * The scheme comes from the MANIFEST, not from the forwarded request: behind a TLS-terminating
	 * balancer the proxy is reached over plain HTTP and `X-Forwarded-Proto` says so, which would send
	 * the browser back to an `http://` URL for an origin only served over `https://`.
	 */
	private loginUrl(app: ProxyApp, url: URL, handoff: HandoffAttempt): string {
		const target = new URL(url)
		target.protocol = `${app.scheme}:`
		// `readProxyEnv` already reduces the issuer to an origin; this covers a composition root that
		// does not go through it (the Cloudflare Worker reads its env directly).
		const issuer = this.options.issuer.replace(/\/+$/, '')
		const login = new URL('/auth/login', issuer)
		login.searchParams.set('app', app.id)
		login.searchParams.set(LOGIN_REDIRECT_PARAM, target.toString())
		setHandoffParams(login, handoff)
		return login.toString()
	}
}

function invalidKey(): Denial {
	return { outcome: 'deny', status: 401, reason: 'invalid_key' }
}

/**
 * The resource and scopes of a row that admits `oauth`, `null` for any other row, and `unregistered` when the entry
 * has no resource on the row's path.
 */
function oauthBindingOf(app: ProxyApp, row: ManifestEndpointRow): OAuthBinding | null | 'unregistered' {
	const required = 'oauth' in row ? row.oauth : null
	if (required === null) {
		return null
	}
	const resource = 'installation' in app ? oauthResourceOfRow(app, row) : null
	return resource === null ? 'unregistered' : { resource, scopes: required.scopes }
}

/**
 * A refused `px_` key on a row that admits `oauth` still tells an OAuth client where the resource's metadata is
 * (RFC 6750 §3): a 401 as `invalid_token`, a 403 with no error code. Status and reason stay those of the key.
 */
function withBearerChallenge(denial: Denial, oauth: OAuthBinding | null): Denial {
	if (oauth === null || (denial.status !== 401 && denial.status !== 403)) {
		return denial
	}
	const challenge: OAuthBearerChallenge = { resource_metadata: oauth.resource.resourceMetadata }
	return { ...denial, challenge: denial.status === 401 ? { ...challenge, error: 'invalid_token' } : challenge }
}

/** An endpoint that admits a body admits only its declared media types (ADR-0022 rule 3, admission). */
function admitBody(row: ManifestEndpointRow, headers: Headers): Denial | null {
	if (row.admission === null) {
		return null
	}
	const type = headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() ?? ''
	return row.admission.contentTypes.includes(type) ? null : { outcome: 'deny', status: 400, reason: 'content_type' }
}

/**
 * Is this a top-level document navigation — the one caller a 302 actually helps?
 *
 * A redirect is not a neutral way to say "sign in". A cross-origin bounce to IAM is something a
 * page's `fetch` cannot follow, so the console sees an opaque network failure instead of a sign-in;
 * and a 302 destroys the request it answers, turning an in-flight POST into a bodyless GET — the same
 * argument ADR-0022 makes for handing over a session rather than a bare token.
 *
 * **`Sec-Fetch-Mode` is the signal, not `Accept`.** It is written by the browser and not by the page:
 * `Sec-` is a forbidden header PREFIX, so `fetch`/XHR cannot set it, and only a document or frame
 * navigation carries `navigate` — `fetch()` and XHR emit `cors` / `same-origin` / `no-cors`. `Accept:
 * text/html` (what the deleted SDK's `wantsHtml` used) is an ordinary header: any XHR may send it and
 * a navigation may omit it, so it would let the CALLER pick the answer shape instead of describing
 * what the caller is.
 *
 * **Absent → 302**, the answer this proxy has always given. A client old enough to omit the header is
 * overwhelmingly a browser navigating, and a JSON body is unusable to one; a non-browser client that
 * sends no `Sec-Fetch-Mode` is no worse off than before this distinction existed.
 */
function isDocumentNavigation(headers: Headers): boolean {
	const mode = headers.get(FETCH_MODE_HEADER)
	return mode === null || mode === '' || mode === 'navigate'
}
