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

	test('builds typed operator queries and encodes opaque route identifiers', async () => {
		const requests: { input: string; init: RequestInit }[] = []
		const fetcher: OperationsFetch = async (input, init) => {
			requests.push({ input, init })
			return Response.json({ items: [], nextCursor: null, summary: { total: 0, open: 0, resolved: 0, ignored: 0 } })
		}
		const client = createOperationsClient(fetcher)

		await client.issues({ sourceId: 'source / one', status: 'open', limit: 25 })
		await client.mutateIssue('issue / one', { kind: 'status', status: 'resolved' })

		expect(requests[0]?.input).toBe('/operations/api/issues?sourceId=source+%2F+one&status=open&limit=25')
		expect(requests[1]?.input).toBe('/operations/api/issues/issue%20%2F%20one')
		expect(requests[1]?.init.method).toBe('PUT')
		expect(requests[1]?.init.body).toBe(JSON.stringify({ kind: 'status', status: 'resolved' }))
	})

	test('preserves a bounded login bounce outside the browser', async () => {
		const fetcher: OperationsFetch = async () =>
			new Response(JSON.stringify({ error: 'Operations unavailable', loginUrl: 'https://iam.test/auth/login' }), {
				status: 401,
				headers: { 'content-type': 'application/json' },
			})

		await expect(createOperationsClient(fetcher).request('GET', '/issues')).rejects.toEqual(
			new OperationsApiError(401, 'Operations unavailable', 'https://iam.test/auth/login'),
		)
	})
})
