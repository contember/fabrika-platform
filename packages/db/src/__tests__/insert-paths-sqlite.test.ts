// An insert's condition along a foreign key, on SQLite: the insert reads the row each path's first key names, in its
// own transaction, and judges the condition as a read of the inserted row would.

import type { TypedColumnList } from '@fabrika/db'
import { beforeEach, describe, expect, test } from 'bun:test'
import type { ColumnType } from 'kysely'
import type { ConditionPolicy } from '../conditions'
import { QueryRefusedError } from '../errors'
import { bindScopedDatabaseProvisionally, type DataAccess, dataAccessOf, type DataSite } from '../framework'
import { defineTables, type ForeignKey } from '../policy'
import { openSqlite } from '../sqlite'
import { type BunSqliteStorage, bunSqliteStorage } from '../sqlite-bun'
import { scoped } from '../store'
import { TestAuthority } from './fixtures/authority'

const migration = `
create table projects (id text not null primary key, version integer not null);
create table kinds (id text not null primary key, open boolean not null);
create table labels (
	id text not null primary key,
	project_id text not null references projects (id),
	public boolean not null,
	unique (id, project_id)
);
create table tasks (
	id text not null primary key,
	project_id text not null references projects (id),
	kind_id text default 'k-open' references kinds (id),
	label_id text references labels (id),
	title text not null unique,
	foreign key (label_id, project_id) references labels (id, project_id)
);
`

interface DB {
	projects: { id: string; version: number }
	kinds: { id: string; open: ColumnType<boolean, boolean, boolean> }
	labels: { id: string; project_id: string; public: ColumnType<boolean, boolean, boolean> }
	tasks: { id: string; project_id: string; kind_id: string | null; label_id: string | null; title: string }
}

type TaskKey = ForeignKey<keyof DB['tasks'] & string, keyof DB & string>

const tenantKey: TaskKey = { columns: ['label_id', 'project_id'], table: 'labels', references: ['id', 'project_id'] }

function columnsWith(labelKeys: readonly TaskKey[]): TypedColumnList<DB> {
	return {
		projects: { columns: ['id', 'version'], foreignKeys: [] },
		kinds: { columns: ['id', 'open'], foreignKeys: [], booleans: ['open'] },
		labels: {
			columns: ['id', 'project_id', 'public'],
			foreignKeys: [{ columns: ['project_id'], table: 'projects', references: ['id'] }],
			booleans: ['public'],
		},
		tasks: {
			columns: ['id', 'project_id', 'kind_id', 'label_id', 'title'],
			foreignKeys: [
				{ columns: ['project_id'], table: 'projects', references: ['id'] },
				{ columns: ['kind_id'], table: 'kinds', references: ['id'] },
				{ columns: ['label_id'], table: 'labels', references: ['id'] },
				...labelKeys,
			],
		},
	}
}

const vocabulary = {
	app: 'inserts',
	dimensions: { project: {} },
	actions: { 'tasks.read': 'Read tasks', 'tasks.write': 'Write tasks' },
	roles: {},
} as const

function tablesWith(when: ConditionPolicy<keyof DB['tasks'] & string>, labelKeys: readonly TaskKey[] = [tenantKey]) {
	return defineTables(vocabulary, columnsWith(labelKeys))({
		projects: { scope: { dimension: 'project' }, actions: { read: 'tasks.read' }, version: 'version' },
		kinds: { scope: { reference: 'a fixed list of task kinds' }, actions: { read: 'tasks.read' } },
		labels: { scope: { child: 'projects' }, actions: { read: 'tasks.read' } },
		tasks: {
			scope: { child: 'projects' },
			actions: { read: 'tasks.read', insert: 'tasks.write' },
			insert: ['kind_id', 'label_id', 'title'],
			when: { 'tasks.write': when },
		},
	})
}

const alice = new TestAuthority('user:alice')
let storage: BunSqliteStorage

beforeEach(() => {
	storage = bunSqliteStorage()
	storage.sql.exec(migration)
	storage.sql.exec(`
		insert into projects (id, version) values ('p1', 1), ('p2', 1);
		insert into kinds (id, open) values ('k-open', 1), ('k-closed', 0);
		insert into labels (id, project_id, public) values ('l-public', 'p1', 1), ('l-private', 'p1', 0), ('l-other', 'p2', 1);
	`)
})

function layerWith(when: ConditionPolicy<keyof DB['tasks'] & string>): DataAccess {
	const layer = scoped(tablesWith(when))
	bindScopedDatabaseProvisionally(layer, { database: openSqlite(storage), capabilities: alice })
	return dataAccessOf(layer)
}

async function call(handle: unknown, path: string, ...args: unknown[]): Promise<unknown> {
	const parts = path.split('.')
	const name = parts.pop() ?? ''
	const target = parts.reduce<unknown>((node, part) => (typeof node === 'object' && node !== null ? Reflect.get(node, part) : undefined), handle)
	const method: unknown = typeof target === 'object' && target !== null ? Reflect.get(target, name) : undefined
	if (typeof method !== 'function') throw new TypeError(`${path} is not a method of the handle`)
	return Reflect.apply(method, target, args)
}

/** The handler's insert; with `caught`, the handler catches its refusal and goes on to commit. */
async function insert(data: DataAccess, values: Record<string, unknown>, options?: unknown, caught = false): Promise<void> {
	const transaction = data.invocation(false)
	const site: DataSite = {
		kind: 'mutation',
		unscoped: {},
		principal: 'user:alice',
		check() {
			if (transaction.ended) throw new QueryRefusedError('ended', 'this invocation has ended')
		},
		session: () => transaction.session(),
	}
	try {
		const target = data.handles(site).target(alice.ref('project', 'tasks.write', 'p1'), 'on')
		const written = options === undefined ? call(target, 'tasks.insert', values) : call(target, 'tasks.insert', values, options)
		await (caught ? written.catch(() => undefined) : written)
		await transaction.commit()
	} catch (error) {
		await transaction.rollback()
		throw error
	}
}

const titles = () => storage.sql.exec('select title from tasks order by title').toArray()
const refusal = 'outside what tasks.write inserts into tasks'

describe("an insert's condition along a foreign key", () => {
	test('reads the row a key into a reference table names', async () => {
		const data = layerWith({ 'kind_id.open': { eq: true } })
		await insert(data, { kind_id: 'k-open', title: 'open' })
		await expect(insert(data, { kind_id: 'k-closed', title: 'closed' })).rejects.toThrow(refusal)
		await expect(insert(data, { kind_id: null, title: 'none' })).rejects.toThrow(refusal)
		expect(titles()).toEqual([{ title: 'open' }])
	})

	test('reads the row a key that holds the tenant names', async () => {
		const data = layerWith({ 'label_id.public': { eq: true } })
		await insert(data, { label_id: 'l-public', title: 'public' })
		await expect(insert(data, { label_id: 'l-private', title: 'private' })).rejects.toThrow(refusal)
		expect(titles()).toEqual([{ title: 'public' }])
	})

	test('judges a null key as a read does: unknown while a row qualifies, false when none does', async () => {
		const data = layerWith({ not: { 'kind_id.open': { eq: false } } })
		await expect(insert(data, { kind_id: null, title: 'none' })).rejects.toThrow(refusal)
		await expect(insert(data, { kind_id: 'k-closed', title: 'closed' })).rejects.toThrow(refusal)
		await insert(data, { kind_id: 'k-open', title: 'open' })
		storage.sql.exec("update kinds set open = 1 where id = 'k-closed'")
		await insert(data, { kind_id: null, title: 'none' })
		expect(titles()).toEqual([{ title: 'none' }, { title: 'open' }])
	})

	test("judges the row as written, the database's defaults included", async () => {
		const data = layerWith({ 'kind_id.open': { eq: true } })
		await insert(data, { title: 'defaulted' })
		expect(storage.sql.exec('select kind_id from tasks').toArray()).toEqual([{ kind_id: 'k-open' }])
	})

	test('fails the transaction it refuses in, so a handler that catches the refusal commits nothing', async () => {
		const data = layerWith({ 'kind_id.open': { eq: true } })
		await expect(insert(data, { kind_id: 'k-closed', title: 'closed' }, undefined, true)).rejects.toThrow('nothing it wrote commits')
		expect(titles()).toEqual([])
	})

	test("combines with tests of the row's own columns", async () => {
		const data = layerWith({ anyOf: [{ title: { eq: 'pinned' } }, { 'kind_id.open': { eq: true } }] })
		await insert(data, { kind_id: 'k-closed', title: 'pinned' })
		await expect(insert(data, { kind_id: 'k-closed', title: 'other' })).rejects.toThrow(refusal)
		expect(titles()).toEqual([{ title: 'pinned' }])
	})

	test('is judged on an insert that names onConflict, when it writes a row', async () => {
		const data = layerWith({ 'kind_id.open': { eq: true } })
		await expect(insert(data, { kind_id: 'k-closed', title: 'closed' }, { onConflict: { columns: ['title'], do: 'nothing' } })).rejects.toThrow(
			refusal,
		)
		expect(titles()).toEqual([])
	})
})

describe("an insert's condition tells the writer nothing about another tenant's row", () => {
	const otherIs = (open: boolean) => storage.sql.exec(`update labels set public = ${open ? 1 : 0} where id = 'l-other'`)
	const outcome = (work: Promise<void>) => work.then(() => 'written', (error: unknown) => (error instanceof Error ? error.message : 'refused'))

	test('a key into another project fails on its foreign key, whatever the row it names holds', async () => {
		const data = layerWith({ 'label_id.public': { eq: true } })
		otherIs(true)
		const open = await outcome(insert(data, { label_id: 'l-other', title: 'probe' }))
		otherIs(false)
		const closed = await outcome(insert(data, { label_id: 'l-other', title: 'probe' }))
		expect(open).toBe(closed)
		expect(open).not.toContain(refusal)
		expect(titles()).toEqual([])
	})

	test('a conflict writes no row, so nothing is judged, whatever the row it names holds', async () => {
		const data = layerWith({ 'label_id.public': { eq: true } })
		storage.sql.exec("insert into tasks (id, project_id, title) values ('t-taken', 'p1', 'taken')")
		const conflict = { onConflict: { columns: ['title'], do: 'nothing' } }
		otherIs(true)
		const open = await outcome(insert(data, { label_id: 'l-other', title: 'taken' }, conflict))
		otherIs(false)
		const closed = await outcome(insert(data, { label_id: 'l-other', title: 'taken' }, conflict))
		expect([open, closed]).toEqual(['written', 'written'])
		expect(titles()).toEqual([{ title: 'taken' }])
	})
})

describe("the policy bounds the rows an insert's condition reads", () => {
	test("a key that could name another tenant's row is refused", () => {
		expect(() => tablesWith({ 'label_id.public': { eq: true } }, [])).toThrow("outside the row's own containment")
	})
})
