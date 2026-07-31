/**
 * The proxy authorization core ([ADR-0007](../../../docs/decisions/0007-proxy-based-auth-enforcement.md)).
 *
 * Same four steps, same order, same fail-closed posture:
 *   1. match the request path against the app's ordered gate rules;
 *   2. resolve the credential the matched rule requires (cookie session, `px_` key, passthrough JWT);
 *   3. exchange it with IAM once, cache the result, and thereafter verify LOCALLY against the JWKS;
 *   4. deny unless a rule was satisfied.
 *
 * A human miss becomes a 302 to IAM's `/auth/login`, because Caddy returns a non-2xx auth response
 * to the client verbatim. A request with no session cookie needs no IAM call.
 *
 * NOTHING here returns an allow on an unexpected condition. Every `catch` maps to a deny.
 */

import { API_KEY_PREFIX, SESSION_COOKIE, TOKEN_COOKIE, TOKEN_REFRESH_SKEW_SECONDS } from '@fabrika/auth-core'
import type { ProxyApp } from '@fabrika/proxy-contract'
import { cacheKey, type TokenCache } from './cache'
import { applicableGates, type CompiledGate, readCookie, readServiceCredential } from './gates'
import { type IamGateway, IamUnavailableError } from './iam'
import { TokenVerifier } from './verifier'

/** Every way a request can be refused. Coarse on purpose — these are logged, not returned to clients. */
export type DenyReason =
	/** No gate rule matched the path. The fail-closed default. */
	| 'no_rule'
	/** Every matching rule was a `service` rule and no credential was presented. */
	| 'no_credential'
	/** A `px_` key or passthrough JWT was presented and is not valid. */
	| 'invalid_key'
	| 'no_session'
	| 'invalid_session'
	| 'unknown_principal'
	| 'disabled'
	/** The `Host` maps to no app in the manifest. */
	| 'no_app'
	/** The forwarded-request headers are missing or malformed — we cannot know what was asked for. */
	| 'bad_forward'
	/** IAM could not be consulted, or its keys could not be fetched. We do not know; we refuse. */
	| 'iam_unavailable'
	/** Anything that escaped. Always a deny. */
	| 'internal_error'

export type Decision =
	| {
		outcome: 'allow'
		gate: 'public' | 'service' | 'human'
		/** The verified token to inject upstream. `null` on a `public` gate — no credential, no token. */
		token: string | null
		/** Principal id (or credential id) for the log line. Never a secret. */
		subject: string | null
	}
	| { outcome: 'deny'; status: 401 | 403 | 503; reason: DenyReason }
	/** A human hit a `human` gate without a usable session — bounce the browser to IAM. */
	| { outcome: 'login'; status: 302; location: string; reason: DenyReason }

/** The original request, reconstructed from what `forward_auth` forwarded. */
export interface ForwardedRequest {
	/** Original method. Informational — gates are path-only — but logged. */
	method: string
	/** Original absolute URL. Its `pathname` drives gate matching; the whole URL is the login return. */
	url: URL
	/** The original request's headers, forwarded verbatim by Caddy. */
	headers: Headers
	requestId: string
}

/** An app plus its precompiled gates, built once at startup. */
export interface ResolvedApp {
	app: ProxyApp
	gates: CompiledGate[]
}

export interface AuthorizerOptions {
	iam: IamGateway
	/** IAM's origin — verifies the token `iss` and is the base for the `/auth/login` bounce. */
	issuer: string
	/** `null` disables caching entirely. Decisions are identical either way; only the IAM call count changes. */
	cache?: TokenCache | null
	/** Unix seconds. Injectable for tests. */
	now?: () => number
}

/** Why a `human` attempt failed — mirrors `mintToken`'s reasons. */
type SessionFailureReason = 'no_session' | 'invalid_session' | 'unknown_principal' | 'disabled'

type SessionAttempt = { ok: true; token: string; subject: string } | { ok: false; reason: SessionFailureReason }

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
			return await this.decide(resolved, request)
		} catch (err) {
			if (err instanceof IamUnavailableError) {
				return { outcome: 'deny', status: 503, reason: 'iam_unavailable' }
			}
			return { outcome: 'deny', status: 403, reason: 'internal_error' }
		}
	}

	private async decide(resolved: ResolvedApp, request: ForwardedRequest): Promise<Decision> {
		const matching = applicableGates(resolved.gates, request.url.pathname)
		if (matching.length === 0) {
			// Fail closed — the app has no public route of its own, so an unmatched path is denied.
			return { outcome: 'deny', status: 403, reason: 'no_rule' }
		}

		// Remembers a human rule's miss (with its precise reason) so the browser is bounced to login
		// only after every matching rule has been exhausted.
		let humanMiss: SessionFailureReason | null = null

		for (const { rule } of matching) {
			if (rule.kind === 'public') {
				return { outcome: 'allow', gate: 'public', token: null, subject: null }
			}
			if (rule.kind === 'service') {
				const raw = readServiceCredential(request.headers, request.url, rule.credential)
				if (raw === null) {
					continue // absent → fall through to the next matching rule
				}
				return await this.authorizeBearer(resolved.app, raw, request.requestId) // present → terminal
			}
			const attempt = await this.authorizeSession(resolved.app, request)
			if (attempt.ok) {
				return { outcome: 'allow', gate: 'human', token: attempt.token, subject: attempt.subject }
			}
			humanMiss = attempt.reason
		}

		if (humanMiss !== null) {
			return { outcome: 'login', status: 302, location: this.loginUrl(request.url), reason: humanMiss }
		}
		// Every matching rule was a `service` rule with no credential present.
		return { outcome: 'deny', status: 401, reason: 'no_credential' }
	}

	/**
	 * A `service`-rule bearer. A `px_` opaque key is exchanged via `mintFromKey` (cached, so the hot
	 * path is a local verify); anything else is treated as an already-signed passthrough token and
	 * verified locally with no IAM call. A present-but-invalid credential fails closed — no fall-through.
	 */
	private async authorizeBearer(app: ProxyApp, bearer: string, requestId: string): Promise<Decision> {
		if (!bearer.startsWith(API_KEY_PREFIX)) {
			const verified = await this.verifier.verify(bearer, app.id)
			if (!verified.ok) {
				return verified.reason === 'unavailable'
					? { outcome: 'deny', status: 503, reason: 'iam_unavailable' }
					: { outcome: 'deny', status: 401, reason: 'invalid_key' }
			}
			return { outcome: 'allow', gate: 'service', token: bearer, subject: verified.claims.sub }
		}

		const key = cacheKey(app.id, 'key', bearer)
		const cached = this.cache?.get(key)
		if (cached !== undefined && cached.expiresAt - this.now() > TOKEN_REFRESH_SKEW_SECONDS) {
			const verified = await this.verifier.verify(cached.token, app.id)
			if (verified.ok) {
				return { outcome: 'allow', gate: 'service', token: cached.token, subject: verified.claims.sub }
			}
			// A cached entry that no longer verifies (rotated key, revoked issuer) is dropped, and we
			// fall through to a fresh mint rather than trusting it.
			this.cache?.delete(key)
		}

		const minted = await this.callIam('mintFromKey', () => this.options.iam.mintFromKey({ app: app.id, key: bearer, requestId }))
		if (!minted.ok) {
			return { outcome: 'deny', status: minted.reason === 'invalid_key' ? 401 : 403, reason: minted.reason }
		}
		const verified = await this.verifier.verify(minted.token, app.id)
		if (!verified.ok) {
			// We just minted it, so a verification miss is a config/clock/key problem — not a client
			// error. Either way: deny.
			return verified.reason === 'unavailable'
				? { outcome: 'deny', status: 503, reason: 'iam_unavailable' }
				: { outcome: 'deny', status: 401, reason: 'invalid_key' }
		}
		this.cache?.set(key, { token: minted.token, expiresAt: minted.expiresAt })
		return { outcome: 'allow', gate: 'service', token: minted.token, subject: verified.claims.sub }
	}

	/**
	 * Resolve a human. Three tiers, cheapest first:
	 *   1. a `px_token` cookie that still verifies — no IAM call, no cache entry needed;
	 *   2. a cached token minted earlier from the SAME session — no IAM call;
	 *   3. exchange the `px_session` SSO cookie via `mintToken`.
	 */
	private async authorizeSession(app: ProxyApp, request: ForwardedRequest): Promise<SessionAttempt> {
		const cookieHeader = request.headers.get('Cookie')
		const now = this.now()

		const tokenCookie = readCookie(cookieHeader, TOKEN_COOKIE)
		if (tokenCookie !== null) {
			const verified = await this.verifier.verify(tokenCookie, app.id)
			if (verified.ok && verified.claims.exp - now > TOKEN_REFRESH_SKEW_SECONDS) {
				return { ok: true, token: tokenCookie, subject: verified.claims.sub }
			}
		}

		const session = readCookie(cookieHeader, SESSION_COOKIE)
		if (session === null) {
			// DIVERGENCE from the SDK, which calls `mintToken({ session: null })` and lets IAM answer
			// `no_session`. The proxy sits in front of EVERY request to every app, so an anonymous
			// flood would otherwise become an IAM flood. The answer is knowable locally; take it.
			return { ok: false, reason: 'no_session' }
		}

		const key = cacheKey(app.id, 'session', session)
		const cached = this.cache?.get(key)
		if (cached !== undefined && cached.expiresAt - now > TOKEN_REFRESH_SKEW_SECONDS) {
			const verified = await this.verifier.verify(cached.token, app.id)
			if (verified.ok) {
				return { ok: true, token: cached.token, subject: verified.claims.sub }
			}
			this.cache?.delete(key)
		}

		const minted = await this.callIam('mintToken', () => this.options.iam.mintToken({ app: app.id, session, requestId: request.requestId }))
		if (!minted.ok) {
			return { ok: false, reason: minted.reason }
		}
		const verified = await this.verifier.verify(minted.token, app.id)
		if (!verified.ok) {
			return { ok: false, reason: 'invalid_session' }
		}
		this.cache?.set(key, { token: minted.token, expiresAt: minted.expiresAt })
		return { ok: true, token: minted.token, subject: verified.claims.sub }
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

	/** Where to send the browser to log in, returning to the originally requested URL afterwards. */
	private loginUrl(url: URL): string {
		return `${this.options.issuer.replace(/\/+$/, '')}/auth/login?redirect=${encodeURIComponent(url.toString())}`
	}
}
