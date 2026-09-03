/**
 * The shared verifier's own contract: the three states, the TTL, and the bound on unknown-`kid`
 * refetches. Both consumers wrap this class, so a property proven here holds on both sides.
 */

import { describe, expect, test } from 'bun:test'
import { SignJWT } from 'jose'
import { createJwksCache, TokenVerifier } from '../verifier'
import { APP, ISSUER, KeySource, privateKey, ROTATED_JWKS, rotatedPrivateKey, signToken } from './helpers'

const wallClock = () => Math.floor(Date.now() / 1000)

describe('TokenVerifier', () => {
	test('the key set is fetched once and reused', async () => {
		const keys = new KeySource()
		const verifier = new TokenVerifier({ getJwks: keys.getJwks, issuer: ISSUER, now: wallClock })
		const token = await signToken({})
		expect((await verifier.verify(token, APP)).ok).toBe(true)
		expect((await verifier.verify(token, APP)).ok).toBe(true)
		expect(keys.calls).toBe(1)
	})

	test('a token for another app, another issuer, or past its expiry is invalid, never unavailable', async () => {
		const keys = new KeySource()
		const verifier = new TokenVerifier({ getJwks: keys.getJwks, issuer: ISSUER, now: wallClock })
		expect(await verifier.verify(await signToken({ audience: 'another-app' }), APP)).toEqual({ ok: false, reason: 'invalid' })
		expect(await verifier.verify(await signToken({ issuer: 'https://evil.test' }), APP)).toEqual({ ok: false, reason: 'invalid' })
		expect(await verifier.verify(await signToken({ ttlSeconds: -60 }), APP)).toEqual({ ok: false, reason: 'invalid' })
	})

	test('a valid signature with unparseable claims is invalid', async () => {
		const keys = new KeySource()
		const verifier = new TokenVerifier({ getJwks: keys.getJwks, issuer: ISSUER, now: wallClock })
		// Signed by the PUBLISHED key, so the signature checks out — but `perms` is missing, a shape the
		// token contract forbids. Signature validity alone must not be enough.
		const bogus = await new SignJWT({ iss: ISSUER, aud: APP, sub: 'x', label: null })
			.setProtectedHeader({ alg: 'ES256', kid: 'k1' })
			.setIssuedAt()
			.setExpirationTime('5m')
			.sign(privateKey)
		expect(await verifier.verify(bogus, APP)).toEqual({ ok: false, reason: 'invalid' })
	})

	test('an unknown kid triggers exactly one refetch, then verifies', async () => {
		const keys = new KeySource()
		const verifier = new TokenVerifier({ getJwks: keys.getJwks, issuer: ISSUER, now: wallClock })
		expect((await verifier.verify(await signToken({}), APP)).ok).toBe(true)
		expect(keys.calls).toBe(1)

		keys.served = ROTATED_JWKS
		expect((await verifier.verify(await signToken({ kid: 'k2', key: rotatedPrivateKey }), APP)).ok).toBe(true)
		expect(keys.calls).toBe(2)
	})

	test('unknown kids cannot be turned into one IAM fetch per request', async () => {
		// Without a cooldown, a caller invents a `kid` and every request becomes a JWKS round trip —
		// defeating the local-verify hot path the whole design rests on.
		const keys = new KeySource()
		const verifier = new TokenVerifier({ getJwks: keys.getJwks, issuer: ISSUER, now: wallClock })
		for (let i = 0; i < 20; i++) {
			expect((await verifier.verify(await signToken({ kid: `unknown-${i}`, key: rotatedPrivateKey }), APP)).ok).toBe(false)
		}
		expect(keys.calls).toBeLessThanOrEqual(2)
	})

	test('the cooldown lapses, so a real rotation is still picked up', async () => {
		let clock = 1_000_000
		const keys = new KeySource()
		const verifier = new TokenVerifier({ getJwks: keys.getJwks, issuer: ISSUER, now: () => clock })
		expect((await verifier.verify(await signToken({ kid: 'unknown', key: rotatedPrivateKey }), APP)).ok).toBe(false)
		expect(keys.calls).toBe(2)

		keys.served = ROTATED_JWKS
		clock += 31
		expect((await verifier.verify(await signToken({ kid: 'k2', key: rotatedPrivateKey }), APP)).ok).toBe(true)
		expect(keys.calls).toBe(3)
	})

	test('an unfetchable key set reports `unavailable`, not `invalid`', async () => {
		const keys = new KeySource()
		keys.error = new Error('connect ECONNREFUSED')
		const verifier = new TokenVerifier({ getJwks: keys.getJwks, issuer: ISSUER, now: wallClock })
		expect(await verifier.verify(await signToken({}), APP)).toEqual({ ok: false, reason: 'unavailable' })
	})

	test('a stale key set is NOT reused once the TTL lapses and the refetch fails', async () => {
		let clock = 1_000_000
		const keys = new KeySource()
		const verifier = new TokenVerifier({ getJwks: keys.getJwks, issuer: ISSUER, now: () => clock, ttlSeconds: 60 })
		const token = await signToken({ ttlSeconds: 100_000 })
		expect((await verifier.verify(token, APP)).ok).toBe(true)
		clock += 120
		keys.error = new Error('down')
		// The old key set may have been rotated out precisely because it was compromised.
		expect(await verifier.verify(token, APP)).toEqual({ ok: false, reason: 'unavailable' })
	})

	test('an injected cache is shared, so a second verifier over it starts warm and shares the cooldown', async () => {
		const keys = new KeySource()
		const cache = createJwksCache()
		const build = () => new TokenVerifier({ getJwks: keys.getJwks, issuer: ISSUER, now: wallClock, cache })

		expect((await build().verify(await signToken({}), APP)).ok).toBe(true)
		expect((await build().verify(await signToken({}), APP)).ok).toBe(true)
		expect(keys.calls).toBe(1)

		for (let i = 0; i < 5; i++) {
			expect((await build().verify(await signToken({ kid: `unknown-${i}`, key: rotatedPrivateKey }), APP)).ok).toBe(false)
		}
		expect(keys.calls).toBe(2)
	})
})
