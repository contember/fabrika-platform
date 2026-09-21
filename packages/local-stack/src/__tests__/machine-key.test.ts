import { describe, expect, test } from 'bun:test'
import { machineKeyStillWorks } from '../machine-key'

describe('machine key readiness', () => {
	test('lists namespaces through RPC with the machine bearer and manual redirects', async () => {
		const works = await machineKeyStillWorks('px_test', async (input, init) => {
			expect(input).toBe('http://control.fabrika.localhost:18080/api/rpc')
			expect(init?.method).toBe('POST')
			expect(init?.redirect).toBe('manual')
			expect(new Headers(init?.headers).get('authorization')).toBe('Bearer px_test')
			expect(JSON.parse(typeof init?.body === 'string' ? init.body : '')).toEqual({ method: 'namespaces.list', input: null })
			return Response.json({ result: { items: [], operator: null } })
		})
		expect(works).toBe(true)
	})

	test('rejects redirects, failed HTTP, RPC errors, malformed results and transport failures', async () => {
		for (
			const response of [
				new Response(null, { status: 302, headers: { location: 'https://iam.test/auth/login' } }),
				Response.json({ result: { items: [] } }, { status: 503 }),
				Response.json({ error: { type: 'auth', message: 'Denied' } }),
				Response.json({}),
				Response.json({ result: { items: 'invalid' } }),
				new Response('<html>login</html>'),
			]
		) {
			expect(await machineKeyStillWorks('px_test', async () => response)).toBe(false)
		}
		expect(
			await machineKeyStillWorks('px_test', async () => {
				throw new Error('offline')
			}),
		).toBe(false)
	})
})
