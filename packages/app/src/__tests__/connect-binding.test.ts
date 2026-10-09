// On Cloudflare a consumer reaches the owner through a service binding to the owner's proxy Worker, and the request
// URL carries the owner's host, which the proxy Worker selects the application by. This pins, in Lopata, that a
// binding routes by the binding and hands the target the URL unchanged. workerd documents the same: the URL of a
// service-binding fetch is not used for routing.

import { describe, expect, test } from 'bun:test'
import { createTestEnv } from 'lopata/testing'
import { z } from 'zod/v4'
import { describeSnapshot } from '../contract/connect'
import { type ConnectFetch, Connector } from '../implement/connect'
import type { TestCallerOptions } from '../testing/caller'
import { testKit } from '../testing/kit'
import { catalogApp } from './fixtures/connect-catalog/app'
import { app as shopApp } from './fixtures/connect-shop/src/app'

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
				description: describeSnapshot({
					app: 'catalog',
					export: 'products',
					version: 1,
					audience: 'any consumer user',
					digest: '',
					procedures: { get: { input: null, output: z.strictObject({ host: z.string(), path: z.string(), bearer: z.boolean() }) } },
				}),
				procedures: ['get'],
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

describe("a consumer reaches the owner through the platform's binding with its app key", () => {
	const products = new Map([['p1', { sku: 'p1', name: 'Kettle', price: 2500, tags: ['new' as const], internalCost: 900 }]])

	/** The shop, wired to the catalog through the binding with a key of the catalog's reader role presented as `as`. */
	async function shopOverBinding(as: TestCallerOptions) {
		const owner = testKit(catalogApp(products))
		const key = owner.testCaller([{ role: 'reader' }], as).key ?? ''
		// The binding's target is the owner's proxy: the kit's fetch decides at the endpoint table, as the proxy Worker does.
		const testEnv = await createTestEnv({
			worker: { fetch: (request: Request) => owner.fetch(request) },
			bindings: { FABRIKA_CONNECT_CATALOG: { type: 'service', service: 'catalog-proxy' } },
		})
		const consumer = testKit(shopApp, {
			connect: { catalog: { origin: owner.origin, key, fetch: bindingOf(testEnv.env, 'FABRIKA_CONNECT_CATALOG') } },
		})
		const show = async (): Promise<unknown> => {
			const response = await consumer.browser(consumer.testCaller([{ role: 'visitor' }]))('/api/products.show', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sku: 'p1' }),
			})
			const body: unknown = await response.json()
			return typeof body === 'object' && body !== null && 'result' in body ? body.result : body
		}
		return { show, dispose: () => testEnv.dispose() }
	}

	test("the shop's app key reads the catalog; a machine key holding the same action is denied", async () => {
		const connected = await shopOverBinding({ kind: 'app', app: 'shop' })
		const machine = await shopOverBinding({ kind: 'machine' })
		try {
			expect(await connected.show()).toEqual({ outcome: 'ok', name: 'Kettle' })
			expect(await machine.show()).toEqual({ outcome: 'denied', name: null })
		} finally {
			connected.dispose()
			machine.dispose()
		}
	})
})
