import { buildAccessClaims, type Jwks, type PermissionEntry, PROXY_TOKEN_HEADER, type Scope } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { exportJWK, generateKeyPair, type KeyLike, SignJWT } from 'jose'
import { anonymousContext, createIam, type IamEnv } from '../iam'
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

const iamEnv = (stub: IamRpcStub): IamEnv => ({ IAM: stub, FABRIKA_IAM_ISSUER: ISSUER, FABRIKA_APP_ID: APP })

/** A request carrying the token the proxy injected. */
function proxied(token: string, url = 'https://app/page'): Request {
	return new Request(url, { headers: { [PROXY_TOKEN_HEADER]: token } })
}

// ── createIam ────────────────────────────────────────────────────────────────────

describe('createIam', () => {
	test('builds an IamClient-backed Iam and delegates listPrincipals', async () => {
		const stub = new IamRpcStub({ listPrincipals: { ok: true, principals: [] }, jwks: JWKS })
		const iam = createIam(iamEnv(stub))
		await iam.listPrincipals(new Request('https://app/x', { headers: { Authorization: 'Bearer px_ci' } }))
		expect(stub.listPrincipalsInputs[0]?.app).toBe(APP)
	})

	test('the env app id is used when opts.appId is omitted', async () => {
		const stub = new IamRpcStub({ listPrincipals: { ok: true, principals: [] } })
		const iam = createIam({ IAM: stub, FABRIKA_IAM_ISSUER: ISSUER, FABRIKA_APP_ID: 'env-app' })

		await iam.listPrincipals(new Request('https://app/x'))
		expect(stub.listPrincipalsInputs[0]?.app).toBe('env-app')
	})

	test('throws when no app id is resolvable', () => {
		expect(() => createIam({})).toThrow(/app id is required/)
	})

	test('throws when the IAM binding is missing — there is no mode that makes it optional', () => {
		expect(() => createIam({ FABRIKA_IAM_ISSUER: ISSUER, FABRIKA_APP_ID: APP })).toThrow(/IAM service binding is missing/)
	})

	test('throws when no IAM URL is resolvable', () => {
		expect(() => createIam({ IAM: new IamRpcStub(), FABRIKA_APP_ID: APP })).toThrow(/FABRIKA_IAM_ISSUER is missing/)
	})
})

// ── createIam — issuer canonicalization (CORR-2) ─────────────────────────────────

describe('createIam — the issuer is canonicalized once', () => {
	test('a trailing slash and a bare origin are the SAME issuer', async () => {
		const token = await sign()
		const withSlash = createIam(iamEnv(new IamRpcStub({ jwks: JWKS })), { appId: APP })
		const bare = createIam({ IAM: new IamRpcStub({ jwks: JWKS }), FABRIKA_IAM_ISSUER: `${ISSUER}/`, FABRIKA_APP_ID: APP })

		expect((await withSlash.authenticate(proxied(token))).ok).toBe(true)
		expect((await bare.authenticate(proxied(token))).ok).toBe(true)
	})

	test('a path, query or fragment is discarded — only the origin is the issuer', async () => {
		const token = await sign()
		const iam = createIam({ IAM: new IamRpcStub({ jwks: JWKS }), FABRIKA_IAM_ISSUER: `${ISSUER}/some/path?x=1#y`, FABRIKA_APP_ID: APP })
		expect((await iam.authenticate(proxied(token))).ok).toBe(true)
	})

	test('an unparseable or non-http(s) issuer throws at construction', () => {
		expect(() => createIam({ IAM: new IamRpcStub(), FABRIKA_IAM_ISSUER: 'not a url', FABRIKA_APP_ID: APP })).toThrow(/not an absolute URL/)
		expect(() => createIam({ IAM: new IamRpcStub(), FABRIKA_IAM_ISSUER: 'ftp://iam.test', FABRIKA_APP_ID: APP })).toThrow(/http\(s\) origin/)
	})
})

// ── authenticate — the proxy-injected token ──────────────────────────────────────

describe('authenticate', () => {
	test('a valid injected token resolves the principal and its permissions', async () => {
		const iam = createIam(iamEnv(new IamRpcStub({ jwks: JWKS })))
		const result = await iam.authenticate(proxied(await sign()))

		expect(result.ok).toBe(true)
		if (!result.ok) throw new Error('expected ok')
		expect(result.context.principal?.id).toBe('user-1')
		expect(result.context.can('demo.read')).toBe(true)
		expect(result.context.can('demo.write')).toBe(false)
	})

	test('an anonymous token (no ptype) resolves with principal null', async () => {
		const iam = createIam(iamEnv(new IamRpcStub({ jwks: JWKS })))
		const result = await iam.authenticate(proxied(await sign({ anonymous: true })))

		expect(result.ok).toBe(true)
		if (!result.ok) throw new Error('expected ok')
		expect(result.context.principal).toBeNull()
		expect(result.context.can('demo.read')).toBe(true)
	})

	test('no header at all → no_token 401, and NO key set is fetched', async () => {
		const stub = new IamRpcStub({ jwks: JWKS })
		const iam = createIam(iamEnv(stub))
		const result = await iam.authenticate(new Request('https://app/page'))

		expect(result).toEqual({ ok: false, reason: 'no_token', status: 401 })
		expect(stub.jwksCalls).toBe(0)
	})

	test('an empty header is treated as absent, not as a bad token', async () => {
		const iam = createIam(iamEnv(new IamRpcStub({ jwks: JWKS })))
		const result = await iam.authenticate(new Request('https://app/page', { headers: { [PROXY_TOKEN_HEADER]: '   ' } }))
		expect(result.ok === false && result.reason).toBe('no_token')
	})

	test('the header is NOT trusted blindly — garbage denies', async () => {
		const iam = createIam(iamEnv(new IamRpcStub({ jwks: JWKS })))
		const result = await iam.authenticate(proxied('not.a.jwt'))
		expect(result).toEqual({ ok: false, reason: 'invalid_token', status: 401 })
	})
})

// ── authenticate — token binding (TEST-6) ────────────────────────────────────────

describe('authenticate — the token is bound to this app, this issuer and this moment', () => {
	test("another app's token denies (aud)", async () => {
		const iam = createIam(iamEnv(new IamRpcStub({ jwks: JWKS })))
		const result = await iam.authenticate(proxied(await sign({ aud: 'other-app' })))
		expect(result).toEqual({ ok: false, reason: 'invalid_token', status: 401 })
	})

	test('a token from a different issuer denies (iss)', async () => {
		const iam = createIam(iamEnv(new IamRpcStub({ jwks: JWKS })))
		const result = await iam.authenticate(proxied(await sign({ iss: 'https://evil.test' })))
		expect(result).toEqual({ ok: false, reason: 'invalid_token', status: 401 })
	})

	test('an expired token denies (exp)', async () => {
		const iam = createIam(iamEnv(new IamRpcStub({ jwks: JWKS })))
		const result = await iam.authenticate(proxied(await sign({ ttl: -120 })))
		expect(result).toEqual({ ok: false, reason: 'invalid_token', status: 401 })
	})

	test('a token signed by a key the issuer never published denies', async () => {
		const iam = createIam(iamEnv(new IamRpcStub({ jwks: JWKS })))
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
			expect((await createIam(iamEnv(stub)).authenticate(proxied(token))).ok).toBe(true)
		}
		expect(stub.jwksCalls).toBe(1)
	})

	test('an unknown kid triggers exactly ONE refetch, and the rotated key then verifies', async () => {
		const stub = new IamRpcStub({ jwks: JWKS })
		const iam = createIam(iamEnv(stub))
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
		const iam = createIam(iamEnv(stub))
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
		const iam = createIam(iamEnv(stub))

		const result = await iam.authenticate(proxied(await sign()))
		expect(result).toEqual({ ok: false, reason: 'unavailable', status: 503 })
	})

	test('a throwing mintFromKey yields unavailable during a share-link redemption', async () => {
		const stub = new IamRpcStub({ jwks: JWKS })
		stub.mintFromKey = () => Promise.reject(new Error('connect ECONNREFUSED'))
		const iam = createIam(iamEnv(stub))

		expect(await iam.redeemKey('px_share')).toEqual({ ok: false, reason: 'unavailable', status: 503 })
	})

	test('a recovered IAM verifies on the next request (no poisoned cache)', async () => {
		const stub = new IamRpcStub({ jwks: JWKS })
		stub.jwksError = new Error('connect ECONNREFUSED')
		const iam = createIam(iamEnv(stub))
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
		const result = await createIam(iamEnv(stub)).redeemKey('px_share')

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
		const iam = createIam(iamEnv(stub))

		expect((await iam.redeemKey('px_share')).ok).toBe(true)
		expect((await iam.redeemKey('px_share')).ok).toBe(true)
		expect(stub.mintFromKeyInputs).toHaveLength(1)
	})

	test('a passthrough JWT verifies locally with NO binding call', async () => {
		const stub = new IamRpcStub({ jwks: JWKS })
		const result = await createIam(iamEnv(stub)).redeemKey(await sign({ anonymous: true, perms: CAP_PERMS }))

		expect(result.ok).toBe(true)
		expect(stub.mintFromKeyInputs).toHaveLength(0)
	})

	test('an unknown px_ credential → invalid_token 401 (the caller maps it to a 404)', async () => {
		const stub = new IamRpcStub({ jwks: JWKS }) // mintFromKey defaults to invalid_key
		expect(await createIam(iamEnv(stub)).redeemKey('px_nope')).toEqual({ ok: false, reason: 'invalid_token', status: 401 })
	})

	test('a disabled principal → unknown_principal 403', async () => {
		const stub = new IamRpcStub({ jwks: JWKS, mintFromKey: { ok: false, reason: 'disabled' } })
		expect(await createIam(iamEnv(stub)).redeemKey('px_dead')).toEqual({ ok: false, reason: 'unknown_principal', status: 403 })
	})

	test('a garbage passthrough token denies without a binding call', async () => {
		const stub = new IamRpcStub({ jwks: JWKS })
		expect((await createIam(iamEnv(stub)).redeemKey('eyJnot.a.jwt')).ok).toBe(false)
		expect(stub.mintFromKeyInputs).toHaveLength(0)
	})
})

// ── anonymousContext ─────────────────────────────────────────────────────────────

describe('anonymousContext', () => {
	test('holds nothing: no principal, no permission, no scope', async () => {
		const ctx = anonymousContext()
		expect(ctx.principal).toBeNull()
		expect(ctx.can('anything')).toBe(false)
		expect(ctx.scopedTo('anything', 'project')).toEqual([])
		await expect(ctx.audit({ action: 'x', resourceType: 'y' })).resolves.toBeUndefined()
	})
})
