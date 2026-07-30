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

describe('Operations console gateway', () => {
	test('strips the console prefix and preserves Operations-owned credentials', async () => {
		const gateway = new RecordingGateway()
		const response = await forwardOperationsApi(
			new Request('https://console.test/operations/api/issues?status=open', {
				headers: { cookie: 'px_session=session-one' },
			}),
			{ gateway, publicIamUrl: 'https://iam.test' },
		)

		expect(response.status).toBe(200)
		expect(gateway.requests[0]?.url).toBe('https://console.test/api/issues?status=open')
		expect(gateway.requests[0]?.headers.get('cookie')).toBe('px_session=session-one')
	})

	test('allows only safe methods without a same-origin proof, including guarding PUT', async () => {
		const gateway = new RecordingGateway()
		const missingOrigin = await forwardOperationsApi(
			new Request('https://console.test/operations/api/issues/one', { method: 'PUT', body: '{}' }),
			{ gateway },
		)
		const crossOrigin = await forwardOperationsApi(
			new Request('https://console.test/operations/api/issues/one', {
				method: 'PUT',
				headers: { origin: 'https://attacker.test' },
				body: '{}',
			}),
			{ gateway },
		)
		const sameOrigin = await forwardOperationsApi(
			new Request('https://console.test/operations/api/issues/one', {
				method: 'PUT',
				headers: { origin: 'https://console.test' },
				body: '{}',
			}),
			{ gateway },
		)

		expect(missingOrigin.status).toBe(403)
		expect(crossOrigin.status).toBe(403)
		expect(sameOrigin.status).toBe(200)
		expect(gateway.requests).toHaveLength(1)
	})

	test('never transports direct ingest or artifact paths', async () => {
		const gateway = new RecordingGateway()
		for (
			const path of [
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
			new Request('https://console.test/operations/api/issues'),
			{ gateway: unauthorized, publicIamUrl: 'https://iam.test' },
		)
		const unauthorizedBody: unknown = await response.json()
		expect(unauthorizedBody).toEqual({
			error: 'authentication required',
			loginUrl: 'https://iam.test/auth/login?redirect=https%3A%2F%2Fconsole.test',
		})

		const unavailable = await forwardOperationsApi(
			new Request('https://console.test/operations/api/issues'),
			{ gateway: new RecordingGateway(Response.json({ ok: false }), true) },
		)
		expect(unavailable.status).toBe(503)
		const unavailableBody: unknown = await unavailable.json()
		expect(unavailableBody).toEqual({ error: 'operations unavailable' })
	})
})
