// One endpoint for several actions, through the test kit on SQLite: an `anyOf` endpoint runs for a global holder of any
// listed action and is refused (403) otherwise; its `ctx.db.app` reaches what the held actions reach together, a `when`
// as an OR over them. A single-action endpoint beside it behaves as before.

import { createClient, RpcError } from '@fabrika/app/client'
import type { App, Declared, EndpointContext, KitTypes, Unavailable } from '@fabrika/app/contract'
import { type AppCapability, serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { scoped } from '@fabrika/db'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { contract } from './any-of-fixture/fabrika.contract'
import type { app } from './any-of-fixture/src/app-kit'
import { tables } from './any-of-fixture/src/db/tables'

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

/** An `anyOf` endpoint holds an app capability over its listed actions, and has no target or member directory. */
export type AnyOfContext = [
	Expect<Equal<AnyOfQuery['app'], AppCapability<'cash.read' | 'cash.audit'>>>,
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

	test('ctx.app carries the held listed actions and ctx.holds reports the held ones; a column of a held action is read', async () => {
		expect(await holding('cash.read').cash.detail({ id: open.id })).toEqual({
			columns: ['created_by', 'id', 'label', 'status', 'version'],
			held: ['cash.read'],
			canClose: false,
			audits: false,
		})
		expect(await holding('cash.read', 'cash.audit', 'cash.manage').cash.detail({ id: closed.id })).toEqual({
			columns: ['audit_note', 'created_by', 'id', 'label', 'status', 'version'],
			held: ['cash.audit', 'cash.read'],
			canClose: true,
			audits: true,
		})
		// The get reaches a row only through a held action whose `when` admits it.
		expect(await statusOf(holding('cash.read').cash.detail({ id: closed.id }))).toBe(404)
	})

	test('writes a table whose action list names only the second listed action, and refuses a holder of only the first', async () => {
		const before = (await manager.cash.entries()).count
		expect(await statusOf(holding('cash.manage').cash.record({ deskId: open.id, amount: 10 }))).toBe('ok')
		expect(await statusOf(holding('cash.audit', 'cash.manage').cash.record({ deskId: open.id, amount: 20 }))).toBe('ok')
		expect((await manager.cash.entries()).count).toBe(before + 2)
		expect(await statusOf(holding('cash.audit').cash.record({ deskId: open.id, amount: 30 }))).toBe(500)
		expect((await manager.cash.entries()).count).toBe(before + 2)
	})

	test('a single-action endpoint reads with its own action only, whatever else the caller holds', async () => {
		expect(labels(await holding('cash.read').cash.open())).toEqual(['a-open'])
		expect(labels(await holding('cash.read', 'cash.audit', 'cash.manage').cash.open())).toEqual(['a-open'])
		expect(await statusOf(holding('cash.audit').cash.open())).toBe(403)
	})
})
