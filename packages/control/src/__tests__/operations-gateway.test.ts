import type { HttpService } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import { forwardOperationsApi } from '../operations-gateway'

class RecordingGateway implements HttpService {
	readonly requests: Request[] = []

	constructor(private readonly response: Response = Response.json({ ok: true }), private readonly fails = false) {}

	fetch(request: Request): Promise<Response> {
		this.requests.push(request)
		return this.fails ? Promise.reject(new Error('offline')) : Promise.resolve(this.response)
	}
}

const CONSOLE = 'https://console.test'

describe('Operations console gateway', () => {
	test('strips the console prefix and preserves Operations-owned credentials', async () => {
		const gateway = new RecordingGateway()
		const response = await forwardOperationsApi(
			new Request('https://console.test/operations/api/rpc?trace=one', {
				method: 'POST',
				headers: { cookie: '__Host-px_session=session-one', 'X-Fabrika-Token': 'trusted-token', origin: CONSOLE },
				body: JSON.stringify({ method: 'issues.list', input: {} }),
			}),
			{ gateway, publicIamUrl: 'https://iam.test' },
		)

		expect(response.status).toBe(200)
		expect(gateway.requests[0]?.url).toBe('https://console.test/api/rpc?trace=one')
		expect(gateway.requests[0]?.headers.get('cookie')).toBe('__Host-px_session=session-one')
		expect(gateway.requests[0]?.headers.get('X-Fabrika-Token')).toBe('trusted-token')
		expect(gateway.requests[0]?.headers.get('origin')).toBe(CONSOLE)
		const forwardedBody: unknown = await gateway.requests[0]?.json()
		expect(forwardedBody).toEqual({ method: 'issues.list', input: {} })
	})

	test('reads no origin: a state change is transported as the proxy admitted it', async () => {
		// Admission is the proxy's (ADR-0022): a session's POST reaches here only with `Sec-Fetch-Site: same-origin`,
		// and a bearer is explicit authority. `console-admission.test.ts` drives both through the real proxy.
		const gateway = new RecordingGateway()
		const response = await forwardOperationsApi(new Request('http://console.test/operations/api/rpc', { method: 'PUT', body: '{}' }), { gateway })
		expect(response.status).toBe(200)
		expect(gateway.requests).toHaveLength(1)
	})

	test('never transports removed operator REST, direct ingest, or artifact paths', async () => {
		const gateway = new RecordingGateway()
		for (
			const path of [
				'/operations/api',
				'/operations/api/issues',
				'/operations/api/issues/one',
				'/operations/api/rpc/extra',
				'/operations/api/ingest',
				'/operations/api/projects/source/envelope',
				'/operations/api/releases/one/artifacts',
				'/operations/api/releases/one/source-maps',
			]
		) {
			expect((await forwardOperationsApi(new Request(`https://console.test${path}`), { gateway })).status).toBe(404)
		}
		expect(gateway.requests).toHaveLength(0)
	})

	test('preserves IAM login bounce semantics and isolates transport outages', async () => {
		const unauthorized = new RecordingGateway(Response.json({ error: 'unauthorized' }, { status: 401 }))
		const response = await forwardOperationsApi(
			new Request('https://console.test/operations/api/rpc'),
			{ gateway: unauthorized, publicIamUrl: 'https://iam.test' },
		)
		const unauthorizedBody: unknown = await response.json()
		expect(unauthorizedBody).toEqual({
			error: { type: 'auth', message: 'authentication required', loginUrl: 'https://iam.test/auth/login?redirect=https%3A%2F%2Fconsole.test' },
		})

		const unavailable = await forwardOperationsApi(
			new Request('https://console.test/operations/api/rpc'),
			{ gateway: new RecordingGateway(Response.json({ ok: false }), true) },
		)
		expect(unavailable.status).toBe(503)
		const unavailableBody: unknown = await unavailable.json()
		expect(unavailableBody).toEqual({ error: 'operations unavailable' })
	})

	test('returns the structured authentication envelope expected by the RPC client', async () => {
		const unauthorized = new RecordingGateway(Response.json({ error: 'unauthorized' }, { status: 401 }))
		const response = await forwardOperationsApi(
			new Request('https://console.test/operations/api/rpc', {
				method: 'POST',
				headers: { origin: 'https://console.test' },
				body: JSON.stringify({ method: 'issues', input: {} }),
			}),
			{ gateway: unauthorized, publicIamUrl: 'https://iam.test' },
		)

		expect(response.status).toBe(401)
		const responseBody: unknown = await response.json()
		expect(responseBody).toEqual({
			error: {
				type: 'auth',
				message: 'authentication required',
				loginUrl: 'https://iam.test/auth/login?redirect=https%3A%2F%2Fconsole.test',
			},
		})
		expect(unauthorized.requests[0]?.url).toBe('https://console.test/api/rpc')
	})
})
