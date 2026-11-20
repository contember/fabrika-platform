// An `anyOf` endpoint's app capability on SQLite: it holds the set of listed actions the caller holds, and reaches the
// union of what each of them reaches alone. An operation is allowed when its action list shares a held action, and a
// `when` keyed by an action applies as an OR over the held actions the table names for the operation. A column of its own
// read action is answered only where that action reads every row or alone reaches them, and an update runs under only
// the actions that write every column it sets, so one action's columns never land on another action's rows. A claim needs
// one action, so a capability of several is refused it.

import { beforeEach, describe, expect, test } from 'bun:test'
import { CapabilityError, ConflictError, NotFoundError, QueryRefusedError } from '../errors'
import type { FileBinding } from '../file-columns'
import { holdsFile } from '../file-references'
import { bindScopedDatabase, type DataAccess, dataAccessOf, type DataHandles, type DataSite } from '../framework'
import type { DataKind } from '../orm-types'
import { defineTables, readTables } from '../policy'
import { openSqlite } from '../sqlite'
import { bunSqliteStorage } from '../sqlite-bun'
import { scoped } from '../store'
import { storedFiles } from '../stored-files'
import type { ApplicationTables, DbIndex, Tables, Unavailable } from '../tables'
import type { TypedColumnList } from '../vocabulary-tables'
import { TestAuthority } from './fixtures/authority'
import { sqliteFramework } from './fixtures/sqlite-framework'

const vocabulary = {
	app: 'desk',
	dimensions: { branch: {} },
	actions: {
		'desks.read': 'Read the open desks',
		'desks.audit': 'Audit the closed desks',
		'desks.manage': 'Manage every desk',
		'entries.write': 'Record entries',
		'staff.read': 'Read the sales staff',
		'staff.self': 'Read your own staff records with their salary',
		'staff.audit': 'Read every staff record with its bonus',
		'staff.edit': 'Rename the sales staff',
		'staff.flag': 'Flag your own staff records',
		'acc.signup': 'Sign up an account',
		'acc.edit': 'Edit the sales accounts',
		'acc.sales': 'Sign up and edit the sales accounts',
		'acc.hr': 'Sign up and edit the hr accounts',
	},
	roles: {},
} as const

interface DB {
	desks: { id: string; label: string; status: string; note: string; version: number }
	entries: { id: string; amount: number }
	tallies: { id: string; result: string | null; attempts: number; next_attempt_at: string | null; version: number }
	people: { id: string; name: string; dept: string; owner: string; salary: number; bonus: number; flag: string | null }
	accounts: { id: string; email: string; dept: string; note: string; secret: string }
}

const columns: TypedColumnList<DB> = {
	desks: { columns: ['id', 'label', 'status', 'note', 'version'], foreignKeys: [], notNull: ['id', 'label', 'status', 'note', 'version'] },
	entries: { columns: ['id', 'amount'], foreignKeys: [], notNull: ['id', 'amount'] },
	tallies: { columns: ['id', 'result', 'attempts', 'next_attempt_at', 'version'], foreignKeys: [], timestamps: ['next_attempt_at'] },
	people: { columns: ['id', 'name', 'dept', 'owner', 'salary', 'bonus', 'flag'], foreignKeys: [] },
	accounts: { columns: ['id', 'email', 'dept', 'note', 'secret'], foreignKeys: [] },
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
	// One action's rows and another one's columns: `staff.read` reads sales, `staff.self` reads alice's rows and their salary.
	people: {
		scope: { app: 'the staff records of every department' },
		actions: { read: ['staff.read', 'staff.self', 'staff.audit'], update: 'staff.edit' },
		update: ['name'],
		columns: { salary: { read: 'staff.self' }, bonus: { read: 'staff.audit' }, flag: { write: 'staff.flag' } },
		when: {
			'staff.read': { dept: { eq: 'sales' } },
			'staff.edit': { dept: { eq: 'sales' } },
			'staff.self': { owner: { eq: 'alice' } },
			'staff.flag': { owner: { eq: 'alice' } },
		},
	},
	// One action that only inserts, one that only updates, and two that do both, each in its own department.
	accounts: {
		scope: { app: 'the accounts of every department' },
		actions: { read: 'acc.edit', insert: ['acc.signup', 'acc.sales', 'acc.hr'], update: ['acc.edit', 'acc.sales', 'acc.hr'] },
		insert: ['email', 'dept', 'note'],
		update: ['note'],
		when: { 'acc.edit': { dept: { eq: 'sales' } }, 'acc.sales': { dept: { eq: 'sales' } }, 'acc.hr': { dept: { eq: 'hr' } } },
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
	storage.sql.exec(
		'create table people (id text not null primary key, name text not null, dept text not null, owner text not null, salary integer not null, bonus integer not null, flag text)',
	)
	storage.sql.exec(
		"insert into people (id, name, dept, owner, salary, bonus) values ('alice', 'Alice', 'hr', 'alice', 200, 20), ('bob', 'Bob', 'sales', 'bob', 100, 10), ('carol', 'Carol', 'sales', 'alice', 300, 30)",
	)
	storage.sql.exec(
		"create table accounts (id text not null primary key, email text not null unique, dept text not null, note text not null, secret text not null default 'kept')",
	)
	storage.sql.exec("insert into accounts (id, email, dept, note) values ('a1', 'bob@x', 'sales', 'first'), ('a2', 'alice@x', 'hr', 'first')")
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

	test('a get reaches a row through a held action whose when admits it; a column of its own read action shows only where that action alone reaches', async () => {
		await invoke('query', async (db) => {
			const both = db.app(alice.anyOf(['desks.read', 'desks.audit']))
			// `note` is `desks.audit`'s, and `desks.read` reaches rows too: hidden on every row, d1 being only desks.read's.
			expect(await call(both, 'desks.get', 'd1')).toEqual({ id: 'd1', label: 'one', status: 'open', version: 1 })
			expect(await call(both, 'desks.get', 'd2')).toEqual({ id: 'd2', label: 'two', status: 'closed', version: 1 })
			// `entries.write` names no desk, so `desks.audit` alone reaches the row and shows its column.
			expect(await call(db.app(alice.anyOf(['desks.audit', 'entries.write'])), 'desks.get', 'd2')).toMatchObject({ note: 'y' })
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

describe('the union of what each held action reaches alone', () => {
	const people = (): unknown[] => storage.sql.exec('select id, name, flag from people order by id').toArray()
	const rowsOf = (page: unknown): unknown[] => {
		const items: unknown = typeof page === 'object' && page !== null ? Reflect.get(page, 'items') : undefined
		return Array.isArray(items) ? [...items].sort((left, right) => String(Reflect.get(left, 'id')).localeCompare(String(Reflect.get(right, 'id')))) : []
	}

	test("one action's column is never answered on another action's rows: a list, a where on it and a get hide it", async () => {
		await invoke('query', async (db) => {
			const both = db.app(alice.anyOf(['staff.read', 'staff.self']))
			// bob is only staff.read's row (sales); salary is staff.self's, whose condition admits alice's rows only.
			expect(rowsOf(await call(both, 'people.list'))).toEqual([
				{ id: 'alice', name: 'Alice', dept: 'hr', owner: 'alice', flag: null },
				{ id: 'bob', name: 'Bob', dept: 'sales', owner: 'bob', flag: null },
				{ id: 'carol', name: 'Carol', dept: 'sales', owner: 'alice', flag: null },
			])
			await expect(call(both, 'people.list', { where: [['salary', '=', 100]] })).rejects.toBeInstanceOf(QueryRefusedError)
			await expect(call(both, 'people.aggregate', { groupBy: ['salary'], count: true })).rejects.toBeInstanceOf(QueryRefusedError)
			expect(await call(both, 'people.get', 'bob')).toEqual({ id: 'bob', name: 'Bob', dept: 'sales', owner: 'bob', flag: null })
		})
	})

	test('a column of an action without a when is answered on every row, and one of the only reaching action on its rows', async () => {
		await invoke('query', async (db) => {
			// staff.audit has no when: it reads every row alone, so its bonus is answered beside staff.read's rows.
			const audit = rowsOf(await call(db.app(alice.anyOf(['staff.read', 'staff.audit'])), 'people.list'))
			expect(audit.map((row) => [Reflect.get(Object(row), 'id'), Reflect.get(Object(row), 'bonus')])).toEqual([['alice', 20], ['bob', 10], [
				'carol',
				30,
			]])
			// staff.edit reads nothing, so staff.self alone reaches the listed rows and answers its salary.
			const own = rowsOf(await call(db.app(alice.anyOf(['staff.edit', 'staff.self'])), 'people.list'))
			expect(own.map((row) => [Reflect.get(Object(row), 'id'), Reflect.get(Object(row), 'salary')])).toEqual([['alice', 200], ['carol', 300]])
		})
	})

	test('an update runs under only the held actions that write every column it sets, within their conditions', async () => {
		const update = (id: string, values: Readonly<Record<string, unknown>>) =>
			invoke('mutation', async (db) => await call(db.app(alice.anyOf(['staff.edit', 'staff.flag'])), 'people.update', id, values))
		// alice is hr: staff.edit, which writes name, does not reach her, and staff.flag does not write name.
		await expect(update('alice', { name: 'Renamed' })).rejects.toBeInstanceOf(NotFoundError)
		// bob is not alice's: staff.flag, which writes flag, does not reach him, and staff.edit does not write flag.
		await expect(update('bob', { flag: 'x' })).rejects.toBeInstanceOf(NotFoundError)
		// No held action writes both columns.
		await expect(update('carol', { name: 'Both', flag: 'x' })).rejects.toThrow('no action of staff.edit, staff.flag updates every column')
		expect(people()).toEqual([
			{ id: 'alice', name: 'Alice', flag: null },
			{ id: 'bob', name: 'Bob', flag: null },
			{ id: 'carol', name: 'Carol', flag: null },
		])
		// Each write one held action covers succeeds under that action's condition only.
		await update('bob', { name: 'Robert' })
		await update('alice', { flag: 'checked' })
		expect(people()).toEqual([
			{ id: 'alice', name: 'Alice', flag: 'checked' },
			{ id: 'bob', name: 'Robert', flag: null },
			{ id: 'carol', name: 'Carol', flag: null },
		])
	})

	test('a single action reaches what it reached before: its rows, and its own column on them', async () => {
		await invoke('query', async (db) => {
			expect(rowsOf(await call(db.app(alice.app('staff.self')), 'people.list'))).toEqual([
				{ id: 'alice', name: 'Alice', dept: 'hr', owner: 'alice', salary: 200, flag: null },
				{ id: 'carol', name: 'Carol', dept: 'sales', owner: 'alice', salary: 300, flag: null },
			])
			expect(idsOf(await call(db.app(alice.app('staff.read')), 'people.list'))).toEqual(['bob', 'carol'])
		})
		await invoke('mutation', async (db) => await call(db.app(alice.app('staff.flag')), 'people.update', 'carol', { flag: 'own' }))
		await expect(invoke('mutation', async (db) => await call(db.app(alice.app('staff.flag')), 'people.update', 'bob', { flag: 'x' }))).rejects
			.toBeInstanceOf(NotFoundError)
		await expect(invoke('mutation', async (db) => await call(db.app(alice.app('staff.flag')), 'people.update', 'carol', { name: 'x' }))).rejects
			.toBeInstanceOf(QueryRefusedError)
	})
})

describe('an insert that updates on a conflict', () => {
	const accounts = (): unknown[] => storage.sql.exec('select id, email, dept, note from accounts order by id').toArray()
	const unchanged = [{ id: 'a1', email: 'bob@x', dept: 'sales', note: 'first' }, { id: 'a2', email: 'alice@x', dept: 'hr', note: 'first' }]
	const upsert = (actions: readonly [string, ...string[]], values: Readonly<Record<string, unknown>>, mode: 'update' | 'nothing') =>
		invoke(
			'mutation',
			async (db) => await call(db.app(alice.anyOf(actions)), 'accounts.insert', values, { onConflict: { columns: ['email'], do: mode } }),
		)

	test("one action's insert never pairs with another's update; a conflict that updates nothing still works", async () => {
		// acc.signup inserts and acc.edit updates: neither does both, so neither alone nor the two together upsert.
		await expect(upsert(['acc.edit', 'acc.signup'], { email: 'bob@x', dept: 'sales', note: 'over' }, 'update')).rejects.toBeInstanceOf(CapabilityError)
		await expect(upsert(['acc.signup'], { email: 'bob@x', dept: 'sales', note: 'over' }, 'update')).rejects.toBeInstanceOf(CapabilityError)
		expect(accounts()).toEqual(unchanged)
		expect(await upsert(['acc.edit', 'acc.signup'], { email: 'bob@x', dept: 'sales', note: 'over' }, 'nothing')).toEqual({ inserted: false })
		expect(await upsert(['acc.edit', 'acc.signup'], { email: 'carol@x', dept: 'hr', note: 'new' }, 'nothing')).toMatchObject({ inserted: true })
		expect(accounts()).toHaveLength(3)
	})

	test("an action that inserts and updates upserts under its own when, never under another such action's", async () => {
		const sales = await invoke(
			'mutation',
			async (db) =>
				await call(db.app(alice.app('acc.sales')), 'accounts.insert', { email: 'bob@x', dept: 'sales', note: 'mine' }, {
					onConflict: { columns: ['email'], do: 'update' },
				}),
		)
		expect(sales).toMatchObject({ id: 'a1', inserted: false })
		// alice@x is hr: acc.sales inserts the given sales row, acc.hr would update the stored hr row; no one action does both.
		await expect(upsert(['acc.sales', 'acc.hr'], { email: 'alice@x', dept: 'sales', note: 'paired' }, 'update')).rejects.toBeInstanceOf(ConflictError)
		expect(await upsert(['acc.sales', 'acc.hr'], { email: 'alice@x', dept: 'hr', note: 'hr' }, 'update')).toMatchObject({ id: 'a2', inserted: false })
		expect(accounts()).toEqual([{ id: 'a1', email: 'bob@x', dept: 'sales', note: 'mine' }, { id: 'a2', email: 'alice@x', dept: 'hr', note: 'hr' }])
	})
})

describe('a file column under several read actions', () => {
	const fileVocabulary = {
		dimensions: { branch: {} },
		actions: { 'staff.read': 'Read the sales badges', 'staff.self': 'Read your own badges and their photo', 'staff.edit': 'Edit the sales badges' },
	}
	const fileColumns = { badges: { columns: ['id', 'dept', 'owner', 'card', 'photo'], foreignKeys: [] } }
	const filePolicies = {
		badges: {
			scope: { app: 'the badges of every department' },
			actions: { read: ['staff.read', 'staff.self'], update: 'staff.edit' },
			update: ['dept'],
			files: { card: 'cards', photo: 'photos' },
			columns: { photo: { read: 'staff.self' } },
			when: { 'staff.read': { dept: { eq: 'sales' } }, 'staff.self': { owner: { eq: 'alice' } }, 'staff.edit': { dept: { eq: 'sales' } } },
		},
	}
	const BADGES = `CREATE TABLE badges (
	id TEXT PRIMARY KEY, dept TEXT NOT NULL, owner TEXT NOT NULL,
	card TEXT NOT NULL REFERENCES fabrika_files (id), photo TEXT NOT NULL REFERENCES fabrika_files (id)
) STRICT;`
	let files: Record<string, string>
	let badges: DataAccess

	beforeEach(async () => {
		const framework = await sqliteFramework(BADGES)
		const stored = storedFiles(() => ({ database: framework.database, capabilities: alice }))
		files = {}
		for (const name of ['bobCard', 'bobPhoto', 'aliceCard', 'alicePhoto']) {
			const id = Bun.randomUUIDv7()
			const kind = name.endsWith('Card') ? 'cards' : 'photos'
			await stored.stage({ id, kind, objectKey: `${kind}/${id}`, contentType: 'image/png', name: null, request: 'seed' })
			await stored.written(id, { size: 3, sha256: 'c'.repeat(64) })
			files[name] = id
		}
		framework.exec(
			"insert into badges (id, dept, owner, card, photo) values ('b1', 'sales', 'bob', ?, ?), ('b2', 'hr', 'alice', ?, ?)",
			files['bobCard'] ?? '',
			files['bobPhoto'] ?? '',
			files['aliceCard'] ?? '',
			files['alicePhoto'] ?? '',
		)
		const layer = scoped(readTables(fileColumns, filePolicies, fileVocabulary))
		bindScopedDatabase(layer, { database: framework.database, capabilities: alice })
		badges = dataAccessOf(layer)
	})

	/** What `work` reads under `actions`, and the files whose references it may open. */
	async function readBadges(actions: readonly [string, ...string[]], work: (handle: unknown) => Promise<unknown>) {
		const holder = {}
		const binding: FileBinding = { holder, request: 'read', graceMs: 3_600_000, scans: () => false }
		const transaction = badges.invocation(true)
		const site: DataSite = {
			kind: 'query',
			unscoped: {},
			principal: 'user:alice',
			files: binding,
			check: () => undefined,
			session: () => transaction.session(),
		}
		try {
			const answer = await work(badges.handles(site).app(alice.anyOf(actions)))
			const readable = Object.keys(files).filter((name) => holdsFile(holder, files[name] ?? '')).sort()
			return { answer, readable }
		} finally {
			await transaction.rollback()
		}
	}
	const columnsOf = (page: unknown): string[][] => {
		const items: unknown = Reflect.get(Object(page), 'items')
		return Array.isArray(items) ? items.map((item: unknown) => Object.keys(Object(item)).sort()).sort() : []
	}

	test("a list under read actions only opens every listed row's file; its own action's file only where that action alone reads", async () => {
		// Each listed row was admitted by a read action that alone reads its card: both cards open; the photo is staff.self's.
		const both = await readBadges(['staff.read', 'staff.self'], (handle) => call(handle, 'badges.list'))
		expect(columnsOf(both.answer)).toEqual([['card', 'dept', 'id', 'owner'], ['card', 'dept', 'id', 'owner']])
		expect(both.readable).toEqual(['aliceCard', 'bobCard'])
		// staff.self alone reads here (staff.edit reads nothing): its photo is answered and opens.
		const own = await readBadges(['staff.edit', 'staff.self'], (handle) => call(handle, 'badges.list'))
		expect(columnsOf(own.answer)).toEqual([['card', 'dept', 'id', 'owner', 'photo']])
		expect(own.readable).toEqual(['aliceCard', 'alicePhoto'])
	})

	test('a get through a held action that does not read keeps the file closed', async () => {
		// The get reaches b1 through staff.read or staff.edit, and staff.edit does not read the table.
		const got = await readBadges(['staff.read', 'staff.edit'], (handle) => call(handle, 'badges.get', 'b1'))
		expect(Object.keys(Object(got.answer)).sort()).toEqual(['card', 'dept', 'id', 'owner'])
		expect(got.readable).toEqual([])
	})
})
