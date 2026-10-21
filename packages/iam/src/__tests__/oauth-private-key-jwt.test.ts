import { type OAuthManagedClient, parseOAuthClientMetadata } from '@fabrika/iam-contract'
import { afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test'
import { exportJWK, generateKeyPair, type JWK, type KeyLike, SignJWT } from 'jose'
import { createHarness } from './helpers/harness'
import { ISSUER, oauthFixture, REDIRECT_URI, tokenBody } from './helpers/oauth'

const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
const TOKEN_ENDPOINT = `${ISSUER}/oauth/token`

type Fixture = Awaited<ReturnType<typeof oauthFixture>>
let active: Fixture | null = null

interface SigningKey {
	privateKey: KeyLike
	jwk: JWK
}

let first: SigningKey
let second: SigningKey

async function signingKey(kid: string): Promise<SigningKey> {
	const pair = await generateKeyPair('RS256')
	return { privateKey: pair.privateKey, jwk: { ...(await exportJWK(pair.publicKey)), kid, alg: 'RS256', use: 'sig' } }
}

beforeAll(async () => {
	first = await signingKey('key-1')
	second = await signingKey('key-2')
})

afterEach(() => {
	active?.restoreFetch()
	active = null
})

/** ChatGPT's live document (fetched 2026-10-21) under the fixture's client id, redirect URI and key set URL. */
function chatGptDocument(clientId: string, jwksUri: string): Record<string, unknown> {
	return {
		client_id: clientId,
		client_uri: 'https://chatgpt.com/',
		redirect_uris: [REDIRECT_URI],
		token_endpoint_auth_method: 'private_key_jwt',
		token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
		grant_types: ['authorization_code', 'refresh_token'],
		response_types: ['code'],
		client_name: 'ChatGPT',
		logo_uri: 'https://persistent.oaistatic.com/sonic/misc/openai-logo.png',
		token_endpoint_auth_signing_alg: 'RS256',
		jwks_uri: jwksUri,
	}
}

async function fixture(options: { jwks?: () => Record<string, unknown>; document?: typeof chatGptDocument } = {}): Promise<Fixture> {
	active = await oauthFixture(createHarness().repositories, {
		document: options.document ?? chatGptDocument,
		jwks: options.jwks ?? (() => ({ keys: [first.jwk] })),
	})
	return active
}

interface AssertionClaims {
	iss?: string
	sub?: string
	aud?: string | string[]
	jti?: string
	expiresIn?: number
	key?: SigningKey
}

let jtiCounter = 0

function assertion(f: Fixture, claims: AssertionClaims = {}): Promise<string> {
	const key = claims.key ?? first
	const now = Math.floor(Date.now() / 1000)
	const jwt = new SignJWT({ jti: claims.jti ?? `jti-${++jtiCounter}` })
		.setProtectedHeader({ alg: 'RS256', kid: key.jwk.kid ?? '' })
		.setIssuer(claims.iss ?? f.clientId)
		.setSubject(claims.sub ?? f.clientId)
		.setAudience(claims.aud ?? TOKEN_ENDPOINT)
		.setIssuedAt(now)
		.setExpirationTime(now + (claims.expiresIn ?? 60))
	return jwt.sign(key.privateKey)
}

async function authenticated(f: Fixture, claims: AssertionClaims = {}): Promise<Record<string, string>> {
	return { client_assertion_type: ASSERTION_TYPE, client_assertion: await assertion(f, claims) }
}

async function expectInvalidClient(response: Response): Promise<void> {
	expect(response.status).toBe(401)
	const body: unknown = await response.json()
	expect(body).toEqual({ error: 'invalid_client' })
}

describe('private_key_jwt client authentication', () => {
	test('a valid assertion redeems the code and refreshes, each with a fresh assertion', async () => {
		const f = await fixture()
		const exchanged = await f.exchange(await f.approve(), await authenticated(f))
		expect(exchanged.status).toBe(200)
		const body = await tokenBody(exchanged)
		const refreshed = await f.refresh(body.refresh_token ?? '', await authenticated(f))
		expect(refreshed.status).toBe(200)
	})

	test('the issuer identifier is accepted as the audience (RFC 7523bis)', async () => {
		const f = await fixture()
		expect((await f.exchange(await f.approve(), await authenticated(f, { aud: ISSUER }))).status).toBe(200)
	})

	test('no assertion is invalid_client and leaves the code unspent: no downgrade to none', async () => {
		const f = await fixture()
		const code = await f.approve()
		await expectInvalidClient(await f.exchange(code))
		expect((await f.exchange(code, await authenticated(f))).status).toBe(200)
	})

	test('a refresh without an assertion is invalid_client', async () => {
		const f = await fixture()
		const body = await tokenBody(await f.exchange(await f.approve(), await authenticated(f)))
		await expectInvalidClient(await f.refresh(body.refresh_token ?? ''))
	})

	test('a wrong audience, issuer or subject is refused', async () => {
		const f = await fixture()
		const code = await f.approve()
		const other = 'https://claude.example.test/cimd/other'
		await expectInvalidClient(await f.exchange(code, await authenticated(f, { aud: 'https://other.example.test/oauth/token' })))
		await expectInvalidClient(await f.exchange(code, await authenticated(f, { iss: other })))
		await expectInvalidClient(await f.exchange(code, await authenticated(f, { sub: other })))
		await expectInvalidClient(await f.exchange(code, await authenticated(f, { iss: other, sub: other })))
	})

	test('an expired assertion and one that lives longer than an hour are refused', async () => {
		const f = await fixture()
		const code = await f.approve()
		await expectInvalidClient(await f.exchange(code, await authenticated(f, { expiresIn: -120 })))
		await expectInvalidClient(await f.exchange(code, await authenticated(f, { expiresIn: 7200 })))
	})

	test('a replayed jti is refused', async () => {
		const f = await fixture()
		const replayed = await authenticated(f, { jti: 'once' })
		expect((await f.exchange(await f.approve(), replayed)).status).toBe(200)
		await expectInvalidClient(await f.exchange(await f.approve(), replayed))
		await expectInvalidClient(await f.exchange(await f.approve(), await authenticated(f, { jti: 'once' })))
	})

	test('an assertion signed by a key outside the set is refused, also under a known kid', async () => {
		const f = await fixture()
		const forged: SigningKey = { privateKey: second.privateKey, jwk: first.jwk }
		await expectInvalidClient(await f.exchange(await f.approve(), await authenticated(f, { key: forged })))
	})

	test('an unknown kid refetches the key set once, and not again within the interval', async () => {
		let rotated = false
		const f = await fixture({ jwks: () => ({ keys: rotated ? [first.jwk, second.jwk] : [first.jwk] }) })
		expect((await f.exchange(await f.approve(), await authenticated(f))).status).toBe(200)
		rotated = true
		setSystemTime(new Date(Date.now() + 31_000))
		try {
			expect((await f.exchange(await f.approve(), await authenticated(f, { key: second }))).status).toBe(200)
			expect(f.fetched.filter((url) => url === f.jwksUri)).toHaveLength(2)
			const unknown = await signingKey('key-3')
			await expectInvalidClient(await f.exchange(await f.approve(), await authenticated(f, { key: unknown })))
			expect(f.fetched.filter((url) => url === f.jwksUri)).toHaveLength(2)
		} finally {
			setSystemTime()
		}
	})

	test('an unknown kid within the refetch interval of the last fetch is refused without a fetch', async () => {
		let rotated = false
		const f = await fixture({ jwks: () => ({ keys: rotated ? [first.jwk, second.jwk] : [first.jwk] }) })
		expect((await f.exchange(await f.approve(), await authenticated(f))).status).toBe(200)
		rotated = true
		await expectInvalidClient(await f.exchange(await f.approve(), await authenticated(f, { key: second })))
		expect(f.fetched.filter((url) => url === f.jwksUri)).toHaveLength(1)
	})

	test('a key set on another host makes the document invalid, and is never fetched', async () => {
		const f = await fixture({ document: (clientId) => chatGptDocument(clientId, 'https://evil.example.test/jwks.json') })
		expect((await f.authorize()).status).toBe(400)
		await expectInvalidClient(await f.exchange('any-code', await authenticated(f)))
		expect(f.fetched.every((url) => url === f.clientId)).toBe(true)
	})

	test('a client id omitted beside an assertion is taken from its subject (RFC 7521 §4.2)', async () => {
		const f = await fixture()
		const code = await f.approve()
		const exchange = await f.exchange(code, await authenticated(f))
		expect(exchange.status).toBe(200)
		const body = await tokenBody(exchange)
		const form = new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: body.refresh_token ?? '',
			resource: 'https://control.example.test/mcp',
		})
		for (const [name, value] of Object.entries(await authenticated(f))) form.set(name, value)
		expect((await f.post('/oauth/token', Object.fromEntries(form))).status).toBe(200)
	})

	test('a half-present or foreign assertion type is invalid_client', async () => {
		const f = await fixture()
		const code = await f.approve()
		await expectInvalidClient(await f.exchange(code, { client_assertion: await assertion(f) }))
		await expectInvalidClient(await f.exchange(code, { client_assertion_type: ASSERTION_TYPE }))
		await expectInvalidClient(await f.exchange(code, { client_assertion_type: 'urn:example:other', client_assertion: await assertion(f) }))
	})

	test('revocation authenticates the client too', async () => {
		const f = await fixture()
		const body = await tokenBody(await f.exchange(await f.approve(), await authenticated(f)))
		await expectInvalidClient(await f.post('/oauth/revoke', { client_id: f.clientId, token: body.refresh_token ?? '' }))
		expect((await f.refresh(body.refresh_token ?? '', await authenticated(f))).status).toBe(200)
	})

	test('an authenticated revocation revokes the grant', async () => {
		const f = await fixture()
		const body = await tokenBody(await f.exchange(await f.approve(), await authenticated(f)))
		const revoked = await f.post('/oauth/revoke', { client_id: f.clientId, token: body.refresh_token ?? '', ...(await authenticated(f)) })
		expect(revoked.status).toBe(200)
		expect((await f.refresh(body.refresh_token ?? '', await authenticated(f))).status).toBe(400)
	})
})

describe('a public client', () => {
	test('that sends an assertion is refused, and without one is unchanged', async () => {
		active = await oauthFixture(createHarness().repositories, { jwks: () => ({ keys: [first.jwk] }) })
		const f = active
		const code = await f.approve()
		await expectInvalidClient(await f.exchange(code, await authenticated(f)))
		expect((await f.exchange(code)).status).toBe(200)
	})
})

describe('parseOAuthClientMetadata', () => {
	const stable: OAuthManagedClient = {
		provider: 'chatgpt',
		clientId: 'https://chatgpt.com/oauth/client.json',
		redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
	}
	const document = {
		client_id: 'https://chatgpt.com/oauth/client.json',
		client_uri: 'https://chatgpt.com/',
		redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
		token_endpoint_auth_method: 'private_key_jwt',
		token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
		grant_types: ['authorization_code', 'refresh_token'],
		response_types: ['code'],
		client_name: 'ChatGPT',
		logo_uri: 'https://persistent.oaistatic.com/sonic/misc/openai-logo.png',
		token_endpoint_auth_signing_alg: 'RS256',
		jwks_uri: 'https://chatgpt.com/oauth/jwks.json',
	}

	test("accepts ChatGPT's stable document as a private_key_jwt client", () => {
		expect(parseOAuthClientMetadata(document, stable)).toEqual({
			client_id: 'https://chatgpt.com/oauth/client.json',
			client_name: 'ChatGPT',
			redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'private_key_jwt',
			jwks_uri: 'https://chatgpt.com/oauth/jwks.json',
			token_endpoint_auth_signing_alg: 'RS256',
		})
	})

	test('refuses a key set off the client origin, an inline key set, an unsupported algorithm or another method', () => {
		expect(parseOAuthClientMetadata({ ...document, jwks_uri: 'https://evil.example/oauth/jwks.json' }, stable)).toBeNull()
		expect(parseOAuthClientMetadata({ ...document, jwks_uri: 'http://chatgpt.com/oauth/jwks.json' }, stable)).toBeNull()
		expect(parseOAuthClientMetadata({ ...document, jwks_uri: undefined }, stable)).toBeNull()
		expect(parseOAuthClientMetadata({ ...document, jwks: { keys: [] } }, stable)).toBeNull()
		expect(parseOAuthClientMetadata({ ...document, token_endpoint_auth_signing_alg: 'HS256' }, stable)).toBeNull()
		expect(parseOAuthClientMetadata({ ...document, token_endpoint_auth_signing_alg: undefined }, stable)).toBeNull()
		expect(parseOAuthClientMetadata({ ...document, token_endpoint_auth_method: 'client_secret_post' }, stable)).toBeNull()
	})

	test('keeps the grants IAM serves, and refuses a list without authorization_code or with a non-string', () => {
		const claude = { ...document, token_endpoint_auth_method: 'none' }
		expect(
			parseOAuthClientMetadata(
				{ ...claude, grant_types: ['authorization_code', 'urn:ietf:params:oauth:grant-type:jwt-bearer', 'refresh_token'] },
				stable,
			)
				?.grant_types,
		).toEqual(['authorization_code', 'refresh_token'])
		expect(parseOAuthClientMetadata({ ...claude, grant_types: ['refresh_token', 'urn:ietf:params:oauth:grant-type:jwt-bearer'] }, stable)).toBeNull()
		expect(parseOAuthClientMetadata({ ...claude, grant_types: ['authorization_code', 7] }, stable)).toBeNull()
	})
})
