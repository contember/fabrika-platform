import { OAUTH_CLI_CLIENT_ID, parseAccessClaims } from '@fabrika/auth-core'
import { parseOAuthResourceDto, resolveOAuthAuthorizationScopes } from '@fabrika/iam-contract'
import { uuidv7 } from '@fabrika/platform'
import { afterEach, describe, expect, test } from 'bun:test'
import { decodeJwt } from 'jose'
import type { OAuthConfig } from '../oauth-config'
import { handleOAuth } from '../oauth-http'
import { unixNow } from '../repositories/sql'
import { generateToken, hashToken } from '../secret'
import type { Services } from '../services'
import { createHarness } from './helpers/harness'
import { ISSUER, oauthFixture, RESOURCE, SIGNING_ENV, tokenBody } from './helpers/oauth'

const SECOND_RESOURCE = 'https://control.example.test/api/rpc'
const CLI_CLIENT = OAUTH_CLI_CLIENT_ID

type Fixture = Awaited<ReturnType<typeof oauthFixture>>
let active: Fixture | null = null

afterEach(() => {
	active?.restoreFetch()
	active = null
})

/** The shared fixture with a parameterized `deploy` scope on both resources, served by `services`. */
async function fixture() {
	const f = await oauthFixture(createHarness().repositories)
	active = f
	const scopeGrants = [
		{ scope: 'authoring', permissions: [{ action: 'source.workspace.*' }] },
		{ scope: 'deploy', parameter: 'app', permissions: [{ action: 'source.workspace.read' }, { action: 'deploy.run' }] },
	]
	const config: OAuthConfig = {
		clients: f.config.clients,
		resources: [
			{ app: 'control', resource: RESOURCE, defaultScopes: ['authoring'], scopeGrants },
			{ app: 'control', resource: SECOND_RESOURCE, scopeGrants },
		],
	}
	const services: Services = { ...f.services, config: { ...f.services.config, oauth: config } }
	const call = (request: Request) => handleOAuth(request, services, SIGNING_ENV, 'req-oauth')
	const post = (path: string, form: Record<string, string>) =>
		call(
			new Request(`${ISSUER}${path}`, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams(form),
			}),
		)

	/** A CLI grant for both resources, as the device flow records one, and its first refresh token. */
	async function cliGrant(scopes: string[], resources: string[] = [RESOURCE, SECOND_RESOURCE]): Promise<{ grantId: string; refreshToken: string }> {
		const grantId = uuidv7()
		const now = unixNow()
		await f.repositories.oauth.createGrant(
			{
				id: grantId,
				principal_id: f.principal.id,
				session_id: f.sessionId,
				client_id: CLI_CLIENT,
				app: 'control',
				resource: resources[0] ?? RESOURCE,
				resources: JSON.stringify(resources),
				scopes: JSON.stringify(scopes),
				created_at: now,
				expires_at: now + 3600,
				revoked_at: null,
			},
			{ token_hash: await hashToken(generateToken()), redirect_uri: 'urn:fabrika:unused', challenge: 'unused', expires_at: now },
		)
		const refreshToken = generateToken()
		await f.repositories.oauth.insertRefreshToken({ token_hash: await hashToken(refreshToken), grant_id: grantId, expires_at: now + 3600 })
		return { grantId, refreshToken }
	}

	function refresh(refreshToken: string, resource: string, clientId = CLI_CLIENT, extra: Record<string, string> = {}) {
		return post('/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken, resource, ...extra })
	}

	return { f, services, call, post, cliGrant, refresh }
}

function permissionsOf(token: string) {
	const claims = parseAccessClaims(decodeJwt(token))
	if (claims === null) throw new Error('the token does not parse')
	return claims
}

describe('a parameterized scope', () => {
	test('narrows its actions to the value it names and drops what the person holds elsewhere', async () => {
		const { f, cliGrant, refresh } = await fixture()
		// Beside the fixture's grants at app `alpha`, the person holds `deploy.run` everywhere.
		await f.repositories.grants.createGrant({ principalId: f.principal.id, app: 'control', permissions: ['deploy.run'] })
		const alpha = await cliGrant(['deploy:alpha'])
		const minted = await tokenBody(await refresh(alpha.refreshToken, RESOURCE))
		expect(minted.scope).toBe('deploy:alpha')
		const claims = permissionsOf(minted.access_token)
		expect(claims.perms.map((entry) => `${entry.action}@${entry.scope?.type}:${entry.scope?.value}`).sort()).toEqual([
			'deploy.run@app:alpha',
			'source.workspace.read@app:alpha',
		])
		expect(claims.sub).toBe(f.principal.id)

		// At app `beta` only the global grant reaches the token, narrowed to `beta`.
		const beta = await cliGrant(['deploy:beta'])
		const betaClaims = permissionsOf((await tokenBody(await refresh(beta.refreshToken, RESOURCE))).access_token)
		expect(betaClaims.perms.map((entry) => `${entry.action}@${entry.scope?.type}:${entry.scope?.value}`)).toEqual(['deploy.run@app:beta'])
	})

	test('is refused bare, and a value is refused on a scope that takes none', () => {
		const resource = {
			app: 'control',
			resource: RESOURCE,
			scopeGrants: [
				{ scope: 'authoring', permissions: [{ action: 'source.workspace.*' }] },
				{ scope: 'deploy', parameter: 'app', permissions: [{ action: 'deploy.run' }] },
			],
		}
		expect(resolveOAuthAuthorizationScopes('deploy:alpha authoring', resource)).toEqual(['deploy:alpha', 'authoring'])
		expect(resolveOAuthAuthorizationScopes('deploy', resource)).toBeNull()
		expect(resolveOAuthAuthorizationScopes('deploy:', resource)).toBeNull()
		expect(resolveOAuthAuthorizationScopes('deploy:a/b', resource)).toBeNull()
		expect(resolveOAuthAuthorizationScopes('authoring:alpha', resource)).toBeNull()
	})

	test('a resource declaration refuses a parameter beside a scoped permission and a parameterized default scope', () => {
		const base = { app: 'control', resource: RESOURCE }
		expect(parseOAuthResourceDto({
			...base,
			scopeGrants: [{ scope: 'deploy', parameter: 'app', permissions: [{ action: 'deploy.run', scope: { type: 'app', value: 'beta' } }] }],
		})).toBeNull()
		expect(parseOAuthResourceDto({
			...base,
			defaultScopes: ['deploy'],
			scopeGrants: [{ scope: 'deploy', parameter: 'app', permissions: [{ action: 'deploy.run' }] }],
		})).toBeNull()
		expect(parseOAuthResourceDto({ ...base, scopeGrants: [{ scope: 'deploy:x', permissions: [{ action: 'deploy.run' }] }] })).toBeNull()
		expect(parseOAuthResourceDto({ ...base, scopeGrants: [{ scope: 'deploy', parameter: 'a:b', permissions: [{ action: 'deploy.run' }] }] }))
			.toBeNull()
	})

	test('a resource declaration refuses an unknown key, so a misspelled parameter cannot leave a scope unnarrowed', () => {
		const base = { app: 'control', resource: RESOURCE }
		expect(parseOAuthResourceDto({ ...base, scopeGrants: [{ scope: 'deploy', paramter: 'app', permissions: [{ action: 'deploy.run' }] }] }))
			.toBeNull()
		expect(parseOAuthResourceDto({ ...base, scopeGrants: [{ scope: 'deploy', permissions: [{ action: 'deploy.run', scop: null }] }] })).toBeNull()
		expect(parseOAuthResourceDto({
			...base,
			scopeGrants: [{ scope: 'deploy', permissions: [{ action: 'deploy.run', scope: { type: 'app', value: 'a', extra: 1 } }] }],
		})).toBeNull()
	})
})

describe('a grant for several resources', () => {
	test('mints a token for each of its resources and for no other', async () => {
		const { cliGrant, refresh } = await fixture()
		const grant = await cliGrant(['deploy:alpha'])
		const first = await tokenBody(await refresh(grant.refreshToken, SECOND_RESOURCE))
		const claims = permissionsOf(first.access_token)
		expect(claims.aud).toBe(SECOND_RESOURCE)
		const second = await tokenBody(await refresh(first.refresh_token ?? '', RESOURCE))
		expect(permissionsOf(second.access_token).aud).toBe(RESOURCE)

		const elsewhere = await refresh(second.refresh_token ?? '', 'https://control.example.test/other')
		expect(elsewhere.status).toBe(400)
		expect(await elsewhere.json()).toEqual({ error: 'invalid_grant' })
	})

	test('a single-resource grant still refuses a token for another resource the server knows', async () => {
		const { cliGrant, refresh } = await fixture()
		const grant = await cliGrant(['deploy:alpha'], [RESOURCE])
		const refused = await refresh(grant.refreshToken, SECOND_RESOURCE)
		expect(await refused.json()).toEqual({ error: 'invalid_grant' })
	})
})

describe('the CLI client', () => {
	test('refreshes and revokes without a key, and a rotated token presented again revokes the grant', async () => {
		const { f, cliGrant, refresh, post } = await fixture()
		const grant = await cliGrant(['deploy:alpha'])
		const rotated = await tokenBody(await refresh(grant.refreshToken, RESOURCE))
		expect(rotated.refresh_token).toBeString()

		const replay = await refresh(grant.refreshToken, RESOURCE)
		expect(await replay.json()).toEqual({ error: 'invalid_grant' })
		expect((await f.repositories.oauth.grant(grant.grantId))?.revoked_at).not.toBeNull()

		const other = await cliGrant(['deploy:alpha'])
		const revoked = await post('/oauth/revoke', { client_id: CLI_CLIENT, token: other.refreshToken })
		expect(revoked.status).toBe(200)
		expect((await f.repositories.oauth.grant(other.grantId))?.revoked_at).not.toBeNull()
	})

	test('is refused with a client assertion, for an authorization code, and at the authorization endpoint', async () => {
		const { f, cliGrant, refresh } = await fixture()
		const grant = await cliGrant(['deploy:alpha'])
		const asserted = await refresh(grant.refreshToken, RESOURCE, CLI_CLIENT, {
			client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
			client_assertion: 'a.b.c',
		})
		expect(asserted.status).toBe(401)

		// Refused before the code is spent: the client it was issued to still redeems it.
		const code = await f.approve()
		const redeemed = await f.exchange(code, { client_id: CLI_CLIENT })
		expect(await redeemed.json()).toEqual({ error: 'unauthorized_client' })
		expect((await f.exchange(code)).status).toBe(200)

		// A complete, otherwise valid authorization request is refused for the CLI client, never redirected.
		const authorize = await f.authorize({ client_id: CLI_CLIENT })
		expect(authorize.status).toBe(400)
		expect(authorize.headers.get('location')).toBeNull()
	})

	test("neither refreshes another client's grant nor has its own grant revoked by another client", async () => {
		const { f, cliGrant, refresh, post } = await fixture()
		const managed = await tokenBody(await f.exchange(await f.approve()))
		const crossed = await refresh(managed.refresh_token ?? '', RESOURCE)
		expect(await crossed.json()).toEqual({ error: 'invalid_grant' })

		const grant = await cliGrant(['deploy:alpha'])
		const foreign = await post('/oauth/revoke', { client_id: f.clientId, token: grant.refreshToken })
		expect(foreign.status).toBe(200)
		expect((await f.repositories.oauth.grant(grant.grantId))?.revoked_at).toBeNull()
		expect((await refresh(grant.refreshToken, RESOURCE)).status).toBe(200)
	})
})
