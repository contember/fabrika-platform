// The HTTP transport for `IamRpc`. What is asserted here is the WIRE and the failure split — the two
// things that cannot be checked by the type system and that fail closed but silently when wrong.
//
// The wire is `@fabrika/iam`'s `src/rpc-http.ts`; a mismatch there becomes a 5xx on every gated
// request with nothing in the message saying why, so the path, the method, the bearer and the body
// are each pinned. The failure split is the other half: a DECIDED negative (`{ ok:false, reason }` at
// 200) must come back as a result, and only a transport fault may throw.

import { describe, expect, test } from 'bun:test'
import { HttpIamRpc, IamTransportError } from '../rpc-http'

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
		expect(jwks.keys).toEqual([{ kty: 'EC', crv: 'P-256', x: 'x', y: 'y', kid: 'k1', alg: 'ES256', use: 'sig' }])
	})

	test('audit is a 204 with no body, and resolves rather than trying to decode one', async () => {
		const { rpc, calls } = stub(204, null)

		await rpc.audit({
			app: 'vozka',
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
	test('issueKey carries the optional principalId only when present', async () => {
		const bound = stub(200, { ok: true, token: 'px_k', id: 'cred-1', principalId: 'p1' })
		expect(await bound.rpc.issueKey({ app: 'vozka', credential: null, requestId: 'r' })).toEqual({
			ok: true,
			token: 'px_k',
			id: 'cred-1',
			principalId: 'p1',
		})

		const standalone = stub(200, { ok: true, token: 'px_k', id: 'cred-2' })
		expect(await standalone.rpc.issueKey({ app: 'vozka', credential: null, requestId: 'r' })).toEqual({ ok: true, token: 'px_k', id: 'cred-2' })
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

	test('issueJwt requires all three fields; a partial body is a transport fault', async () => {
		const ok = stub(200, { ok: true, token: 'jwt', expiresAt: 99, id: 'aud-1' })
		expect(await ok.rpc.issueJwt({ app: 'vozka', credential: null, requestId: 'r', permissions: [] })).toEqual({
			ok: true,
			token: 'jwt',
			expiresAt: 99,
			id: 'aud-1',
		})

		const partial = stub(200, { ok: true, token: 'jwt' })
		await expect(partial.rpc.issueJwt({ app: 'vozka', credential: null, requestId: 'r', permissions: [] })).rejects.toBeInstanceOf(IamTransportError)
	})
})
