import { buildAccessClaims, matchesTokenAudience, parseAccessClaims, RESOURCE_ACCESS_TOKEN_TYP, TOKEN_ALG } from '@fabrika/auth-core'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { decodeJwt, decodeProtectedHeader } from 'jose'
import { resolveAdmin } from '../admin/router'
import { resolveCaller } from '../auth'
import { narrowPermissions } from '../oauth'
import { parseOAuthConfig } from '../oauth-config'
import { handleOAuth } from '../oauth-http'
import { getSigner, verifyAccessToken, verifyResourceAccessToken } from '../signing'
import { createHarness } from './helpers/harness'
import { ISSUER, oauthFixture, REDIRECT_URI, RESOURCE, SIGNING_ENV, tokenBody } from './helpers/oauth'

type Fixture = Awaited<ReturnType<typeof oauthFixture>>
let active: Fixture | null = null

async function fixture(options: Parameters<typeof oauthFixture>[1] = {}): Promise<Fixture> {
	active = await oauthFixture(createHarness().repositories, options)
	return active
}

afterEach(() => {
	active?.restoreFetch()
	active = null
})

function locationOf(response: Response): URL {
	const location = response.headers.get('location')
	if (location === null) throw new Error(`no redirect (${response.status})`)
	return new URL(location)
}

describe('authorization server metadata', () => {
	test('advertises the endpoints, PKCE S256, public clients and CIMD', async () => {
		const f = await fixture()
		const response = await f.call(new Request(`${ISSUER}/.well-known/oauth-authorization-server`))
		expect(response.status).toBe(200)
		const body: unknown = await response.json()
		expect(body).toEqual({
			issuer: ISSUER,
			authorization_endpoint: `${ISSUER}/oauth/authorize`,
			token_endpoint: `${ISSUER}/oauth/token`,
			revocation_endpoint: `${ISSUER}/oauth/revoke`,
			jwks_uri: `${ISSUER}/.well-known/jwks.json`,
			response_types_supported: ['code'],
			grant_types_supported: ['authorization_code', 'refresh_token'],
			code_challenge_methods_supported: ['S256'],
			token_endpoint_auth_methods_supported: ['none'],
			client_id_metadata_document_supported: true,
		})
	})

	test('every OAuth path is 404 when OAUTH_CONFIG is unset', async () => {
		const f = await fixture()
		const services = { ...f.services, config: { ...f.services.config, oauth: null } }
		const response = await handleOAuth(new Request(`${ISSUER}/.well-known/oauth-authorization-server`), services, SIGNING_ENV, 'req-oauth')
		expect(response.status).toBe(404)
	})
})

describe('authorization code flow', () => {
	test('authorize → login → consent → code → token → refresh', async () => {
		const f = await fixture()

		const anonymous = await f.authorize({}, false)
		expect(anonymous.status).toBe(302)
		const login = locationOf(anonymous)
		expect(login.pathname).toBe('/auth/login')
		const back = new URL(login.searchParams.get('redirect') ?? '')
		expect(back.origin + back.pathname).toBe(`${ISSUER}/oauth/authorize`)
		expect(back.searchParams.get('client_id')).toBe(f.clientId)

		const page = await f.authorize()
		expect(page.status).toBe(200)
		const html = await page.text()
		expect(html).toContain('Claude &lt;test&gt;')
		expect(html).toContain('control')
		expect(html).toContain(RESOURCE)
		expect(html).toContain('authoring')
		expect(page.headers.get('content-security-policy')).toContain(`form-action 'self' https://claude.example.test`)

		const approved = await f.decide('approve')
		expect(approved.status).toBe(302)
		const callback = locationOf(approved)
		expect(callback.origin + callback.pathname).toBe(REDIRECT_URI)
		expect(callback.searchParams.get('state')).toBe('opaque-state')
		const code = callback.searchParams.get('code') ?? ''

		const exchanged = await f.exchange(code)
		expect(exchanged.status).toBe(200)
		expect(exchanged.headers.get('cache-control')).toBe('no-store')
		const first = await tokenBody(exchanged)
		expect(first.scope).toBe('authoring')
		expect(first.expires_in).toBeLessThanOrEqual(300)
		expect(first.refresh_token).toBeString()

		const header = decodeProtectedHeader(first.access_token)
		expect(header.alg).toBe(TOKEN_ALG)
		expect(header.typ).toBe(RESOURCE_ACCESS_TOKEN_TYP)
		expect(header.kid).toBeString()
		const claims = parseAccessClaims(decodeJwt(first.access_token))
		expect(claims).not.toBeNull()
		if (claims === null) return
		expect(claims.iss).toBe(ISSUER)
		expect(claims.sub).toBe(f.principal.id)
		expect(matchesTokenAudience(claims, { kind: 'resource', app: 'control', resource: RESOURCE })).toBe(true)
		expect(claims.oauth?.clientId).toBe(f.clientId)
		expect(claims.oauth?.scopes).toEqual(['authoring'])
		expect(claims.oauth?.app).toBe('control')
		// The ceiling `source.workspace.*` keeps the two workspace grants and drops `deploy.run`.
		expect(claims.perms.map((entry) => entry.action).sort()).toEqual(['source.workspace.read', 'source.workspace.write'])
		expect(claims.perms.every((entry) => entry.scope?.type === 'app' && entry.scope.value === 'alpha')).toBe(true)
		expect(await verifyResourceAccessToken(await getSigner(SIGNING_ENV), first.access_token, { issuer: ISSUER })).not.toBeNull()

		const rotated = await f.refresh(first.refresh_token ?? '')
		expect(rotated.status).toBe(200)
		const second = await tokenBody(rotated)
		expect(second.refresh_token).not.toBe(first.refresh_token)
		const secondClaims = parseAccessClaims(decodeJwt(second.access_token))
		expect(secondClaims?.oauth?.grantId).toBe(claims.oauth?.grantId)
		expect(secondClaims?.oauth?.tokenId).not.toBe(claims.oauth?.tokenId)
	})

	test('deny returns access_denied with the state', async () => {
		const f = await fixture()
		const callback = locationOf(await f.decide('deny'))
		expect(callback.searchParams.get('error')).toBe('access_denied')
		expect(callback.searchParams.get('state')).toBe('opaque-state')
		expect(callback.searchParams.get('code')).toBeNull()
	})

	test('a cross-site consent post is refused', async () => {
		const f = await fixture()
		const response = await f.decide('approve', {}, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' })
		expect(response.status).toBe(403)
		expect(response.headers.get('location')).toBeNull()
	})

	test('a scope the user consented to without holding grants mints no permission from the scope alone', async () => {
		const f = await fixture()
		const code = new URL(locationOf(await f.decide('approve', { scope: 'deploy' }))).searchParams.get('code') ?? ''
		const claims = parseAccessClaims(decodeJwt((await tokenBody(await f.exchange(code))).access_token))
		// The user holds `deploy.run` only at app alpha; the `deploy` scope's ceiling names app beta.
		expect(claims?.perms).toEqual([])
	})
})

describe('authorization request validation', () => {
	test('an unregistered client is refused with a page, before any metadata fetch', async () => {
		const f = await fixture()
		const response = await f.authorize({ client_id: 'https://unknown.example.test/cimd' })
		expect(response.status).toBe(400)
		expect(response.headers.get('location')).toBeNull()
		const token = await f.exchange('anything', { client_id: 'https://unknown.example.test/cimd' })
		expect(token.status).toBe(401)
		const body: unknown = await token.json()
		expect(body).toEqual({ error: 'invalid_client' })
		expect(f.fetched).toEqual([])
	})

	test('an unregistered redirect URI is refused with a page, never redirected to', async () => {
		const f = await fixture()
		const response = await f.authorize({ redirect_uri: 'https://evil.example.test/callback' })
		expect(response.status).toBe(400)
		expect(response.headers.get('location')).toBeNull()
		expect(f.fetched).toEqual([])
	})

	test('a fetched document cannot add a redirect URI beyond the configured set', async () => {
		const f = await fixture({
			document: (clientId) => ({
				client_id: clientId,
				redirect_uris: [REDIRECT_URI, 'https://evil.example.test/callback'],
				token_endpoint_auth_method: 'none',
			}),
		})
		const response = await f.authorize()
		expect(response.status).toBe(400)
		expect(f.fetched).toHaveLength(1)
	})

	test("Claude's document, which lists a grant IAM does not serve, is accepted for the grants IAM serves", async () => {
		// Claude's live document (fetched 2026-10-21) under the fixture's client id and redirect URI.
		const f = await fixture({
			document: (clientId) => ({
				client_id: clientId,
				client_name: 'Claude',
				client_uri: 'https://claude.ai',
				redirect_uris: [REDIRECT_URI],
				grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:jwt-bearer'],
				response_types: ['code'],
				token_endpoint_auth_method: 'none',
			}),
		})
		const first = await tokenBody(await f.exchange(await f.approve()))
		expect((await f.refresh(first.refresh_token ?? '')).status).toBe(200)
	})

	test('a document without grant_types gets no refresh token', async () => {
		const f = await fixture({
			document: (clientId) => ({ client_id: clientId, redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' }),
		})
		const body = await tokenBody(await f.exchange(await f.approve()))
		expect(body.refresh_token).toBeUndefined()
	})

	test('an unknown scope redirects with invalid_scope, an unknown resource with invalid_target', async () => {
		const f = await fixture()
		expect(locationOf(await f.authorize({ scope: 'everything' })).searchParams.get('error')).toBe('invalid_scope')
		expect(locationOf(await f.authorize({ resource: 'https://other.example.test/mcp' })).searchParams.get('error')).toBe('invalid_target')
	})

	test('a repeated parameter is a malformed request', async () => {
		const f = await fixture()
		const query = new URLSearchParams({ client_id: f.clientId, scope: 'authoring' })
		query.append('scope', 'deploy')
		const response = await f.call(new Request(`${ISSUER}/oauth/authorize?${query}`))
		expect(response.status).toBe(400)
	})
})

describe('token endpoint', () => {
	test('a code is single-use, and a replay revokes what it issued', async () => {
		const f = await fixture()
		const code = await f.approve()
		const first = await tokenBody(await f.exchange(code))
		const replay = await f.exchange(code)
		expect(replay.status).toBe(400)
		const body: unknown = await replay.json()
		expect(body).toEqual({ error: 'invalid_grant' })
		expect((await f.refresh(first.refresh_token ?? '')).status).toBe(400)
	})

	test('a wrong verifier is refused and spends the code', async () => {
		const f = await fixture()
		const code = await f.approve()
		expect((await f.exchange(code, { code_verifier: 'x'.repeat(43) })).status).toBe(400)
		expect((await f.exchange(code)).status).toBe(400)
	})

	test('a wrong resource or redirect URI is refused', async () => {
		const f = await fixture()
		expect((await f.exchange(await f.approve(), { resource: 'https://other.example.test/mcp' })).status).toBe(400)
		expect((await f.exchange(await f.approve(), { redirect_uri: 'https://claude.example.test/other' })).status).toBe(400)
	})

	test('an expired code is refused', async () => {
		const harness = createHarness()
		active = await oauthFixture(harness.repositories)
		const code = await active.approve()
		harness.sqlite.run('UPDATE oauth_codes SET expires_at = 1')
		expect((await active.exchange(code)).status).toBe(400)
	})

	test('a code exchange and a refresh refuse a token above MAX_ACCESS_TOKEN_BYTES', async () => {
		const harness = createHarness()
		active = await oauthFixture(harness.repositories)
		const f = active
		const refreshable = await tokenBody(await f.exchange(await f.approve()))
		for (let index = 0; index < 200; index++) {
			await harness.repositories.grants.createGrant({
				principalId: f.principal.id,
				app: 'control',
				permissions: ['source.workspace.read', 'source.workspace.write'],
				scopeType: 'app',
				scopeValue: `workspace-${index}`,
			})
		}
		const exchanged = await f.exchange(await f.approve())
		expect(exchanged.status).toBe(400)
		const exchangeBody: unknown = await exchanged.json()
		expect(exchangeBody).toEqual({ error: 'invalid_grant' })
		const refreshed = await f.refresh(refreshable.refresh_token ?? '')
		expect(refreshed.status).toBe(400)
		const refreshBody: unknown = await refreshed.json()
		expect(refreshBody).toEqual({ error: 'invalid_grant' })
	})

	test('reusing a rotated refresh token revokes the whole family', async () => {
		const f = await fixture()
		const first = await tokenBody(await f.exchange(await f.approve()))
		const second = await tokenBody(await f.refresh(first.refresh_token ?? ''))
		expect((await f.refresh(first.refresh_token ?? '')).status).toBe(400)
		expect((await f.refresh(second.refresh_token ?? '')).status).toBe(400)
	})

	test('a revoked grant cannot refresh (RFC 7009)', async () => {
		const f = await fixture()
		const first = await tokenBody(await f.exchange(await f.approve()))
		const revoked = await f.post('/oauth/revoke', { client_id: f.clientId, token: first.refresh_token ?? '' })
		expect(revoked.status).toBe(200)
		expect((await f.refresh(first.refresh_token ?? '')).status).toBe(400)
	})

	test('revoking the access token revokes its grant', async () => {
		const f = await fixture()
		const first = await tokenBody(await f.exchange(await f.approve()))
		expect((await f.post('/oauth/revoke', { client_id: f.clientId, token: first.access_token })).status).toBe(200)
		expect((await f.refresh(first.refresh_token ?? '')).status).toBe(400)
	})

	test('ending the IAM session ends the grant', async () => {
		const f = await fixture()
		const first = await tokenBody(await f.exchange(await f.approve()))
		await f.services.repositories.sessions.revokeSessionById(f.sessionId)
		expect((await f.refresh(first.refresh_token ?? '')).status).toBe(400)
	})

	test('a disabled principal cannot redeem a code', async () => {
		const harness = createHarness()
		active = await oauthFixture(harness.repositories)
		const code = await active.approve()
		harness.sqlite.run('UPDATE principals SET disabled_at = 1 WHERE id = ?', [active.principal.id])
		expect((await active.exchange(code)).status).toBe(400)
	})
})

describe('OAUTH_CONFIG', () => {
	const valid = {
		clients: [{ provider: 'chatgpt', clientId: 'https://chatgpt.example.test/cimd', redirectUris: ['https://chatgpt.example.test/cb'] }],
		resources: [{ app: 'control', resource: RESOURCE, scopeGrants: [{ scope: 'authoring', permissions: [{ action: 'source.workspace.*' }] }] }],
	}

	test('absent or empty disables OAuth', () => {
		expect(parseOAuthConfig(undefined)).toBeNull()
		expect(parseOAuthConfig('')).toBeNull()
	})

	test('a valid config defaults the metadata URL to the client id', () => {
		expect(parseOAuthConfig(JSON.stringify(valid))?.clients[0]?.metadataUrl).toBe('https://chatgpt.example.test/cimd')
	})

	test('malformed JSON, unknown keys, non-HTTPS metadata and duplicates are refused', () => {
		expect(() => parseOAuthConfig('{')).toThrow()
		expect(() => parseOAuthConfig(JSON.stringify({ ...valid, admission: {} }))).toThrow()
		expect(() => parseOAuthConfig(JSON.stringify({ ...valid, clients: [{ ...valid.clients[0], metadataUrl: 'http://x.test/cimd' }] }))).toThrow()
		expect(() => parseOAuthConfig(JSON.stringify({ ...valid, resources: [...valid.resources, ...valid.resources] }))).toThrow()
		expect(() => parseOAuthConfig(JSON.stringify({ ...valid, clients: [] }))).toThrow()
	})
})

describe('narrowPermissions', () => {
	test('takes the narrower action and scope of each pair, and never adds what is not held', () => {
		const live = [
			{ action: 'source.*', scope: null, source: 'grant' as const },
			{ action: 'deploy.run', scope: { type: 'app', value: 'alpha' }, source: 'grant' as const },
		]
		expect(narrowPermissions(live, [{ action: 'source.workspace.read', scope: { type: 'app', value: 'alpha' } }])).toEqual([
			{ action: 'source.workspace.read', scope: { type: 'app', value: 'alpha' }, source: 'grant' },
		])
		expect(narrowPermissions(live, [{ action: 'deploy.*' }])).toEqual([{
			action: 'deploy.run',
			scope: { type: 'app', value: 'alpha' },
			source: 'grant',
		}])
		expect(narrowPermissions(live, [{ action: 'deploy.run', scope: { type: 'app', value: 'beta' } }])).toEqual([])
		expect(narrowPermissions(live, [{ action: 'admin.*' }])).toEqual([])
	})
})

describe('a resource token is never a native IAM credential', () => {
	const env = { ...SIGNING_ENV, FABRIKA_IAM_PROVISIONING_KEY: '' }

	async function resourceToken(f: Fixture): Promise<string> {
		return (await tokenBody(await f.exchange(await f.approve()))).access_token
	}

	test('the native verifier refuses it and the resource verifier refuses a native token', async () => {
		const f = await fixture()
		const signer = await getSigner(SIGNING_ENV)
		const token = await resourceToken(f)
		expect(await verifyAccessToken(signer, token, { issuer: ISSUER })).toBeNull()
		expect(await verifyAccessToken(signer, token, { issuer: ISSUER, audience: RESOURCE })).toBeNull()
		const now = Math.floor(Date.now() / 1000)
		const native = await signer.sign(buildAccessClaims({
			iss: ISSUER,
			app: 'control',
			subject: f.principal.id,
			type: 'user',
			label: f.principal.label,
			permissions: [],
			issuedAt: now,
			expiresAt: now + 60,
		}))
		expect(await verifyAccessToken(signer, native, { issuer: ISSUER, audience: 'control' })).not.toBeNull()
		expect(await verifyResourceAccessToken(signer, native, { issuer: ISSUER })).toBeNull()
	})

	test('management caller resolution refuses it as a credential', async () => {
		const f = await fixture()
		const token = await resourceToken(f)
		for (const app of ['control', RESOURCE]) {
			const resolution = await resolveCaller(f.services, env, { app, credential: token, requestId: 'r' })
			expect(resolution.ok).toBe(false)
		}
	})

	test('admin resolution refuses it as a bearer', async () => {
		const f = await fixture()
		// Even with the resource registered as an admin audience, the token is not an admin credential.
		const services = { ...f.services, config: { ...f.services.config, adminAudiences: new Set([RESOURCE, 'control']) } }
		const resolution = await resolveAdmin(services, env, { bearer: await resourceToken(f), requestId: 'r' })
		expect(resolution.ok).toBe(false)
	})
})

describe('mint races and client metadata fetches', () => {
	test('a grant revoked while authority resolves is not minted for', async () => {
		const f = await fixture()
		const code = await f.approve()
		const oauth = f.repositories.oauth
		const read = oauth.grant.bind(oauth)
		const spy = spyOn(oauth, 'grant').mockImplementationOnce(async (id) => {
			const row = await read(id)
			await oauth.revokeGrant(id, Math.floor(Date.now() / 1000))
			return row
		})
		const response = await f.exchange(code)
		spy.mockRestore()
		expect(response.status).toBe(400)
		const body: unknown = await response.json()
		expect(body).toEqual({ error: 'invalid_grant' })
	})

	test('concurrent requests share one fetch', async () => {
		const f = await fixture()
		const statuses = await Promise.all(Array.from({ length: 5 }, () => f.authorize().then((response) => response.status)))
		expect(statuses).toEqual([200, 200, 200, 200, 200])
		expect(f.fetched).toHaveLength(1)
	})

	test('a failed fetch is remembered briefly instead of retried per request', async () => {
		const f = await fixture({ failFetch: true })
		expect((await f.authorize()).status).toBe(400)
		expect((await f.authorize()).status).toBe(400)
		expect(f.fetched).toHaveLength(1)
	})
})
