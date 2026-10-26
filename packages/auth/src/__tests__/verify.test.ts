/**
 * What the SDK's construction shape adds on top of `@fabrika/jwks`: the key set AND the unknown-`kid`
 * cooldown live per BINDING, so they survive the per-request verifier `@fabrika/app` builds.
 */

import { buildAccessClaims, type Jwks, type PermissionEntry } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { exportJWK, generateKeyPair, type KeyLike, SignJWT } from 'jose'
import { TokenVerifier } from '../verify'
import { IamRpcStub } from './stub'

const ISSUER = 'https://iam.test'
const APP = 'example-app'

const { publicKey, privateKey } = await generateKeyPair('ES256')
const { privateKey: rotatedPrivate } = await generateKeyPair('ES256')

async function jwk(key: KeyLike, kid: string): Promise<Jwks['keys'][number]> {
	const exported = await exportJWK(key)
	return { kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y, kid, alg: 'ES256', use: 'sig' }
}

const JWKS: Jwks = { keys: [await jwk(publicKey, 'k1')] }
const PERMS: PermissionEntry[] = [{ action: 'demo.read', scope: null, source: 'grant' }]

async function sign(opts: { kid?: string; key?: KeyLike } = {}): Promise<string> {
	const now = Math.floor(Date.now() / 1000)
	const claims = buildAccessClaims({
		iss: ISSUER,
		app: APP,
		subject: 'user-1',
		type: 'user',
		label: 'a@b.cz',
		permissions: PERMS,
		issuedAt: now - 60,
		expiresAt: now + 3600,
	})
	return new SignJWT({ ...claims }).setProtectedHeader({ alg: 'ES256', kid: opts.kid ?? 'k1' }).sign(opts.key ?? privateKey)
}

describe('the unknown-kid refetch is bounded per binding', () => {
	test('twenty invented kids inside the cooldown cost ONE forced refetch, not twenty', async () => {
		// A fresh verifier per request is the real shape — `@fabrika/app` calls its middleware factory
		// per request — so the bound only holds if the cooldown lives with the binding, not the instance.
		const stub = new IamRpcStub({ jwks: JWKS })
		const clock = 1_000_000
		for (let i = 0; i < 20; i++) {
			const verifier = new TokenVerifier(stub, ISSUER, APP, () => clock)
			expect(await verifier.verify(await sign({ kid: `unknown-${i}`, key: rotatedPrivate }))).toEqual({ ok: false, reason: 'invalid' })
		}
		// One cold fetch plus exactly one forced refetch inside the window.
		expect(stub.jwksCalls).toBe(2)
	})

	test('a forced refetch is allowed again once the cooldown lapses', async () => {
		const stub = new IamRpcStub({ jwks: JWKS })
		let clock = 1_000_000
		const verifier = () => new TokenVerifier(stub, ISSUER, APP, () => clock)
		expect((await verifier().verify(await sign({ kid: 'unknown', key: rotatedPrivate }))).ok).toBe(false)
		expect(stub.jwksCalls).toBe(2)

		clock += 31
		expect((await verifier().verify(await sign({ kid: 'unknown', key: rotatedPrivate }))).ok).toBe(false)
		expect(stub.jwksCalls).toBe(3)
	})

	test('the cooldown never blocks a token the cached key set can already verify', async () => {
		const stub = new IamRpcStub({ jwks: JWKS })
		const clock = 1_000_000
		const verifier = () => new TokenVerifier(stub, ISSUER, APP, () => clock)
		expect((await verifier().verify(await sign({ kid: 'unknown', key: rotatedPrivate }))).ok).toBe(false)
		expect((await verifier().verify(await sign())).ok).toBe(true)
		expect(stub.jwksCalls).toBe(2)
	})
})
