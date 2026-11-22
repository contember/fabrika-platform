// A column read by a list of actions, on SQLite: a capability of any listed action reads, filters and sorts by the
// column; one of a table read action the list leaves out does not see it, and its filter and order on it are refused.
// A column of one read action behaves as before: only that action reads it.

import { beforeEach, describe, expect, test } from 'bun:test'
import { QueryRefusedError } from '../errors'
import { bindScopedDatabase, type DataAccess, dataAccessOf, type DataHandles, type DataSite } from '../framework'
import type { DataKind, RowOf } from '../orm-types'
import { defineTables, modelOf, tableModels, visibleFor } from '../policy'
import { openSqlite } from '../sqlite'
import { bunSqliteStorage } from '../sqlite-bun'
import { scoped } from '../store'
import { tablePolicies } from '../tables'
import type { TypedColumnList } from '../vocabulary-tables'
import { TestAuthority } from './fixtures/authority'

const vocabulary = {
	app: 'people',
	dimensions: { team: {}, person: { in: 'team' } },
	actions: {
		'people.read': 'Read the people of a team',
		'people.contact': 'Contact the people of a team',
		'people.ship': 'Ship to the people of a team',
		'people.pay': 'Pay the people of a team',
	},
	roles: {},
} as const

interface DB {
	people: { id: string; team_id: string; name: string; email: string; salary: number; version: number }
}

const columns: TypedColumnList<DB> = {
	people: {
		columns: ['id', 'team_id', 'name', 'email', 'salary', 'version'],
		foreignKeys: [],
		notNull: ['id', 'team_id', 'name', 'email', 'salary', 'version'],
	},
}

const tables = defineTables(vocabulary, columns)({
	people: {
		scope: { dimension: 'person', in: { dimension: 'team', column: 'team_id' } },
		actions: { read: ['people.read', 'people.contact', 'people.ship', 'people.pay'] },
		columns: { email: { read: ['people.contact', 'people.ship'] }, salary: { read: 'people.pay' } },
	},
})

type Expect<T extends true> = T
type Has<R, C extends string> = C extends keyof R ? true : false
type Lacks<R, C extends string> = C extends keyof R ? false : true
type Row<A extends 'people.read' | 'people.contact' | 'people.ship' | 'people.pay'> = RowOf<typeof tables, 'people', A>

/** The row types follow the list: each listed action has the column, a third action and a union of two do not. */
export type ColumnReadListTypes = [
	Expect<Has<Row<'people.contact'>, 'email'>>,
	Expect<Has<Row<'people.ship'>, 'email'>>,
	Expect<Lacks<Row<'people.read'>, 'email'>>,
	Expect<Lacks<Row<'people.pay'>, 'email'>>,
	Expect<Lacks<Row<'people.contact' | 'people.ship'>, 'email'>>,
	Expect<Has<Row<'people.pay'>, 'salary'>>,
	Expect<Lacks<Row<'people.contact'>, 'salary'>>,
	Expect<Lacks<Row<'people.read'>, 'salary'>>,
]

const alice = new TestAuthority('user:alice')
let data: DataAccess

beforeEach(() => {
	const storage = bunSqliteStorage()
	storage.sql.exec(
		'create table people (id text not null primary key, team_id text not null, name text not null, email text not null, salary integer not null, version integer not null)',
	)
	storage.sql.exec(
		"insert into people (id, team_id, name, email, salary, version) values ('p1', 't1', 'Ann', 'b@x', 100, 1), ('p2', 't1', 'Ben', 'a@x', 200, 1), ('p3', 't2', 'Cid', 'c@x', 300, 1)",
	)
	const layer = scoped(tables)
	bindScopedDatabase(layer, { database: openSqlite(storage), capabilities: alice })
	data = dataAccessOf(layer)
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

async function call(handle: unknown, path: string, ...args: unknown[]): Promise<unknown> {
	const parts = path.split('.')
	const name = parts.pop() ?? ''
	const target = parts.reduce<unknown>((node, part) => (typeof node === 'object' && node !== null ? Reflect.get(node, part) : undefined), handle)
	const method: unknown = typeof target === 'object' && target !== null ? Reflect.get(target, name) : undefined
	if (typeof method !== 'function') {
		throw new TypeError(`${path} is not a method of the handle`)
	}
	return Reflect.apply(method, target, args)
}

function itemsOf(page: unknown): unknown[] {
	const items: unknown = typeof page === 'object' && page !== null ? Reflect.get(page, 'items') : undefined
	return Array.isArray(items) ? items : []
}

const list = (action: string, options?: unknown) =>
	invoke('query', (db) => call(db.within(alice.within('team', action, ['t1'])), 'people.list', options))
const count = (action: string, options?: unknown) =>
	invoke('query', (db) => call(db.within(alice.within('team', action, ['t1'])), 'people.count', options))
const get = (action: string, id = 'p1') => invoke('query', (db) => call(db.target(alice.ref('person', action, id, { team: 't1' }), 'on'), 'get'))
const appList = (action: string) => invoke('query', (db) => call(db.app(alice.app(action)), 'people.list'))

describe('a column whose read lists two actions', () => {
	for (const action of ['people.contact', 'people.ship']) {
		test(`${action} reads it through a Within, a Ref and an app capability`, async () => {
			expect(itemsOf(await list(action))).toEqual([
				{ id: 'p1', team_id: 't1', name: 'Ann', email: 'b@x', version: 1 },
				{ id: 'p2', team_id: 't1', name: 'Ben', email: 'a@x', version: 1 },
			])
			expect(await get(action)).toEqual({ id: 'p1', team_id: 't1', name: 'Ann', email: 'b@x', version: 1 })
			expect(itemsOf(await appList(action)).map((row) => Reflect.get(Object(row), 'email'))).toEqual(['b@x', 'a@x', 'c@x'])
		})

		test(`${action} filters and sorts by it`, async () => {
			expect(itemsOf(await list(action, { where: [['email', '=', 'a@x']] })).map((row) => Reflect.get(Object(row), 'id'))).toEqual(['p2'])
			expect(await count(action, { where: [['email', '=', 'a@x']] })).toBe(1)
			expect(itemsOf(await list(action, { orderBy: [['email', 'asc']] })).map((row) => Reflect.get(Object(row), 'id'))).toEqual(['p2', 'p1'])
		})
	}

	// The negative control: a table read action the list leaves out, and the single-action column's own action.
	for (const action of ['people.read', 'people.pay']) {
		test(`${action}, which the list leaves out, neither reads nor filters nor sorts by it`, async () => {
			for (const row of itemsOf(await list(action))) {
				expect(row).not.toHaveProperty('email')
			}
			expect(await get(action)).not.toHaveProperty('email')
			for (const row of itemsOf(await appList(action))) {
				expect(row).not.toHaveProperty('email')
			}
			await expect(list(action, { where: [['email', '=', 'a@x']] })).rejects.toBeInstanceOf(QueryRefusedError)
			await expect(count(action, { where: [['email', '=', 'a@x']] })).rejects.toBeInstanceOf(QueryRefusedError)
			await expect(list(action, { orderBy: [['email', 'asc']] })).rejects.toBeInstanceOf(QueryRefusedError)
		})
	}
})

describe('a column of one read action, as before', () => {
	test('only its action reads, filters and sorts by it', async () => {
		expect(itemsOf(await list('people.pay', { where: [['salary', '>', 150]], orderBy: [['salary', 'desc']] }))).toEqual([
			{ id: 'p2', team_id: 't1', name: 'Ben', salary: 200, version: 1 },
		])
		expect(await get('people.pay')).toMatchObject({ salary: 100 })
		for (const action of ['people.read', 'people.contact', 'people.ship']) {
			expect(await get(action)).not.toHaveProperty('salary')
			await expect(list(action, { where: [['salary', '>', 150]] })).rejects.toBeInstanceOf(QueryRefusedError)
			await expect(list(action, { orderBy: [['salary', 'asc']] })).rejects.toBeInstanceOf(QueryRefusedError)
		}
	})
})

describe('the parsed list', () => {
	test('a column is hidden from the table read the list leaves out, and each listed action sees it', () => {
		const model = modelOf(tableModels(tables), 'people')
		if (model === undefined) throw new Error('people has no model')
		expect(model.visible).toEqual(['id', 'team_id', 'name', 'version'])
		expect(visibleFor(model, 'people.ship')).toEqual(['id', 'team_id', 'name', 'email', 'version'])
		expect(visibleFor(model, 'people.read')).toEqual(['id', 'team_id', 'name', 'version'])
	})

	test('the artifact keeps one action as its text and several as a list', () => {
		expect(tablePolicies(tables)['people']?.columns).toEqual({
			email: { read: ['people.contact', 'people.ship'] },
			salary: { read: 'people.pay' },
		})
	})
})
