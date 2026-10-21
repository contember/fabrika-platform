// The identifications at a terminal over IAM's membership transport (ADR-0067): the path, the bearer and the body are
// pinned, a decided refusal comes back as a result, and only a transport fault or a body outside the contract throws.

import { describe, expect, test } from 'bun:test'
import { HttpIamTerminals, IamTransportError } from '../rpc-http'

interface Call {
	url: string
	init: RequestInit
}

function stub(status: number, body: unknown): { rpc: HttpIamTerminals; calls: Call[] } {
	const calls: Call[] = []
	const rpc = new HttpIamTerminals({
		origin: 'https://iam.test/',
		key: 'px_membership-key',
		fetch: (url, init) => {
			calls.push({ url, init })
			return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
		},
	})
	return { rpc, calls }
}

const caller = { app: 'kiosk@prod', credential: 'workload-token', requestId: 'r1' }

describe('the identification wire', () => {
	test('POSTs /membership/<method> with the membership key and the input as the body', async () => {
		const { rpc, calls } = stub(200, { ok: true, terminal: { id: 'terminal-1', label: 'Entrance' }, expiresAt: 42 })
		expect(await rpc.inspectIdentification({ ...caller, id: 'ident-1' })).toEqual({
			ok: true,
			terminal: { id: 'terminal-1', label: 'Entrance' },
			expiresAt: 42,
		})
		expect(calls[0]?.url).toBe('https://iam.test/membership/inspectIdentification')
		expect(calls[0]?.init.method).toBe('POST')
		expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('Bearer px_membership-key')
		expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ ...caller, id: 'ident-1' })
	})

	test('assertIdentity answers the callback URL, and cancelIdentification an empty success', async () => {
		const callbackUrl = 'https://kiosk.test/__fabrika/auth/callback?code=c1&state=s1'
		const asserted = stub(200, { ok: true, callbackUrl })
		expect(await asserted.rpc.assertIdentity({ ...caller, id: 'ident-1', principalId: 'person-7' })).toEqual({ ok: true, callbackUrl })
		expect(asserted.calls[0]?.url).toBe('https://iam.test/membership/assertIdentity')
		expect(await stub(200, { ok: true }).rpc.cancelIdentification({ ...caller, id: 'ident-1' })).toEqual({ ok: true })
	})

	test('a decided refusal is a result; an unknown reason degrades to not_allowed', async () => {
		expect(await stub(200, { ok: false, reason: 'invalid_principal' }).rpc.assertIdentity({ ...caller, id: 'i', principalId: 'p' })).toEqual({
			ok: false,
			reason: 'invalid_principal',
		})
		expect(await stub(200, { ok: false, reason: 'not_found' }).rpc.inspectIdentification({ ...caller, id: 'i' })).toEqual({
			ok: false,
			reason: 'not_found',
		})
		expect(await stub(200, { ok: false, reason: 'granted_anyway' }).rpc.cancelIdentification({ ...caller, id: 'i' })).toEqual({
			ok: false,
			reason: 'not_allowed',
		})
	})

	test('a non-200, or a success body outside the contract, is a transport fault', async () => {
		await expect(stub(401, { error: 'unauthorized' }).rpc.inspectIdentification({ ...caller, id: 'i' })).rejects.toBeInstanceOf(IamTransportError)
		await expect(stub(200, { ok: true, terminal: { id: 'terminal-1' }, expiresAt: 42 }).rpc.inspectIdentification({ ...caller, id: 'i' })).rejects
			.toBeInstanceOf(IamTransportError)
		await expect(stub(200, { ok: true, callbackUrl: 'not a url' }).rpc.assertIdentity({ ...caller, id: 'i', principalId: 'p' })).rejects
			.toBeInstanceOf(IamTransportError)
	})
})
