// One endpoint for several actions, through the test kit on SQLite: an `anyOf` endpoint runs for a global holder of any
// listed action and is refused (403) otherwise; its `ctx.db.app` reaches the union of what each held action reaches
// alone, a `when` as an OR over them, and the data layer's refusal of an action the caller does not hold is its 403. A
// single-action endpoint beside it behaves as before.

import { createClient, RpcError } from '@fabrika/app/client'
import {
	type AnyOfAppCapability,
	type App,
	type Declared,
	defineApp,
	type EndpointContext,
	type KitTypes,
	type Unavailable,
} from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { scoped } from '@fabrika/db'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { CapabilityRefusedError, createCapabilityIssuer, RequestFrame } from '../implement/capability'
import { contract } from './any-of-fixture/fabrika.contract'
import type { app } from './any-of-fixture/src/app-kit'
import { tables } from './any-of-fixture/src/db/tables'
import { vocabulary } from './any-of-fixture/src/vocabulary'

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T
type Kit = typeof app extends App<infer K extends KitTypes> ? K : never
type AnyOfQuery = EndpointContext<
	Kit,
	'human',
	'query',
	{ readonly anyOf: readonly ['cash.read', 'cash.audit']; readonly app: true },
	Declared<never, never, never, never>
>

/** An `anyOf` endpoint holds an app capability over its listed actions, with no one action, and no target or member directory. */
export type AnyOfContext = [
	Expect<Equal<AnyOfQuery['app'], AnyOfAppCapability<'cash.read' | 'cash.audit'>>>,
	Expect<AnyOfQuery['app']['action'] extends Unavailable<string> ? true : false>,
	Expect<Equal<AnyOfQuery['app']['actions'], readonly ['cash.read' | 'cash.audit', ...('cash.read' | 'cash.audit')[]]>>,
	Expect<AnyOfQuery['target'] extends Unavailable<string> ? true : false>,
	Expect<AnyOfQuery['members'] extends Unavailable<string> ? true : false>,
]

const database = await testDatabase({ migrations: new URL('./any-of-fixture/db/migrations/', import.meta.url), label: 'any-of.test.ts' })
afterAll(() => database.close())

const kit = testKit(serve(contract, { database: scoped(tables) }), { database: database.database })
type Grant = Parameters<typeof kit.testCaller>[0][number]
type Action = 'cash.read' | 'cash.audit' | 'cash.manage' | 'reports.run'
const asCaller = (grants: readonly Grant[]) => createClient(contract, 'api', { fetch: kit.browser(kit.testCaller(grants)) })
const holding = (...actions: Action[]) => asCaller(actions.map((action) => ({ action })))
const inB1 = { type: 'branch', value: 'b1' } as const

async function statusOf(call: Promise<unknown>): Promise<number | 'ok'> {
	try {
		await call
		return 'ok'
	} catch (error) {
		if (error instanceof RpcError && error.httpStatus !== undefined) return error.httpStatus
		throw error
	}
}

const labels = (page: { readonly items: readonly { readonly label: string }[] }): string[] => page.items.map((item) => item.label)

const manager = holding('cash.manage')
const open = await manager.cash.add({ label: 'a-open', status: 'open', auditNote: 'counted' })
const closed = await manager.cash.add({ label: 'b-closed', status: 'closed', auditNote: 'short by 10' })
await manager.cash.add({ label: 'c-suspended', status: 'suspended', auditNote: 'under review' })

describe('an anyOf endpoint', () => {
	test('runs for a global holder of any listed action', async () => {
		expect(await statusOf(holding('cash.read').cash.list())).toBe('ok')
		expect(await statusOf(holding('cash.audit').cash.list())).toBe('ok')
		expect(await statusOf(holding('cash.manage').cash.list())).toBe('ok')
	})

	test('is refused with 403 for a caller holding none, or holding one only in a scope', async () => {
		expect(await statusOf(holding('reports.run').cash.list())).toBe(403)
		expect(await statusOf(asCaller([{ action: 'cash.read', scope: inB1 }]).cash.list())).toBe(403)
		expect(await statusOf(asCaller([{ action: 'cash.read', scope: inB1 }, { action: 'cash.audit', scope: inB1 }]).cash.detail({ id: open.id }))).toBe(
			403,
		)
	})

	test('a when keyed by an action applies as an OR over the held actions; a held action without one admits every row', async () => {
		expect(labels(await holding('cash.read').cash.list())).toEqual(['a-open'])
		expect(labels(await holding('cash.audit').cash.list())).toEqual(['b-closed'])
		expect(labels(await holding('cash.read', 'cash.audit').cash.list())).toEqual(['a-open', 'b-closed'])
		expect(labels(await holding('cash.read', 'cash.manage').cash.list())).toEqual(['a-open', 'b-closed', 'c-suspended'])
	})

	test("ctx.app carries the held listed actions and ctx.holds reports the held ones; an action's column shows where it alone reads", async () => {
		expect(await holding('cash.read').cash.detail({ id: open.id })).toEqual({
			columns: ['created_by', 'id', 'label', 'status', 'version'],
			held: ['cash.read'],
			canClose: false,
			audits: false,
		})
		expect(await holding('cash.audit').cash.detail({ id: closed.id })).toEqual({
			columns: ['audit_note', 'created_by', 'id', 'label', 'status', 'version'],
			held: ['cash.audit'],
			canClose: false,
			audits: true,
		})
		// cash.read reaches desks too, under a condition of its own: cash.audit's column is not answered beside it.
		expect(await holding('cash.read', 'cash.audit', 'cash.manage').cash.detail({ id: closed.id })).toEqual({
			columns: ['created_by', 'id', 'label', 'status', 'version'],
			held: ['cash.audit', 'cash.read'],
			canClose: true,
			audits: true,
		})
		// The get reaches a row only through a held action whose `when` admits it.
		expect(await statusOf(holding('cash.read').cash.detail({ id: closed.id }))).toBe(404)
	})

	test('writes a table whose action list names only the second listed action, and refuses a holder of only the first with 403', async () => {
		const before = (await manager.cash.entries()).count
		expect(await statusOf(holding('cash.manage').cash.record({ deskId: open.id, amount: 10 }))).toBe('ok')
		expect(await statusOf(holding('cash.audit', 'cash.manage').cash.record({ deskId: open.id, amount: 20 }))).toBe('ok')
		expect((await manager.cash.entries()).count).toBe(before + 2)
		// Which listed action the caller holds decided the data layer's refusal: the caller's 403, not a server fault.
		expect(await statusOf(holding('cash.audit').cash.record({ deskId: open.id, amount: 30 }))).toBe(403)
		expect((await manager.cash.entries()).count).toBe(before + 2)
	})

	test('a single-action endpoint reads with its own action only, whatever else the caller holds', async () => {
		expect(labels(await holding('cash.read').cash.open())).toEqual(['a-open'])
		expect(labels(await holding('cash.read', 'cash.audit', 'cash.manage').cash.open())).toEqual(['a-open'])
		expect(await statusOf(holding('cash.audit').cash.open())).toBe(403)
	})
})

describe('one action of an app capability', () => {
	test("a capability of one action names it; an anyOf endpoint's capability of several refuses to pick one", () => {
		const { mint } = createCapabilityIssuer()
		const frame = new RequestFrame('request-1')
		expect(mint.app(frame, 'cash.read', 'user:alice').action).toBe('cash.read')
		expect(mint.anyOf(frame, ['cash.audit'], 'user:alice').action).toBe('cash.audit')
		const several = mint.anyOf(frame, ['cash.audit', 'cash.read'], 'user:alice')
		expect(several.actions).toEqual(['cash.audit', 'cash.read'])
		expect(() => several.action).toThrow(CapabilityRefusedError)
		expect(() => several.action).toThrow("read ctx.app.actions, or ask ctx.holds('<action>')")
		frame.end()
	})
})

describe('a data-layer refusal no held actions could avoid', () => {
	const single = defineApp(vocabulary, tables)
	/** Inserts into `entries` on a handle whose type refuses it, as a handler that defeated the types would. */
	async function insertUntyped(handle: unknown): Promise<unknown> {
		const entries: unknown = Reflect.get(Object(handle), 'entries')
		const insert: unknown = Reflect.get(Object(entries), 'insert')
		if (typeof insert !== 'function') throw new TypeError('entries has no insert')
		return await Reflect.apply(insert, entries, [{ desk_id: 'd', amount: 1 }])
	}
	// `entries` names only cash.manage: neither endpoint lists it, so no caller is ever allowed this insert.
	const misfiled = single.group({ callers: ['human'] }, (r) => ({
		write: r.mutation({ output: z.strictObject({}), access: { action: 'cash.audit', app: true } }).handle(async ({ ctx }) => {
			await insertUntyped(ctx.db.app)
			return {}
		}),
		writeAny: r.mutation({ output: z.strictObject({}), access: { anyOf: ['cash.read', 'cash.audit'], app: true } }).handle(async ({ ctx }) => {
			await insertUntyped(ctx.db.app)
			return {}
		}),
	}))
	const misfiledContract = single.contract((c) => ({ api: c.rpc('/api', { misfiled }) }))

	test('stays a 500 for a caller holding every listed action, and is a 403 only for one holding some of them', async () => {
		const own = await testDatabase({ migrations: new URL('./any-of-fixture/db/migrations/', import.meta.url), label: 'any-of.test.ts single' })
		try {
			const ownKit = testKit(serve(misfiledContract, { database: scoped(tables) }), { database: own.database })
			const as = (...actions: Action[]) =>
				createClient(misfiledContract, 'api', { fetch: ownKit.browser(ownKit.testCaller(actions.map((action) => ({ action })))) })
			// A single-action endpoint that writes a table its action does not name is a fault of its code.
			expect(await statusOf(as('cash.audit').misfiled.write())).toBe(500)
			// Under every listed action the refusal is the code's fault too, so it is recorded as one.
			expect(await statusOf(as('cash.read', 'cash.audit').misfiled.writeAny())).toBe(500)
			// A holder of some only cannot tell the code's fault from its own reach: it is refused.
			expect(await statusOf(as('cash.read').misfiled.writeAny())).toBe(403)
		} finally {
			await own.close()
		}
	})
})
