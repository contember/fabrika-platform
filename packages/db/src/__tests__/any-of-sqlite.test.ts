// An `anyOf` endpoint's app capability on SQLite: it holds the set of listed actions the caller holds, and reaches what
// they reach together. An operation is allowed when its action list shares a held action, a column when a held action
// reads it, and a `when` keyed by an action applies as an OR over the held actions the table names for the operation.
// A claim needs one action, so a capability of several is refused it.

import { beforeEach, describe, expect, test } from 'bun:test'
import { CapabilityError, ConflictError, NotFoundError } from '../errors'
import { bindScopedDatabase, type DataAccess, dataAccessOf, type DataHandles, type DataSite } from '../framework'
import type { DataKind } from '../orm-types'
import { defineTables } from '../policy'
import { openSqlite } from '../sqlite'
import { bunSqliteStorage } from '../sqlite-bun'
import { scoped } from '../store'
import type { ApplicationTables, DbIndex, Tables, Unavailable } from '../tables'
import type { TypedColumnList } from '../vocabulary-tables'
import { TestAuthority } from './fixtures/authority'

const vocabulary = {
	app: 'desk',
	dimensions: { branch: {} },
	actions: {
		'desks.read': 'Read the open desks',
		'desks.audit': 'Audit the closed desks',
		'desks.manage': 'Manage every desk',
		'entries.write': 'Record entries',
	},
	roles: {},
} as const

interface DB {
	desks: { id: string; label: string; status: string; note: string; version: number }
	entries: { id: string; amount: number }
	tallies: { id: string; result: string | null; attempts: number; next_attempt_at: string | null; version: number }
}

const columns: TypedColumnList<DB> = {
	desks: { columns: ['id', 'label', 'status', 'note', 'version'], foreignKeys: [], notNull: ['id', 'label', 'status', 'note', 'version'] },
	entries: { columns: ['id', 'amount'], foreignKeys: [], notNull: ['id', 'amount'] },
	tallies: { columns: ['id', 'result', 'attempts', 'next_attempt_at', 'version'], foreignKeys: [], timestamps: ['next_attempt_at'] },
}

const tables = defineTables(vocabulary, columns)({
	desks: {
		scope: { app: 'the desks of every branch' },
		actions: {
			read: ['desks.read', 'desks.audit', 'desks.manage'],
			insert: ['desks.read', 'desks.audit'],
			update: ['desks.audit', 'desks.manage'],
		},
		insert: ['label', 'status', 'note'],
		update: ['label'],
		version: 'version',
		columns: { note: { read: 'desks.audit' } },
		when: { 'desks.read': { status: { eq: 'open' } }, 'desks.audit': { status: { eq: 'closed' } } },
	},
	entries: {
		scope: { app: 'the entries of every desk' },
		actions: { read: 'entries.write', insert: 'entries.write' },
		insert: ['amount'],
	},
	tallies: {
		scope: { app: 'the tallies a job computes' },
		actions: { read: 'desks.manage', update: 'desks.manage' },
		update: ['result'],
		queue: { attempts: 'attempts', due: 'next_attempt_at' },
		version: 'version',
	},
})

type Policies = typeof tables extends Tables<DB, infer P> ? P : never
type Index = DbIndex<DB, Policies>
type Expect<T extends true> = T
type Handle<A extends string> = ApplicationTables<Index, A, 'mutation'>
type IsUnavailable<T> = T extends Unavailable<string> ? true : false

/** The types allow what the union allows: an operation is open when any listed action is named for it. */
export type AnyOfTypes = [
	Expect<IsUnavailable<Handle<'desks.read'>['entries']['insert']>>,
	Expect<IsUnavailable<Handle<'desks.read' | 'entries.write'>['entries']['insert']> extends false ? true : false>,
	Expect<IsUnavailable<Handle<'desks.read'>['desks']['update']>>,
	Expect<IsUnavailable<Handle<'desks.read' | 'desks.audit'>['desks']['update']> extends false ? true : false>,
]

const alice = new TestAuthority('user:alice')
let data: DataAccess
let storage: ReturnType<typeof bunSqliteStorage>

beforeEach(async () => {
	storage = bunSqliteStorage()
	storage.sql.exec(
		'create table desks (id text not null primary key, label text not null, status text not null, note text not null, version integer not null)',
	)
	storage.sql.exec('create table entries (id text not null primary key, amount integer not null)')
	storage.sql.exec(
		'create table tallies (id text primary key, result text, attempts integer not null default 0, next_attempt_at text, version integer not null)',
	)
	storage.sql.exec(
		"insert into desks (id, label, status, note, version) values ('d1', 'one', 'open', 'x', 1), ('d2', 'two', 'closed', 'y', 1), ('d3', 'three', 'suspended', 'z', 1)",
	)
	storage.sql.exec('insert into tallies (id, next_attempt_at, version) values (?, ?, 1)', 't1', new Date(Date.now() - 60_000).toISOString())
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

function idsOf(page: unknown): string[] {
	const items: unknown = typeof page === 'object' && page !== null ? Reflect.get(page, 'items') : undefined
	return Array.isArray(items) ? items.map((item: unknown) => String(Reflect.get(Object(item), 'id'))).sort() : []
}

const statuses = (): unknown[] => storage.sql.exec('select id, label from desks order by id').toArray()

describe('an app capability of several actions', () => {
	test("a read's when is an OR over the held actions; a held action without one admits every row", async () => {
		await invoke('query', async (db) => {
			expect(idsOf(await call(db.app(alice.anyOf(['desks.read'])), 'desks.list'))).toEqual(['d1'])
			expect(idsOf(await call(db.app(alice.anyOf(['desks.audit'])), 'desks.list'))).toEqual(['d2'])
			expect(idsOf(await call(db.app(alice.anyOf(['desks.read', 'desks.audit'])), 'desks.list'))).toEqual(['d1', 'd2'])
			expect(await call(db.app(alice.anyOf(['desks.read', 'desks.audit'])), 'desks.count')).toBe(2)
			expect(idsOf(await call(db.app(alice.anyOf(['desks.read', 'desks.manage'])), 'desks.list'))).toEqual(['d1', 'd2', 'd3'])
		})
	})

	test('a get reaches a row through a held action whose when admits it, and a column of a held read action is read', async () => {
		await invoke('query', async (db) => {
			const both = db.app(alice.anyOf(['desks.read', 'desks.audit']))
			expect(await call(both, 'desks.get', 'd1')).toEqual({ id: 'd1', label: 'one', status: 'open', note: 'x', version: 1 })
			expect(await call(both, 'desks.get', 'd2')).toMatchObject({ note: 'y' })
			await expect(call(both, 'desks.get', 'd3')).rejects.toBeInstanceOf(NotFoundError)
			expect(await call(db.app(alice.anyOf(['desks.read', 'desks.manage'])), 'desks.get', 'd3')).toEqual({
				id: 'd3',
				label: 'three',
				status: 'suspended',
				version: 1,
			})
		})
	})

	test('an insert into a table that names only one of the held actions is allowed, and refused when it names none', async () => {
		await invoke('mutation', async (db) => {
			await call(db.app(alice.anyOf(['desks.read', 'entries.write'])), 'entries.insert', { amount: 10 })
		})
		expect(storage.sql.exec('select amount from entries').toArray()).toEqual([{ amount: 10 }])
		const refused = invoke('mutation', async (db) => await call(db.app(alice.anyOf(['desks.read', 'desks.audit'])), 'entries.insert', { amount: 20 }))
		await expect(refused).rejects.toBeInstanceOf(CapabilityError)
		expect(storage.sql.exec('select amount from entries').toArray()).toEqual([{ amount: 10 }])
	})

	test("an insert's when is an OR over the held insert actions", async () => {
		await invoke('mutation', async (db) => {
			const both = db.app(alice.anyOf(['desks.read', 'desks.audit']))
			await call(both, 'desks.insert', { label: 'four', status: 'open', note: '' })
			await call(both, 'desks.insert', { label: 'five', status: 'closed', note: '' })
		})
		const outside = invoke(
			'mutation',
			async (db) => await call(db.app(alice.anyOf(['desks.read', 'desks.audit'])), 'desks.insert', { label: 'six', status: 'suspended', note: '' }),
		)
		await expect(outside).rejects.toBeInstanceOf(ConflictError)
		const readerOnly = invoke(
			'mutation',
			async (db) => await call(db.app(alice.anyOf(['desks.read'])), 'desks.insert', { label: 'seven', status: 'closed', note: '' }),
		)
		await expect(readerOnly).rejects.toBeInstanceOf(ConflictError)
		expect(storage.sql.exec("select label from desks where label in ('four', 'five', 'six', 'seven') order by label").toArray()).toEqual([
			{ label: 'five' },
			{ label: 'four' },
		])
	})

	test('an update is allowed through the held update actions only, each under its own when', async () => {
		await invoke('mutation', async (db) => {
			const both = db.app(alice.anyOf(['desks.read', 'desks.audit']))
			await call(both, 'desks.update', 'd2', { label: 'two audited' }, { expectVersion: 1 })
		})
		// `desks.read` reads the open desk but does not update; `desks.audit` updates only closed ones.
		const open = invoke(
			'mutation',
			async (db) => await call(db.app(alice.anyOf(['desks.read', 'desks.audit'])), 'desks.update', 'd1', { label: 'one changed' }, { expectVersion: 1 }),
		)
		await expect(open).rejects.toBeInstanceOf(NotFoundError)
		await invoke('mutation', async (db) => {
			const manager = db.app(alice.anyOf(['desks.audit', 'desks.manage']))
			await call(manager, 'desks.update', 'd3', { label: 'three managed' }, { expectVersion: 1 })
		})
		expect(statuses()).toEqual([
			{ id: 'd1', label: 'one' },
			{ id: 'd2', label: 'two audited' },
			{ id: 'd3', label: 'three managed' },
		])
	})

	test('a single-action capability reaches what its action reaches, as before', async () => {
		await invoke('query', async (db) => {
			expect(idsOf(await call(db.app(alice.app('desks.read')), 'desks.list'))).toEqual(['d1'])
			expect(await call(db.app(alice.app('desks.read')), 'desks.get', 'd1')).toEqual({ id: 'd1', label: 'one', status: 'open', version: 1 })
		})
	})

	test('a claim needs a capability of one action: one of several is refused, one of one leases', async () => {
		const site: DataSite = {
			kind: 'job',
			unscoped: {},
			principal: 'job:tally',
			tickMs: 60_000,
			check: () => undefined,
			session: async () => data.direct(),
		}
		const several = call(data.handles(site).app(alice.anyOf(['desks.audit', 'desks.manage'])), 'tallies.claim', { limit: 1 })
		await expect(several).rejects.toThrow('a claim of tallies needs a capability of one action, got one of desks.audit, desks.manage')
		const rows = await call(data.handles(site).app(alice.app('desks.manage')), 'tallies.claim', { limit: 1 })
		expect(Array.isArray(rows) ? rows.map((row: unknown) => Reflect.get(Object(row), 'id')) : rows).toEqual(['t1'])
	})
})
