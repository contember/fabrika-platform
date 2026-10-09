import { SESSION_COOKIE } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { PROXY_TOKEN_HEADER } from '../constants'
import { formatOAuthBearerChallenge, type InstallationProxyEndpointRow, type OAuthBearerChallenge } from '../manifest'
import { OAUTH_METADATA_VERIFY_PATH } from '../oauth'
import { createVerifyService } from '../service'
import {
	APP,
	FakeIam,
	foreignPrivateKey,
	ISSUER,
	manifestWith,
	MCP_ROW,
	OAUTH_RESOURCE,
	protocolRow,
	RESOURCE,
	RESOURCE_METADATA,
	type ResourceSignOptions,
	serviceRow,
	signResourceToken,
	signUserToken,
	verifyRequest,
} from './helpers'

const METADATA_PATH = new URL(RESOURCE_METADATA).pathname

function service(iam = new FakeIam(), endpoints: InstallationProxyEndpointRow[] = [MCP_ROW]) {
	return createVerifyService({ manifest: manifestWith(endpoints, { oauthResources: [OAUTH_RESOURCE] }), iam, issuer: ISSUER })
}

function expectChallenge(response: Response, status: number, parameters: Omit<OAuthBearerChallenge, 'resource_metadata'> = {}): void {
	expect(response.status).toBe(status)
	expect(response.headers.get('WWW-Authenticate')).toBe(formatOAuthBearerChallenge({ resource_metadata: RESOURCE_METADATA, ...parameters }))
	expect(response.headers.get('location')).toBeNull()
	expect(response.headers.get('set-cookie')).toBeNull()
	expect(response.headers.get(PROXY_TOKEN_HEADER)).toBeNull()
}

describe('a row that admits oauth', () => {
	test('a valid resource token is verified locally and injected as the proxy token', async () => {
		const iam = new FakeIam()
		const token = await signResourceToken()
		const response = await service(iam)(verifyRequest({ path: '/mcp', bearer: token }))
		expect(response.status).toBe(204)
		expect(response.headers.get(PROXY_TOKEN_HEADER)).toBe(token)
		expect(iam.mintTokenCalls + iam.mintFromKeyCalls).toBe(0)
	})

	test('no Authorization header is a 401 challenge without an error code, even with a session cookie', async () => {
		const iam = new FakeIam()
		const response = await service(iam)(verifyRequest({
			path: '/mcp',
			cookie: `${SESSION_COOKIE}=session`,
			headers: { 'Sec-Fetch-Mode': 'navigate' },
		}))
		expectChallenge(response, 401)
		expect(iam.mintTokenCalls + iam.mintFromKeyCalls + iam.jwksCalls).toBe(0)
	})

	test('another Authorization scheme is no bearer: a 401 challenge without an error code', async () => {
		const iam = new FakeIam()
		const verify = service(iam)
		for (const authorization of ['Basic value', 'Bearer']) {
			expectChallenge(await verify(verifyRequest({ path: '/mcp', headers: { Authorization: authorization } })), 401)
		}
		expect(iam.mintTokenCalls + iam.mintFromKeyCalls + iam.jwksCalls).toBe(0)
	})

	test('a native app token is an invalid_token challenge on an oauth row', async () => {
		expectChallenge(await service()(verifyRequest({ path: '/mcp', bearer: await signUserToken() })), 401, { error: 'invalid_token' })
	})

	const invalid: Record<string, ResourceSignOptions> = {
		'another resource': { resource: 'https://other.example.com/mcp' },
		'another app': { app: 'other-app' },
		'a foreign key': { key: foreignPrivateKey },
		'an expired token': { ttlSeconds: -1 },
		'no typ header': { typ: null },
		'a JWT typ header': { typ: 'JWT' },
	}
	for (const [name, options] of Object.entries(invalid)) {
		test(`a resource token for ${name} is an invalid_token challenge`, async () => {
			expectChallenge(await service()(verifyRequest({ path: '/mcp', bearer: await signResourceToken(options) })), 401, { error: 'invalid_token' })
		})
	}

	test('a token without a required scope is a 403 insufficient_scope challenge', async () => {
		const response = await service()(verifyRequest({ path: '/mcp', bearer: await signResourceToken({ scopes: ['mcp:write'] }) }))
		expectChallenge(response, 403, { error: 'insufficient_scope', scope: 'mcp:read' })
	})

	test('a JWKS outage is a 503 without a challenge', async () => {
		const response = await service(new FakeIam({ jwksUnreachable: true }))(verifyRequest({ path: '/mcp', bearer: await signResourceToken() }))
		expect(response.status).toBe(503)
		expect(response.headers.get('WWW-Authenticate')).toBeNull()
	})

	test('the oauth row is terminal: a refusal on /mcp is never answered by the wildcard row', async () => {
		const verify = service(new FakeIam(), [MCP_ROW, protocolRow('/*')])
		expectChallenge(await verify(verifyRequest({ path: '/mcp', cookie: `${SESSION_COOKIE}=session` })), 401)
		expectChallenge(await verify(verifyRequest({ path: '/mcp', bearer: await signUserToken() })), 401, { error: 'invalid_token' })
		expect((await verify(verifyRequest({ path: '/other' }))).status).toBe(204)
	})

	test('a resource token does not satisfy a machine row', async () => {
		const verify = service(new FakeIam(), [MCP_ROW, serviceRow('/api', ['machine'])])
		expect((await verify(verifyRequest({ path: '/api', bearer: await signResourceToken() }))).status).toBe(401)
	})
})

describe('oauth protected resource metadata', () => {
	test('is served publicly on the configured host and exact path, without IAM', async () => {
		const iam = new FakeIam({ unreachable: true })
		const response = await service(iam)(verifyRequest({ endpoint: OAUTH_METADATA_VERIFY_PATH, path: METADATA_PATH }))
		expect(response.status).toBe(200)
		expect(response.headers.get(PROXY_TOKEN_HEADER)).toBeNull()
		expect(await response.json()).toEqual({
			resource: RESOURCE,
			authorization_servers: [ISSUER],
			scopes_supported: ['mcp:read', 'mcp:write'],
			bearer_methods_supported: ['header'],
		})
		expect(iam.jwksCalls + iam.mintTokenCalls + iam.mintFromKeyCalls).toBe(0)
	})

	test('ignores the query string and answers HEAD without a body', async () => {
		const verify = service()
		expect((await verify(verifyRequest({ endpoint: OAUTH_METADATA_VERIFY_PATH, path: `${METADATA_PATH}?x=1` }))).status).toBe(200)
		const head = await verify(verifyRequest({ endpoint: OAUTH_METADATA_VERIFY_PATH, path: METADATA_PATH, method: 'HEAD' }))
		expect(head.status).toBe(200)
		expect(await head.text()).toBe('')
		expect((await verify(verifyRequest({ endpoint: OAUTH_METADATA_VERIFY_PATH, path: METADATA_PATH, method: 'POST' }))).status).toBe(405)
	})

	test('any other path or app is not metadata', async () => {
		const verify = service()
		for (const path of ['/.well-known/oauth-protected-resource/other', METADATA_PATH.toUpperCase(), `${METADATA_PATH}/`, '/mcp']) {
			expect((await verify(verifyRequest({ endpoint: OAUTH_METADATA_VERIFY_PATH, path }))).status).toBe(404)
		}
		expect((await verify(verifyRequest({ endpoint: OAUTH_METADATA_VERIFY_PATH, path: METADATA_PATH, app: 'other-app' }))).status).toBe(403)
		expect((await verify(verifyRequest({ endpoint: OAUTH_METADATA_VERIFY_PATH, path: METADATA_PATH, app: APP, host: 'evil.example.com' }))).status)
			.toBe(403)
	})

	test('the metadata path on /verify is still planned, never admitted implicitly', async () => {
		expect((await service()(verifyRequest({ path: METADATA_PATH }))).status).toBe(403)
	})
})
