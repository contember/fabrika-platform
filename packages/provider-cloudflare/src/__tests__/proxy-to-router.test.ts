/**
 * The proxy's gate matcher and the application router read the same path table, and must agree on
 * every path that gets through: a path a gate admits as `public` must not reach a handler that a
 * stricter gate covers. These tests run each request through the proxy decision into the router.
 */

import { defineApp, route } from '@fabrika/app'
import type { AppGates } from '@fabrika/auth-core'
import { encodeProxyManifestJson } from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { APP, FakeIam, HOST, ISSUER } from '../../../proxy-core/src/__tests__/helpers'
import { createCloudflareProxyHandler } from '../proxy-worker'

const GATES: AppGates = {
	rules: [
		{ path: '/public', kind: 'public' },
		{ path: '/public/*', kind: 'human' },
		{ path: '/open/*', kind: 'public' },
		{ path: '/*', kind: 'human' },
	],
}

// The wildcard routes come first on purpose: order must not let one answer a path its gate does not cover.
const application = defineApp<Record<string, never>, Record<string, never>>({
	context: () => ({}),
	routes: [
		route.get('/public/*path', () => new Response('protected wildcard')),
		route.get('/public', () => new Response('public root')),
		route.get('/open/*path', (_ctx, params) => new Response(`open:${params.path}`)),
		route.get('/open', () => new Response('protected open root')),
	],
})

const proxy = createCloudflareProxyHandler({
	IAM: new FakeIam(),
	FABRIKA_IAM_ISSUER: ISSUER,
	FABRIKA_PROXY_MANIFEST_JSON: encodeProxyManifestJson({ apps: [{ id: APP, hosts: [HOST], upstream: 'APP', scheme: 'https', gates: GATES }] }),
	APP: { fetch: (request: Request) => application.fetch(request, {}, { waitUntil: () => {} }) },
})

const anonymous = (path: string): Promise<Response> => proxy(new Request(`https://${HOST}${path}`))

describe('the proxy decision and the router agree on the path', () => {
	test('an anonymous /public reaches only the public root handler', async () => {
		const response = await anonymous('/public')
		expect(response.status).toBe(200)
		expect(await response.text()).toBe('public root')
	})

	test('the protected wildcard needs its slash, and stays behind the human gate', async () => {
		for (const path of ['/public/', '/public/x', '/public/x/']) {
			const response = await anonymous(path)
			expect(response.status).toBe(302)
			expect(response.headers.get('location')).toContain(`${ISSUER}/auth/login`)
		}
	})

	test('a public wildcard never serves the root route its gate does not cover', async () => {
		expect(await (await anonymous('/open/')).text()).toBe('open:')
		expect(await (await anonymous('/open/a/')).text()).toBe('open:a/')
		expect((await anonymous('/open')).status).toBe(302)
	})

	test('a non-canonical path stops at the proxy', async () => {
		for (const path of ['//public/x', '/open/a%2Fb']) {
			expect((await anonymous(path)).status).toBe(400)
		}
	})
})
