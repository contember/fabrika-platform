/**
 * The ONE JWKS-backed access-token verifier: fetch IAM's key set, cache it, verify every token
 * locally with no network call on the warm path.
 *
 * `verify` is THREE-STATE, and the distinction is load-bearing: "this token is bad" is the caller's
 * fault (401) and "we could not check" is ours (503). Both deny; only the second is an incident.
 * Collapsing them would let a JWKS outage read as a forged token.
 */

import { type AccessTokenClaims, type Jwks, parseAccessClaims } from '@fabrika/auth-core'
import { createLocalJWKSet, errors as joseErrors, jwtVerify } from 'jose'

export type VerifyResult =
	| { ok: true; claims: AccessTokenClaims }
	/** Signature, issuer, audience, expiry or claim-shape failure — the token is not trustworthy. */
	| { ok: false; reason: 'invalid' }
	/** The key set could not be obtained, so nothing could be checked. Deny, but say why. */
	| { ok: false; reason: 'unavailable' }

/** How long a fetched JWKS is reused before a refetch (a kid rotation also forces one on demand). */
export const JWKS_TTL_SECONDS = 600
/**
 * Minimum gap between two unknown-`kid` refetches. Bounds how often a token nobody can verify may
 * cost an IAM round trip — the token is denied either way, and a real rotation is picked up within it.
 */
export const JWKS_REFETCH_COOLDOWN_SECONDS = 30

/** Sentinel distinguishing "no signing key matched (kid rotation)" from a real verification failure. */
const NO_KEY = Symbol('no-matching-key')

/** Raised only by `keySet`, so `verify` can tell an unfetchable key set from an untrustworthy token. */
class JwksUnavailableError extends Error {
	constructor() {
		super('the IAM key set could not be fetched')
		this.name = 'JwksUnavailableError'
	}
}

/** jose's local key-set resolver — what `jwtVerify` is handed once the JWKS is in hand. */
type LocalJwks = ReturnType<typeof createLocalJWKSet>

/**
 * The mutable state verification carries between calls: the cached key set and when an unknown `kid`
 * last forced a refetch. Injectable because the app SDK keys it by the IAM BINDING — `@fabrika/app`
 * builds a new SDK object per request, so per-instance state would refetch, and reset the cooldown,
 * on every request.
 */
export interface JwksCache {
	entry: { keys: LocalJwks; expiresAt: number } | null
	lastForcedAt: number | null
}

export function createJwksCache(): JwksCache {
	return { entry: null, lastForcedAt: null }
}

export interface TokenVerifierOptions {
	getJwks: () => Promise<Jwks>
	/** Byte-exact: it is the token's `iss` and jose compares it verbatim. */
	issuer: string
	/** Unix seconds; injectable for tests. Defaults to the wall clock. */
	now?: () => number
	ttlSeconds?: number
	refetchCooldownSeconds?: number
	/** Where the key set and the cooldown live. Defaults to state private to this verifier. */
	cache?: JwksCache
}

export class TokenVerifier {
	private readonly getJwks: () => Promise<Jwks>
	private readonly issuer: string
	private readonly now: () => number
	private readonly ttlSeconds: number
	private readonly refetchCooldownSeconds: number
	private readonly cache: JwksCache

	constructor(options: TokenVerifierOptions) {
		this.getJwks = options.getJwks
		this.issuer = options.issuer
		this.now = options.now ?? (() => Math.floor(Date.now() / 1000))
		this.ttlSeconds = options.ttlSeconds ?? JWKS_TTL_SECONDS
		this.refetchCooldownSeconds = options.refetchCooldownSeconds ?? JWKS_REFETCH_COOLDOWN_SECONDS
		this.cache = options.cache ?? createJwksCache()
	}

	/**
	 * Verify `token` for `audience` and narrow it to access claims. An unknown `kid` forces one JWKS
	 * refetch (a key rotated in), then a retry — but at most once per cooldown, because otherwise any
	 * caller can turn every request into an IAM round trip just by inventing a `kid`.
	 */
	async verify(token: string, audience: string): Promise<VerifyResult> {
		let payload: unknown
		try {
			payload = await this.verifyWith(token, audience, false)
			if (payload === NO_KEY && this.mayForceRefetch()) {
				payload = await this.verifyWith(token, audience, true)
			}
		} catch (err) {
			if (err instanceof JwksUnavailableError) {
				return { ok: false, reason: 'unavailable' }
			}
			throw err
		}
		if (payload === NO_KEY || payload === null) {
			return { ok: false, reason: 'invalid' }
		}
		const claims = parseAccessClaims(payload)
		return claims === null ? { ok: false, reason: 'invalid' } : { ok: true, claims }
	}

	/**
	 * May an unknown `kid` force a refetch right now? A rotation is rare and the token is denied either
	 * way, so rate-limiting this costs a few seconds of rotation lag and removes an amplification
	 * primitive: without it, N requests with N invented kids are N IAM fetches.
	 */
	private mayForceRefetch(): boolean {
		const now = this.now()
		if (this.cache.lastForcedAt !== null && now - this.cache.lastForcedAt < this.refetchCooldownSeconds) {
			return false
		}
		this.cache.lastForcedAt = now
		return true
	}

	/** Returns the payload, `null` on a genuine verification failure, or `NO_KEY` on a kid miss. */
	private async verifyWith(token: string, audience: string, force: boolean): Promise<unknown> {
		const keys = await this.keySet(force)
		try {
			const { payload } = await jwtVerify(token, keys, { issuer: this.issuer, audience })
			return payload
		} catch (err) {
			return err instanceof joseErrors.JWKSNoMatchingKey ? NO_KEY : null
		}
	}

	private async keySet(force: boolean): Promise<LocalJwks> {
		const now = this.now()
		const cached = this.cache.entry
		if (!force && cached !== null && cached.expiresAt > now) {
			return cached.keys
		}
		let jwks: Jwks
		try {
			jwks = await this.getJwks()
		} catch {
			// Never re-wrap the cause: it can stringify a request URL or a transport credential. A stale
			// key set is not a fallback either — it may have been rotated out because it was compromised.
			throw new JwksUnavailableError()
		}
		const keys = createLocalJWKSet(jwks)
		this.cache.entry = { keys, expiresAt: now + this.ttlSeconds }
		return keys
	}
}
