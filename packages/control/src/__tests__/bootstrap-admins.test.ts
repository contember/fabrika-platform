import { type AuthContext, type IamRpc, PROXY_TOKEN_HEADER } from '@fabrika/auth'
import { buildResourceAccessClaims, OAUTH_CLI_CLIENT_ID, RESOURCE_ACCESS_TOKEN_TYP } from '@fabrika/auth-core'
import { CONTROL_ACTIONS } from '@fabrika/control-contract'
import { describe, expect, test } from 'bun:test'
import { controlAuthenticator, parseBootstrapAdmins } from '../iam'

/** What a credentialed row's handler gets: the caller, or the response it answers instead of running. */
async function runMiddleware(env: Parameters<typeof controlAuthenticator>[0], request: Request) {
	const caller = await controlAuthenticator(env)(request)
	const auth: AuthContext | undefined = caller.ok ? caller.auth : undefined
	return { auth, nextCalled: caller.ok, response: caller.ok ? new Response('ok') : caller.response }
}

const ISSUER = 'https://iam.test'
const serviceKeys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const servicePublicJwk = await crypto.subtle.exportKey('jwk', serviceKeys.publicKey)

function requiredKeyPart(value: string | undefined, name: string): string {
	if (value === undefined) throw new Error(`generated service test key is missing ${name}`)
	return value
}

const servicePublicKey = {
	kty: requiredKeyPart(servicePublicJwk.kty, 'kty'),
	crv: requiredKeyPart(servicePublicJwk.crv, 'crv'),
	x: requiredKeyPart(servicePublicJwk.x, 'x'),
	y: requiredKeyPart(servicePublicJwk.y, 'y'),
	kid: 'service-test',
	alg: 'ES256',
	use: 'sig',
}

function base64Url(value: string | Uint8Array): string {
	const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** An IAM-shaped access token, the way the proxy would inject it. */
async function token(input: { label: string; ptype: 'user' | 'service'; actions?: readonly string[] }): Promise<string> {
	const now = Math.floor(Date.now() / 1000)
	const header = base64Url(JSON.stringify({ alg: 'ES256', kid: 'service-test', typ: 'JWT' }))
	const payload = base64Url(JSON.stringify({
		iss: ISSUER,
		aud: 'vozka',
		sub: `${input.ptype}-one`,
		iat: now,
		exp: now + 300,
		perms: (input.actions ?? ['deploy.read']).map((action) => ({ action, scope: null, source: 'grant' })),
		ptype: input.ptype,
		label: input.label,
	}))
	const signingInput = `${header}.${payload}`
	const signature = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' },
		serviceKeys.privateKey,
		new TextEncoder().encode(signingInput),
	)
	return `${signingInput}.${base64Url(new Uint8Array(signature))}`
}

/** A command-line client's resource token for the console's RPC, as IAM mints one after a device grant. */
async function resourceToken(input: { label: string; actions: readonly string[]; resource?: string }): Promise<string> {
	const now = Math.floor(Date.now() / 1000)
	const header = base64Url(JSON.stringify({ alg: 'ES256', kid: 'service-test', typ: RESOURCE_ACCESS_TOKEN_TYP }))
	const payload = base64Url(JSON.stringify(buildResourceAccessClaims({
		iss: ISSUER,
		app: 'vozka',
		resource: input.resource ?? 'https://control.test/api/rpc',
		subject: 'user-one',
		label: input.label,
		permissions: input.actions.map((action) => ({ action, scope: null, source: 'grant' })),
		issuedAt: now,
		expiresAt: now + 300,
		clientId: OAUTH_CLI_CLIENT_ID,
		scopes: ['read:alpha'],
		grantId: 'grant-1',
		tokenId: crypto.randomUUID(),
	})))
	const signingInput = `${header}.${payload}`
	const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, serviceKeys.privateKey, new TextEncoder().encode(signingInput))
	return `${signingInput}.${base64Url(new Uint8Array(signature))}`
}

const serviceIam: IamRpc = {
	inspectDeviceAuthorization: () => Promise.resolve({ ok: false, reason: 'not_allowed' }),
	approveDeviceAuthorization: () => Promise.resolve({ ok: false, reason: 'not_allowed' }),
	denyDeviceAuthorization: () => Promise.resolve({ ok: false, reason: 'not_allowed' }),
	listOwnDeviceAuthorizations: () => Promise.resolve({ ok: false, reason: 'not_allowed' }),
	mintToken: () => Promise.resolve({ ok: false, reason: 'no_session' }),
	mintFromKey: () => Promise.resolve({ ok: false, reason: 'invalid_key' }),
	issueKey: () => Promise.resolve({ ok: false, reason: 'not_allowed' }),
	getJwks: () =>
		Promise.resolve({
			keys: [servicePublicKey],
		}),
	audit: () => Promise.resolve(),
	listPrincipals: () => Promise.resolve({ ok: false, reason: 'not_allowed' }),
	revokeKey: () => Promise.resolve({ ok: false, reason: 'not_found' }),
}

describe('parseBootstrapAdmins', () => {
	test('parses a JSON array of emails', () => {
		expect([...parseBootstrapAdmins('["a@x.test","b@x.test"]')]).toEqual(['a@x.test', 'b@x.test'])
	})

	test('empty, unset, malformed, and non-array values fail closed', () => {
		expect(parseBootstrapAdmins(undefined).size).toBe(0)
		expect(parseBootstrapAdmins('').size).toBe(0)
		expect(parseBootstrapAdmins('[]').size).toBe(0)
		expect(parseBootstrapAdmins('not json').size).toBe(0)
		expect(parseBootstrapAdmins('{"a":1}').size).toBe(0)
		expect([...parseBootstrapAdmins('["ok@x.test", 42, null]')]).toEqual(['ok@x.test'])
	})
})

/** The one env shape there is: the IAM binding plus the issuer its tokens are verified against. */
const ENV = { ENVIRONMENT: 'stage', IAM: serviceIam, FABRIKA_IAM_ISSUER: ISSUER } as const

describe('controlAuthenticator bootstrap semantics', () => {
	test('the provisioning key buys nothing here — machine access is an IAM-issued service key', async () => {
		// The hatch is deleted, not disabled. Behind the proxy it was already dead: `/api/*` is gated
		// `service`, the proxy resolves a `px_` bearer by asking IAM to mint from it, and the provisioning
		// key has no `credentials` row — so `mintFromKey` answered `invalid_key` and control never saw the
		// bearer. What remains is the ordinary token path, which a raw bearer does not satisfy.
		const key = 'px_provision_secret_key_value'
		const result = await runMiddleware(
			ENV,
			new Request('https://control.test/api/apps', { headers: { Authorization: `Bearer ${key}` } }),
		)

		expect(result.nextCalled).toBe(false)
		expect(result.response.status).toBe(401)
		expect(result.auth).toBeUndefined()
	})

	test('a listed user is elevated while a non-listed user keeps their original permissions', async () => {
		const admins = '["viewer@fabrika.test"]'
		const listed = await runMiddleware(
			{ ...ENV, FABRIKA_CONTROL_BOOTSTRAP_ADMINS: admins },
			new Request('https://control.test/api/apps', {
				headers: { [PROXY_TOKEN_HEADER]: await token({ label: 'viewer@fabrika.test', ptype: 'user' }) },
			}),
		)
		const notListed = await runMiddleware(
			{ ...ENV, FABRIKA_CONTROL_BOOTSTRAP_ADMINS: admins },
			new Request('https://control.test/api/apps', {
				headers: { [PROXY_TOKEN_HEADER]: await token({ label: 'operator@fabrika.test', ptype: 'user' }) },
			}),
		)

		expect(listed.nextCalled).toBe(true)
		expect(listed.auth?.principal?.type).toBe('user')
		for (const action of Object.values(CONTROL_ACTIONS)) {
			expect(listed.auth?.can(action)).toBe(true)
		}
		expect(notListed.nextCalled).toBe(true)
		expect(notListed.auth?.can(CONTROL_ACTIONS.DEPLOY_READ)).toBe(true)
		expect(notListed.auth?.can(CONTROL_ACTIONS.APP_MANAGE)).toBe(false)
	})

	test("the command-line client's token is accepted on the RPC beside native ones, and a listed person's token is not elevated", async () => {
		const env = { ...ENV, FABRIKA_CONTROL_DOMAIN: 'https://control.test', FABRIKA_CONTROL_BOOTSTRAP_ADMINS: '["viewer@fabrika.test"]' }
		const call = async (oauthPath: string | undefined, bearer: string) => {
			const caller = await controlAuthenticator(env, oauthPath)(
				new Request('https://control.test/api/rpc', { headers: { [PROXY_TOKEN_HEADER]: bearer } }),
			)
			return caller.ok ? caller.auth : caller.response.status
		}
		const delegated = await call('/api/rpc', await resourceToken({ label: 'viewer@fabrika.test', actions: [CONTROL_ACTIONS.DEPLOY_READ] }))
		if (typeof delegated === 'number') throw new Error(`expected the token accepted, got ${delegated}`)
		expect(delegated.oauth?.clientId).toBe(OAUTH_CLI_CLIENT_ID)
		expect(delegated.can(CONTROL_ACTIONS.DEPLOY_READ)).toBe(true)
		expect(delegated.can(CONTROL_ACTIONS.APP_MANAGE)).toBe(false)

		// The person's own session token is still elevated on the same row.
		const native = await call('/api/rpc', await token({ label: 'viewer@fabrika.test', ptype: 'user' }))
		if (typeof native === 'number') throw new Error(`expected the token accepted, got ${native}`)
		expect(native.can(CONTROL_ACTIONS.APP_MANAGE)).toBe(true)

		// Without the row's resource, or for another resource, the token is refused.
		expect(await call(undefined, await resourceToken({ label: 'viewer@fabrika.test', actions: ['*'] }))).toBe(401)
		expect(await call('/api/rpc', await resourceToken({ label: 'x', actions: ['*'], resource: 'https://control.test/operations/api/rpc' }))).toBe(401)
	})

	test('bootstrap elevation does not apply to a service caller, however it is listed', async () => {
		const label = 'service@fabrika.test'
		const service = await runMiddleware(
			{ ...ENV, FABRIKA_CONTROL_BOOTSTRAP_ADMINS: `["${label}"]` },
			new Request('https://control.test/api/apps', { headers: { [PROXY_TOKEN_HEADER]: await token({ label, ptype: 'service' }) } }),
		)

		expect(service.nextCalled).toBe(true)
		expect(service.auth?.principal?.type).toBe('service')
		expect(service.auth?.can(CONTROL_ACTIONS.DEPLOY_READ)).toBe(true)
		expect(service.auth?.can(CONTROL_ACTIONS.APP_MANAGE)).toBe(false)
	})

	test('elevation keys on the VERIFIED label, so a listed email nobody presented elevates nobody', async () => {
		const result = await runMiddleware(
			{ ...ENV, FABRIKA_CONTROL_BOOTSTRAP_ADMINS: '["missing@fabrika.test"]' },
			new Request('https://control.test/api/apps', {
				headers: { [PROXY_TOKEN_HEADER]: await token({ label: 'viewer@fabrika.test', ptype: 'user' }) },
			}),
		)

		expect(result.nextCalled).toBe(true)
		expect(result.auth?.can(CONTROL_ACTIONS.DEPLOY_READ)).toBe(true)
		expect(result.auth?.can(CONTROL_ACTIONS.APP_MANAGE)).toBe(false)
	})

	test('an /api/* request with no proxy-injected token is refused', async () => {
		const result = await runMiddleware(ENV, new Request('https://control.test/api/apps'))

		expect(result.nextCalled).toBe(false)
		expect(result.response.status).toBe(401)
		expect(result.auth).toBeUndefined()
	})

	test('a token the proxy did not sign is refused — the header is not trusted blindly', async () => {
		const result = await runMiddleware(
			ENV,
			new Request('https://control.test/api/apps', { headers: { [PROXY_TOKEN_HEADER]: 'not.a.jwt' } }),
		)

		expect(result.nextCalled).toBe(false)
		expect(result.response.status).toBe(401)
	})
})
