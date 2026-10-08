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
			{ gateway, publicIamUrl: 'https://iam.test', publicOrigin: CONSOLE },
		)

		expect(response.status).toBe(200)
		expect(gateway.requests[0]?.url).toBe('https://console.test/api/rpc?trace=one')
		expect(gateway.requests[0]?.headers.get('cookie')).toBe('__Host-px_session=session-one')
		expect(gateway.requests[0]?.headers.get('X-Fabrika-Token')).toBe('trusted-token')
		expect(gateway.requests[0]?.headers.get('origin')).toBe(CONSOLE)
		const forwardedBody: unknown = await gateway.requests[0]?.json()
		expect(forwardedBody).toEqual({ method: 'issues.list', input: {} })
	})

	test('allows only safe methods without a same-origin proof, including guarding PUT', async () => {
		const gateway = new RecordingGateway()
		const missingOrigin = await forwardOperationsApi(
			new Request('https://console.test/operations/api/rpc', { method: 'PUT', body: '{}' }),
			{ gateway, publicOrigin: CONSOLE },
		)
		const crossOrigin = await forwardOperationsApi(
			new Request('https://console.test/operations/api/rpc', {
				method: 'PUT',
				headers: { origin: 'https://attacker.test' },
				body: '{}',
			}),
			{ gateway, publicOrigin: CONSOLE },
		)
		const sameOrigin = await forwardOperationsApi(
			new Request('https://console.test/operations/api/rpc', {
				method: 'PUT',
				headers: { origin: 'https://console.test' },
				body: '{}',
			}),
			{ gateway, publicOrigin: CONSOLE },
		)

		expect(missingOrigin.status).toBe(403)
		expect(crossOrigin.status).toBe(403)
		expect(sameOrigin.status).toBe(200)
		expect(gateway.requests).toHaveLength(1)
	})

	test('the origin compared against is CONFIGURED, never the reconstructed request URL', async () => {
		// Behind a TLS-terminating balancer the process is reached over plain HTTP, so `request.url`
		// reads `http://console.test` while the browser truthfully sent `https://console.test`. The old
		// comparison refused every genuine operator write in exactly that shape.
		const gateway = new RecordingGateway()
		const behindBalancer = await forwardOperationsApi(
			new Request('http://console.test/operations/api/rpc', {
				method: 'PUT',
				headers: { origin: CONSOLE },
				body: '{}',
			}),
			{ gateway, publicOrigin: CONSOLE },
		)
		expect(behindBalancer.status).toBe(200)

		// With nothing configured the guard fails closed rather than trusting the socket.
		const unconfigured = await forwardOperationsApi(
			new Request('https://console.test/operations/api/rpc', {
				method: 'PUT',
				headers: { origin: CONSOLE },
				body: '{}',
			}),
			{ gateway },
		)
		expect(unconfigured.status).toBe(403)
	})

	test('applies the shared same-origin rule: Sec-Fetch-Site, Origin: null and the Referer fallback', async () => {
		const send = (headers: Record<string, string>) =>
			forwardOperationsApi(
				new Request('http://console.test/operations/api/rpc', { method: 'POST', headers, body: '{}' }),
				{ gateway: new RecordingGateway(), publicOrigin: CONSOLE },
			)
		expect((await send({ origin: CONSOLE, 'sec-fetch-site': 'cross-site' })).status).toBe(403)
		expect((await send({ origin: 'null' })).status).toBe(403)
		expect((await send({ origin: 'null', 'sec-fetch-site': 'same-origin' })).status).toBe(200)
		expect((await send({ referer: `${CONSOLE}/operations/issues` })).status).toBe(200)
		expect((await send({ referer: 'https://attacker.test/' })).status).toBe(403)
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
			{ gateway: unauthorized, publicIamUrl: 'https://iam.test', publicOrigin: CONSOLE },
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
