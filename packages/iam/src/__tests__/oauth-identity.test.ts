import { createIam, type IamBinding } from '@fabrika/auth'
import { parseAccessClaims, PROXY_TOKEN_HEADER, RESOURCE_ACCESS_TOKEN_TYP } from '@fabrika/auth-core'
import { afterEach, describe, expect, test } from 'bun:test'
import { decodeJwt, decodeProtectedHeader } from 'jose'
import { parseOAuthConfig } from '../oauth-config'
import { DEFAULT_PLATFORM_AUDIENCES } from '../services'
import { getSigner } from '../signing'
import { createHarness } from './helpers/harness'
import { ISSUER, oauthFixture, REDIRECT_URI, RESOURCE, SIGNING_ENV, tokenBody } from './helpers/oauth'

const IDENTITY = { app: 'ops-tool', resource: 'https://ops.example.test' }
const IDENTITY_REQUEST = { resource: IDENTITY.resource, scope: 'identity' }

type Fixture = Awaited<ReturnType<typeof oauthFixture>>
let active: Fixture | null = null

let database: ReturnType<typeof createHarness>['sqlite'] | null = null

async function fixture(options: Parameters<typeof oauthFixture>[1] = {}): Promise<Fixture> {
	const harness = createHarness()
	database = harness.sqlite
	active = await oauthFixture(harness.repositories, options)
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

async function identityCode(f: Fixture): Promise<string> {
	const code = locationOf(await f.decide('approve', IDENTITY_REQUEST)).searchParams.get('code')
	if (code === null) throw new Error('consent did not issue a code')
	return code
}

/** What a platform service verifies an injected token with: the SDK over IAM's JWKS, for the profile it serves. */
async function platformVerifier(options: Parameters<typeof createIam>[1]) {
	const signer = await getSigner(SIGNING_ENV)
	const binding: IamBinding = {
		getJwks: () => Promise.resolve(signer.jwks()),
		listPrincipals: () => Promise.reject(new Error('not used')),
		audit: () => Promise.resolve(),
	}
	return createIam({ IAM: binding, FABRIKA_IAM_ISSUER: ISSUER }, options)
}

describe('an identity-only external client', () => {
	test('gets a token naming the person, with no permission, and a refresh keeps it so', async () => {
		const f = await fixture({ provider: 'external', identity: IDENTITY })
		// A grant at the identity app's own id must not reach the token either: IAM reads no grant for it.
		await f.repositories.grants.createGrant({ principalId: f.principal.id, app: IDENTITY.app, permissions: ['accounts.manage'] })

		const page = await f.authorize(IDENTITY_REQUEST)
		expect(page.status).toBe(200)
		const html = await page.text()
		expect(html).toContain('no permission')
		expect(html).not.toContain('accounts.manage')

		const exchanged = await f.exchange(await identityCode(f), { resource: IDENTITY.resource })
		expect(exchanged.status).toBe(200)
		const first = await tokenBody(exchanged)
		expect(first.scope).toBe('identity')
		expect(decodeProtectedHeader(first.access_token).typ).toBe(RESOURCE_ACCESS_TOKEN_TYP)
		const claims = parseAccessClaims(decodeJwt(first.access_token))
		expect(claims?.iss).toBe(ISSUER)
		expect(claims?.sub).toBe(f.principal.id)
		expect(claims?.aud).toBe(IDENTITY.resource)
		expect(claims?.ptype).toBe('user')
		expect(claims?.oauth?.app).toBe(IDENTITY.app)
		expect(claims?.oauth?.clientId).toBe(f.clientId)
		expect(claims?.perms).toEqual([])

		const rotated = await f.refresh(first.refresh_token ?? '', { resource: IDENTITY.resource })
		expect(rotated.status).toBe(200)
		const refreshed = parseAccessClaims(decodeJwt((await tokenBody(rotated)).access_token))
		expect(refreshed?.sub).toBe(f.principal.id)
		expect(refreshed?.perms).toEqual([])
	})

	test('is refused every registered resource and every scope but `identity`, with the error sent to its redirect', async () => {
		const f = await fixture({ provider: 'external', identity: IDENTITY })
		const target = locationOf(await f.authorize({ resource: RESOURCE, scope: 'authoring' }))
		expect(target.origin + target.pathname).toBe(REDIRECT_URI)
		expect(target.searchParams.get('error')).toBe('invalid_target')
		expect(locationOf(await f.decide('approve', { resource: RESOURCE })).searchParams.get('error')).toBe('invalid_target')
		expect(locationOf(await f.authorize({ ...IDENTITY_REQUEST, scope: 'authoring' })).searchParams.get('error')).toBe('invalid_scope')
		expect(locationOf(await f.authorize({ ...IDENTITY_REQUEST, scope: 'identity authoring' })).searchParams.get('error')).toBe('invalid_scope')
		// No scope is the `identity` scope.
		const withoutScope = new URLSearchParams({
			response_type: 'code',
			client_id: f.clientId,
			redirect_uri: REDIRECT_URI,
			resource: IDENTITY.resource,
			code_challenge: 'a'.repeat(43),
			code_challenge_method: 'S256',
		})
		const page = await f.call(new Request(`${ISSUER}/oauth/authorize?${withoutScope}`, { headers: { cookie: f.cookie } }))
		expect(page.status).toBe(200)
		expect(await page.text()).toContain('<code>identity</code>')
	})

	test('a code for its identity resource redeems for no other resource', async () => {
		const f = await fixture({ provider: 'external', identity: IDENTITY })
		expect((await f.exchange(await identityCode(f), { resource: RESOURCE })).status).toBe(400)
	})

	test('a grant for a registered resource given before the client was bound mints nothing after', async () => {
		const f = await fixture({ provider: 'external' })
		const authoring = await tokenBody(await f.exchange(await f.approve()))
		const client = f.config.clients[0]
		if (client === undefined) throw new Error('no client')
		f.config.clients[0] = { ...client, identity: IDENTITY }
		const refused = await f.refresh(authoring.refresh_token ?? '')
		expect(refused.status).toBe(400)
		expect(await refused.json()).toEqual({ error: 'invalid_grant' })
	})

	test("its token is refused by the console's and Operations' resources and by every application", async () => {
		const f = await fixture({ provider: 'external', identity: IDENTITY })
		const token = (await tokenBody(await f.exchange(await identityCode(f), { resource: IDENTITY.resource }))).access_token
		const request = new Request('https://console.example.test/api/rpc', { headers: { [PROXY_TOKEN_HEADER]: token } })
		const verifiers = await Promise.all([
			// Control's `/mcp` (`control/src/bun/mcp.ts`) and its RPC with the command-line client's resource.
			platformVerifier({ appId: 'vozka', tokenAudience: { kind: 'resource', app: 'vozka', resource: RESOURCE } }),
			platformVerifier({ appId: 'vozka', oauthResource: 'https://console.example.test/api/rpc' }),
			// Operations (`createOperationsIam`): the console's audience beside its OAuth resource.
			platformVerifier({ appId: 'vozka', oauthResource: 'https://console.example.test/operations/api/rpc' }),
			// An application accepts only its own native tokens, the identity app's id included.
			platformVerifier({ appId: 'notes@prod' }),
			platformVerifier({ appId: IDENTITY.app }),
		])
		for (const iam of verifiers) {
			expect(await iam.authenticate(request)).toEqual({ ok: false, reason: 'invalid_token', status: 401 })
		}
		// The positive control: the same SDK accepts it at the identity resource itself.
		const own = await platformVerifier({ appId: IDENTITY.app, tokenAudience: { kind: 'resource', app: IDENTITY.app, resource: IDENTITY.resource } })
		const accepted = await own.authenticate(request)
		expect(accepted.ok).toBe(true)
		if (accepted.ok) expect(accepted.context.can('accounts.manage')).toBe(false)
	})
})

describe('an external application that declares roles', () => {
	const ROLES = { ...IDENTITY, roles: [{ key: 'admin-ops', name: 'Administrator' }, { key: 'viewer', name: 'Viewer' }] }

	async function signIn(f: Fixture) {
		return f.exchange(await identityCode(f), { resource: IDENTITY.resource })
	}

	test('a person holding a role gets a token naming it and their mailbox, with no permission; a refresh names it again', async () => {
		const f = await fixture({ provider: 'external', identity: ROLES })
		const until = Math.floor(Date.now() / 1000) + 120
		await f.repositories.grants.createGrant({ principalId: f.principal.id, app: IDENTITY.app, roleKey: 'viewer', expiresAt: until })
		// Neither a role the application does not declare, nor a declared role held only in a scope value, is named.
		await f.repositories.grants.createGrant({ principalId: f.principal.id, app: IDENTITY.app, roleKey: 'other' })
		await f.repositories.grants.createGrant({
			principalId: f.principal.id,
			app: IDENTITY.app,
			roleKey: 'admin-ops',
			scopeType: 'team',
			scopeValue: 'a',
		})

		const html = await (await f.authorize(IDENTITY_REQUEST)).text()
		expect(html).toContain('the roles you hold in <strong>ops-tool</strong>')
		const exchanged = await signIn(f)
		expect(exchanged.status).toBe(200)
		const first = await tokenBody(exchanged)
		const claims = parseAccessClaims(decodeJwt(first.access_token))
		expect(claims?.oauth?.roles).toEqual(['viewer'])
		expect(claims?.email).toBe(f.principal.email ?? '')
		expect(claims?.perms).toEqual([])
		// The token ends when the role's grant does.
		expect(claims?.exp).toBeLessThanOrEqual(until)

		await f.repositories.grants.createGrant({ principalId: f.principal.id, app: IDENTITY.app, roleKey: 'admin-ops' })
		const refreshed = parseAccessClaims(
			decodeJwt((await tokenBody(await f.refresh(first.refresh_token ?? '', { resource: IDENTITY.resource }))).access_token),
		)
		expect(refreshed?.oauth?.roles).toEqual(['admin-ops', 'viewer'])
		expect(refreshed?.perms).toEqual([])
	})

	test('a person holding no role is refused at sign-in, with access_denied sent to the client', async () => {
		const f = await fixture({ provider: 'external', identity: ROLES })
		const shown = locationOf(await f.authorize(IDENTITY_REQUEST))
		expect(shown.origin + shown.pathname).toBe(REDIRECT_URI)
		expect(shown.searchParams.get('error')).toBe('access_denied')
		const decided = locationOf(await f.decide('approve', IDENTITY_REQUEST))
		expect(decided.searchParams.get('error')).toBe('access_denied')
		expect(decided.searchParams.get('code')).toBeNull()
	})

	test('removing the role ends the sign-in at the next refresh', async () => {
		const f = await fixture({ provider: 'external', identity: ROLES })
		const grant = await f.repositories.grants.createGrant({ principalId: f.principal.id, app: IDENTITY.app, roleKey: 'admin-ops' })
		const first = await tokenBody(await signIn(f))
		expect(parseAccessClaims(decodeJwt(first.access_token))?.oauth?.roles).toEqual(['admin-ops'])
		await f.repositories.grants.deleteGrant(grant.id)
		const refused = await f.refresh(first.refresh_token ?? '', { resource: IDENTITY.resource })
		expect(refused.status).toBe(400)
		expect(await refused.json()).toEqual({ error: 'invalid_grant' })
	})

	test('a code issued while the person held a role redeems for nothing once it is removed', async () => {
		const f = await fixture({ provider: 'external', identity: ROLES })
		const grant = await f.repositories.grants.createGrant({ principalId: f.principal.id, app: IDENTITY.app, roleKey: 'admin-ops' })
		const code = await identityCode(f)
		await f.repositories.grants.deleteGrant(grant.id)
		expect((await f.exchange(code, { resource: IDENTITY.resource })).status).toBe(400)
	})

	test('a cross-app grant and a grant of the built-in admin name no role', async () => {
		const f = await fixture({ provider: 'external', identity: ROLES })
		await f.repositories.grants.createGrant({ principalId: f.principal.id, app: null, roleKey: 'viewer' })
		await f.repositories.grants.createGrant({ principalId: f.principal.id, app: IDENTITY.app, roleKey: 'admin' })
		expect(locationOf(await f.authorize(IDENTITY_REQUEST)).searchParams.get('error')).toBe('access_denied')
	})

	test('an external principal holds no role of it, a grant written around the locks included', async () => {
		const f = await fixture({ provider: 'external', identity: ROLES })
		await f.repositories.grants.createGrant({ principalId: f.principal.id, app: IDENTITY.app, roleKey: 'viewer' })
		const first = await tokenBody(await signIn(f))
		// The grant locks refuse this grant for an external principal; resolution is the lock that remains.
		database?.run("UPDATE principals SET affiliation = 'external' WHERE id = ?", [f.principal.id])
		expect((await f.refresh(first.refresh_token ?? '', { resource: IDENTITY.resource })).status).toBe(400)
		expect(locationOf(await f.authorize(IDENTITY_REQUEST)).searchParams.get('error')).toBe('access_denied')
	})

	test('without declared roles the token names none and every active user signs in', async () => {
		const f = await fixture({ provider: 'external', identity: IDENTITY })
		const claims = parseAccessClaims(decodeJwt((await tokenBody(await signIn(f))).access_token))
		expect(claims?.oauth?.roles).toBeUndefined()
		expect(claims?.email).toBe(f.principal.email ?? '')
	})
})

describe('OAUTH_CONFIG with an identity-only client', () => {
	const client = {
		provider: 'external',
		clientId: 'https://ops.example.test/oauth/client.json',
		redirectUris: ['https://ops.example.test/oauth/callback'],
		identity: IDENTITY,
	}
	const resources = [{ app: 'vozka', resource: RESOURCE, scopeGrants: [{ scope: 'authoring', permissions: [{ action: 'source.workspace.read' }] }] }]
	const parse = (changes: Record<string, unknown>, audiences: ReadonlySet<string> = DEFAULT_PLATFORM_AUDIENCES) =>
		parseOAuthConfig(JSON.stringify({ clients: [{ ...client, ...changes }], resources }), audiences)

	test('parses the binding', () => {
		expect(parse({})?.clients[0]?.identity).toEqual(IDENTITY)
		const roles = [{ key: 'admin-ops', name: 'Administrator' }]
		expect(parse({ identity: { ...IDENTITY, roles } })?.clients[0]?.identity).toEqual({ ...IDENTITY, roles })
	})

	test('refuses a malformed role list: empty, a built-in key, a repeated key, an unknown field', () => {
		const malformed = 'is not a valid managed client'
		const withRoles = (roles: unknown) => parse({ identity: { ...IDENTITY, roles } })
		expect(() => withRoles([])).toThrow(malformed)
		expect(() => withRoles([{ key: 'admin', name: 'Administrator' }])).toThrow(malformed)
		expect(() => withRoles([{ key: 'ops', name: 'A' }, { key: 'ops', name: 'B' }])).toThrow(malformed)
		expect(() => withRoles([{ key: 'ops', name: 'A', permissions: ['x'] }])).toThrow(malformed)
		expect(() => withRoles([{ key: 'Ops', name: 'A' }])).toThrow(malformed)
		expect(() => withRoles([{ key: 'ops', name: '' }])).toThrow(malformed)
	})

	test("refuses it on another client kind, with a malformed app or resource, or on an installation service's app or resource", () => {
		const malformed = 'is not a valid managed client'
		const reserved = "names an installation service's app or resource"
		expect(() => parse({ provider: 'claude' })).toThrow(malformed)
		expect(() => parse({ identity: { ...IDENTITY, app: 'notes@prod' } })).toThrow(malformed)
		expect(() => parse({ identity: { ...IDENTITY, app: '*' } })).toThrow(malformed)
		expect(() => parse({ identity: { ...IDENTITY, app: 'a'.repeat(64) } })).toThrow(malformed)
		expect(() => parse({ identity: { ...IDENTITY, resource: 'http://ops.example.test' } })).toThrow(malformed)
		expect(() => parse({ identity: { ...IDENTITY, extra: true } })).toThrow(malformed)
		expect(() => parse({ identity: { ...IDENTITY, app: 'operations' } })).toThrow(reserved)
		expect(() => parse({ identity: { ...IDENTITY, resource: RESOURCE } })).toThrow(reserved)
		expect(() => parse({}, new Set([...DEFAULT_PLATFORM_AUDIENCES, IDENTITY.app]))).toThrow(reserved)
		// A registered resource's app that is no platform audience is refused on its own.
		const registered = [{ ...resources[0], app: 'tools' }]
		const config = { clients: [{ ...client, identity: { ...IDENTITY, app: 'tools' } }], resources: registered }
		expect(() => parseOAuthConfig(JSON.stringify(config), DEFAULT_PLATFORM_AUDIENCES)).toThrow(reserved)
	})
})
