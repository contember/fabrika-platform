import type { AppGates } from '@fabrika/auth'
import { encodeProxyManifestJson } from '@fabrika/proxy-contract'
import { describe, expect, test } from 'bun:test'
import { Worker } from 'oblaka-iac'
import { APP, FakeIam, HOST, ISSUER, signUserToken } from '../../../proxy-core/src/__tests__/helpers'
import { createCloudflareProxyWorker } from '../proxy'
import { type CloudflareProxyEnv, createCloudflareProxyHandler } from '../proxy-worker'

const environment = (
	gates: AppGates,
	upstream: CloudflareProxyEnv['APP'] = { fetch: () => Promise.resolve(new Response('upstream')) },
): CloudflareProxyEnv => ({
	IAM: new FakeIam(),
	FABRIKA_IAM_ISSUER: ISSUER,
	FABRIKA_PROXY_MANIFEST_JSON: encodeProxyManifestJson({
		apps: [{ id: APP, hosts: [HOST], upstream: 'APP', scheme: 'https', gates }],
	}),
	APP: upstream,
})

describe('Cloudflare proxy Worker', () => {
	test('rejects an application Worker that can still be published on workers.dev', () => {
		const app = new Worker({ dir: '.', name: APP, main: './src/index.ts', compatibility_flags: [], bindings: {}, routes: [] })
		expect(() => createCloudflareProxyWorker({ name: 'proxy', app, appId: APP, appHost: HOST, gates: { rules: [] } })).toThrow(
			'must disable workers.dev',
		)
	})

	test('disables automatic invocation logs because callback URLs carry a one-time code', () => {
		const app = new Worker({
			dir: '.',
			name: APP,
			main: './src/index.ts',
			compatibility_flags: [],
			bindings: {},
			routes: [],
			workers_dev: false,
		})
		const proxy = createCloudflareProxyWorker({ name: 'proxy', app, appId: APP, appHost: HOST, gates: { rules: [] } })
		expect(proxy.options.observability).toEqual({ logs: { enabled: true, invocation_logs: false } })
	})

	test('forwards a public request with its method and body, but never a client token', async () => {
		let seen: Request | undefined
		const env = environment(
			{ rules: [{ path: '/public/*', kind: 'public' }] },
			{
				fetch: (request: Request) => {
					seen = request
					return Promise.resolve(new Response('streamed', { status: 201 }))
				},
			},
		)
		const response = await createCloudflareProxyHandler(env)(
			new Request(`https://${HOST}/public/stream?x=1`, {
				method: 'POST',
				body: 'payload',
				headers: {
					'X-Fabrika-Token': 'forged',
					'X-Request-Id': 'request-1',
					Cookie: '__Host-px_session=session-secret; app-cookie=kept; __Host-px_handoff_state=verifier',
				},
			}),
		)

		expect(response.status).toBe(201)
		expect(seen?.method).toBe('POST')
		expect(seen?.url).toBe(`https://${HOST}/public/stream?x=1`)
		expect(seen?.headers.get('X-Fabrika-Token')).toBeNull()
		// The proxy mints the correlation id: a client-chosen one would land in IAM's audit trail.
		const requestId = seen?.headers.get('X-Request-Id')
		expect(requestId).not.toBe('request-1')
		expect(requestId).toMatch(/^[0-9a-f-]{36}$/)
		expect(seen?.headers.get('Cookie')).toBe('app-cookie=kept')
		expect(await seen?.text()).toBe('payload')
		expect(await response.text()).toBe('streamed')
	})

	// The spoofing test for THIS composition. `CF-Connecting-IP` is written by Cloudflare's edge and
	// replaces a caller's, so it is the only address here a limiter may key on; every other name a client
	// address travels under is deleted, so an upstream reading `X-Fabrika-Client-Ip` reads the edge.
	test('a caller cannot choose the client coordinate on any of the names it travels under', async () => {
		const forged = { 'X-Fabrika-Client-Ip': '203.0.113.99', 'X-Forwarded-For': '203.0.113.99' }
		const upstreamHeaders = async (headers: Record<string, string>): Promise<Headers> => {
			const seen: Request[] = []
			const env = environment({ rules: [{ path: '/*', kind: 'public' }] }, {
				fetch: (request: Request) => {
					seen.push(request)
					return Promise.resolve(new Response('ok'))
				},
			})
			await createCloudflareProxyHandler(env)(new Request(`https://${HOST}/anything`, { headers }))
			const first = seen[0]
			if (first === undefined) throw new Error('the upstream was never reached')
			return first.headers
		}

		const withEdge = await upstreamHeaders({ ...forged, 'CF-Connecting-IP': '198.51.100.7' })
		expect(withEdge.get('X-Fabrika-Client-Ip')).toBe('198.51.100.7')
		// Deleted rather than passed through: an app that read one of these would key on a forgery here
		// and on a real address on the other cloud, or the other way round.
		expect(withEdge.get('X-Forwarded-For')).toBeNull()
		expect(withEdge.get('CF-Connecting-IP')).toBeNull()

		// Edge header absent (a local run, or a service-binding call): this hop cannot see the client, so
		// it injects nothing and the upstream falls back to its deployment-wide bucket. It does NOT
		// promote the caller's value.
		const withoutEdge = await upstreamHeaders(forged)
		expect(withoutEdge.get('X-Fabrika-Client-Ip')).toBeNull()
		expect(withoutEdge.get('X-Forwarded-For')).toBeNull()
	})

	test('injects only a verified token on a protected request', async () => {
		const token = await signUserToken()
		let seen: Request | undefined
		const env = environment(
			{ rules: [{ path: '/*', kind: 'human' }] },
			{
				fetch: (request: Request) => {
					seen = request
					return Promise.resolve(new Response('ok'))
				},
			},
		)
		const configured: CloudflareProxyEnv = {
			...env,
			IAM: new FakeIam({ mintToken: { ok: true, token, expiresAt: Math.floor(Date.now() / 1000) + 300 } }),
		}
		const response = await createCloudflareProxyHandler(configured)(
			new Request(`https://${HOST}/private`, {
				headers: { Cookie: '__Host-px_session=session; app-cookie=kept', 'X-Fabrika-Token': 'forged' },
			}),
		)

		expect(response.status).toBe(200)
		expect(seen?.headers.get('X-Fabrika-Token')).toBe(token)
		expect(seen?.headers.get('Cookie')).toBe('app-cookie=kept')
	})

	test('uses the shared service gate before a later human gate', async () => {
		const token = await signUserToken()
		let seen: Request | undefined
		const env = environment(
			{ rules: [{ path: '/*', kind: 'service' }, { path: '/*', kind: 'human' }] },
			{
				fetch: (request: Request) => {
					seen = request
					return Promise.resolve(new Response('ok'))
				},
			},
		)
		const configured: CloudflareProxyEnv = {
			...env,
			IAM: new FakeIam({
				mintFromKey: { ok: true, token, expiresAt: Math.floor(Date.now() / 1000) + 300 },
				mintToken: { ok: false, reason: 'no_session' },
			}),
		}
		const response = await createCloudflareProxyHandler(configured)(
			new Request(`https://${HOST}/private`, {
				headers: { Authorization: 'Bearer px_service', Cookie: '__Host-px_session=ignored' },
			}),
		)

		expect(response.status).toBe(200)
		expect(seen?.headers.get('X-Fabrika-Token')).toBe(token)
		expect(seen?.headers.get('Cookie')).toBeNull()
	})

	test('returns the shared login bounce and does not call the application', async () => {
		let calls = 0
		const env = environment(
			{ rules: [{ path: '/*', kind: 'human' }] },
			{
				fetch: () => {
					calls++
					return Promise.resolve(new Response('should not run'))
				},
			},
		)
		const response = await createCloudflareProxyHandler(env)(new Request(`https://${HOST}/private`))

		expect(response.status).toBe(302)
		expect(response.headers.get('location')).toContain(`${ISSUER}/auth/login`)
		expect(calls).toBe(0)
	})

	test('denies an invalid service credential and a malformed manifest before the app', async () => {
		let calls = 0
		const upstream = {
			fetch: () => {
				calls++
				return Promise.resolve(new Response('should not run'))
			},
		}
		const service = environment({ rules: [{ path: '/*', kind: 'service' }] }, upstream)
		const denied = await createCloudflareProxyHandler(service)(
			new Request(`https://${HOST}/private`, {
				headers: { Authorization: 'Bearer not-a-token' },
			}),
		)
		expect(denied.status).toBe(401)
		expect(calls).toBe(0)

		const malformed = createCloudflareProxyHandler({ ...service, FABRIKA_PROXY_MANIFEST_JSON: '{' })
		expect((await malformed(new Request(`https://${HOST}/private`))).status).toBe(503)
		expect(calls).toBe(0)
	})

	// The Bun composition refuses to boot without a usable issuer (`readProxyEnv`); this Worker does not
	// run that, so the same refusal has to exist here or the invariant holds on one provider only. An
	// absent issuer does not degrade — jose compares `iss` byte-for-byte, so it fails EVERY verification.
	test('refuses to serve without a usable issuer rather than failing every verification', async () => {
		let calls = 0
		const upstream = {
			fetch: () => {
				calls++
				return Promise.resolve(new Response('should not run'))
			},
		}
		const base = environment({ rules: [{ path: '/*', kind: 'public' }] }, upstream)
		for (const issuer of [undefined, '', '   ', 'not a url', 'ftp://iam.test']) {
			const handler = createCloudflareProxyHandler({ ...base, FABRIKA_IAM_ISSUER: issuer })
			expect((await handler(new Request(`https://${HOST}/anything`))).status).toBe(503)
		}
		expect(calls).toBe(0)

		// A trailing slash is the same issuer, not a second one — jose would disagree.
		const canonical = createCloudflareProxyHandler({ ...base, FABRIKA_IAM_ISSUER: `${ISSUER}/` })
		expect((await canonical(new Request(`https://${HOST}/anything`))).status).toBe(200)
	})
})
