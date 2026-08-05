import type { HttpService } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import { forwardIamAdmin } from '../iam-admin'
import { HttpIamAdminGateway } from '../node/iam-admin'

class RecordingGateway implements HttpService {
	requests: Request[] = []

	constructor(private readonly response: Response = Response.json({ ok: true })) {}

	fetch(request: Request): Promise<Response> {
		this.requests.push(request)
		return Promise.resolve(this.response)
	}
}

describe('IAM admin gateway', () => {
	test('strips the console prefix and preserves the IAM-owned request', async () => {
		const gateway = new RecordingGateway()
		const response = await forwardIamAdmin(
			new Request('https://console.test/iam/admin/apps/notes/schema?view=full', {
				headers: { cookie: '__Host-px_session=session-one' },
			}),
			{ gateway, publicIamUrl: 'https://iam.test', publicOrigin: 'https://console.test' },
		)

		expect(response.status).toBe(200)
		expect(gateway.requests).toHaveLength(1)
		expect(gateway.requests[0]?.url).toBe('https://console.test/admin/apps/notes/schema?view=full')
		expect(gateway.requests[0]?.headers.get('cookie')).toBe('__Host-px_session=session-one')
	})

	test('rejects cross-origin mutations before they reach IAM', async () => {
		const gateway = new RecordingGateway()
		const response = await forwardIamAdmin(
			new Request('https://console.test/iam/admin/api-keys', {
				method: 'POST',
				headers: { origin: 'https://attacker.test' },
				body: '{}',
			}),
			{ gateway },
		)

		expect(response.status).toBe(403)
		expect(gateway.requests).toHaveLength(0)
	})

	test('adds the public IAM login URL to an unauthenticated response', async () => {
		const gateway = new RecordingGateway(Response.json({ error: 'unauthorized' }, { status: 401 }))
		const response = await forwardIamAdmin(
			new Request('https://console.test/iam/admin/me'),
			{ gateway, publicIamUrl: 'https://iam.test', publicOrigin: 'https://console.test' },
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
			{ gateway, publicIamUrl: 'https://iam.test', publicOrigin: 'https://console.test' },
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

// ── The CSRF origin guard (backlog 50) ────────────────────────────────────────
//
// Both cases below were live 403s on Zerops: the console could not write anything, and neither could
// any machine caller. The gateway is reached over plain HTTP behind the balancer, which is why the
// request URL cannot be the thing the browser's `Origin` is compared against.

describe('the gateway CSRF guard', () => {
	// `null` means "not configured" — an explicit `undefined` would just re-select the default.
	const forward = (headers: Record<string, string>, publicOrigin: string | null = 'https://console.test') =>
		forwardIamAdmin(
			new Request('http://console.test/iam/admin/rpc', { method: 'POST', headers, body: '{}' }),
			{ gateway: new RecordingGateway(Response.json({ ok: true })), ...(publicOrigin === null ? {} : { publicOrigin }) },
		)

	test("accepts the browser's https origin although the process was reached over http", async () => {
		expect((await forward({ origin: 'https://console.test' })).status).toBe(200)
	})

	test('still rejects a cross-site origin', async () => {
		expect((await forward({ origin: 'https://evil.test' })).status).toBe(403)
	})

	test('lets a bearer-only caller through — no cookie, no ambient authority, nothing to forge', async () => {
		expect((await forward({ authorization: 'Bearer px_machine' })).status).toBe(200)
	})

	test('checks a bearer that arrives alongside any cookie', async () => {
		expect((await forward({ authorization: 'Bearer px_machine', cookie: '__Host-px_token=abc' })).status).toBe(403)
	})

	test('fails closed when no public origin is configured', async () => {
		expect((await forward({ origin: 'https://console.test' }, null)).status).toBe(403)
	})
})
