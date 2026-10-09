// The HTTP transport for `IamRpc`. What is asserted here is the WIRE and the failure split — the two
// things that cannot be checked by the type system and that fail closed but silently when wrong.
//
// The wire is `@fabrika/iam`'s `src/rpc-http.ts`; a mismatch there becomes a 5xx on every credentialed
// request with nothing in the message saying why, so the path, the method, the bearer and the body
// are each pinned. The failure split is the other half: a DECIDED negative (`{ ok:false, reason }` at
// 200) must come back as a result, and only a transport fault may throw.

import { describe, expect, test } from 'bun:test'
import { APP, ISSUER, PUBLIC_JWKS, signToken } from '../../../jwks/src/__tests__/helpers'
import { HttpIamRpc, IamTransportError } from '../rpc-http'
import { TokenVerifier } from '../verify'

interface Call {
	url: string
	init: RequestInit
}

/** A fake `fetch` that records the call and answers with a fixed status + body. */
function stub(status: number, body: unknown): { rpc: HttpIamRpc; calls: Call[] } {
	const calls: Call[] = []
	const rpc = new HttpIamRpc({
		origin: 'http://iam:3000/',
		key: 'transport-key-0123456789abcdef',
		fetch: (url, init) => {
			calls.push({ url, init })
			const payload = status === 204 ? null : JSON.stringify(body)
			return Promise.resolve(new Response(payload, { status, headers: { 'content-type': 'application/json' } }))
		},
	})
	return { rpc, calls }
}

describe('the wire', () => {
	test('POSTs /rpc/<method> with the bearer key and the input as the JSON body', async () => {
		const { rpc, calls } = stub(200, { ok: true, token: 'px_t', expiresAt: 42 })

		await rpc.mintToken({ app: 'vozka', session: 'sess', requestId: 'req-1' })

		expect(calls).toHaveLength(1)
		// The trailing slash on the configured origin is trimmed — `//rpc/` would 404.
		expect(calls[0]?.url).toBe('http://iam:3000/rpc/mintToken')
		expect(calls[0]?.init.method).toBe('POST')
		const headers = new Headers(calls[0]?.init.headers)
		expect(headers.get('authorization')).toBe('Bearer transport-key-0123456789abcdef')
		expect(headers.get('content-type')).toBe('application/json')
		expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ app: 'vozka', session: 'sess', requestId: 'req-1' })
	})

	test('getJwks goes through /rpc/*, not the public JWKS route — one surface, one key', async () => {
		const { rpc, calls } = stub(200, { keys: [{ kty: 'EC', crv: 'P-256', x: 'x', y: 'y', kid: 'k1', alg: 'ES256', use: 'sig' }] })

		const jwks = await rpc.getJwks()

		expect(calls[0]?.url).toBe('http://iam:3000/rpc/getJwks')
		expect(calls[0]?.init.method).toBe('POST')
		expect(calls[0]?.init.body).toBe('{}')
		expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('Bearer transport-key-0123456789abcdef')
		expect(jwks.keys).toEqual([{ kty: 'EC', crv: 'P-256', x: 'x', y: 'y', kid: 'k1', alg: 'ES256', use: 'sig' }])
	})

	test('audit is a 204 with no body, and resolves rather than trying to decode one', async () => {
		const { rpc, calls } = stub(204, null)

		await rpc.audit({
			credential: 'verified-token',
			requestId: 'req-2',
			principalId: 'p1',
			principalLabel: 'op@x.cz',
			action: 'deploy.trigger',
			resourceType: 'run',
			resourceId: 'run-1',
		})

		expect(calls[0]?.url).toBe('http://iam:3000/rpc/audit')
	})
})

describe('JWKS response boundary', () => {
	test('preserves optional EC fields and ignores fields outside PublicJwk', async () => {
		const keys = [{ kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }, { kty: 'EC', kid: '', alg: 'ES256', use: 'sig' }]
		const { rpc } = stub(200, { keys: keys.map(key => ({ ...key, extra: true })), extra: true })
		expect(await rpc.getJwks()).toStrictEqual({ keys })
		expect(await stub(200, { keys: [] }).rpc.getJwks()).toStrictEqual({ keys: [] })
	})

	const malformed: [string, unknown][] = [
		['missing keys', {}],
		['keys is not an array', { keys: 'nope' }],
		['missing kty', { keys: [{ crv: 'P-256' }] }],
		['a null member', { keys: [null] }],
		['a malformed EC field', { keys: [...PUBLIC_JWKS.keys, { kty: 'EC', x: 42 }] }],
		['mixed EC and RSA', { keys: [...PUBLIC_JWKS.keys, { kty: 'RSA', n: 'modulus', e: 'AQAB', kid: 'r1', alg: 'RS256', use: 'sig' }] }],
	]
	for (const [name, body] of malformed) {
		test(`${name} raises IamTransportError`, async () => {
			await expect(stub(200, body).rpc.getJwks()).rejects.toThrow(IamTransportError)
		})
	}

	test('invalid JSON raises IamTransportError', async () => {
		const rpc = new HttpIamRpc({ origin: ISSUER, key: 'rpc-key', fetch: async () => new Response('{') })
		await expect(rpc.getJwks()).rejects.toThrow(IamTransportError)
	})

	test('the verifier reports an unsupported set as unavailable even when its EC member could verify', async () => {
		const body = { keys: [...PUBLIC_JWKS.keys, { kty: 'RSA', n: 'modulus', e: 'AQAB' }] }
		const { rpc, calls } = stub(200, body)
		const verifier = new TokenVerifier(rpc, ISSUER, APP)
		expect(await verifier.verify(await signToken())).toEqual({ ok: false, reason: 'unavailable' })
		expect(calls).toHaveLength(1)
	})

	test('a parsed EC set still verifies locally and caches per binding', async () => {
		const { rpc, calls } = stub(200, { keys: PUBLIC_JWKS.keys.map(key => ({ ...key, extra: true })) })
		const token = await signToken()
		expect((await new TokenVerifier(rpc, ISSUER, APP).verify(token)).ok).toBe(true)
		expect((await new TokenVerifier(rpc, ISSUER, APP).verify(token)).ok).toBe(true)
		expect(await new TokenVerifier(rpc, ISSUER, 'other-app').verify(token)).toEqual({ ok: false, reason: 'invalid' })
		expect(calls).toHaveLength(1)
	})
})

describe('a DECIDED negative is a result, never a throw', () => {
	test('mintToken', async () => {
		const { rpc } = stub(200, { ok: false, reason: 'no_session' })
		expect(await rpc.mintToken({ app: 'vozka', session: null, requestId: 'r' })).toEqual({ ok: false, reason: 'no_session' })
	})

	test('mintFromKey', async () => {
		const { rpc } = stub(200, { ok: false, reason: 'invalid_key' })
		expect(await rpc.mintFromKey({ app: 'vozka', key: 'px_nope', requestId: 'r' })).toEqual({ ok: false, reason: 'invalid_key' })
	})

	test('revokeKey distinguishes not_found from the delegation reasons', async () => {
		const { rpc } = stub(200, { ok: false, reason: 'not_found' })
		expect(await rpc.revokeKey({ app: 'vozka', credential: null, requestId: 'r', id: 'c1' })).toEqual({ ok: false, reason: 'not_found' })
	})

	test('an UNRECOGNISED reason degrades to a deny, never to an allow', async () => {
		const { rpc } = stub(200, { ok: false, reason: 'brand_new_reason_we_do_not_know' })
		const result = await rpc.mintFromKey({ app: 'vozka', key: 'px_x', requestId: 'r' })
		expect(result).toEqual({ ok: false, reason: 'invalid_key' })
	})
})

describe('a TRANSPORT fault throws, and says nothing about the request', () => {
	test('a non-200 status', async () => {
		const { rpc } = stub(401, { error: 'unauthorized' })
		await expect(rpc.mintToken({ app: 'vozka', session: 's', requestId: 'r' })).rejects.toBeInstanceOf(IamTransportError)
	})

	test('a disabled surface (404, the fail-closed default of an unset key)', async () => {
		const { rpc } = stub(404, { error: 'not found' })
		await expect(rpc.getJwks()).rejects.toBeInstanceOf(IamTransportError)
	})

	test('a body that does not match the contract', async () => {
		// `ok` is neither true nor false — a decided negative it is not, and a success decode fails.
		const { rpc } = stub(200, { token: 'px_t' })
		await expect(rpc.mintToken({ app: 'vozka', session: 's', requestId: 'r' })).rejects.toThrow(IamTransportError)
	})

	test('a network failure — and the message carries no URL, no key, no cause', async () => {
		const rpc = new HttpIamRpc({
			origin: 'http://iam:3000',
			key: 'transport-key-0123456789abcdef',
			fetch: () => Promise.reject(new Error('connect ECONNREFUSED http://iam:3000/rpc/audit')),
		})
		const failure = await rpc.getJwks().then(() => null, (err: unknown) => err)
		expect(failure).toBeInstanceOf(IamTransportError)
		const message = failure instanceof Error ? failure.message : ''
		expect(message).toBe('iam unavailable: getJwks')
		expect(message).not.toContain('transport-key')
		expect(message).not.toContain('iam:3000')
	})
})

describe('successful results decode field by field', () => {
	test('success fields do not require an ok discriminator and strip extensions', async () => {
		for (const ok of [undefined, null, 'true', 0, true]) {
			const { rpc } = stub(200, { ok, token: 'jwt', expiresAt: -0.5, extra: 'ignored' })
			expect(await rpc.mintToken({ app: 'a', session: 's', requestId: 'r' })).toStrictEqual({ ok: true, token: 'jwt', expiresAt: -0.5 })
		}
	})

	test('literal false takes precedence over success fields even with a malformed reason', async () => {
		for (const reason of [undefined, null, 42, {}, '']) {
			const { rpc } = stub(200, { ok: false, reason, token: 'jwt', expiresAt: 10 })
			expect(await rpc.mintFromKey({ app: 'a', key: 'px_k', requestId: 'r' })).toStrictEqual({ ok: false, reason: 'invalid_key' })
		}
	})

	test('malformed optional key identity is omitted, while empty required strings remain valid', async () => {
		for (const principalId of [undefined, null, 42, {}]) {
			expect(await stub(200, { token: '', id: '', principalId }).rpc.issueKey({ app: 'a', credential: null, requestId: 'r', expiresAt: 1 }))
				.toStrictEqual({ ok: true, token: '', id: '' })
		}
	})

	test('principal optional fields default by type and one malformed required field rejects the whole list', async () => {
		const input = { app: 'a', credential: null, requestId: 'r' }
		const principal = { id: '', label: '', type: 'service', email: 42, disabled: 'true', extra: true }
		expect(await stub(200, { principals: [principal] }).rpc.listPrincipals(input)).toStrictEqual({
			ok: true,
			principals: [{ id: '', label: '', type: 'service', email: null, disabled: false }],
		})
		await expect(stub(200, { principals: [principal, { ...principal, type: null }] }).rpc.listPrincipals(input))
			.rejects.toThrow(IamTransportError)
	})

	test('issueKey carries the optional principalId only when present', async () => {
		const bound = stub(200, { ok: true, token: 'px_k', id: 'cred-1', principalId: 'p1' })
		expect(await bound.rpc.issueKey({ app: 'vozka', credential: null, requestId: 'r', expiresAt: 1 })).toEqual({
			ok: true,
			token: 'px_k',
			id: 'cred-1',
			principalId: 'p1',
		})

		const standalone = stub(200, { ok: true, token: 'px_k', id: 'cred-2' })
		expect(await standalone.rpc.issueKey({ app: 'vozka', credential: null, requestId: 'r', expiresAt: 1 })).toEqual({
			ok: true,
			token: 'px_k',
			id: 'cred-2',
		})
	})

	test('listPrincipals narrows the principal type and defaults a missing email/disabled', async () => {
		const { rpc } = stub(200, {
			ok: true,
			principals: [
				{ id: 'p1', type: 'user', label: 'a@x.cz', email: 'a@x.cz', disabled: false },
				{ id: 'p2', type: 'something-else', label: 'b' },
			],
		})
		const result = await rpc.listPrincipals({ app: 'vozka', credential: null, requestId: 'r' })
		expect(result).toEqual({
			ok: true,
			principals: [
				{ id: 'p1', type: 'user', label: 'a@x.cz', email: 'a@x.cz', disabled: false },
				// Anything but 'service' is a user, and an absent email/disabled is null/false.
				{ id: 'p2', type: 'user', label: 'b', email: null, disabled: false },
			],
		})
	})
})
