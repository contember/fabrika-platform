import { buildResourceAccessClaims, RESOURCE_ACCESS_TOKEN_TYP, type TokenAudienceProfile } from '@fabrika/auth-core'
import { expect, test } from 'bun:test'
import { SignJWT } from 'jose'
import { TokenVerifier, type VerifyResult } from '../verifier'
import { APP, ISSUER, privateKey, PUBLIC_JWKS, signToken } from './helpers'

const RESOURCE = 'https://builder.test/mcp'
const PROFILE: TokenAudienceProfile = { kind: 'resource', app: APP, resource: RESOURCE }
const INVALID: VerifyResult = { ok: false, reason: 'invalid' }

function verifier(): TokenVerifier {
	return new TokenVerifier({ issuer: ISSUER, getJwks: () => Promise.resolve(PUBLIC_JWKS) })
}

async function resourceToken(changes: Record<string, unknown> = {}, typ: string | null = RESOURCE_ACCESS_TOKEN_TYP): Promise<string> {
	const now = Math.floor(Date.now() / 1000)
	const claims = buildResourceAccessClaims({
		iss: ISSUER,
		app: APP,
		resource: RESOURCE,
		subject: 'user-1',
		label: 'User',
		permissions: [{ action: 'demo.read', scope: null, source: 'grant' }],
		issuedAt: now,
		expiresAt: now + 300,
		clientId: 'https://client.test/metadata.json',
		scopes: ['authoring'],
		grantId: 'grant-1',
		tokenId: 'token-1',
	})
	const header = typ === null ? { alg: 'ES256', kid: 'k1' } : { alg: 'ES256', kid: 'k1', typ }
	return new SignJWT({ ...claims, ...changes }).setProtectedHeader(header).sign(privateKey)
}

test('a resource profile accepts a correctly typed resource token and exposes its OAuth claims', async () => {
	const result = await verifier().verify(await resourceToken(), PROFILE)
	if (!result.ok) throw new Error('resource verification failed')
	expect(result.claims.aud).toBe(RESOURCE)
	expect(result.claims.oauth).toEqual({
		app: APP,
		clientId: 'https://client.test/metadata.json',
		scopes: ['authoring'],
		grantId: 'grant-1',
		tokenId: 'token-1',
	})
})

test('a resource profile refuses a token without the at+jwt header type', async () => {
	for (const typ of [null, 'JWT', 'application/at+jwt']) {
		expect(await verifier().verify(await resourceToken({}, typ), PROFILE)).toEqual(INVALID)
	}
})

test('a resource profile refuses the wrong resource or the wrong app', async () => {
	const token = await resourceToken()
	expect(await verifier().verify(token, { kind: 'resource', app: APP, resource: `${RESOURCE}/other` })).toEqual(INVALID)
	expect(await verifier().verify(token, { kind: 'resource', app: 'other-app', resource: RESOURCE })).toEqual(INVALID)
	expect(await verifier().verify(await resourceToken({ app: 'other-app' }), PROFILE)).toEqual(INVALID)
})

test('a resource profile refuses partial OAuth claims even when signed', async () => {
	for (const changes of [{ client_id: undefined }, { scope: undefined }, { grant: undefined }, { jti: '' }]) {
		expect(await verifier().verify(await resourceToken(changes), PROFILE)).toEqual(INVALID)
	}
})

test('a native app token never passes a resource profile, and a resource token never passes an app profile', async () => {
	expect(await verifier().verify(await signToken({ audience: RESOURCE }), PROFILE)).toEqual(INVALID)
	expect(await verifier().verify(await signToken(), PROFILE)).toEqual(INVALID)
	const resource = await resourceToken()
	expect(await verifier().verify(resource, { kind: 'app', app: RESOURCE })).toEqual(INVALID)
	expect(await verifier().verify(resource, RESOURCE)).toEqual(INVALID)
})

test('an app profile keeps accepting native app tokens, by profile or by bare app id', async () => {
	const token = await signToken()
	expect((await verifier().verify(token, APP)).ok).toBe(true)
	expect((await verifier().verify(token, { kind: 'app', app: APP })).ok).toBe(true)
})
