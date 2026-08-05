import type { AppGates } from '@fabrika/auth'
import { encodeProxyManifestJson } from '@fabrika/proxy-contract'
import { describe, expect, test } from 'bun:test'
import { Worker } from 'oblaka-iac'
import { APP, FakeIam, HOST, ISSUER, signUserToken } from '../../../proxy/src/__tests__/helpers'
import { createCloudflareProxyWorker } from '../proxy'
import { type CloudflareProxyEnv, createCloudflareProxyHandler } from '../proxy-worker'

const environment = (
	gates: AppGates,
	upstream: CloudflareProxyEnv['APP'] = { fetch: () => Promise.resolve(new Response('upstream')) },
): CloudflareProxyEnv => ({
	IAM: new FakeIam(),
	FABRIKA_IAM_URL: ISSUER,
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
				headers: { 'X-Fabrika-Token': 'forged', 'X-Request-Id': 'request-1' },
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
		expect(await seen?.text()).toBe('payload')
		expect(await response.text()).toBe('streamed')
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
		const response = await createCloudflareProxyHandler(env)(
			new Request(`https://${HOST}/private`, {
				headers: { Cookie: `__Host-px_token=${token}`, 'X-Fabrika-Token': 'forged' },
			}),
		)

		expect(response.status).toBe(200)
		expect(seen?.headers.get('X-Fabrika-Token')).toBe(token)
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
			const handler = createCloudflareProxyHandler({ ...base, FABRIKA_IAM_URL: issuer })
			expect((await handler(new Request(`https://${HOST}/anything`))).status).toBe(503)
		}
		expect(calls).toBe(0)

		// A trailing slash is the same issuer, not a second one — jose would disagree.
		const canonical = createCloudflareProxyHandler({ ...base, FABRIKA_IAM_URL: `${ISSUER}/` })
		expect((await canonical(new Request(`https://${HOST}/anything`))).status).toBe(200)
	})
})
