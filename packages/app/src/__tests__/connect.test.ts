// Connectors end to end: the shop's handler calls the catalog's export through the catalog's own proxy decision, with
// the edge key as its bearer. Both applications run in test kits; the shop's requests to the catalog go to the
// catalog kit's `fetch`, which is the production proxy decision in front of the catalog's `boot`.

import { describe, expect, spyOn, test } from 'bun:test'
import { z } from 'zod/v4'
import { compileContract } from '../contract/compile'
import { type ConnectSnapshot, exportDescription, parseExportDescription } from '../contract/connect'
import { defineContract } from '../contract/define'
import { BootError } from '../implement/boot'
import { type ConnectFetch, connectVariables } from '../implement/connect'
import { implement } from '../implement/implement'
import { testKit } from '../testing/kit'
import { catalogApp, type ProductRow } from './fixtures/connect-catalog/app'
import { contract as catalog } from './fixtures/connect-catalog/fabrika.contract'
import { contract as shop } from './fixtures/connect-shop/fabrika.contract'
import { catalogProductsV1 } from './fixtures/connect-shop/fabrika/connect/catalog.products.v1'
import { app as shopApp } from './fixtures/connect-shop/src/app'
import { bootApp, environment, frameworkEnvFor } from './fixtures/implement/harness'

const products: ReadonlyMap<string, ProductRow> = new Map([
	['p1', { sku: 'p1', name: 'Kettle', price: 2500, tags: ['new'], internalCost: 900 }],
])

function post(body: unknown, headers: Record<string, string> = {}): RequestInit {
	return { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }
}

/** The catalog, and a shop whose import reaches it through `fetch`, with an edge key holding `grants`. */
function connected(fetchOwner?: (owner: ConnectFetch) => ConnectFetch, edge: 'reader' | 'none' = 'reader') {
	const owner = testKit(catalogApp(products))
	const key = owner.testCaller(edge === 'reader' ? [{ role: 'reader' }] : [], { kind: 'machine' }).key ?? ''
	const toOwner: ConnectFetch = (request) => owner.fetch(request)
	const consumer = testKit(shopApp, { connect: { catalog: { origin: owner.origin, key, fetch: fetchOwner?.(toOwner) ?? toOwner } } })
	const visitor = consumer.testCaller([{ role: 'visitor' }])
	const show = async (sku: string): Promise<unknown> => {
		const response = await consumer.browser(visitor)('/api/products.show', post({ sku }))
		expect(response.status).toBe(200)
		const body: unknown = await response.json()
		return typeof body === 'object' && body !== null && 'result' in body ? body.result : body
	}
	return { owner, consumer, visitor, key, show }
}

describe('the owner serves its export to the edge key, and to nothing else', () => {
	test('the export procedure answers the edge key, projected through its output', async () => {
		const { owner, key } = connected()
		const response = await owner.fetch('/__fabrika/connect/products.v1.get', post({ sku: 'p1' }, { Authorization: `Bearer ${key}` }))
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ result: { sku: 'p1', name: 'Kettle', price: 2500, tags: ['new'] } })
	})

	test('a signed-in person is no caller of an export, and a key without the action is refused', async () => {
		const { owner } = connected()
		const person = owner.testCaller([{ role: 'reader' }])
		expect((await owner.browser(person)('/__fabrika/connect/products.v1.get', post({ sku: 'p1' }))).status).toBe(401)
		const stranger = owner.testCaller([{ action: 'catalog.product.write' }], { kind: 'machine' })
		const refused = await owner.fetch('/__fabrika/connect/products.v1.get', post({ sku: 'p1' }, { Authorization: `Bearer ${stranger.key}` }))
		expect(refused.status).toBe(403)
	})

	test('the description path serves the schemas and digest a consumer vendors, behind the same callers', async () => {
		const { owner, key } = connected()
		const response = await owner.fetch('/__fabrika/connect/products.v1', post({}, { Authorization: `Bearer ${key}` }))
		expect(response.status).toBe(200)
		const body: unknown = await response.json()
		const served = parseExportDescription(typeof body === 'object' && body !== null && 'result' in body ? body.result : null)
		const expected = exportDescription(compileContract(catalog, {}), 'products')
		if (expected === null) {
			throw new Error('the catalog exports no products')
		}
		expect(served).toEqual(expected)
		expect(served.digest).toBe(catalogProductsV1.digest)
		const anonymous = await owner.fetch('/__fabrika/connect/products.v1', post({}))
		expect(anonymous.status).toBe(401)
	})

	test("the description needs the export's own action: a key holding another action of the owner is refused", async () => {
		const { owner } = connected()
		const writer = owner.testCaller([{ action: 'catalog.product.write' }], { kind: 'machine' })
		const response = await owner.fetch('/__fabrika/connect/products.v1', post({}, { Authorization: `Bearer ${writer.key}` }))
		expect(response.status).toBe(403)
	})
})

describe('ctx.connect in the consumer', () => {
	test('a usedBy handler reads the owner through its proxy and gets the typed value', async () => {
		const { show } = connected()
		expect(await show('p1')).toEqual({ outcome: 'ok', name: 'Kettle' })
		expect(await show('missing')).toEqual({ outcome: 'ok', name: null })
	})

	test('a handler the import does not name has no ctx.connect', async () => {
		const { consumer, visitor } = connected()
		const response = await consumer.browser(visitor)('/api/products.other', post({}))
		expect(await response.json()).toEqual({ result: { connect: false } })
	})

	test('an input the vendored schema refuses is invalid_input, and nothing is sent', async () => {
		let sent = 0
		const { show } = connected((owner) => (request) => {
			sent += 1
			return owner(request)
		})
		expect(await show('')).toEqual({ outcome: 'invalid_input', name: null })
		expect(sent).toBe(0)
	})

	test('an edge key the owner refuses is denied', async () => {
		const { show } = connected(undefined, 'none')
		expect(await show('p1')).toEqual({ outcome: 'denied', name: null })
	})

	test('an unreachable owner is unavailable after two retries, never denied', async () => {
		let attempts = 0
		const { show } = connected(() => () => {
			attempts += 1
			return Promise.reject(new TypeError('connection refused'))
		})
		expect(await show('p1')).toEqual({ outcome: 'unavailable', name: null })
		expect(attempts).toBe(3)
	})

	test('a 503 is retried, and a later answer is used', async () => {
		let attempts = 0
		const { show } = connected((owner) => (request) => {
			attempts += 1
			return attempts === 1 ? Promise.resolve(new Response('busy', { status: 503 })) : owner(request)
		})
		expect(await show('p1')).toEqual({ outcome: 'ok', name: 'Kettle' })
		expect(attempts).toBe(2)
	})

	test('an owner that never answers is a timeout within the import deadline', async () => {
		const { show } = connected(() => () => new Promise<Response>(() => {}))
		const started = Date.now()
		expect(await show('p1')).toEqual({ outcome: 'timeout', name: null })
		expect(Date.now() - started).toBeLessThan(1000)
	})

	test('a response that breaks the vendored schema is contract_violation, reported once', async () => {
		// The owner changed a field's type under the same version: what the shop vendored no longer holds.
		const drifted = defineContract(catalog.vocabulary, (c) => ({
			exports: {
				products: c.export({
					version: 1,
					consumers: ['shop'],
					audience: 'any consumer user',
					procedures: {
						get: c.query({
							input: z.strictObject({ sku: z.string() }),
							output: z.strictObject({ sku: z.string(), name: z.int() }),
							access: { action: 'catalog.product.read', over: 'catalog' },
						}),
					},
				}),
			},
		}))
		const owner = testKit(implement(drifted, {
			database: null,
			deps: () => ({}),
			handlers: () => ({ exports: { products: { get: ({ input }) => ({ sku: input.sku, name: 7 }) } } }),
		}))
		const key = owner.testCaller([{ action: 'catalog.product.read' }], { kind: 'machine' }).key ?? ''
		const consumer = testKit(shopApp, { connect: { catalog: { origin: owner.origin, key, fetch: (request) => owner.fetch(request) } } })
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			const response = await consumer.browser(consumer.testCaller([{ role: 'visitor' }]))('/api/products.show', post({ sku: 'p1' }))
			expect(await response.json()).toEqual({ result: { outcome: 'contract_violation', name: null } })
			const lines = log.mock.calls.map((call) => String(call[0]))
			expect(lines).toEqual([expect.stringContaining("connect 'catalog.get': contract_violation")])
			expect(lines.join('\n')).not.toContain(key)
		} finally {
			log.mockRestore()
		}
	})
})

describe('boot refuses an import it cannot serve', () => {
	const framework = (variables: Record<string, string>) => environment({ ...frameworkEnvFor(shopApp), FABRIKA_IAM_APP_ID: 'shop@prod', ...variables })
	const { url, key } = connectVariables('catalog')
	const wired = { [url]: 'https://catalog.example.com', [key]: 'px_edge_key' }

	function problems(run: () => unknown): readonly string[] {
		try {
			run()
		} catch (error) {
			if (error instanceof BootError) {
				return error.problems
			}
			throw error
		}
		return []
	}

	test('a wired import boots', () => {
		expect(problems(() => bootApp(shopApp, { environment: framework(wired) }))).toEqual([])
	})

	test('without the owner origin and the edge key', () => {
		expect(problems(() => bootApp(shopApp, { environment: framework({}) }))).toEqual([
			"FABRIKA_CONNECT_CATALOG_URL is not set; it is the origin of the owner's proxy",
			"FABRIKA_CONNECT_CATALOG_KEY is not set to a px_ key; it is the edge key the owner's proxy admits import 'catalog' with",
		])
	})

	test('an origin that carries credentials is refused without quoting it', () => {
		const found = problems(() => bootApp(shopApp, { environment: framework({ ...wired, [url]: 'https://user:secret@catalog.example.com' }) }))
		expect(found).toEqual(['FABRIKA_CONNECT_CATALOG_URL is not an http(s) origin without credentials'])
	})

	test('without its snapshot, with another export, and with an edited one', () => {
		const withSnapshot = (snapshot: ConnectSnapshot | null) =>
			problems(() => bootApp({ ...shopApp, connect: snapshot === null ? {} : { catalog: snapshot } }, { environment: framework(wired) }))
		expect(withSnapshot(null)).toEqual([
			"import 'catalog' has no snapshot; pass implement({ connect: { catalog: <the snapshot in fabrika/connect/> } })",
		])
		expect(withSnapshot({ ...catalogProductsV1, version: 2 })).toEqual([
			"import 'catalog' imports catalog/products@1, and its snapshot is catalog/products@2",
		])
		const edited = {
			...catalogProductsV1,
			procedures: {
				...catalogProductsV1.procedures,
				get: { ...catalogProductsV1.procedures.get, output: z.nullable(z.strictObject({ sku: z.string() })) },
			},
		}
		expect(withSnapshot(edited)).toEqual([
			'the snapshot catalog/products@1 was edited after fabrika connect wrote it; run fabrika connect pull',
		])
	})

	test('a contract whose digest is not its snapshot’s', () => {
		const other = defineContract(shop.vocabulary, (c) => ({
			api: c.rpc('/api', { callers: ['human'] }, {
				products: { show: c.query({ output: z.strictObject({ ok: z.boolean() }), access: { action: 'shop.view', over: 'shop' } }) },
			}),
			imports: {
				catalog: {
					app: 'catalog',
					export: 'products',
					version: 1,
					digest: `sha256:${'0'.repeat(64)}`,
					procedures: ['get'],
					usedBy: ['api.products.show'],
				},
			},
		}))
		const app = implement(other, {
			database: null,
			connect: { catalog: catalogProductsV1 },
			deps: () => ({}),
			handlers: () => ({ api: { products: { show: () => ({ ok: true }) } } }),
		})
		const found = problems(() => bootApp(app, { environment: environment({ ...frameworkEnvFor(app), FABRIKA_IAM_APP_ID: 'shop@prod', ...wired }) }))
		expect(found).toEqual([
			`import 'catalog' names digest sha256:${'0'.repeat(64)}, and its snapshot is ${catalogProductsV1.digest}; import the digest from the snapshot`,
		])
	})
})
