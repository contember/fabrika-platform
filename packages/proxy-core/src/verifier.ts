/**
 * Local token verification — the warm path. Fetch the JWKS once, then verify every token with no
 * network call on the warm path.
 *
 * The verification itself is `@fabrika/jwks`, shared byte-for-byte with the app SDK. What this file
 * owns is the proxy's construction shape: one long-lived process holding one verifier, so the key set
 * is cached per instance, and the audience is the app the forwarded request resolved to — per call,
 * not per verifier.
 */

import type { Jwks, TokenAudienceProfile } from '@fabrika/auth-core'
import { TokenVerifier as JwksVerifier, type VerifyResult } from '@fabrika/jwks'
import { JWKS_REFETCH_COOLDOWN_SECONDS, JWKS_TTL_SECONDS } from './constants'

export type { VerifyResult }

export class TokenVerifier {
	private readonly inner: JwksVerifier

	constructor(
		getJwks: () => Promise<Jwks>,
		issuer: string,
		now: () => number,
		ttlSeconds: number = JWKS_TTL_SECONDS,
		refetchCooldownSeconds: number = JWKS_REFETCH_COOLDOWN_SECONDS,
	) {
		this.inner = new JwksVerifier({ getJwks, issuer, now, ttlSeconds, refetchCooldownSeconds })
	}

	/**
	 * Verify `token` for `audience` (a bare string is an app id). An unknown `kid` forces one JWKS refetch (a key rotated in), then a
	 * retry — but at most once per cooldown, because otherwise any caller can turn every request into an
	 * IAM round trip just by inventing a `kid`.
	 */
	verify(token: string, audience: string | TokenAudienceProfile): Promise<VerifyResult> {
		return this.inner.verify(token, audience)
	}
}
