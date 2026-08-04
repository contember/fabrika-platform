/**
 * Local access-token verification — the only thing this SDK still does with a credential.
 *
 * Since [ADR-0007](../../../docs/decisions/0007-proxy-based-auth-enforcement.md) the PROXY is the only
 * enforcement point: it matches the app's gates, resolves the credential, and injects the verified
 * token as `PROXY_TOKEN_HEADER`. The app must NOT trust that header blindly, so every token is
 * re-verified here against IAM's published JWKS — signature, `iss`, `aud`, `exp` — before it can
 * become an `AuthContext`.
 *
 * `verify` is THREE-STATE, exactly like `@fabrika/proxy`'s verifier: "this token is bad" (the
 * caller's fault, 401) and "we could not check" (ours, 503) are different denials. Both deny; only
 * the second is an incident. Collapsing them would let a JWKS outage look like a forged token.
 *
 * The JWKS is cached PER BINDING in a module-level WeakMap rather than per instance: `@fabrika/app`
 * calls its `middleware(env)` factory on every request, so an SDK object built there is per-request
 * while the binding lives for the isolate/process. An unknown `kid` (a key rotated in) forces exactly
 * one refetch, and a stale verifier is never reused after a fetch failure — the previous key set may
 * have been rotated out precisely because it was compromised.
 */

import { type AccessTokenClaims, type IamRpc, type Jwks, parseAccessClaims } from '@fabrika/auth-core'
import { createLocalJWKSet, errors as joseErrors, jwtVerify } from 'jose'

export type VerifyResult =
	| { ok: true; claims: AccessTokenClaims }
	/** Signature, issuer, audience, expiry or claim-shape failure — the token is not trustworthy. */
	| { ok: false; reason: 'invalid' }
	/** The key set could not be obtained, so nothing could be checked. Deny, but say why. */
	| { ok: false; reason: 'unavailable' }

/** How long a fetched JWKS is reused before a refetch (a rotation also forces one on demand). */
const JWKS_TTL_SECONDS = 600

/** Sentinel distinguishing "no signing key matched (kid rotation)" from a real verification failure. */
const NO_KEY = Symbol('no-matching-key')

type JwksVerifier = ReturnType<typeof createLocalJWKSet>

/** Raised only by `jwks()`, so `verify` can tell an unfetchable key set from an untrustworthy token. */
class JwksUnavailableError extends Error {
	constructor() {
		super('the IAM key set could not be fetched')
		this.name = 'JwksUnavailableError'
	}
}

/** JWKS verifier cached per binding, so it survives the per-request SDK objects built over it. */
const jwksCache = new WeakMap<IamRpc, { verifier: JwksVerifier; expiresAt: number }>()

/** Verifies tokens for ONE (binding, issuer, audience) triple. Cheap to construct; the cache is shared. */
export class TokenVerifier {
	constructor(
		private readonly binding: IamRpc,
		private readonly issuer: string,
		private readonly audience: string,
		private readonly now: () => number = () => Math.floor(Date.now() / 1000),
	) {}

	async verify(token: string): Promise<VerifyResult> {
		let payload: unknown
		try {
			payload = await this.verifyWith(token, false)
			if (payload === NO_KEY) {
				// Unknown kid — a key was rotated in. Refetch the JWKS once and retry.
				payload = await this.verifyWith(token, true)
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

	/** Returns the payload, `null` on a genuine verification failure, or `NO_KEY` on a kid miss. */
	private async verifyWith(token: string, force: boolean): Promise<unknown> {
		const jwks = await this.jwks(force)
		try {
			const { payload } = await jwtVerify(token, jwks, { issuer: this.issuer, audience: this.audience })
			return payload
		} catch (err) {
			return err instanceof joseErrors.JWKSNoMatchingKey ? NO_KEY : null
		}
	}

	private async jwks(force: boolean): Promise<JwksVerifier> {
		const now = this.now()
		const cached = jwksCache.get(this.binding)
		if (!force && cached !== undefined && cached.expiresAt > now) {
			return cached.verifier
		}
		let keys: Jwks
		try {
			keys = await this.binding.getJwks()
		} catch {
			// Never re-wrap the cause: it can stringify a request URL or a transport credential.
			throw new JwksUnavailableError()
		}
		const verifier = createLocalJWKSet(keys)
		jwksCache.set(this.binding, { verifier, expiresAt: now + JWKS_TTL_SECONDS })
		return verifier
	}
}
