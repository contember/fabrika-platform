import { describe, expect, test } from 'bun:test'
import { createOperationsClient, type OperationsFetch, RpcError } from '../client'

interface RecordedRequest {
	readonly url: string
	readonly init: RequestInit | undefined
}

function requestUrl(input: RequestInfo | URL): string {
	return input instanceof Request ? input.url : input.toString()
}

describe('operations client', () => {
	test('uses the typed RPC gateway and includes the browser session', async () => {
		const requests: RecordedRequest[] = []
		const fetcher: OperationsFetch = async (input, init) => {
			requests.push({ url: requestUrl(input), init })
			return Response.json({ result: { items: [], nextCursor: null, summary: { total: 0, open: 0, resolved: 0, ignored: 0 } } })
		}
		const client = createOperationsClient(fetcher)

		await client.issues({ sourceId: 'source / one', status: 'open', limit: 25 })
		await client.mutateIssue('issue / one', { kind: 'status', status: 'resolved' })

		expect(requests[0]?.url).toBe('/operations/api/rpc')
		expect(requests[0]?.init?.method).toBe('POST')
		expect(requests[0]?.init?.credentials).toBe('include')
		expect(requests[0]?.init?.body).toBe(JSON.stringify({
			method: 'issues',
			input: { sourceId: 'source / one', status: 'open', limit: 25 },
		}))
		expect(requests[1]?.init?.body).toBe(JSON.stringify({
			method: 'mutateIssue',
			input: { issueId: 'issue / one', mutation: { kind: 'status', status: 'resolved' } },
		}))
	})

	test('preserves a bounded login bounce outside the browser', async () => {
		const fetcher: OperationsFetch = async () =>
			Response.json(
				{ error: { type: 'auth', message: 'authentication required', loginUrl: 'https://iam.test/auth/login' } },
				{ status: 401 },
			)

		const error = await createOperationsClient(fetcher).issues().catch((cause: unknown) => cause)
		expect(error).toBeInstanceOf(RpcError)
		if (!(error instanceof RpcError)) throw new Error('expected RpcError')
		expect(error.type).toBe('auth')
		expect(error.httpStatus).toBe(401)
		expect(error.loginUrl).toBe('https://iam.test/auth/login')
	})

	test('carries the HTTP status used by the optional latest-event loader', async () => {
		const fetcher: OperationsFetch = async () => Response.json({ error: { type: 'not_found', message: 'event not found' } }, { status: 404 })

		const error = await createOperationsClient(fetcher).latestEvent('issue-one').catch((cause: unknown) => cause)
		expect(error).toBeInstanceOf(RpcError)
		if (!(error instanceof RpcError)) throw new Error('expected RpcError')
		expect(error.httpStatus).toBe(404)
	})
})
