// A connector against an owner that misbehaves, and against application code that keeps what the framework handed
// it: a captured `ctx.connect` method sends nothing outside its request, nothing the owner writes reaches a message
// or the log, a redirect is never followed, a body is read under its budget and its deadline, and only as JSON.

import { describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test'
import { z } from 'zod/v4'
import { compileContract } from '../contract/compile'
import { type ConnectSnapshot, describeSnapshot } from '../contract/connect'
import { CONNECT_LIMITS } from '../contract/defaults'
import type { InputSchema, Schema } from '../contract/define'
import { defineContract } from '../contract/define'
import { type ConnectFetch, Connector, type ConnectResult } from '../implement/connect'
import { implement } from '../implement/implement'
import { testKit } from '../testing/kit'
import { catalogApp, type ProductRow } from './fixtures/connect-catalog/app'
import { contract as catalog } from './fixtures/connect-catalog/fabrika.contract'
import { contract as shop, Seen, Show, Shown } from './fixtures/connect-shop/fabrika.contract'
import { catalogProductsV1, catalogProductsV1Digest } from './fixtures/connect-shop/fabrika/connect/catalog.products.v1'

// The capture cases boot two test kits each, which a loaded host stretches past the 5 s default.
setDefaultTimeout(20_000)

const KEY = 'px_edge_key_of_the_shop'
const ORIGIN = 'https://catalog.example.com'

function post(body: unknown, headers: Record<string, string> = {}): RequestInit {
	return { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }
}

function json(body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', ...headers } })
}

/** A connector to the catalog's `get`, or to one procedure whose output is `output`, over `fetchOwner`. */
function connector(fetchOwner: ConnectFetch, output?: Schema, timeoutMs = 1000): Connector {
	const procedures: ConnectSnapshot['procedures'] = output === undefined ? catalogProductsV1.procedures : { get: { input: null, output } }
	return new Connector({
		name: 'catalog',
		export: 'products',
		version: 1,
		origin: ORIGIN,
		key: KEY,
		fetch: fetchOwner,
		timeoutMs,
		description: describeSnapshot({ ...catalogProductsV1, procedures }),
		procedures: ['get'],
	})
}

interface TrackedStream {
	readonly stream: ReadableStream<Uint8Array>
	readonly cancelled: () => boolean
	/** Settles when the reader cancels the body; a case that awaits it fails by its own timeout when nothing does. */
	readonly whenCancelled: Promise<void>
}

/** A body of `bytes` bytes that records whether its reader was cancelled. */
function trackedStream(bytes: number | 'never'): TrackedStream {
	let cancelled = false
	const { promise: whenCancelled, resolve: markCancelled } = Promise.withResolvers<void>()
	let sent = 0
	const chunk = new Uint8Array(64 * 1024).fill(0x20)
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (bytes === 'never') {
				return new Promise(() => {})
			}
			if (sent >= bytes) {
				controller.close()
				return
			}
			sent += chunk.byteLength
			controller.enqueue(chunk)
		},
		cancel() {
			cancelled = true
			markCancelled()
		},
	})
	return { stream, cancelled: () => cancelled, whenCancelled }
}

async function quietly<T>(work: () => Promise<T>): Promise<{ readonly value: T; readonly logged: string }> {
	const log = spyOn(console, 'error').mockImplementation(() => {})
	try {
		const value = await work()
		return { value, logged: log.mock.calls.map((call) => call.map(String).join(' ')).join('\n') }
	} finally {
		log.mockRestore()
	}
}

describe('a captured ctx.connect method sends nothing outside its own request', () => {
	const capturing = defineContract(shop.vocabulary, (c) => ({
		api: c.rpc('/api', { callers: ['human'] }, {
			products: {
				show: c.query({ input: Show, output: Shown, access: { action: 'shop.view', over: 'shop' } }),
				other: c.query({ output: Seen, access: { action: 'shop.view', over: 'shop' } }),
			},
		}),
		exports: {
			mirror: c.export({
				version: 1,
				consumers: ['portal'],
				audience: 'any consumer user',
				procedures: { get: c.query({ output: Seen, access: { action: 'shop.view', over: 'shop' } }) },
			}),
		},
		imports: {
			catalog: {
				app: 'catalog',
				export: 'products',
				version: 1,
				digest: catalogProductsV1Digest,
				procedures: ['get'],
				usedBy: ['api.products.show'],
				timeoutMs: 400,
			},
		},
	}))

	type Get = (input: { readonly sku: string }) => Promise<ConnectResult<unknown>>

	function setup() {
		const owner = testKit(catalogApp(new Map<string, ProductRow>()))
		const key = owner.testCaller([{ role: 'reader' }], { kind: 'app', app: 'shop' }).key ?? ''
		let sent = 0
		const kept: Get[] = []
		const outcomes: string[] = []
		let afterwards: Promise<ConnectResult<unknown>> | null = null
		// The request's timer calls only once the test says the request has ended; a fixed delay can fire before that.
		const ended = Promise.withResolvers<void>()
		const use = async (): Promise<boolean> => {
			const [get] = kept
			if (get === undefined) {
				throw new Error('nothing was kept')
			}
			const result = await get({ sku: 'p1' })
			outcomes.push(result.outcome)
			return result.outcome === 'denied'
		}
		const app = implement(capturing, {
			database: null,
			connect: { catalog: catalogProductsV1 },
			deps: () => ({}),
			handlers: () => ({
				api: {
					products: {
						show: async ({ ctx }) => {
							const get = ctx.connect.catalog.get
							kept.push(get)
							afterwards = new Promise((resolve) =>
								setTimeout(async () => {
									await ended.promise
									resolve(get({ sku: 'p1' }))
								}, 0)
							)
							const result = await get({ sku: 'p1' })
							return { outcome: result.outcome, name: null }
						},
						other: async () => ({ connect: await use() }),
					},
				},
				exports: { mirror: { get: async () => ({ connect: await use() }) } },
			}),
		})
		const consumer = testKit(app, {
			connect: {
				catalog: {
					origin: owner.origin,
					key,
					fetch: (request) => {
						sent += 1
						return owner.fetch(request)
					},
				},
			},
		})
		const visitor = consumer.testCaller([{ role: 'visitor' }])
		const afterRequest = (): Promise<ConnectResult<unknown>> | null => {
			ended.resolve()
			return afterwards
		}
		return { consumer, visitor, kept, outcomes, sent: () => sent, afterwards: afterRequest, use }
	}

	test('the handler the import names reaches the owner', async () => {
		const { consumer, visitor, sent } = setup()
		const response = await consumer.browser(visitor)('/api/products.show', post({ sku: 'p1' }))
		expect(await response.json()).toEqual({ result: { outcome: 'ok', name: null } })
		expect(sent()).toBe(1)
	})

	test('kept and called from a handler the import does not name: denied, nothing sent', async () => {
		const { consumer, visitor, sent } = setup()
		await consumer.browser(visitor)('/api/products.show', post({ sku: 'p1' }))
		const response = await consumer.browser(visitor)('/api/products.other', post({}))
		expect(await response.json()).toEqual({ result: { connect: true } })
		expect(sent()).toBe(1)
	})

	test('called after its request ended, from a timer of that request or from no request at all: denied', async () => {
		const { consumer, visitor, sent, afterwards, use } = setup()
		await consumer.browser(visitor)('/api/products.show', post({ sku: 'p1' }))
		expect((await afterwards())?.outcome).toBe('denied')
		expect(await use()).toBe(true)
		expect(sent()).toBe(1)
	})

	test("kept and called from an export handler: denied, so an export's request never calls out", async () => {
		const { consumer, visitor, sent } = setup()
		await consumer.browser(visitor)('/api/products.show', post({ sku: 'p1' }))
		const portal = consumer.testCaller([{ action: 'shop.view' }], { kind: 'app', app: 'portal' })
		const response = await consumer.fetch('/__fabrika/connect/mirror.v1.get', post({}, { Authorization: `Bearer ${portal.key}` }))
		expect(await response.json()).toEqual({ result: { connect: true } })
		expect(sent()).toBe(1)
	})
})

describe('what the owner writes never reaches a message or the log', () => {
	test('a record key named after the edge key, with a value the vendored schema refuses', async () => {
		const owner: ConnectFetch = () => Promise.resolve(json({ result: { [KEY]: 'not a number' } }))
		const { value, logged } = await quietly(() => connector(owner, z.record(z.string(), z.int())).call('get', {}))
		expect(value).toEqual({ outcome: 'contract_violation', message: 'the answer breaks the vendored output schema at {} (invalid_type)' })
		expect(logged).toContain('contract_violation')
		expect(`${JSON.stringify(value)}${logged}`).not.toContain(KEY)
	})

	test('an unknown field named after the edge key', async () => {
		const owner: ConnectFetch = () => Promise.resolve(json({ result: { sku: 'p1', name: 'Kettle', price: 1, tags: [], [KEY]: true } }))
		const { value, logged } = await quietly(() => connector(owner).call('get', { sku: 'p1' }))
		expect(value.outcome).toBe('contract_violation')
		expect(`${JSON.stringify(value)}${logged}`).not.toContain(KEY)
	})
})

describe('the answer is the owner’s own, bounded, timely and JSON', () => {
	test('a 307 is unavailable and never followed', async () => {
		let followed = 0
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				if (new URL(request.url).pathname === '/elsewhere') {
					followed += 1
					return json({ result: { sku: 'p1', name: 'Kettle', price: 1, tags: [] } })
				}
				return new Response(null, { status: 307, headers: { Location: '/elsewhere' } })
			},
		})
		try {
			const owner = new Connector({
				name: 'catalog',
				export: 'products',
				version: 1,
				origin: `http://127.0.0.1:${server.port}`,
				key: KEY,
				fetch: (request) => fetch(request),
				timeoutMs: 1000,
				description: describeSnapshot(catalogProductsV1),
				procedures: ['get'],
			})
			const result = await owner.call('get', { sku: 'p1' })
			expect(result.outcome).toBe('unavailable')
			expect(followed).toBe(0)
		} finally {
			server.stop(true)
		}
	})

	test(`an 8 MiB answer is contract_violation, and its stream is cancelled at ${CONNECT_LIMITS.maxAnswerBytes} bytes`, async () => {
		const body = trackedStream(8 * 1024 * 1024)
		const owner: ConnectFetch = () => Promise.resolve(new Response(body.stream, { headers: { 'Content-Type': 'application/json' } }))
		const { value } = await quietly(() => connector(owner).call('get', { sku: 'p1' }))
		expect(value).toEqual({ outcome: 'contract_violation', message: `the answer is larger than ${CONNECT_LIMITS.maxAnswerBytes} bytes` })
		expect(body.cancelled()).toBe(true)
	})

	test('an answer whose body never ends is a timeout, and no stream stays open after it', async () => {
		const bodies: ReturnType<typeof trackedStream>[] = []
		const owner: ConnectFetch = () => {
			const body = trackedStream('never')
			bodies.push(body)
			return Promise.resolve(new Response(body.stream, { headers: { 'Content-Type': 'application/json' } }))
		}
		const result = await connector(owner, undefined, 300).call('get', { sku: 'p1' })
		expect(result.outcome).toBe('timeout')
		expect(bodies.length).toBeGreaterThan(0)
		await Promise.all(bodies.map((body) => body.whenCancelled))
	})

	test('a transport that answers after the deadline has its body cancelled', async () => {
		const bodies: ReturnType<typeof trackedStream>[] = []
		const owner: ConnectFetch = () => {
			const body = trackedStream('never')
			bodies.push(body)
			return new Promise((resolve) => setTimeout(() => resolve(new Response(body.stream, { headers: { 'Content-Type': 'application/json' } })), 150))
		}
		const result = await connector(owner, undefined, 90).call('get', { sku: 'p1' })
		expect(result.outcome).toBe('timeout')
		expect(bodies.length).toBeGreaterThan(0)
		await Promise.all(bodies.map((body) => body.whenCancelled))
	})

	test('JSON served as text/html is contract_violation', async () => {
		const owner: ConnectFetch = () =>
			Promise.resolve(new Response(JSON.stringify({ result: null }), { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
		const { value } = await quietly(() => connector(owner).call('get', { sku: 'p1' }))
		expect(value).toEqual({ outcome: 'contract_violation', message: 'the answer is not application/json' })
	})

	test('application/json with a charset is JSON', async () => {
		const owner: ConnectFetch = () => Promise.resolve(json({ result: null }, { 'Content-Type': 'application/json; charset=utf-8' }))
		expect(await connector(owner).call('get', { sku: 'p1' })).toEqual({ outcome: 'ok', value: null })
	})
})

describe('the connector validates against what boot checked, not against the snapshot object', () => {
	test('replacing a schema of the snapshot after boot changes nothing', async () => {
		const get: { input: InputSchema | null; output: Schema } = { ...catalogProductsV1.procedures.get }
		const mutable = { ...catalogProductsV1, procedures: { ...catalogProductsV1.procedures, get } }
		const app = implement(shop, {
			database: null,
			connect: { catalog: mutable },
			deps: () => ({}),
			handlers: () => ({
				api: {
					products: {
						show: async ({ input, ctx }) => ({ outcome: (await ctx.connect.catalog.get({ sku: input.sku })).outcome, name: null }),
						other: () => ({ connect: false }),
					},
				},
			}),
		})
		const consumer = testKit(app, {
			connect: { catalog: { origin: ORIGIN, key: KEY, fetch: () => Promise.resolve(json({ result: 'outside the approved schema' })) } },
		})
		get.output = z.string()
		const response = await quietly(() => consumer.browser(consumer.testCaller([{ role: 'visitor' }]))('/api/products.show', post({ sku: 'p1' })))
		expect(await response.value.json()).toEqual({ result: { outcome: 'contract_violation', name: null } })
	})
})

test("an export's procedures share one action in one dimension, which its description requires", () => {
	const mixed = defineContract(catalog.vocabulary, (c) => ({
		exports: {
			products: c.export({
				version: 1,
				consumers: ['shop'],
				audience: 'any consumer user',
				procedures: {
					get: c.query({ output: z.strictObject({ ok: z.boolean() }), access: { action: 'catalog.product.read', over: 'catalog' } }),
					audit: c.query({ output: z.strictObject({ ok: z.boolean() }), access: { action: 'catalog.product.write', over: 'catalog' } }),
				},
			}),
		},
	}))
	expect(() => compileContract(mixed, {})).toThrow('its procedures need different actions or dimensions')
})
