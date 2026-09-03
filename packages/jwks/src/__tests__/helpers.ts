/**
 * Test doubles. Tokens are really signed with real ES256 keys and really verified through jose —
 * only the transport to IAM is faked, because "the token verifies" is the property under test.
 */

import { buildAccessClaims, type Jwks, type PermissionEntry } from '@fabrika/auth-core'
import { exportJWK, generateKeyPair, type KeyLike, SignJWT } from 'jose'

export const ISSUER = 'https://iam.test'
export const APP = 'example-app'

const PERMS: PermissionEntry[] = [{ action: 'demo.read', scope: null, source: 'grant' }]

const primary = await generateKeyPair('ES256')
/** A key ROTATED IN: unpublished until a test serves `ROTATED_JWKS`, after which it must verify. */
const rotated = await generateKeyPair('ES256')

export const privateKey = primary.privateKey
export const rotatedPrivateKey = rotated.privateKey

async function jwksOf(key: KeyLike, kid: string): Promise<Jwks> {
	const jwk = await exportJWK(key)
	return { keys: [{ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid, alg: 'ES256', use: 'sig' }] }
}

export const PUBLIC_JWKS: Jwks = await jwksOf(primary.publicKey, 'k1')
/** What IAM serves AFTER a rotation: `k1` is gone and `rotatedPrivateKey` signs as `k2`. */
export const ROTATED_JWKS: Jwks = await jwksOf(rotated.publicKey, 'k2')

export interface SignOptions {
	ttlSeconds?: number
	audience?: string
	issuer?: string
	key?: KeyLike
	kid?: string
}

export async function signToken(options: SignOptions = {}): Promise<string> {
	const now = Math.floor(Date.now() / 1000)
	const claims = buildAccessClaims({
		iss: options.issuer ?? ISSUER,
		app: options.audience ?? APP,
		subject: 'user-1',
		type: 'user',
		label: 'a@b.cz',
		permissions: PERMS,
		issuedAt: now,
		expiresAt: now + (options.ttlSeconds ?? 300),
	})
	return new SignJWT({ ...claims })
		.setProtectedHeader({ alg: 'ES256', kid: options.kid ?? 'k1' })
		.sign(options.key ?? primary.privateKey)
}

/** A key-set source that counts its fetches — the JWKS cache's only observable. */
export class KeySource {
	calls = 0
	served: Jwks = PUBLIC_JWKS
	error: Error | undefined

	getJwks = (): Promise<Jwks> => {
		this.calls += 1
		return this.error === undefined ? Promise.resolve(this.served) : Promise.reject(this.error)
	}
}
