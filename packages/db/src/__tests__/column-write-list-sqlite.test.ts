// A column written by a list of actions, on SQLite: a capability of any listed action updates the column and no other
// column of the table; a listed table update action updates it beside its update list; an action the list leaves out
// does not update it. A column of one write action behaves as before.

import { beforeEach, describe, expect, test } from 'bun:test'
import { namesOf } from '../builtins'
import type { Ref } from '../capability'
import { CapabilityError, PolicyError } from '../errors'
import { bindScopedDatabase, type DataAccess, dataAccessOf, type DataHandles, type DataSite } from '../framework'
import type { DataKind } from '../orm-types'
import { defineTables, modelOf, namesAction, readTables, tableModels, updatableBy, updateActions } from '../policy'
import { openSqlite } from '../sqlite'
import { bunSqliteStorage } from '../sqlite-bun'
import { scoped } from '../store'
import { type DbIndex, type ScopeTarget, tablePolicies, type Tables } from '../tables'
import type { TypedColumnList } from '../vocabulary-tables'
import { TestAuthority } from './fixtures/authority'

const vocabulary = {
	app: 'orders',
	dimensions: { shop: {}, order: { in: 'shop' } },
	actions: {
		'orders.read': 'Read the orders of a shop',
		'orders.write': 'Edit the orders of a shop',
		'orders.settle': 'Settle an order',
		'orders.writeoff': 'Write an order off',
		'orders.assign': 'Assign an order',
	},
	roles: {},
} as const

interface DB {
	orders: {
		id: string
		shop_id: string
		note: string | null
		blocked_reason: string | null
		settled_on: string | null
		assignee: string | null
		version: number
	}
}

const columns: TypedColumnList<DB> = {
	orders: {
		columns: ['id', 'shop_id', 'note', 'blocked_reason', 'settled_on', 'assignee', 'version'],
		foreignKeys: [],
		notNull: ['id', 'shop_id', 'version'],
	},
}

const tables = defineTables(vocabulary, columns)({
	orders: {
		scope: { dimension: 'order', in: { dimension: 'shop', column: 'shop_id' } },
		actions: { read: 'orders.read', update: 'orders.write' },
		update: ['note', 'blocked_reason'],
		columns: {
			settled_on: { write: ['orders.settle', 'orders.writeoff', 'orders.write'] },
			assignee: { write: 'orders.assign' },
		},
	},
})

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T
type Policies = typeof tables extends Tables<DB, infer P> ? P : never
type OnOrder<A extends string> = ScopeTarget<DbIndex<DB, Policies>, 'order', A, 'mutation', 'on'>
type UpdateValues<A extends string> = OnOrder<A>['update'] extends (values: infer V, ...version: infer _) => unknown ? V : never

/** The update types follow the list: each listed action updates the column, and only a listed update action more. */
export type ColumnWriteListTypes = [
	Expect<Equal<UpdateValues<'orders.settle'>, { settled_on?: string | null | undefined }>>,
	Expect<Equal<UpdateValues<'orders.writeoff'>, { settled_on?: string | null | undefined }>>,
	Expect<Equal<keyof UpdateValues<'orders.write'>, 'note' | 'blocked_reason' | 'settled_on'>>,
	Expect<Equal<UpdateValues<'orders.assign'>, { assignee?: string | null | undefined }>>,
]

const alice = new TestAuthority('user:alice')
let data: DataAccess
let rows: () => unknown[]

beforeEach(() => {
	const storage = bunSqliteStorage()
	storage.sql.exec(
		'create table orders (id text not null primary key, shop_id text not null, note text, blocked_reason text, settled_on text, assignee text, version integer not null)',
	)
	storage.sql.exec("insert into orders (id, shop_id, version) values ('o1', 's1', 1)")
	const layer = scoped(tables)
	bindScopedDatabase(layer, { database: openSqlite(storage), capabilities: alice })
	data = dataAccessOf(layer)
	rows = () => storage.sql.exec('select note, blocked_reason, settled_on, assignee, version from orders').toArray()
})

async function invoke<T>(kind: DataKind, work: (handles: DataHandles) => Promise<T>): Promise<T> {
	const transaction = data.invocation(kind === 'query')
	const site: DataSite = { kind, unscoped: {}, principal: 'user:alice', check: () => undefined, session: () => transaction.session() }
	try {
		const result = await work(data.handles(site))
		await transaction.commit()
		return result
	} catch (error) {
		await transaction.rollback()
		throw error
	}
}

const order = (action: string): Ref<'order', string> => alice.ref('order', action, 'o1', { shop: 's1' })

async function update(action: string, values: Readonly<Record<string, unknown>>, expectVersion: number): Promise<unknown> {
	return invoke('mutation', async (db) => {
		const target: unknown = db.target(order(action), 'on')
		const method: unknown = typeof target === 'object' && target !== null ? Reflect.get(target, 'update') : undefined
		if (typeof method !== 'function') throw new TypeError('the target has no update')
		return Reflect.apply(method, target, [values, { expectVersion }])
	})
}

describe('a column whose write lists several actions', () => {
	test('each of two listed actions updates it, with the version bumped', async () => {
		expect(await update('orders.settle', { settled_on: '2026-11-01' }, 1)).toEqual({ id: 'o1', version: 2 })
		expect(await update('orders.writeoff', { settled_on: '2026-11-02' }, 2)).toEqual({ id: 'o1', version: 3 })
		expect(rows()).toEqual([{ note: null, blocked_reason: null, settled_on: '2026-11-02', assignee: null, version: 3 }])
	})

	for (const action of ['orders.settle', 'orders.writeoff']) {
		test(`${action} updates no other column of the table`, async () => {
			for (const column of ['blocked_reason', 'note', 'assignee']) {
				await expect(update(action, { [column]: 'x' }, 1)).rejects.toThrow(
					new PolicyError(`${column} is not an update column of orders (update columns: settled_on)`),
				)
				await expect(update(action, { settled_on: '2026-11-01', [column]: 'x' }, 1)).rejects.toThrow(
					`${column} is not an update column of orders (update columns: settled_on)`,
				)
			}
			expect(rows()).toEqual([{ note: null, blocked_reason: null, settled_on: null, assignee: null, version: 1 }])
		})
	}

	test('the listed table update action updates it beside its update list, in one update', async () => {
		expect(await update('orders.write', { note: 'n', blocked_reason: 'b', settled_on: '2026-11-03' }, 1)).toEqual({ id: 'o1', version: 2 })
		expect(rows()).toEqual([{ note: 'n', blocked_reason: 'b', settled_on: '2026-11-03', assignee: null, version: 2 }])
		await expect(update('orders.write', { assignee: 'x' }, 2)).rejects.toThrow(
			'assignee is not an update column of orders (update columns: note, blocked_reason, settled_on)',
		)
	})

	test('an action the list leaves out does not update it', async () => {
		await expect(update('orders.assign', { settled_on: '2026-11-01' }, 1)).rejects.toThrow(
			'settled_on is not an update column of orders (update columns: assignee)',
		)
		await expect(update('orders.read', { settled_on: '2026-11-01' }, 1)).rejects.toThrow(
			new CapabilityError(
				'wrong_action',
				'update on orders requires orders.write or orders.settle or orders.writeoff or orders.assign; the capability holds orders.read',
			),
		)
		expect(rows()).toEqual([{ note: null, blocked_reason: null, settled_on: null, assignee: null, version: 1 }])
	})
})

describe('the parsed list', () => {
	const model = modelOf(tableModels(tables), 'orders')
	if (model === undefined) throw new Error('orders has no model')

	test('each action updates the columns that list it, and the update action its update list too', () => {
		expect([...namesOf(updatableBy(model, 'orders.settle'))]).toEqual(['settled_on'])
		expect([...namesOf(updatableBy(model, 'orders.writeoff'))]).toEqual(['settled_on'])
		expect([...namesOf(updatableBy(model, 'orders.write'))]).toEqual(['note', 'blocked_reason', 'settled_on'])
		expect([...namesOf(updatableBy(model, 'orders.read'))]).toEqual([])
		expect(updateActions(model)).toEqual(['orders.write', 'orders.settle', 'orders.writeoff', 'orders.assign'])
		expect(namesAction(model, 'orders.writeoff')).toBe(true)
	})

	test('the artifact keeps one action as its text and several as a list', () => {
		expect(tablePolicies(tables)['orders']?.columns).toEqual({
			settled_on: { write: ['orders.settle', 'orders.writeoff', 'orders.write'] },
			assignee: { write: 'orders.assign' },
		})
	})
})

describe('the refusals', () => {
	const refusal = (columnPolicy: unknown, update: readonly string[] = ['note', 'blocked_reason'], updateAction: unknown = 'orders.write') => {
		try {
			readTables(columns, {
				orders: {
					scope: { dimension: 'order', in: { column: 'shop_id' } },
					actions: { read: 'orders.read', update: updateAction },
					update,
					columns: { settled_on: columnPolicy },
				},
			}, vocabulary)
		} catch (error) {
			if (error instanceof PolicyError) return error.message
			throw error
		}
		return 'accepted'
	}

	test('a list that names exactly the table update actions says what update says', () => {
		expect(refusal({ write: 'orders.write' })).toBe(
			"orders: columns.settled_on.write names orders.write, the table's update action; list settled_on in update instead",
		)
		expect(refusal({ write: ['orders.write'] })).toBe(
			"orders: columns.settled_on.write names orders.write, the table's update action; list settled_on in update instead",
		)
		expect(refusal({ write: ['orders.settle', 'orders.write'] }, undefined, ['orders.write', 'orders.settle'])).toBe(
			"orders: columns.settled_on.write names orders.settle, orders.write, the table's update action; list settled_on in update instead",
		)
	})

	test('a list that names one of several update actions, or another action beside one, is accepted', () => {
		expect(refusal({ write: 'orders.write' }, undefined, ['orders.write', 'orders.settle'])).toBe('accepted')
		expect(refusal({ write: ['orders.write', 'orders.writeoff'] })).toBe('accepted')
	})

	test('an empty list, a repeated action, an action outside the vocabulary and a column in update are refused', () => {
		expect(refusal({ write: [] })).toBe('orders: columns.settled_on.write lists no action; leave it out')
		expect(refusal({ write: ['orders.settle', 'orders.settle'] })).toBe('orders: columns.settled_on.write names orders.settle twice')
		expect(refusal({ write: ['orders.settle', 'orders.setle'] })).toStartWith(
			'orders: columns.settled_on.write names orders.setle, which is not an action of the vocabulary',
		)
		expect(refusal({ write: ['orders.settle', 'orders.writeoff'] }, ['note', 'settled_on'])).toBe(
			"orders: settled_on is in update, which the table's update action writes, and declares its own write action orders.settle, orders.writeoff; remove it from update",
		)
	})
})
