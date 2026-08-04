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
