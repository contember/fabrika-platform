/**
 * `createIam` — the single request-time entry point apps use instead of hand-rolling auth.
 *
 * Since [ADR-0007](../../../docs/decisions/0007-proxy-based-auth-enforcement.md) the PROXY is the only
 * thing that enforces: it matches the app's gates, resolves the credential, and injects a verified
 * access token as `PROXY_TOKEN_HEADER`. What is left for an app is small and fixed:
 *   - `authenticate(request)` — read that header and verify it LOCALLY against IAM's published JWKS
 *     (signature, `iss`, `aud`, `exp`), then build an `AuthContext`. The header is never trusted blindly.
 *   - `redeemKey(token)` — redeem a share-link capability OFF the gate path. Those requests arrive
 *     through a `public`/`service` gate and the app redeems the capability itself; there is no proxy
 *     equivalent by design.
 *   - the MANAGEMENT surface (`listPrincipals` / `issueKey` / `issueJwt` / `revokeKey`).
 *
 * There is NO gate evaluation here, no session→token exchange, and no cookie is ever written.
 *
 * There is also NO local mode. The SDK verifies IAM-issued tokens and nothing else, everywhere. Local
 * development runs the real stack (`bun run local:up`), where the proxy fronts each service and IAM
 * authenticates through its own `LOCAL_DEV_LOGIN` bypass — one dev bypass in the system, owned by the
 * service that owns identity.
 */

import { API_KEY_PREFIX, type IamRpc, type MintFromKeyResult, PROXY_TOKEN_HEADER, TOKEN_REFRESH_SKEW_SECONDS } from '@fabrika/auth-core'
import { environmentAliases } from '@fabrika/platform'
import { buildAuthContext, IamClient } from './client'
import { readRequestId } from './request'
import type {
	AuthContext,
	IssuedJwt,
	IssuedKey,
	IssueFailure,
	IssueJwtRequest,
	IssueKeyRequest,
	ListPrincipalsFailure,
	PrincipalList,
	RevokedKey,
	RevokeFailure,
} from './types'
import { TokenVerifier } from './verify'

// ── Public config surfaces ──────────────────────────────────────────────────────

/** The env `createIam` reads. An app's Worker `Env` satisfies it structurally (extra fields are fine). */
export interface IamEnv {
	/** The IAM service binding. Typed as the `IamRpc` contract — never the IAM Worker. */
	IAM?: IamRpc
	/** IAM origin — the token `iss` this SDK verifies against. Canonicalized once in `createIam`. */
	FABRIKA_IAM_URL?: string
	/** Deprecated issuer fallback. */
	PROPUSTKA_URL?: string
	/** Canonical fallback app id when `opts.appId` is omitted. */
	FABRIKA_APP_ID?: string
	/** Deprecated app id fallback. */
	PROPUSTKA_APP_ID?: string
}

/** Options for `createIam`. `appId` falls back to `env.FABRIKA_APP_ID`, then the legacy name. */
export interface CreateIamOptions {
	/** The IAM app id (baked in so it can never be mistyped). Falls back to the canonical env alias. */
	appId?: string
}

// ── Authentication result ────────────────────────────────────────────────────────

/** Why an authentication attempt produced no `AuthContext`. */
export type AuthFailureReason =
	/** No proxy-injected token on the request — a `public` gate, or nothing is in front of the app. */
	| 'no_token'
	/** A token was presented and did not verify: signature, `iss`, `aud`, `exp` or claim shape. */
	| 'invalid_token'
	/** The credential resolved to nobody — IAM says the principal is gone or disabled. */
	| 'unknown_principal'
	/** IAM could not be consulted at all. NOT a decided negative — an incident, and never a 401. */
	| 'unavailable'

/**
 * The outcome of `authenticate` / `redeemKey`. A DECIDED NEGATIVE (`invalid_token`,
 * `unknown_principal`) is not the same as "could not consult IAM" (`unavailable`, 503) — the same
 * three-state rule `@fabrika/proxy` implements. Neither method throws for either case.
 */
export type AuthResult =
	| { ok: true; context: AuthContext }
	| { ok: false; reason: AuthFailureReason; status: 401 | 403 | 503 }

/** Failure half of `AuthResult` — what a caller maps to its own error envelope. */
export type AuthFailure = Extract<AuthResult, { ok: false }>

// ── Synthetic contexts ───────────────────────────────────────────────────────────

/**
 * The ANONYMOUS context — no principal, NO permissions (`can` → false, `scopedTo` → [] = none),
 * `audit` a no-op. What an app sets on a request the proxy admitted through a `public` gate: there is
 * no token to verify, and nothing about the caller is known. An RPC procedure's `.require` on such a
 * request would (correctly) 403.
 */
export function anonymousContext(): AuthContext {
	return {
		ok: true,
		principal: null,
		can: () => false,
		scopedTo: () => [],
		audit: () => Promise.resolve(),
	}
}

// ── Small helpers ────────────────────────────────────────────────────────────────

/** Hex SHA-256 — the key-cache index, so no plaintext credential is ever held in memory as a map key. */
async function digest(value: string): Promise<string> {
	const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
	let hex = ''
	for (const byte of bytes) {
		hex += byte.toString(16).padStart(2, '0')
	}
	return hex
}

/**
 * Per-binding cache of the access token minted from a `px_` share credential, keyed by the credential's
 * SHA-256 digest and bounded — a share link redeemed on every request would otherwise pin an unbounded
 * number of plaintext credentials for the process lifetime.
 */
const KEY_CACHE_MAX_ENTRIES = 256
const keyTokenCache = new WeakMap<IamRpc, Map<string, { token: string; expiresAt: number }>>()

function keyCacheFor(binding: IamRpc): Map<string, { token: string; expiresAt: number }> {
	let cache = keyTokenCache.get(binding)
	if (cache === undefined) {
		cache = new Map()
		keyTokenCache.set(binding, cache)
	}
	return cache
}

/** Insert with a hard bound, evicting the oldest entry (Map preserves insertion order). */
function rememberKey(cache: Map<string, { token: string; expiresAt: number }>, key: string, entry: { token: string; expiresAt: number }): void {
	if (!cache.has(key) && cache.size >= KEY_CACHE_MAX_ENTRIES) {
		const oldest = cache.keys().next()
		if (oldest.done !== true) {
			cache.delete(oldest.value)
		}
	}
	cache.set(key, entry)
}

// ── Iam ──────────────────────────────────────────────────────────────────────────

/** Internal construction config — `createIam` assembles this; apps never build it directly. */
interface IamConfig {
	management: IamClient
	binding: IamRpc
	verifier: TokenVerifier
	appId: string
}

/**
 * The request-time IAM surface. Build it with `createIam` (the only intended entry point — the
 * constructor takes an internal config). Bundles the management methods, token verification and
 * share-link redemption, all bound to the env + app id resolved at construction.
 */
export class Iam {
	private readonly management: IamClient
	private readonly binding: IamRpc
	private readonly verifier: TokenVerifier
	private readonly appId: string

	/** @internal — use `createIam`. */
	constructor(config: IamConfig) {
		this.management = config.management
		this.binding = config.binding
		this.verifier = config.verifier
		this.appId = config.appId
	}

	// ── Management surface (delegated to the real client) ─────────────────────────

	listPrincipals(req: Request): Promise<PrincipalList | ListPrincipalsFailure> {
		return this.management.listPrincipals(req)
	}

	issueKey(req: Request, input: IssueKeyRequest): Promise<IssuedKey | IssueFailure> {
		return this.management.issueKey(req, input)
	}

	issueJwt(req: Request, input: IssueJwtRequest): Promise<IssuedJwt | IssueFailure> {
		return this.management.issueJwt(req, input)
	}

	revokeKey(req: Request, id: string): Promise<RevokedKey | RevokeFailure> {
		return this.management.revokeKey(req, id)
	}

	// ── Authentication ────────────────────────────────────────────────────────────

	/**
	 * Resolve the caller from the token the PROXY injected, verifying it locally against the JWKS.
	 * Never throws: an absent token, a token that does not verify, and an unreachable IAM are three
	 * distinct `ok: false` results.
	 */
	authenticate(request: Request): Promise<AuthResult> {
		const token = request.headers.get(PROXY_TOKEN_HEADER)?.trim() ?? ''
		if (token === '') {
			return Promise.resolve({ ok: false, reason: 'no_token', status: 401 })
		}
		return this.contextFor(token, readRequestId(request))
	}

	/**
	 * Redeem an opaque `px_` share credential (or a passthrough JWT) into an `AuthContext` OFF the gate
	 * path — the seam a capability/share link uses, where the token rides a query param or a cookie
	 * rather than satisfying a gate. A `px_` key is exchanged once via `mintFromKey` and cached per
	 * binding; anything else is verified locally with no IAM call. Never throws — map a failure to a 404
	 * so the surface does not reveal whether the resource exists.
	 */
	async redeemKey(token: string): Promise<AuthResult> {
		const requestId = crypto.randomUUID()
		if (!token.startsWith(API_KEY_PREFIX)) {
			// A passthrough JWT — verify locally, no IAM call.
			return await this.contextFor(token, requestId)
		}

		const cache = keyCacheFor(this.binding)
		const index = await digest(token)
		const now = Math.floor(Date.now() / 1000)
		const cached = cache.get(index)
		if (cached !== undefined && cached.expiresAt - now > TOKEN_REFRESH_SKEW_SECONDS) {
			const result = await this.contextFor(cached.token, requestId)
			if (result.ok || result.reason === 'unavailable') {
				// Unverifiable because IAM is down is NOT evidence against the cached token — say so and stop.
				return result
			}
			// A cached token that no longer verifies (rotated key, revoked issuer) is dropped, not trusted.
			cache.delete(index)
		}

		let minted: MintFromKeyResult
		try {
			minted = await this.binding.mintFromKey({ app: this.appId, key: token, requestId })
		} catch {
			// A transport failure is "we could not consult IAM", never a decided negative. Never log the
			// error object: it can carry the credential or a request URL.
			return { ok: false, reason: 'unavailable', status: 503 }
		}
		if (!minted.ok) {
			return minted.reason === 'invalid_key'
				? { ok: false, reason: 'invalid_token', status: 401 }
				: { ok: false, reason: 'unknown_principal', status: 403 }
		}
		const result = await this.contextFor(minted.token, requestId)
		if (result.ok) {
			rememberKey(cache, index, { token: minted.token, expiresAt: minted.expiresAt })
		}
		return result
	}

	// ── Internals ─────────────────────────────────────────────────────────────────

	/** Verify one token and wrap its claims in the `permits`-backed `AuthContext`. */
	private async contextFor(token: string, requestId: string): Promise<AuthResult> {
		const verified = await this.verifier.verify(token)
		if (!verified.ok) {
			return verified.reason === 'unavailable'
				? { ok: false, reason: 'unavailable', status: 503 }
				: { ok: false, reason: 'invalid_token', status: 401 }
		}
		return { ok: true, context: buildAuthContext(this.binding, this.appId, verified.claims, requestId) }
	}
}

// ── createIam ──────────────────────────────────────────────────────────────────

/**
 * The single request-time entry point. Reads `env.IAM` and the canonical-first IAM environment
 * aliases, and returns an `Iam` bound to them. Throws if the app id, the binding or the issuer is
 * missing or unusable — there is no mode in which any of the three is optional.
 */
export function createIam(env: IamEnv, opts: CreateIamOptions = {}): Iam {
	const appId = opts.appId
		?? environmentAliases.read(env, { canonical: 'FABRIKA_APP_ID', legacy: 'PROPUSTKA_APP_ID' })
	if (appId === undefined || appId === '') {
		throw new Error('createIam: app id is required — pass opts.appId or set env.FABRIKA_APP_ID')
	}

	const binding = env.IAM
	if (binding === undefined) {
		throw new Error('createIam: the IAM service binding is missing (env.IAM) — check the IAM ServiceReference.')
	}
	const issuer = canonicalIssuer(environmentAliases.read(env, { canonical: 'FABRIKA_IAM_URL', legacy: 'PROPUSTKA_URL' }))
	return new Iam({
		management: new IamClient(binding, appId),
		binding,
		verifier: new TokenVerifier(binding, issuer, appId),
		appId,
	})
}

/**
 * Canonicalize the issuer ONCE, at the boundary. It is a byte-exact contract — it is the token's `iss`,
 * and jose compares it verbatim — so `https://iam.test/` and `https://iam.test` must not be two
 * different issuers depending on which call site happened to trim.
 */
function canonicalIssuer(raw: string | undefined): string {
	if (raw === undefined || raw.trim() === '') {
		throw new Error('createIam: FABRIKA_IAM_URL is missing — it is the issuer every token is verified against.')
	}
	let url: URL
	try {
		url = new URL(raw.trim())
	} catch {
		throw new Error('createIam: FABRIKA_IAM_URL is not an absolute URL.')
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new Error('createIam: FABRIKA_IAM_URL must be an http(s) origin.')
	}
	return url.origin
}
