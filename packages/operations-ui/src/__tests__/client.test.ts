import { describe, expect, test } from 'bun:test'
import { createOperationsClient, OperationsApiError, operationsApiUrl, type OperationsFetch } from '../client'

describe('operations client', () => {
	test('keeps requests behind the same-origin gateway', () => {
		expect(operationsApiUrl('/issues')).toBe('/operations/api/issues')
		expect(() => operationsApiUrl('https://example.test/issues')).toThrow('same-origin')
		expect(() => operationsApiUrl('//example.test/issues')).toThrow('same-origin')
	})

	test('preserves the requested method and includes the browser session', async () => {
		let seenMethod: string | undefined
		let seenCredentials: RequestCredentials | undefined
		const fetcher: OperationsFetch = async (_input, init) => {
			seenMethod = init?.method
			seenCredentials = init?.credentials
			return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })
		}

		const result = await createOperationsClient(fetcher).request<{ ok: boolean }>('PUT', '/issues/opaque', { status: 'resolved' })

		expect(result).toEqual({ ok: true })
		expect(seenMethod).toBe('PUT')
		expect(seenCredentials).toBe('include')
	})

	test('returns a bounded API error', async () => {
		const fetcher: OperationsFetch = async () =>
			new Response(JSON.stringify({ message: 'Operations unavailable' }), {
				status: 503,
				headers: { 'content-type': 'application/json' },
			})

		await expect(createOperationsClient(fetcher).request('GET', '/issues')).rejects.toEqual(
			new OperationsApiError(503, 'Operations unavailable'),
		)
	})
})
