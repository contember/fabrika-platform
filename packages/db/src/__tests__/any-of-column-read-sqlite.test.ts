// A column with its own read list under an `anyOf` endpoint, on SQLite, types and runtime together. The types show it
// only where every listed action is on its list and none of them has a `when`: then every set of them a caller may hold
// reads it at run time. Otherwise it stays hidden, and an action off the list never reads, filters, sorts or aggregates
// by it. A handle that reads more columns passes where a handle that reads fewer is expected, never the reverse.

import { beforeEach, describe, expect, test } from 'bun:test'
import { QueryRefusedError } from '../errors'
import { bindScopedDatabase, type DataAccess, dataAccessOf, type DataHandles } from '../framework'
import type { RowOf } from '../orm-types'
import { defineTables } from '../policy'
import { openSqlite } from '../sqlite'
import { bunSqliteStorage } from '../sqlite-bun'
import { scoped } from '../store'
import type { ApplicationTables, DbIndex, ListPage, Tables, WithinTables } from '../tables'
import type { TypedColumnList } from '../vocabulary-tables'
import { TestAuthority } from './fixtures/authority'

const vocabulary = {
	app: 'staff',
	dimensions: { team: {}, squad: {} },
	actions: {
		'p.read': 'Read the staff',
		'p.pay': 'Pay the staff',
		'p.hr': 'Keep the staff records',
		'p.audit': 'Audit the sales staff',
		'p.self': 'Read your own record',
	},
	roles: {},
} as const

interface DB {
	people: { id: string; team: string; name: string; salary: number; review: string }
	teams: { id: string; name: string; budget: number }
	squads: { id: string; name: string; budget: number }
}

const columns: TypedColumnList<DB> = {
	people: { columns: ['id', 'team', 'name', 'salary', 'review'], foreignKeys: [], notNull: ['id', 'team', 'name', 'salary', 'review'] },
	teams: { columns: ['id', 'name', 'budget'], foreignKeys: [], notNull: ['id', 'name', 'budget'] },
	squads: { columns: ['id', 'name', 'budget'], foreignKeys: [], notNull: ['id', 'name', 'budget'] },
}

const tables = defineTables(vocabulary, columns)({
	// `salary` lists two actions without a `when`; `review` two that each have one.
	people: {
		scope: { app: 'the staff of every team' },
		actions: { read: ['p.read', 'p.pay', 'p.hr', 'p.audit', 'p.self'] },
		columns: { salary: { read: ['p.pay', 'p.hr'] }, review: { read: ['p.audit', 'p.self'] } },
		when: { 'p.audit': { team: { eq: 'sales' } }, 'p.self': { name: { eq: 'Ann' } } },
	},
	teams: {
		scope: { dimension: 'team' },
		actions: { read: ['p.read', 'p.pay', 'p.hr'] },
		columns: { budget: { read: ['p.pay', 'p.hr'] } },
	},
	// A dimension table whose listed action has a `when`; only the types read it.
	squads: {
		scope: { dimension: 'squad' },
		actions: { read: ['p.pay', 'p.hr'] },
		columns: { budget: { read: ['p.pay', 'p.hr'] } },
		when: { 'p.hr': { name: { eq: 'hr' } } },
	},
})

type Policies = typeof tables extends Tables<DB, infer P> ? P : never
type Index = DbIndex<DB, Policies>
type Expect<T extends true> = T
type Has<R, C extends string> = C extends keyof R ? true : false
type Lacks<R, C extends string> = C extends keyof R ? false : true
type Assignable<S, T> = [S] extends [T] ? true : false
type People<A extends string> = ApplicationTables<Index, A, 'query'>['people']
type Teams<A extends string> = ApplicationTables<Index, A, 'query'>['teams']
type Squads<A extends string> = ApplicationTables<Index, A, 'query'>['squads']
type TeamsWithin<A extends string> = WithinTables<Index, 'team', A, 'query'>['teams']
type Listed<H> = H extends { readonly list: (...args: never[]) => Promise<ListPage<infer R>> } ? R : never
type Got<H> = H extends { readonly get: (...args: never[]) => Promise<infer R> } ? R : never
/** What a function that only reads takes from a handle. */
type Reads<H> = Pick<H, Extract<keyof H, 'list' | 'all' | 'count' | 'get' | 'aggregate'>>

/** An anyOf handle reads a column of its own read list where every listed action is on it and none has a when. */
export type AnyOfColumnTypes = [
	Expect<Has<Listed<People<'p.pay' | 'p.hr'>>, 'salary'>>,
	Expect<Has<Got<People<'p.pay' | 'p.hr'>>, 'salary'>>,
	Expect<Has<RowOf<typeof tables, 'people', 'p.pay' | 'p.hr'>, 'salary'>>,
	Expect<Has<Listed<Teams<'p.pay' | 'p.hr'>>, 'budget'>>,
	// An action off the list: hidden, whichever listed action the caller may also hold.
	Expect<Lacks<Listed<People<'p.read' | 'p.pay'>>, 'salary'>>,
	Expect<Lacks<Got<People<'p.read' | 'p.pay'>>, 'salary'>>,
	Expect<Lacks<Listed<People<'p.pay' | 'p.hr'>>, 'review'>>,
	Expect<Lacks<Listed<Teams<'p.read' | 'p.hr'>>, 'budget'>>,
	// Every action on the list, but each has a when: hidden.
	Expect<Lacks<Listed<People<'p.audit' | 'p.self'>>, 'review'>>,
	Expect<Lacks<Listed<Squads<'p.pay' | 'p.hr'>>, 'budget'>>,
	Expect<Has<Listed<Squads<'p.hr'>>, 'budget'>>,
	// One action reads its column on its own rows, when or not, as before.
	Expect<Has<Listed<People<'p.audit'>>, 'review'>>,
	Expect<Lacks<Listed<People<'p.read'>>, 'salary'>>,
]

/** A handle that reads more columns passes where one that reads fewer is expected, never the reverse. */
export type WiderHandleTypes = [
	Expect<Assignable<Reads<People<'p.pay' | 'p.hr'>>, Reads<People<'p.read'>>>>,
	Expect<Assignable<Reads<People<'p.pay'>>, Reads<People<'p.read'>>>>,
	Expect<Assignable<Reads<Teams<'p.hr'>>, Reads<Teams<'p.read'>>>>,
	Expect<Assignable<Reads<TeamsWithin<'p.pay'>>, Reads<TeamsWithin<'p.read'>>>>,
	Expect<Assignable<Reads<People<'p.read'>>, Reads<People<'p.pay' | 'p.hr'>>> extends false ? true : false>,
	Expect<Assignable<Reads<People<'p.read'>>, Reads<People<'p.pay'>>> extends false ? true : false>,
	Expect<Assignable<Reads<Teams<'p.read'>>, Reads<Teams<'p.hr'>>> extends false ? true : false>,
	Expect<Assignable<Reads<TeamsWithin<'p.read'>>, Reads<TeamsWithin<'p.pay'>>> extends false ? true : false>,
	// Columns of different lists: neither handle reads all the other's columns.
	Expect<Assignable<Reads<People<'p.pay'>>, Reads<People<'p.audit'>>> extends false ? true : false>,
]

/** The narrower handle's read, called with the wider one: what a shared read function of an application does. */
export async function namesOf(people: Pick<People<'p.read'>, 'list'>): Promise<string[]> {
	const page = await people.list({ where: [['team', '=', 'sales']], orderBy: [['name', 'asc']] })
	return page.items.map((row) => row.name)
}
export const passesWider: (people: Pick<People<'p.pay' | 'p.hr'>, 'list'>) => Promise<string[]> = namesOf

const alice = new TestAuthority('user:alice')
let data: DataAccess

beforeEach(() => {
	const storage = bunSqliteStorage()
	storage.sql.exec(
		'create table people (id text not null primary key, team text not null, name text not null, salary integer not null, review text not null)',
	)
	storage.sql.exec('create table teams (id text not null primary key, name text not null, budget integer not null)')
	storage.sql.exec(
		"insert into people (id, team, name, salary, review) values ('p1', 'sales', 'Ann', 100, 'good'), ('p2', 'hr', 'Ben', 200, 'fair'), ('p3', 'hr', 'Cid', 300, 'poor')",
	)
	storage.sql.exec("insert into teams (id, name, budget) values ('t1', 'sales', 1000), ('t2', 'hr', 2000)")
	const layer = scoped(tables)
	bindScopedDatabase(layer, { database: openSqlite(storage), capabilities: alice })
	data = dataAccessOf(layer)
})

async function read<T>(work: (handles: DataHandles) => Promise<T>): Promise<T> {
	const transaction = data.invocation(true)
	try {
		return await work(
			data.handles({ kind: 'query', unscoped: {}, principal: 'user:alice', check: () => undefined, session: () => transaction.session() }),
		)
	} finally {
		await transaction.rollback()
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

/** `path` called on `ctx.db.app` of an `anyOf` endpoint whose caller holds `held`. */
const appCall = (held: readonly [string, ...string[]], path: string, ...args: unknown[]) =>
	read((db) => call(db.app(alice.anyOf(held)), path, ...args))

function itemsOf(page: unknown): Readonly<Record<string, unknown>>[] {
	const items: unknown = typeof page === 'object' && page !== null ? Reflect.get(page, 'items') : undefined
	return Array.isArray(items) ? items.map((item: unknown) => ({ ...Object(item) })) : []
}

const valuesOf = (rows: readonly Readonly<Record<string, unknown>>[], column: string): unknown[] => rows.map((row) => row[column])

describe('a column whose read list holds every action of an anyOf endpoint, none with a when', () => {
	// Each set of the listed actions a caller may hold: the types promise the column to every one of them.
	for (const held of [['p.pay', 'p.hr'], ['p.pay'], ['p.hr']] as const) {
		test(`a caller holding ${held.join(' and ')} reads, filters, sorts, counts and aggregates by it`, async () => {
			expect(valuesOf(itemsOf(await appCall(held, 'people.list', { orderBy: [['salary', 'desc']] })), 'salary')).toEqual([300, 200, 100])
			expect(valuesOf(itemsOf(await appCall(held, 'people.list', { where: [['salary', '>', 150]] })), 'id').sort()).toEqual(['p2', 'p3'])
			expect(await appCall(held, 'people.get', 'p2')).toMatchObject({ salary: 200 })
			expect(valuesOf(itemsOf({ items: await appCall(held, 'people.all') }), 'salary').sort()).toEqual([100, 200, 300])
			expect(await appCall(held, 'people.count', { where: [['salary', '>=', 200]] })).toBe(2)
			expect(await appCall(held, 'people.aggregate', { sum: ['salary'] })).toEqual([{ sum_salary: '600' }])
			expect(valuesOf(itemsOf(await appCall(held, 'teams.list', { orderBy: [['budget', 'asc']] })), 'budget')).toEqual([1000, 2000])
		})
	}
})

describe('a column an action of the anyOf endpoint is not listed for', () => {
	// A caller who holds only the action off the list: the column is never answered, and every use of it is refused.
	for (const held of [['p.read'], ['p.read', 'p.audit'], ['p.audit', 'p.self']] as const) {
		test(`a caller holding ${held.join(' and ')} never reads salary or budget`, async () => {
			for (const row of itemsOf(await appCall(held, 'people.list'))) {
				expect(row).not.toHaveProperty('salary')
			}
			if (held[0] === 'p.read') {
				expect(await appCall(held, 'people.get', 'p2')).not.toHaveProperty('salary')
				for (const row of itemsOf(await appCall(held, 'teams.list'))) {
					expect(row).not.toHaveProperty('budget')
				}
				await expect(appCall(held, 'teams.list', { where: [['budget', '>', 0]] })).rejects.toBeInstanceOf(QueryRefusedError)
			}
			await expect(appCall(held, 'people.list', { where: [['salary', '>', 0]] })).rejects.toBeInstanceOf(QueryRefusedError)
			await expect(appCall(held, 'people.list', { orderBy: [['salary', 'asc']] })).rejects.toBeInstanceOf(QueryRefusedError)
			await expect(appCall(held, 'people.count', { where: [['salary', '>', 0]] })).rejects.toBeInstanceOf(QueryRefusedError)
			await expect(appCall(held, 'people.aggregate', { sum: ['salary'] })).rejects.toBeInstanceOf(QueryRefusedError)
		})
	}

	test("a holder of a listed action and an unlisted one reads salary only through the listed action's reach", async () => {
		// p.pay reads every row alone (no when), so the column it lists is answered beside p.read's rows; the types still
		// hide it, because a caller of the same endpoint may hold p.read alone.
		expect(valuesOf(itemsOf(await appCall(['p.read', 'p.pay'], 'people.list', { orderBy: [['id', 'asc']] })), 'salary')).toEqual([100, 200, 300])
		for (const row of itemsOf(await appCall(['p.read'], 'people.list'))) {
			expect(row).not.toHaveProperty('salary')
		}
	})
})

describe('a column whose read list holds every action of an anyOf endpoint, each with a when', () => {
	test('a holder of both reads none of it, since each action reads only some rows', async () => {
		const rows = itemsOf(await appCall(['p.audit', 'p.self'], 'people.list', { orderBy: [['id', 'asc']] }))
		expect(valuesOf(rows, 'id')).toEqual(['p1'])
		expect(rows[0]).not.toHaveProperty('review')
		await expect(appCall(['p.audit', 'p.self'], 'people.list', { where: [['review', '=', 'good']] })).rejects.toBeInstanceOf(QueryRefusedError)
	})

	test('a holder of one reads it on the rows that action reaches', async () => {
		expect(itemsOf(await appCall(['p.audit'], 'people.list'))).toEqual([{ id: 'p1', team: 'sales', name: 'Ann', review: 'good' }])
	})
})
