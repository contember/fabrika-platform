import { buildAccessClaims, type Jwks, type PermissionEntry, PROXY_TOKEN_HEADER, type Scope } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { exportJWK, generateKeyPair, type KeyLike, SignJWT } from 'jose'
import { anonymousContext, createIam, type IamEnv, makeDevContext, type PersonaSpec } from '../iam'
import { IamRpcStub } from './stub'

const ISSUER = 'https://propustka.test'
const APP = 'example-app'

// Two ES256 keys for the suite: `k1` is what the stub serves, `k2` is the rotated-in key.
const { publicKey, privateKey } = await generateKeyPair('ES256')
const { publicKey: rotatedPublic, privateKey: rotatedPrivate } = await generateKeyPair('ES256')

async function jwk(key: KeyLike, kid: string): Promise<Jwks['keys'][number]> {
	const exported = await exportJWK(key)
	return { kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y, kid, alg: 'ES256', use: 'sig' }
}

const K1 = await jwk(publicKey, 'k1')
const K2 = await jwk(rotatedPublic, 'k2')
const JWKS: Jwks = { keys: [K1] }

const now = () => Math.floor(Date.now() / 1000)

interface SignOptions {
	key?: KeyLike
	kid?: string
	iss?: string
	aud?: string
	ttl?: number
	perms?: PermissionEntry[]
	anonymous?: true
}

async function sign(opts: SignOptions = {}): Promise<string> {
	const claims = buildAccessClaims({
		iss: opts.iss ?? ISSUER,
		app: opts.aud ?? APP,
		subject: opts.anonymous === true ? 'cred-1' : 'user-1',
		...(opts.anonymous === true ? {} : { type: 'user' as const }),
		label: opts.anonymous === true ? 'share' : 'a@b.cz',
		permissions: opts.perms ?? PERMS,
		issuedAt: now() - 60,
		expiresAt: now() + (opts.ttl ?? 3600),
	})
	return new SignJWT({ ...claims }).setProtectedHeader({ alg: 'ES256', kid: opts.kid ?? 'k1' }).sign(opts.key ?? privateKey)
}

const PERMS: PermissionEntry[] = [{ action: 'demo.read', scope: null, source: 'grant' }]

const PERSONAS: Record<string, PersonaSpec> = {
	'admin@x.test': { id: 'p-admin', label: 'admin@x.test', type: 'user', permissions: [{ action: '*', scope: null }] },
	'scoped@x.test': {
		id: 'p-scoped',
		label: 'scoped@x.test',
		type: 'user',
		permissions: [{ action: 'project.read', scope: { type: 'project', value: 'p1' } }],
	},
}

const offLocalEnv = (stub: IamRpcStub): IamEnv => ({ IAM: stub, FABRIKA_IAM_URL: ISSUER, FABRIKA_APP_ID: APP })
const devEnv: IamEnv = { DEV: 'true', ENVIRONMENT: 'local', FABRIKA_APP_ID: APP }

/** A request carrying the token the proxy injected. */
function proxied(token: string, url = 'https://app/page'): Request {
	return new Request(url, { headers: { [PROXY_TOKEN_HEADER]: token } })
}

// ── createIam ────────────────────────────────────────────────────────────────────

describe('createIam', () => {
	test('off-local builds an IamClient-backed Iam and delegates listPrincipals', async () => {
		const stub = new IamRpcStub({ listPrincipals: { ok: true, principals: [] }, jwks: JWKS })
		const iam = createIam(offLocalEnv(stub))
		await iam.listPrincipals(new Request('https://app/x', { headers: { Authorization: 'Bearer px_ci' } }))
		expect(stub.listPrincipalsInputs[0]?.app).toBe(APP)
	})

	test('dev builds a FakeIamClient whose listPrincipals enumerates the personas', async () => {
		const iam = createIam(devEnv, { devPersonas: PERSONAS })
		const result = await iam.listPrincipals(new Request('https://app/x'))
		expect(result.ok).toBe(true)
		if (!result.ok) throw new Error('expected ok')
		expect(result.principals.map((p) => p.id).sort()).toEqual(['p-admin', 'p-scoped'])
	})

	test('legacy-only IAM names remain supported', async () => {
		const stub = new IamRpcStub({ listPrincipals: { ok: true, principals: [] } })
		const iam = createIam({ IAM: stub, PROPUSTKA_URL: ISSUER, PROPUSTKA_APP_ID: APP })

		await iam.listPrincipals(new Request('https://app/x'))
		expect(stub.listPrincipalsInputs[0]?.app).toBe(APP)
	})

	test('canonical app id wins when both names are set', async () => {
		const stub = new IamRpcStub({ listPrincipals: { ok: true, principals: [] } })
		const iam = createIam({
			IAM: stub,
			FABRIKA_IAM_URL: ISSUER,
			PROPUSTKA_URL: 'https://legacy-iam.test',
			FABRIKA_APP_ID: 'canonical-app',
			PROPUSTKA_APP_ID: 'legacy-app',
		})

		await iam.listPrincipals(new Request('https://app/x'))
		expect(stub.listPrincipalsInputs[0]?.app).toBe('canonical-app')
	})

	test('throws when no app id is resolvable', () => {
		expect(() => createIam({ DEV: 'true', ENVIRONMENT: 'local' })).toThrow(/app id is required/)
	})

	test('off-local throws when the IAM binding is missing', () => {
		expect(() => createIam({ FABRIKA_IAM_URL: ISSUER, FABRIKA_APP_ID: APP })).toThrow(/IAM service binding is missing/)
	})

	test('off-local throws when no IAM URL is resolvable', () => {
		expect(() => createIam({ IAM: new IamRpcStub(), FABRIKA_APP_ID: APP })).toThrow(/FABRIKA_IAM_URL is missing/)
	})
})

// ── createIam — issuer canonicalization (CORR-2) ─────────────────────────────────

describe('createIam — the issuer is canonicalized once', () => {
	test('a trailing slash and a bare origin are the SAME issuer', async () => {
		const token = await sign()
		const withSlash = createIam(offLocalEnv(new IamRpcStub({ jwks: JWKS })), { appId: APP })
		const bare = createIam({ IAM: new IamRpcStub({ jwks: JWKS }), FABRIKA_IAM_URL: `${ISSUER}/`, FABRIKA_APP_ID: APP })

		expect((await withSlash.authenticate(proxied(token))).ok).toBe(true)
		expect((await bare.authenticate(proxied(token))).ok).toBe(true)
	})

	test('a path, query or fragment is discarded — only the origin is the issuer', async () => {
		const token = await sign()
		const iam = createIam({ IAM: new IamRpcStub({ jwks: JWKS }), FABRIKA_IAM_URL: `${ISSUER}/some/path?x=1#y`, FABRIKA_APP_ID: APP })
		expect((await iam.authenticate(proxied(token))).ok).toBe(true)
	})

	test('an unparseable or non-http(s) issuer throws at construction', () => {
		expect(() => createIam({ IAM: new IamRpcStub(), FABRIKA_IAM_URL: 'not a url', FABRIKA_APP_ID: APP })).toThrow(/not an absolute URL/)
		expect(() => createIam({ IAM: new IamRpcStub(), FABRIKA_IAM_URL: 'ftp://iam.test', FABRIKA_APP_ID: APP })).toThrow(/http\(s\) origin/)
	})
})

// ── createIam — DEV is parsed strictly (SEC-4) ───────────────────────────────────

describe('createIam — DEV selection is strict', () => {
	const stub = () => new IamRpcStub({ listPrincipals: { ok: true, principals: [] }, jwks: JWKS })

	test("'false', '0' and '' pin the REAL path (they used to select the fake)", () => {
		for (const dev of ['false', '0', ''] as const) {
			// The real path needs a binding + issuer; reaching that requirement proves the fake was not chosen.
			expect(() => createIam({ DEV: dev, ENVIRONMENT: 'local', FABRIKA_APP_ID: APP })).toThrow(/IAM service binding is missing/)
			expect(() => createIam({ DEV: dev, ENVIRONMENT: 'local', IAM: stub(), FABRIKA_IAM_URL: ISSUER, FABRIKA_APP_ID: APP })).not.toThrow()
		}
	})

	test('boolean false and an absent DEV pin the real path too', () => {
		expect(() => createIam({ DEV: false, ENVIRONMENT: 'local', FABRIKA_APP_ID: APP })).toThrow(/IAM service binding is missing/)
		expect(() => createIam({ ENVIRONMENT: 'local', FABRIKA_APP_ID: APP })).toThrow(/IAM service binding is missing/)
	})

	test("only 'true', '1' and boolean true select the fake", () => {
		for (const dev of ['true', '1', true] as const) {
			expect(() => createIam({ DEV: dev, ENVIRONMENT: 'local', FABRIKA_APP_ID: APP })).not.toThrow()
		}
	})

	test('an unrecognised value THROWS rather than being guessed either way', () => {
		for (const dev of ['no', 'off', 'yes', 'TRUE', '2']) {
			expect(() => createIam({ DEV: dev, ENVIRONMENT: 'local', FABRIKA_APP_ID: APP })).toThrow(/DEV must be one of/)
		}
	})

	test('the dev path is refused outside ENVIRONMENT=local', () => {
		for (const environment of ['stage', 'prod', undefined]) {
			expect(() =>
				createIam({
					DEV: 'true',
					FABRIKA_APP_ID: APP,
					...(environment === undefined ? {} : { ENVIRONMENT: environment }),
				})
			).toThrow(/ENVIRONMENT=local/)
		}
	})
})

// ── authenticate — the proxy-injected token ──────────────────────────────────────

describe('authenticate', () => {
	test('a valid injected token resolves the principal and its permissions', async () => {
		const iam = createIam(offLocalEnv(new IamRpcStub({ jwks: JWKS })))
		const result = await iam.authenticate(proxied(await sign()))

		expect(result.ok).toBe(true)
		if (!result.ok) throw new Error('expected ok')
		expect(result.context.principal?.id).toBe('user-1')
		expect(result.context.can('demo.read')).toBe(true)
		expect(result.context.can('demo.write')).toBe(false)
	})

	test('an anonymous token (no ptype) resolves with principal null', async () => {
		const iam = createIam(offLocalEnv(new IamRpcStub({ jwks: JWKS })))
		const result = await iam.authenticate(proxied(await sign({ anonymous: true })))

		expect(result.ok).toBe(true)
		if (!result.ok) throw new Error('expected ok')
		expect(result.context.principal).toBeNull()
		expect(result.context.can('demo.read')).toBe(true)
	})

	test('no header at all → no_token 401, and NO key set is fetched', async () => {
		const stub = new IamRpcStub({ jwks: JWKS })
		const iam = createIam(offLocalEnv(stub))
		const result = await iam.authenticate(new Request('https://app/page'))

		expect(result).toEqual({ ok: false, reason: 'no_token', status: 401 })
		expect(stub.jwksCalls).toBe(0)
	})

	test('an empty header is treated as absent, not as a bad token', async () => {
		const iam = createIam(offLocalEnv(new IamRpcStub({ jwks: JWKS })))
		const result = await iam.authenticate(new Request('https://app/page', { headers: { [PROXY_TOKEN_HEADER]: '   ' } }))
		expect(result.ok === false && result.reason).toBe('no_token')
	})

	test('the header is NOT trusted blindly — garbage denies', async () => {
		const iam = createIam(offLocalEnv(new IamRpcStub({ jwks: JWKS })))
		const result = await iam.authenticate(proxied('not.a.jwt'))
		expect(result).toEqual({ ok: false, reason: 'invalid_token', status: 401 })
	})
})

// ── authenticate — token binding (TEST-6) ────────────────────────────────────────

describe('authenticate — the token is bound to this app, this issuer and this moment', () => {
	test("another app's token denies (aud)", async () => {
		const iam = createIam(offLocalEnv(new IamRpcStub({ jwks: JWKS })))
		const result = await iam.authenticate(proxied(await sign({ aud: 'other-app' })))
		expect(result).toEqual({ ok: false, reason: 'invalid_token', status: 401 })
	})

	test('a token from a different issuer denies (iss)', async () => {
		const iam = createIam(offLocalEnv(new IamRpcStub({ jwks: JWKS })))
		const result = await iam.authenticate(proxied(await sign({ iss: 'https://evil.test' })))
		expect(result).toEqual({ ok: false, reason: 'invalid_token', status: 401 })
	})

	test('an expired token denies (exp)', async () => {
		const iam = createIam(offLocalEnv(new IamRpcStub({ jwks: JWKS })))
		const result = await iam.authenticate(proxied(await sign({ ttl: -120 })))
		expect(result).toEqual({ ok: false, reason: 'invalid_token', status: 401 })
	})

	test('a token signed by a key the issuer never published denies', async () => {
		const iam = createIam(offLocalEnv(new IamRpcStub({ jwks: JWKS })))
		// `kid: k1` is published, but the signature is from a different private key.
		const result = await iam.authenticate(proxied(await sign({ key: rotatedPrivate })))
		expect(result).toEqual({ ok: false, reason: 'invalid_token', status: 401 })
	})
})

// ── the JWKS cache (TEST-5) ──────────────────────────────────────────────────────

describe('the JWKS cache', () => {
	test('the key set is fetched ONCE per binding, not per request', async () => {
		const stub = new IamRpcStub({ jwks: JWKS })
		const token = await sign()
		// A fresh Iam per request is the real shape: `@fabrika/app` calls its middleware factory per request.
		for (let i = 0; i < 5; i++) {
			expect((await createIam(offLocalEnv(stub)).authenticate(proxied(token))).ok).toBe(true)
		}
		expect(stub.jwksCalls).toBe(1)
	})

	test('an unknown kid triggers exactly ONE refetch, and the rotated key then verifies', async () => {
		const stub = new IamRpcStub({ jwks: JWKS })
		const iam = createIam(offLocalEnv(stub))
		expect((await iam.authenticate(proxied(await sign()))).ok).toBe(true)
		expect(stub.jwksCalls).toBe(1)

		// A key rotated in: the cached set does not carry `k2`, so one refetch happens and then succeeds.
		stub.jwks = { keys: [K1, K2] }
		const rotated = await sign({ key: rotatedPrivate, kid: 'k2' })
		expect((await iam.authenticate(proxied(rotated))).ok).toBe(true)
		expect(stub.jwksCalls).toBe(2)
	})

	test('an unknown kid that is still unknown after the refetch denies, with no third fetch', async () => {
		const stub = new IamRpcStub({ jwks: JWKS })
		const iam = createIam(offLocalEnv(stub))
		const result = await iam.authenticate(proxied(await sign({ key: rotatedPrivate, kid: 'k2' })))

		expect(result).toEqual({ ok: false, reason: 'invalid_token', status: 401 })
		expect(stub.jwksCalls).toBe(2)
	})
})

// ── "could not consult IAM" is not a decided negative (COMP-2) ───────────────────

describe('an unreachable IAM is 503, never 401', () => {
	test('a throwing getJwks yields unavailable, not invalid_token', async () => {
		const stub = new IamRpcStub({ jwks: JWKS })
		stub.jwksError = new Error('connect ECONNREFUSED')
		const iam = createIam(offLocalEnv(stub))

		const result = await iam.authenticate(proxied(await sign()))
		expect(result).toEqual({ ok: false, reason: 'unavailable', status: 503 })
	})

	test('a throwing mintFromKey yields unavailable during a share-link redemption', async () => {
		const stub = new IamRpcStub({ jwks: JWKS })
		stub.mintFromKey = () => Promise.reject(new Error('connect ECONNREFUSED'))
		const iam = createIam(offLocalEnv(stub))

		expect(await iam.redeemKey('px_share')).toEqual({ ok: false, reason: 'unavailable', status: 503 })
	})

	test('a recovered IAM verifies on the next request (no poisoned cache)', async () => {
		const stub = new IamRpcStub({ jwks: JWKS })
		stub.jwksError = new Error('connect ECONNREFUSED')
		const iam = createIam(offLocalEnv(stub))
		const token = await sign()

		expect((await iam.authenticate(proxied(token))).ok).toBe(false)
		stub.jwksError = undefined
		expect((await iam.authenticate(proxied(token))).ok).toBe(true)
	})
})

// ── redeemKey — share links, OFF the gate path ───────────────────────────────────

const CAP_PERMS: PermissionEntry[] = [{ action: 'report.read', scope: { type: 'run', value: 'r1' } as Scope, source: 'grant' }]

describe('redeemKey', () => {
	test('a px_ credential is exchanged via mintFromKey into an anonymous, exact-resource context', async () => {
		const token = await sign({ anonymous: true, perms: CAP_PERMS })
		const stub = new IamRpcStub({ jwks: JWKS, mintFromKey: { ok: true, token, expiresAt: now() + 300 } })
		const result = await createIam(offLocalEnv(stub)).redeemKey('px_share')

		expect(result.ok).toBe(true)
		if (!result.ok) throw new Error('expected ok')
		expect(stub.mintFromKeyInputs[0]?.key).toBe('px_share')
		expect(result.context.principal).toBeNull()
		expect(result.context.can('report.read', { type: 'run', value: 'r1' })).toBe(true)
		expect(result.context.can('report.read', { type: 'run', value: 'r2' })).toBe(false)
	})

	test('the minted token is cached per binding — a second redemption makes no RPC', async () => {
		const token = await sign({ anonymous: true, perms: CAP_PERMS })
		const stub = new IamRpcStub({ jwks: JWKS, mintFromKey: { ok: true, token, expiresAt: now() + 300 } })
		const iam = createIam(offLocalEnv(stub))

		expect((await iam.redeemKey('px_share')).ok).toBe(true)
		expect((await iam.redeemKey('px_share')).ok).toBe(true)
		expect(stub.mintFromKeyInputs).toHaveLength(1)
	})

	test('a passthrough JWT verifies locally with NO binding call', async () => {
		const stub = new IamRpcStub({ jwks: JWKS })
		const result = await createIam(offLocalEnv(stub)).redeemKey(await sign({ anonymous: true, perms: CAP_PERMS }))

		expect(result.ok).toBe(true)
		expect(stub.mintFromKeyInputs).toHaveLength(0)
	})

	test('an unknown px_ credential → invalid_token 401 (the caller maps it to a 404)', async () => {
		const stub = new IamRpcStub({ jwks: JWKS }) // mintFromKey defaults to invalid_key
		expect(await createIam(offLocalEnv(stub)).redeemKey('px_nope')).toEqual({ ok: false, reason: 'invalid_token', status: 401 })
	})

	test('a disabled principal → unknown_principal 403', async () => {
		const stub = new IamRpcStub({ jwks: JWKS, mintFromKey: { ok: false, reason: 'disabled' } })
		expect(await createIam(offLocalEnv(stub)).redeemKey('px_dead')).toEqual({ ok: false, reason: 'unknown_principal', status: 403 })
	})

	test('a garbage passthrough token denies without a binding call', async () => {
		const stub = new IamRpcStub({ jwks: JWKS })
		expect((await createIam(offLocalEnv(stub)).redeemKey('eyJnot.a.jwt')).ok).toBe(false)
		expect(stub.mintFromKeyInputs).toHaveLength(0)
	})

	test('in dev a present token grants an open context', async () => {
		const result = await createIam(devEnv, { devPersonas: PERSONAS }).redeemKey('anything')
		expect(result.ok).toBe(true)
		if (!result.ok) throw new Error('expected ok')
		expect(result.context.can('report.read', { type: 'run', value: 'whatever' })).toBe(true)
	})
})

// ── the dev persona path ─────────────────────────────────────────────────────────

describe('authenticate — dev persona', () => {
	const iam = () => createIam(devEnv, { devPersonas: PERSONAS, devDefaultPersona: 'admin@x.test' })

	async function personaFor(request: Request): Promise<string | undefined> {
		const result = await iam().authenticate(request)
		return result.ok ? result.context.principal?.id : undefined
	}

	test('the ?__as= query selects a persona', async () => {
		expect(await personaFor(new Request('https://app/page?__as=scoped@x.test'))).toBe('p-scoped')
	})

	test('the persona cookie selects a persona', async () => {
		expect(await personaFor(new Request('https://app/page', { headers: { Cookie: 'propustka_dev_principal=scoped@x.test' } }))).toBe('p-scoped')
	})

	test('the persona cookie is URL-decoded (devLoginHandler round-trip)', async () => {
		expect(await personaFor(new Request('https://app/page', { headers: { Cookie: 'propustka_dev_principal=admin%40x.test' } }))).toBe('p-admin')
	})

	test('no selector falls back to the default persona', async () => {
		expect(await personaFor(new Request('https://app/page'))).toBe('p-admin')
	})

	test('an explicit persona header overrides the cookie and default', async () => {
		const configured = createIam(devEnv, { devPersonas: PERSONAS, devDefaultPersona: 'admin@x.test', devPersonaHeader: 'X-Dev-Principal' })
		const result = await configured.authenticate(
			new Request('https://app/page', { headers: { Cookie: 'propustka_dev_principal=admin%40x.test', 'X-Dev-Principal': 'scoped@x.test' } }),
		)
		expect(result.ok && result.context.principal?.id).toBe('p-scoped')
	})

	test('an unknown persona → unknown_principal 403', async () => {
		expect(await iam().authenticate(new Request('https://app/page?__as=ghost@x.test'))).toEqual({
			ok: false,
			reason: 'unknown_principal',
			status: 403,
		})
	})

	test('no selector and no default → no_token 401', async () => {
		const bare = createIam(devEnv, { devPersonas: PERSONAS })
		expect(await bare.authenticate(new Request('https://app/page'))).toEqual({ ok: false, reason: 'no_token', status: 401 })
	})

	test('the dev path ignores an injected token entirely (there is nothing to verify against)', async () => {
		expect(await personaFor(proxied(await sign()))).toBe('p-admin')
	})
})

// ── makeDevContext / anonymousContext / devLoginHandler ──────────────────────────

describe('makeDevContext', () => {
	test('can/scopedTo evaluate against the persona permissions (permits semantics)', () => {
		const ctx = makeDevContext(PERSONAS['scoped@x.test']!)
		expect(ctx.principal?.id).toBe('p-scoped')
		expect(ctx.principal?.type).toBe('user')
		expect(ctx.can('project.read', { type: 'project', value: 'p1' })).toBe(true)
		expect(ctx.can('project.read', { type: 'project', value: 'p2' })).toBe(false)
		expect(ctx.can('project.read')).toBe(false) // scope-less needs a global grant
		expect(ctx.scopedTo('project.read', 'project')).toEqual(['p1'])
	})

	test('a global wildcard persona is unrestricted', () => {
		const ctx = makeDevContext(PERSONAS['admin@x.test']!)
		expect(ctx.can('anything.at.all')).toBe(true)
		expect(ctx.scopedTo('anything', 'project')).toBeNull()
	})

	test('a non-"service" type resolves to user; "service" is preserved', () => {
		expect(makeDevContext({ id: 's', label: 's', type: 'robot', permissions: [] }).principal?.type).toBe('user')
		expect(makeDevContext({ id: 's', label: 's', type: 'service', permissions: [] }).principal?.type).toBe('service')
	})

	test('audit is a no-op', async () => {
		await expect(makeDevContext(PERSONAS['admin@x.test']!).audit({ action: 'x', resourceType: 'y' })).resolves.toBeUndefined()
	})
})

describe('anonymousContext', () => {
	test('holds nothing: no principal, no permission, no scope', async () => {
		const ctx = anonymousContext()
		expect(ctx.principal).toBeNull()
		expect(ctx.can('anything')).toBe(false)
		expect(ctx.scopedTo('anything', 'project')).toEqual([])
		await expect(ctx.audit({ action: 'x', resourceType: 'y' })).resolves.toBeUndefined()
	})
})

describe('devLoginHandler', () => {
	test('sets the persona cookie from ?as= and 302s to /', () => {
		const iam = createIam(devEnv, { devPersonas: PERSONAS })
		const response = iam.devLoginHandler()(new Request('https://app/__dev/login?as=admin@x.test'))
		expect(response.status).toBe(302)
		expect(response.headers.get('location')).toBe('/')
		expect(response.headers.get('set-cookie')).toContain('propustka_dev_principal=admin%40x.test')
	})

	test('honours a custom persona cookie name', () => {
		const iam = createIam(devEnv, { devPersonas: PERSONAS, devPersonaCookie: 'my_dev' })
		const response = iam.devLoginHandler()(new Request('https://app/__dev/login?as=x'))
		expect(response.headers.get('set-cookie')).toContain('my_dev=x')
	})
})
