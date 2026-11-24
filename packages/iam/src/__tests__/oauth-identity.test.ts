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
	})

	test("refuses it on another client kind, with a malformed app or resource, or on an installation service's app or resource", () => {
		expect(() => parse({ provider: 'claude' })).toThrow()
		expect(() => parse({ identity: { ...IDENTITY, app: 'notes@prod' } })).toThrow()
		expect(() => parse({ identity: { ...IDENTITY, app: '*' } })).toThrow()
		expect(() => parse({ identity: { ...IDENTITY, resource: 'http://ops.example.test' } })).toThrow()
		expect(() => parse({ identity: { ...IDENTITY, extra: true } })).toThrow()
		expect(() => parse({ identity: { ...IDENTITY, app: 'operations' } })).toThrow()
		expect(() => parse({ identity: { ...IDENTITY, resource: RESOURCE } })).toThrow()
		expect(() => parse({}, new Set([...DEFAULT_PLATFORM_AUDIENCES, IDENTITY.app]))).toThrow()
	})
})
