// The IAM side of an HTTP-level control-plane test: a throwaway ES256 key, an `IamRpc` binding that
// publishes it, and access tokens signed with it.
//
// There is no local mode in `@fabrika/auth` any more — `createIam` requires the binding and the
// issuer in every environment — so a test that drives `controlApp` over HTTP supplies both, and a
// caller is a REAL token carrying real permission entries. That is also how a test exercises a role:
// the token's `perms` are what `can()` reads, exactly as in production.

import type { IamRpc } from '@fabrika/auth'
import { ACTIONS } from '../../actions'

export const TEST_ISSUER = 'https://propustka.test'

const KEY_ID = 'control-test'
const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const publicJwk = await crypto.subtle.exportKey('jwk', keys.publicKey)

function required(value: string | undefined, name: string): string {
	if (value === undefined) throw new Error(`generated control test key is missing ${name}`)
	return value
}

const publicKey = {
	kty: required(publicJwk.kty, 'kty'),
	crv: required(publicJwk.crv, 'crv'),
	x: required(publicJwk.x, 'x'),
	y: required(publicJwk.y, 'y'),
	kid: KEY_ID,
	alg: 'ES256',
	use: 'sig',
}

/**
 * The `IamRpc` binding a control-plane test binds. It publishes the suite's key so a token verifies,
 * and answers every other operation with a decided negative — nothing here mints or authorizes.
 * ONE instance, because the SDK caches the JWKS in a WeakMap keyed by the binding object.
 */
export const testIamBinding: IamRpc = {
	mintToken: () => Promise.resolve({ ok: false, reason: 'no_session' }),
	mintFromKey: () => Promise.resolve({ ok: false, reason: 'invalid_key' }),
	issueKey: () => Promise.resolve({ ok: false, reason: 'not_allowed' }),
	issueJwt: () => Promise.resolve({ ok: false, reason: 'not_allowed' }),
	getJwks: () => Promise.resolve({ keys: [publicKey] }),
	audit: () => Promise.resolve(),
	listPrincipals: () => Promise.resolve({ ok: true, principals: [] }),
	revokeKey: () => Promise.resolve({ ok: false, reason: 'not_found' }),
}

/** The two `Env` fields `createIam` needs, for spreading into a test env. */
export const testIamEnv = { IAM: testIamBinding, FABRIKA_IAM_ISSUER: TEST_ISSUER } as const

function base64Url(value: string | Uint8Array): string {
	const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** Sign one access token the way IAM does — the shape the proxy injects as `X-Fabrika-Token`. */
export async function testToken(input: {
	label: string
	actions: readonly string[]
	type?: 'user' | 'service'
	subject?: string
}): Promise<string> {
	const now = Math.floor(Date.now() / 1000)
	const type = input.type ?? 'user'
	const header = base64Url(JSON.stringify({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' }))
	const payload = base64Url(JSON.stringify({
		iss: TEST_ISSUER,
		aud: 'vozka',
		sub: input.subject ?? `${type}-${input.label}`,
		iat: now,
		exp: now + 300,
		perms: input.actions.map((action) => ({ action, scope: null, source: 'grant' })),
		ptype: type,
		label: input.label,
	}))
	const signingInput = `${header}.${payload}`
	const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(signingInput))
	return `${signingInput}.${base64Url(new Uint8Array(signature))}`
}

/**
 * The three roles the console's authorization is worth testing against, as tokens. They mirror the
 * `origin='app'` roles fabrika reconciles into IAM (`fabrika.config.ts`) plus a read-only slice.
 */
export const adminToken = await testToken({ label: 'admin@vozka.test', actions: ['*'] })
export const operatorToken = await testToken({ label: 'operator@vozka.test', actions: ['deploy.*', 'operations.*'] })
export const viewerToken = await testToken({ label: 'viewer@vozka.test', actions: [ACTIONS.DEPLOY_READ] })
