// A public procedure (`access: { public: true }` with top-level `actions`): anyone calls it, its row is the `public`
// mode with no callers, and its handler runs as the endpoint's own workload, holding its declared actions only. Its
// admission charges the default buckets of a public mutation before the body, its `ctx.db.app` inserts and reads under
// its actions and nothing else, and `ctx.client` carries what the proxy saw. The artifact half runs everywhere; the
// requests run through the test kit and a REAL Postgres, and skip cleanly when FABRIKA_TEST_POSTGRES_URL is unset.

import type { App, KitTypes, PublicContext, Unavailable } from '@fabrika/app/contract'
import { compileContract } from '@fabrika/app/contract'
import { type AppCapability, serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { endpointAccessKit } from '@fabrika/app/testing/isolation'
import { scoped } from '@fabrika/db'
import { testDatabase } from '@fabrika/db/testing'
import { contractProxyTable } from '@fabrika/proxy-core/manifest'
import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { contract } from './public-fixture/fabrika.contract'
import { app } from './public-fixture/src/app-kit'
import { tables } from './public-fixture/src/db/tables'
import { Submitted } from './public-fixture/src/intake/endpoints'

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T
type Kit = typeof app extends App<infer K extends KitTypes> ? K : never
type Anyone = PublicContext<Kit, 'mutation', 'intake.register'>
type Submissions = ReturnType<Anyone['db']['app']>['submissions']

/** A public handler holds its declared actions only, inserts with nothing read back, and never updates. */
export type PublicContextShape = [
	Expect<Equal<Parameters<Anyone['app']>[0], 'intake.register'>>,
	Expect<Equal<ReturnType<Anyone['app']>, AppCapability<'intake.register'>>>,
	Expect<Submissions['insert'] extends Unavailable<string> ? false : true>,
	Expect<Submissions['update'] extends Unavailable<string> ? true : false>,
	Expect<Submissions['list'] extends Unavailable<string> ? true : false>,
	Expect<Anyone['sql'] extends Unavailable<string> ? true : false>,
	Expect<Equal<Anyone['client'], { readonly ip: string | null; readonly userAgent: string | null }>>,
]

const Empty = z.strictObject({})

describe('the artifact of a public procedure', () => {
	const artifact = compileContract(contract, tables)

	test('is its own row mode: no callers, no requirement, a JSON body within the default limit', () => {
		const row = artifact.endpoints.find((endpoint) => endpoint.id === 'api.intake.register')
		expect(row).toMatchObject({
			kind: 'public',
			method: 'POST',
			path: '/api/intake.register',
			callers: [],
			requirement: null,
			admission: { contentTypes: ['application/json'], maxBytes: 65_536 },
		})
		expect(artifact.mounts['api']).toEqual({ kind: 'rpc', prefix: '/api', callers: ['human'] })
	})

	test('records the workload actions and the effective admission of each procedure', () => {
		expect(artifact.declared?.['api.intake.register']).toMatchObject({ actions: ['intake.register'] })
		expect(artifact.procedures?.['api.intake.register']).toEqual({
			rate: { perClient: 10, perCaller: null, perEndpoint: 100, bytesPerHour: null },
			challenge: null,
			timeoutMs: 10_000,
		})
		expect(artifact.procedures?.['api.intake.limited']).toMatchObject({
			rate: { perClient: 2, perCaller: null, perEndpoint: null, bytesPerHour: null },
			timeoutMs: 2000,
		})
		expect(artifact.endpoints.find((row) => row.id === 'api.intake.limited')?.admission?.maxBytes).toBe(1024)
		// A public query counts nothing unless it declares a bucket: a bucket is a database write per call.
		expect(artifact.procedures?.['api.catalog.products']?.rate).toEqual({ perClient: null, perCaller: null, perEndpoint: null, bytesPerHour: null })
		expect(artifact.procedures?.['api.staff.submissions']?.rate.perCaller).toBe(600)
		expect(artifact.procedures?.['api.staff.addProduct']?.rate.perCaller).toBe(3)
	})

	test('carries the HTTP shape: a GET query reads its URL, a POST its urlencoded body and its query, a redirect its origins', () => {
		expect(artifact.endpoints.find((row) => row.id === 'api.catalog.search')).toMatchObject({ method: 'GET', admission: null })
		const subscribe = artifact.endpoints.find((row) => row.id === 'api.intake.subscribe')
		expect(subscribe).toMatchObject({
			method: 'POST',
			admission: { contentTypes: ['application/x-www-form-urlencoded'] },
			output: { type: 'redirect', origins: ['https://partner.example'] },
		})
		expect(artifact.procedures?.['api.intake.subscribe']?.query).toMatchObject({ type: 'object' })
	})

	test('compiles into a proxy row the strict manifest parser accepts', () => {
		const table = contractProxyTable(artifact)
		expect(table.endpoints.find((row) => row.id === 'api.intake.register')).toMatchObject({ kind: 'public', callers: [], delegation: null })
	})

	test('a group without callers holds public procedures only', () => {
		// The types refuse the credentialed procedure; the runtime refuses it as well.
		const build = (r: { query(def: object): { handle(handler: () => object): object } }) => ({
			list: r.query({ output: Empty, access: { action: 'intake.read', app: true } }).handle(() => ({})),
		})
		expect(() => Reflect.apply(app.group, app, [{}, build])).toThrow(/not public, and the group names no callers/)
	})

	test('a public procedure reaches nothing off the road', () => {
		const raw = app.group({}, (r) => ({
			raw: r.mutation({ output: Empty, access: { public: true }, actions: ['intake.register'], sql: 'write' }).handle(() => ({})),
		}))
		expect(() => compileContract(app.contract((c) => ({ api: c.rpc('/api', { raw }) })), tables)).toThrow(/is public and declares sql/)
	})
})

const postgres = await testDatabase({ migrations: join(import.meta.dir, 'public-fixture', 'db', 'migrations'), label: 'public-procedure.test.ts' })

afterAll(async () => {
	await postgres?.close()
})

if (postgres !== null) {
	const kit = testKit(serve(contract, { database: scoped(tables) }), { database: postgres.database, clientIp: '198.51.100.7' })
	const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
		kit.fetch(`/api/${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'User-Agent': 'probe/1.0', ...headers },
			body: JSON.stringify(body),
		})
	const reader = kit.testCaller([{ action: 'intake.read' }, { action: 'catalog.write' }])

	describe('a public procedure through the proxy and boot', () => {
		test('anyone calls it, and its handler writes with the client the proxy saw', async () => {
			const name = `visitor ${crypto.randomUUID()}`
			const response = await post('intake.register', { name, website: '' })
			expect(response.status).toBe(200)
			expect(await response.json()).toEqual({ result: {} })
			const listed = await kit.browser(reader)('/api/staff.submissions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
			expect(Submitted.parse((await listed.json()).result).items).toContainEqual({ name, clientIp: '198.51.100.7', userAgent: 'probe/1.0' })
		})

		test('a filled honeypot answers as a real submission and writes nothing', async () => {
			const name = `bot ${crypto.randomUUID()}`
			const response = await post('intake.register', { name, website: 'https://spam.example' })
			expect(await response.json()).toEqual({ result: {} })
			const listed = await kit.browser(reader)('/api/staff.submissions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
			expect(Submitted.parse((await listed.json()).result).items.map((item) => item.name)).not.toContain(name)
		})

		test('every credential is discarded: a signed-in caller calls it as anyone', async () => {
			const response = await kit.browser(reader)('/api/intake.register', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: 'staff, anonymously', website: '' }),
			})
			expect(response.status).toBe(200)
		})

		test('a public query reads under its read action', async () => {
			await kit.browser(reader)('/api/staff.addProduct', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Lamp"}' })
			const response = await post('catalog.products', {})
			expect(response.status).toBe(200)
			expect((await response.json()).result.items).toContainEqual({ name: 'Lamp' })
		})

		test('its bucket refuses past its declared rate, before the body is read', async () => {
			expect((await post('intake.limited', { name: 'a', website: '' })).status).toBe(200)
			expect((await post('intake.limited', { name: 'b', website: '' })).status).toBe(200)
			const refused = await post('intake.limited', 'not even an object')
			expect(refused.status).toBe(429)
		})

		test('the data layer refuses an update, and ctx.app an action it does not declare', async () => {
			expect((await post('intake.overreach', {})).status).toBe(500)
			expect((await post('intake.undeclared', {})).status).toBe(500)
		})

		test("a credentialed procedure's perCaller bucket counts each caller apart", async () => {
			const add = (caller: typeof reader) =>
				kit.browser(caller)('/api/staff.addProduct', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Chair"}' })
			const writer = kit.testCaller([{ action: 'catalog.write' }])
			const statuses = [await add(writer), await add(writer), await add(writer), await add(writer)].map((response) => response.status)
			expect(statuses).toEqual([200, 200, 200, 429])
			expect((await add(kit.testCaller([{ action: 'catalog.write' }]))).status).toBe(200)
		})

		test("the generated case's kit asks a public procedure as anyone", async () => {
			const access = endpointAccessKit(serve(contract, { database: scoped(tables) }), tables, postgres)
			expect(await access.anyone('api.intake.register', { name: 'generated', website: '' })).toEqual({ answered: true })
			expect(await access.anyone('api.intake.undeclared', {})).toEqual({ answered: false, status: 500 })
		})

		test('a GET query reads its input from canonical URL parameters, and refuses a duplicate or an unknown one', async () => {
			await kit.browser(reader)('/api/staff.addProduct', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Desk"}' })
			const get = (query: string) => kit.fetch(`/api/catalog.search?${query}`)
			const found = await get('name=Desk&limit=50&exact=true')
			expect(found.status).toBe(200)
			expect((await found.json()).result.items).toEqual([{ name: 'Desk' }])
			expect((await get('name=Desk&name=Lamp')).status).toBe(400)
			expect((await get('name=Desk&limit=05')).status).toBe(400)
			expect((await get('name=Desk&color=red')).status).toBe(400)
			expect((await kit.fetch('/api/catalog.search', { method: 'POST', body: '{}' })).status).toBe(403)
		})

		test('a native form posts urlencoded fields with a query, and is redirected to its own path or a listed origin only', async () => {
			const submit = (next: string, body = 'name=Ann&adult=true') =>
				kit.fetch(`/api/intake.subscribe?next=${next}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: kit.origin },
					body,
					redirect: 'manual',
				})
			const own = await submit('own')
			expect(own.status).toBe(303)
			expect(own.headers.get('Location')).toBe('/thanks')
			const partner = await submit('partner')
			expect(partner.headers.get('Location')).toBe('https://partner.example/welcome')
			expect((await submit('elsewhere')).status).toBe(500)
			expect((await submit('own', 'name=Ann&adult=yes')).status).toBe(400)
			const stranger = await kit.fetch('/api/intake.subscribe?next=own', {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://stranger.example' },
				body: 'name=Ann&adult=true',
			})
			expect(stranger.status).toBe(403)
		})

		test('a body past its limit is refused', async () => {
			expect((await post('intake.register', { name: 'x'.repeat(70_000), website: '' })).status).toBe(413)
		})
	})
} else {
	test.skip('a public procedure through the proxy and boot (set FABRIKA_TEST_POSTGRES_URL)', () => {})
}
