/**
 * The HTTP transport to IAM. Everything here is about the boundary being hostile: a slow service, a
 * 500, a truncated body, a reason word we do not recognise. All of them must produce a deny, and none
 * of them may put a credential anywhere it can be read.
 */

import { describe, expect, test } from 'bun:test'
import { type FetchLike, HttpIamGateway, IamUnavailableError } from '../iam'
import { PUBLIC_JWKS } from './helpers'

interface Recorded {
	url: string
	method: string
	body: string | null
	headers: Headers
}

function gatewayReturning(status: number, payload: unknown, recorded: Recorded[] = []): { gateway: HttpIamGateway; recorded: Recorded[] } {
	const fetchImpl: FetchLike = async (input, init) => {
		recorded.push({
			url: input,
			method: init.method ?? 'GET',
			body: typeof init.body === 'string' ? init.body : null,
			headers: new Headers(init.headers),
		})
		return new Response(payload === undefined ? '' : JSON.stringify(payload), {
			status,
			headers: { 'content-type': 'application/json' },
		})
	}
	return { gateway: new HttpIamGateway({ origin: 'https://iam.test/', fetch: fetchImpl }), recorded }
}

describe('happy path', () => {
	test('mintToken posts to the session endpoint and reads the result', async () => {
		const { gateway, recorded } = gatewayReturning(200, { ok: true, token: 'signed.jwt.here', expiresAt: 1234 })
		const result = await gateway.mintToken({ app: 'a', session: 'sess', requestId: 'r' })
		expect(result).toEqual({ ok: true, token: 'signed.jwt.here', expiresAt: 1234 })
		expect(recorded[0]?.url).toBe('https://iam.test/auth/mint/session')
		expect(recorded[0]?.method).toBe('POST')
	})

	test('a decided negative is a normal result, not an error', async () => {
		const { gateway } = gatewayReturning(200, { ok: false, reason: 'disabled' })
		expect(await gateway.mintToken({ app: 'a', session: 's', requestId: 'r' })).toEqual({ ok: false, reason: 'disabled' })
	})

	test('exchangeAuthCode posts to the exchange endpoint and reads the result', async () => {
		const { gateway, recorded } = gatewayReturning(200, { ok: true, session: 'px_child', returnUrl: 'https://app.test/private', expiresAt: 99 })
		const result = await gateway.exchangeAuthCode({ app: 'a', code: 'handoff', verifier: 'verifier', requestId: 'r' })
		expect(result).toEqual({ ok: true, session: 'px_child', returnUrl: 'https://app.test/private', expiresAt: 99 })
		expect(recorded[0]?.url).toBe('https://iam.test/auth/mint/exchange')
		expect(recorded[0]?.method).toBe('POST')
		// `packages/iam/src/rpc-http.ts` decodes exactly these four fields; anything else is a 400 there.
		expect(JSON.parse(recorded[0]?.body ?? 'null')).toEqual({ app: 'a', code: 'handoff', verifier: 'verifier', requestId: 'r' })
	})

	test('a spent code is a decided negative, not an error', async () => {
		// Every successful sign-in leaves a spent code behind, so this is the ordinary case. Raising here
		// would turn a replayed callback into a 503 instead of a fresh login.
		const { gateway } = gatewayReturning(200, { ok: false, reason: 'expired_code' })
		expect(await gateway.exchangeAuthCode({ app: 'a', code: 'c', verifier: 'verifier', requestId: 'r' })).toEqual({
			ok: false,
			reason: 'expired_code',
		})
	})

	test('getJwks reads the standard well-known endpoint', async () => {
		const { gateway, recorded } = gatewayReturning(200, PUBLIC_JWKS)
		expect((await gateway.getJwks()).keys).toHaveLength(1)
		expect(recorded[0]?.url).toBe('https://iam.test/.well-known/jwks.json')
		expect(recorded[0]?.method).toBe('GET')
	})
})

describe('credentials never travel where they can be read back', () => {
	test('the session rides in the body, never in the URL', async () => {
		const { gateway, recorded } = gatewayReturning(200, { ok: false, reason: 'no_session' })
		await gateway.mintToken({ app: 'a', session: 'SESSIONSECRET', requestId: 'r' })
		expect(recorded[0]?.url).not.toContain('SESSIONSECRET')
		expect(recorded[0]?.body).toContain('SESSIONSECRET')
	})

	test('the px_ key rides in the body, never in the URL', async () => {
		const { gateway, recorded } = gatewayReturning(200, { ok: false, reason: 'invalid_key' })
		await gateway.mintFromKey({ app: 'a', key: 'px_KEYSECRET', requestId: 'r' })
		expect(recorded[0]?.url).not.toContain('px_KEYSECRET')
	})

	test('the handoff code rides in the body, never in the URL', async () => {
		// A code buys a session for as long as it lives, and a URL ends up in an access log. This is the
		// same property the Caddy redaction pattern covers at the other end of the hop.
		const { gateway, recorded } = gatewayReturning(200, { ok: false, reason: 'invalid_code' })
		await gateway.exchangeAuthCode({ app: 'a', code: 'CODESECRET', verifier: 'VERIFIERSECRET', requestId: 'r' })
		expect(recorded[0]?.url).not.toContain('CODESECRET')
		expect(recorded[0]?.body).toContain('CODESECRET')
	})

	test('the proxy authenticates itself with a bearer when configured', async () => {
		const recorded: Recorded[] = []
		const fetchImpl: FetchLike = async (input, init) => {
			recorded.push({ url: input, method: init.method ?? 'GET', body: null, headers: new Headers(init.headers) })
			return new Response(JSON.stringify({ ok: false, reason: 'invalid_key' }), { status: 200 })
		}
		const gateway = new HttpIamGateway({ origin: 'https://iam.test', key: 'px_proxy', fetch: fetchImpl })
		await gateway.mintFromKey({ app: 'a', key: 'px_x', requestId: 'r' })
		expect(recorded[0]?.headers.get('authorization')).toBe('Bearer px_proxy')
	})
})

describe('a hostile or broken IAM always denies', () => {
	const failures: [string, () => HttpIamGateway][] = [
		['a 500', () => gatewayReturning(500, { ok: true, token: 't', expiresAt: 9 }).gateway],
		['a 404', () => gatewayReturning(404, undefined).gateway],
		['an empty body', () => gatewayReturning(200, undefined).gateway],
		['a body with no ok field', () => gatewayReturning(200, { token: 't' }).gateway],
		['ok:true with no token', () => gatewayReturning(200, { ok: true, expiresAt: 5 }).gateway],
		['ok:true with no expiry', () => gatewayReturning(200, { ok: true, token: 't' }).gateway],
		['ok:false with no reason', () => gatewayReturning(200, { ok: false }).gateway],
	]

	for (const [name, build] of failures) {
		test(`${name} raises IamUnavailableError`, async () => {
			await expect(build().mintToken({ app: 'a', session: 's', requestId: 'r' })).rejects.toThrow(IamUnavailableError)
		})
	}

	test('a rejected fetch raises IamUnavailableError and carries no cause', async () => {
		const fetchImpl: FetchLike = () => Promise.reject(new Error('connect ECONNREFUSED https://iam.test?session=SECRET'))
		const gateway = new HttpIamGateway({ origin: 'https://iam.test', fetch: fetchImpl })
		try {
			await gateway.mintToken({ app: 'a', session: 'SECRET', requestId: 'r' })
			throw new Error('expected a rejection')
		} catch (err) {
			expect(err).toBeInstanceOf(IamUnavailableError)
			expect(String(err)).not.toContain('SECRET')
		}
	})

	test('a request that outlives the timeout is aborted, not awaited forever', async () => {
		const fetchImpl: FetchLike = (_input, init) =>
			new Promise((_resolve, reject) => {
				init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
			})
		const gateway = new HttpIamGateway({ origin: 'https://iam.test', timeoutMs: 10, fetch: fetchImpl })
		await expect(gateway.mintFromKey({ app: 'a', key: 'px_x', requestId: 'r' })).rejects.toThrow(IamUnavailableError)
	})

	test('an unrecognised reason degrades to a DENY reason, never to an allow', async () => {
		const { gateway } = gatewayReturning(200, { ok: false, reason: 'please_let_me_in' })
		const result = await gateway.mintToken({ app: 'a', session: 's', requestId: 'r' })
		expect(result).toEqual({ ok: false, reason: 'invalid_session' })
	})

	// The exchange reads FOUR fields off a success rather than the mint's three, so it has its own
	// table. Every row below is a shape that would otherwise become a half-built session: the proxy
	// writes the cookie from `session` and redirects to `returnUrl`, so an empty either one is a
	// browser landing nowhere with no session — which must read as "IAM could not be consulted".
	const exchangeFailures: [string, unknown][] = [
		['a 500', undefined],
		['an empty body', undefined],
		['a body with no ok field', { session: 's', returnUrl: 'https://app.test/', expiresAt: 1 }],
		['ok as a string, not a boolean', { ok: 'true', session: 's', returnUrl: 'https://app.test/', expiresAt: 1 }],
		['ok:true with no session', { ok: true, returnUrl: 'https://app.test/', expiresAt: 1 }],
		['ok:true with an EMPTY session', { ok: true, session: '', returnUrl: 'https://app.test/', expiresAt: 1 }],
		['ok:true with no returnUrl', { ok: true, session: 's', expiresAt: 1 }],
		['ok:true with an EMPTY returnUrl', { ok: true, session: 's', returnUrl: '', expiresAt: 1 }],
		['ok:true with no expiry', { ok: true, session: 's', returnUrl: 'https://app.test/' }],
		['ok:false with no reason', { ok: false }],
	]

	for (const [name, payload] of exchangeFailures) {
		test(`exchangeAuthCode: ${name} raises IamUnavailableError`, async () => {
			const status = name === 'a 500' ? 500 : 200
			const { gateway } = gatewayReturning(status, payload)
			await expect(gateway.exchangeAuthCode({ app: 'a', code: 'c', verifier: 'verifier', requestId: 'r' })).rejects.toThrow(IamUnavailableError)
		})
	}

	test('an unrecognised exchange reason degrades to invalid_code, never to an allow', async () => {
		const { gateway } = gatewayReturning(200, { ok: false, reason: 'please_let_me_in' })
		expect(await gateway.exchangeAuthCode({ app: 'a', code: 'c', verifier: 'verifier', requestId: 'r' })).toEqual({
			ok: false,
			reason: 'invalid_code',
		})
	})

	test('a rejected exchange fetch raises IamUnavailableError and carries no code', async () => {
		const fetchImpl: FetchLike = () => Promise.reject(new Error('connect ECONNREFUSED https://iam.test?code=CODESECRET'))
		const gateway = new HttpIamGateway({ origin: 'https://iam.test', fetch: fetchImpl })
		try {
			await gateway.exchangeAuthCode({ app: 'a', code: 'CODESECRET', verifier: 'VERIFIERSECRET', requestId: 'r' })
			throw new Error('expected a rejection')
		} catch (err) {
			expect(err).toBeInstanceOf(IamUnavailableError)
			expect(String(err)).not.toContain('CODESECRET')
		}
	})

	test('a malformed JWKS raises rather than yielding an empty key set', async () => {
		await expect(gatewayReturning(200, { keys: [{ crv: 'P-256' }] }).gateway.getJwks()).rejects.toThrow(IamUnavailableError)
		await expect(gatewayReturning(200, { keys: 'nope' }).gateway.getJwks()).rejects.toThrow(IamUnavailableError)
	})

	test('a key we cannot represent raises rather than silently shrinking the key set', async () => {
		// `PublicJwk` carries the EC members only, so copying an RSA key would drop `n`/`e` and yield a
		// verifier missing it — reported as "this token is invalid" instead of "we could not check".
		const withRsa = { keys: [...PUBLIC_JWKS.keys, { kty: 'RSA', n: 'modulus', e: 'AQAB', kid: 'r1', alg: 'RS256', use: 'sig' }] }
		await expect(gatewayReturning(200, withRsa).gateway.getJwks()).rejects.toThrow(IamUnavailableError)
	})
})
