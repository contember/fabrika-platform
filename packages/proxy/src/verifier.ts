/**
 * Local token verification — the warm path. Fetch the JWKS once, then verify every token with no
 * network call on the warm path.
 *
 * `verify` returns a three-state result, because "this token is bad" and "we could not check" are
 * different denials: the first is the caller's fault (401/403), the second is ours (503). Both deny.
 */

import { type AccessTokenClaims, type Jwks, parseAccessClaims } from '@fabrika/auth-core'
import { createLocalJWKSet, errors as joseErrors, jwtVerify } from 'jose'
import { JWKS_TTL_SECONDS } from './constants'
import { IamUnavailableError } from './iam'

export type VerifyResult =
	| { ok: true; claims: AccessTokenClaims }
	/** Signature, issuer, audience, expiry or claim-shape failure — the token is not trustworthy. */
	| { ok: false; reason: 'invalid' }
	/** The key set could not be obtained, so nothing can be verified. Deny, but say why. */
	| { ok: false; reason: 'unavailable' }

/** Sentinel distinguishing "no signing key matched (kid rotation)" from a real verification failure. */
const NO_KEY = Symbol('no-matching-key')

export class TokenVerifier {
	private cached: { verifier: ReturnType<typeof createLocalJWKSet>; expiresAt: number } | null = null

	constructor(
		private readonly getJwks: () => Promise<Jwks>,
		private readonly issuer: string,
		private readonly now: () => number,
		private readonly ttlSeconds: number = JWKS_TTL_SECONDS,
	) {}

	/**
	 * Verify `token` for `audience` and narrow it to access claims. An unknown `kid` triggers exactly
	 * one JWKS refetch (a key rotated in), then a retry.
	 */
	async verify(token: string, audience: string): Promise<VerifyResult> {
		let payload: unknown
		try {
			payload = await this.verifyWith(token, audience, false)
			if (payload === NO_KEY) {
				payload = await this.verifyWith(token, audience, true)
			}
		} catch (err) {
			if (err instanceof IamUnavailableError) {
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
	private async verifyWith(token: string, audience: string, force: boolean): Promise<unknown> {
		const jwks = await this.jwks(force)
		try {
			const { payload } = await jwtVerify(token, jwks, { issuer: this.issuer, audience })
			return payload
		} catch (err) {
			return err instanceof joseErrors.JWKSNoMatchingKey ? NO_KEY : null
		}
	}

	private async jwks(force: boolean): Promise<ReturnType<typeof createLocalJWKSet>> {
		const now = this.now()
		if (!force && this.cached !== null && this.cached.expiresAt > now) {
			return this.cached.verifier
		}
		let keys: Jwks
		try {
			keys = await this.getJwks()
		} catch {
			// Any JWKS failure is an IAM outage as far as we are concerned. Note that we do NOT fall
			// back to a stale verifier here: the previous key set may have been rotated out precisely
			// because it was compromised.
			throw new IamUnavailableError('getJwks')
		}
		const verifier = createLocalJWKSet(keys)
		this.cached = { verifier, expiresAt: now + this.ttlSeconds }
		return verifier
	}
}
