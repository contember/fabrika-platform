import { PROXY_TOKEN_HEADER } from '@fabrika/auth'
import type { HttpService } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import { forwardIamAdmin } from '../iam-admin'
import { HttpIamAdminGateway } from '../zerops/iam-admin'

class RecordingGateway implements HttpService {
	requests: Request[] = []

	constructor(private readonly response: Response = Response.json({ ok: true })) {}

	fetch(request: Request): Promise<Response> {
		this.requests.push(request)
		return Promise.resolve(this.response)
	}
}

describe('IAM admin gateway', () => {
	test('strips the console prefix and replaces the app cookie with the proxy token', async () => {
		const gateway = new RecordingGateway()
		const response = await forwardIamAdmin(
			new Request('https://console.test/iam/admin/apps/notes/schema?view=full', {
				headers: { cookie: '__Host-px_session=session-one; app_cookie=kept-here', [PROXY_TOKEN_HEADER]: 'proxy-jwt' },
			}),
			{ gateway, publicIamUrl: 'https://iam.test' },
		)

		expect(response.status).toBe(200)
		expect(gateway.requests).toHaveLength(1)
		expect(gateway.requests[0]?.url).toBe('https://console.test/admin/apps/notes/schema?view=full')
		expect(gateway.requests[0]?.headers.get('cookie')).toBeNull()
		expect(gateway.requests[0]?.headers.get('authorization')).toBe('Bearer proxy-jwt')
	})

	test('adds the public IAM login URL to an unauthenticated response', async () => {
		const gateway = new RecordingGateway(Response.json({ error: 'unauthorized' }, { status: 401 }))
		const response = await forwardIamAdmin(
			new Request('https://console.test/iam/admin/me'),
			{ gateway, publicIamUrl: 'https://iam.test' },
		)
		const body: unknown = await response.json()

		expect(response.status).toBe(401)
		expect(body).toEqual({
			error: 'authentication required',
			loginUrl: 'https://iam.test/auth/login?redirect=https%3A%2F%2Fconsole.test',
		})
	})

	test('returns the structural auth envelope expected by the RPC client', async () => {
		const gateway = new RecordingGateway(Response.json({ error: { type: 'auth', message: 'unauthorized' } }, { status: 401 }))
		const response = await forwardIamAdmin(
			new Request('https://console.test/iam/admin/rpc', { method: 'POST', headers: { origin: 'https://console.test' }, body: '{}' }),
			{ gateway, publicIamUrl: 'https://iam.test' },
		)
		const body: unknown = await response.json()

		expect(response.status).toBe(401)
		expect(body).toEqual({
			error: {
				type: 'auth',
				message: 'unauthorized',
				loginUrl: 'https://iam.test/auth/login?redirect=https%3A%2F%2Fconsole.test',
			},
		})
	})

	test('rewrites the private hop, injects only the explicit local bearer, and leaves Origin alone', async () => {
		let received: { url: string; origin: string | null; authorization: string | null; cookie: string | null; body: string } | undefined
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				received = {
					url: request.url,
					origin: request.headers.get('origin'),
					authorization: request.headers.get('authorization'),
					cookie: request.headers.get('cookie'),
					body: await request.text(),
				}
				return Response.json({ ok: true })
			},
		})
		try {
			const gateway = new HttpIamAdminGateway(`http://127.0.0.1:${server.port}`)
			const response = await gateway.fetch(
				new Request('http://control.localhost/admin/api-keys?limit=2', {
					method: 'POST',
					headers: {
						origin: 'http://control.localhost',
						authorization: 'Bearer px_caller',
						cookie: '__Host-px_session=session-one',
						'content-type': 'application/json',
					},
					body: '{"label":"test"}',
				}),
			)

			expect(response.status).toBe(200)
			expect(received?.url).toBe(`http://127.0.0.1:${server.port}/admin/api-keys?limit=2`)
			// The BROWSER's origin, unmodified. It used to be rewritten to IAM's private RPC origin so
			// that IAM's issuer-based CSRF check would pass — which it never did in any deployment whose
			// private address differed from its public issuer, and which could not have been right anyway:
			// the browser's origin is the console's, never IAM's. IAM is told which origins may drive it.
			expect(received?.origin).toBe('http://control.localhost')
			// The CALLER's credential, forwarded verbatim. The gateway never supplies one of its own —
			// IAM authorizes and audits whoever actually made the request.
			expect(received?.authorization).toBe('Bearer px_caller')
			expect(received?.cookie).toBe('__Host-px_session=session-one')
			expect(received?.body).toBe('{"label":"test"}')
		} finally {
			await server.stop(true)
		}
	})
})

// Admission is the proxy's (ADR-0022): `console-admission.test.ts` drives cross-site, same-site and same-origin
// sessions and bearers through the real proxy, so this gateway reads no origin at all.

describe('the gateway reads no origin', () => {
	test('a state change is transported whatever its Origin, behind a balancer or not', async () => {
		const gateway = new RecordingGateway(Response.json({ ok: true }))
		const response = await forwardIamAdmin(new Request('http://console.test/iam/admin/rpc', { method: 'PUT', body: '{}' }), { gateway })
		expect(response.status).toBe(200)
		expect(gateway.requests).toHaveLength(1)
	})
})
