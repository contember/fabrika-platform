/**
 * The JWKS layer: fetched once, reused, and refetched exactly once when a `kid` we do not know shows
 * up (a key rotated in). The warm path must make no network call at all.
 */

import type { Jwks } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { IamUnavailableError } from '../iam'
import { TokenVerifier } from '../verifier'
import { APP, FakeIam, ISSUER, privateKey, PUBLIC_JWKS, signToken } from './helpers'

const now = () => Math.floor(Date.now() / 1000)

describe('TokenVerifier', () => {
	test('the key set is fetched once and reused', async () => {
		const iam = new FakeIam({})
		const verifier = new TokenVerifier(() => iam.getJwks(), ISSUER, now)
		const token = await signToken({})
		expect((await verifier.verify(token, APP)).ok).toBe(true)
		expect((await verifier.verify(token, APP)).ok).toBe(true)
		expect(iam.jwksCalls).toBe(1)
	})

	test('an unknown kid triggers exactly one refetch, then verifies', async () => {
		const rotated = await generateKeyPair('ES256')
		const jwk = await exportJWK(rotated.publicKey)
		const rotatedJwks: Jwks = { keys: [{ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid: 'k2', alg: 'ES256', use: 'sig' }] }

		let served: Jwks = PUBLIC_JWKS
		let calls = 0
		const verifier = new TokenVerifier(
			() => {
				calls++
				return Promise.resolve(served)
			},
			ISSUER,
			now,
		)

		// Warm the cache with the old key set.
		expect((await verifier.verify(await signToken({}), APP)).ok).toBe(true)
		expect(calls).toBe(1)

		// A token signed by the rotated-in key: unknown kid → one refetch → verifies.
		served = rotatedJwks
		const newToken = await new SignJWT({ ...JSON.parse(atob((await signToken({})).split('.')[1] ?? '')) })
			.setProtectedHeader({ alg: 'ES256', kid: 'k2' })
			.sign(rotated.privateKey)
		expect((await verifier.verify(newToken, APP)).ok).toBe(true)
		expect(calls).toBe(2)
	})

	test('an unfetchable key set reports `unavailable`, not `invalid`', async () => {
		const verifier = new TokenVerifier(() => Promise.reject(new IamUnavailableError('getJwks')), ISSUER, now)
		expect(await verifier.verify(await signToken({}), APP)).toEqual({ ok: false, reason: 'unavailable' })
	})

	test('a stale verifier is NOT reused once the TTL lapses and the refetch fails', async () => {
		let clock = 1_000_000
		let fail = false
		const verifier = new TokenVerifier(
			() => (fail ? Promise.reject(new Error('down')) : Promise.resolve(PUBLIC_JWKS)),
			ISSUER,
			() => clock,
			60,
		)
		const token = await signToken({ ttlSeconds: 100_000 })
		expect((await verifier.verify(token, APP)).ok).toBe(true)
		clock += 120
		fail = true
		// The old key set may have been rotated out precisely because it was compromised.
		expect(await verifier.verify(token, APP)).toEqual({ ok: false, reason: 'unavailable' })
	})

	test('a JWT with a valid signature but unparseable claims is invalid', async () => {
		const iam = new FakeIam({})
		const verifier = new TokenVerifier(() => iam.getJwks(), ISSUER, now)
		// Signed by the PUBLISHED key, so the signature checks out — but `perms` is missing, a shape
		// the token contract forbids. Signature validity alone must not be enough.
		const bogus = await new SignJWT({ iss: ISSUER, aud: APP, sub: 'x', label: null })
			.setProtectedHeader({ alg: 'ES256', kid: 'k1' })
			.setIssuedAt()
			.setExpirationTime('5m')
			.sign(privateKey)
		expect(await verifier.verify(bogus, APP)).toEqual({ ok: false, reason: 'invalid' })
	})
})
