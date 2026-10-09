import { expect, spyOn, test } from 'bun:test'
import { controlRequest } from '../../notes-deploy'

test('Control list RPCs omit input on the wire while keyed calls preserve their coordinates', async () => {
	const requests: Request[] = []
	const response = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		requests.push(new Request(url, init))
		return Response.json({ result: { items: [] } })
	}
	const transport = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(response, { preconnect: fetch.preconnect }))
	try {
		for (const method of ['namespaces.list', 'apps.list']) {
			await expect(controlRequest(method, 'test-machine-key')).resolves.toEqual({ items: [] })
		}
		await controlRequest('namespaces.get', 'test-machine-key', { namespaceId: 'apps-prod' })
		expect(requests).toHaveLength(3)
		const bodies: unknown[] = []
		for (const request of requests) {
			expect(request.method).toBe('POST')
			expect(new URL(request.url).pathname).toBe('/api/rpc')
			expect(request.headers.get('authorization')).toBe('Bearer test-machine-key')
			bodies.push(await request.json())
		}
		expect(bodies).toEqual([
			{ method: 'namespaces.list' },
			{ method: 'apps.list' },
			{ method: 'namespaces.get', input: { namespaceId: 'apps-prod' } },
		])
	} finally {
		transport.mockRestore()
	}
})
