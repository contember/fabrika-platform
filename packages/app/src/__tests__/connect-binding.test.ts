// On Cloudflare a consumer reaches the owner through a service binding to the owner's proxy Worker, and the request
// URL carries the owner's host, which the proxy Worker selects the application by. This pins, in Lopata, that a
// binding routes by the binding and hands the target the URL unchanged. workerd documents the same: the URL of a
// service-binding fetch is not used for routing.

import { describe, expect, test } from 'bun:test'
import { createTestEnv } from 'lopata/testing'
import { z } from 'zod/v4'
import { type ConnectFetch, Connector } from '../implement/connect'

const OWNER_ORIGIN = 'https://catalog.example.com'

/** The owner's proxy Worker, reduced to what the test reads: the URL and the bearer it was called with. */
const ownerProxy = {
	fetch(request: Request): Response {
		const url = new URL(request.url)
		const result = { host: url.host, path: url.pathname, bearer: request.headers.get('Authorization') !== null }
		return new Response(JSON.stringify({ result }), { headers: { 'Content-Type': 'application/json' } })
	},
}

function bindingOf(env: Record<string, unknown>, name: string): ConnectFetch {
	const binding = env[name]
	const fetchOwner: unknown = typeof binding === 'object' && binding !== null ? Reflect.get(binding, 'fetch') : undefined
	if (typeof fetchOwner !== 'function') {
		throw new Error(`${name} is not a service binding`)
	}
	return async (request) => {
		const response: unknown = await Reflect.apply(fetchOwner, binding, [request])
		if (!(response instanceof Response)) {
			throw new Error('the binding answered no Response')
		}
		return response
	}
}

describe('a service binding routes by the binding, not by the URL', () => {
	test('the target receives the owner host and path the consumer called it with', async () => {
		const testEnv = await createTestEnv({ worker: ownerProxy, bindings: { FABRIKA_CONNECT_CATALOG: { type: 'service', service: 'catalog-proxy' } } })
		try {
			const binding = bindingOf(testEnv.env, 'FABRIKA_CONNECT_CATALOG')
			const response = await binding(new Request(`${OWNER_ORIGIN}/__fabrika/connect/products.v1.get`, { method: 'POST', body: '{}' }))
			expect(await response.json()).toEqual({ result: { host: 'catalog.example.com', path: '/__fabrika/connect/products.v1.get', bearer: false } })
		} finally {
			testEnv.dispose()
		}
	})

	test('a connector over the binding calls the owner host with the edge key', async () => {
		const testEnv = await createTestEnv({ worker: ownerProxy, bindings: { FABRIKA_CONNECT_CATALOG: { type: 'service', service: 'catalog-proxy' } } })
		try {
			const connector = new Connector({
				name: 'catalog',
				export: 'products',
				version: 1,
				origin: OWNER_ORIGIN,
				key: 'px_edge_key',
				fetch: bindingOf(testEnv.env, 'FABRIKA_CONNECT_CATALOG'),
				timeoutMs: 1000,
				procedures: { get: { input: null, output: z.strictObject({ host: z.string(), path: z.string(), bearer: z.boolean() }) } },
			})
			expect(await connector.call('get', {})).toEqual({
				outcome: 'ok',
				value: { host: 'catalog.example.com', path: '/__fabrika/connect/products.v1.get', bearer: true },
			})
		} finally {
			testEnv.dispose()
		}
	})
})
