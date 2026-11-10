// Member reveals on SQLite: a grant at a dimension table's row reveals the row's ancestor node to a Within's read, for
// the actions the reveal lists, while its condition admits the row and only while the row lies under that node.

import type { TypedColumnList } from '@fabrika/db'
import { beforeEach, describe, expect, test } from 'bun:test'
import type { ColumnType } from 'kysely'
import { z } from 'zod/v4'
import type { ContainerGrant, Ref } from '../capability'
import { CapabilityError, PolicyError, QueryRefusedError } from '../errors'
import { bindScopedDatabaseProvisionally, type DataAccess, dataAccessOf, type DataHandles, type DataSite } from '../framework'
import type { DataKind } from '../orm-types'
import { defineTables } from '../policy'
import { openSqlite } from '../sqlite'
import { type BunSqliteStorage, bunSqliteStorage } from '../sqlite-bun'
import { defineStore, scoped } from '../store'
import { tablePolicies } from '../tables'
import { TestAuthority } from './fixtures/authority'

const migration = `
create table projects (id text not null primary key, name text not null, version integer not null);
create table tasks (
	id text not null primary key,
	project_id text not null references projects (id),
	open boolean not null default 1,
	version integer not null
);
create table docs (id text not null primary key, project_id text not null references projects (id), title text not null);
create view doc_titles as select id, project_id, title from docs;
`

interface DB {
	projects: { id: string; name: string; version: number }
	tasks: { id: string; project_id: string; open: ColumnType<boolean, boolean | undefined, boolean>; version: number }
	docs: { id: string; project_id: string; title: string }
	doc_titles: { id: string | null; project_id: string | null; title: string | null }
}

const columns: TypedColumnList<DB, 'doc_titles'> = {
	projects: { columns: ['id', 'name', 'version'], foreignKeys: [] },
	tasks: {
		columns: ['id', 'project_id', 'open', 'version'],
		foreignKeys: [{ columns: ['project_id'], table: 'projects', references: ['id'] }],
		booleans: ['open'],
	},
	docs: { columns: ['id', 'project_id', 'title'], foreignKeys: [{ columns: ['project_id'], table: 'projects', references: ['id'] }] },
	doc_titles: { columns: ['id', 'project_id', 'title'], foreignKeys: [], view: true },
}

const vocabulary = {
	app: 'members',
	dimensions: { project: {}, task: { in: 'project' } },
	actions: {
		'projects.read': 'Read projects',
		'docs.read': 'Read documents',
		'tasks.read': 'Read tasks',
		'tasks.write': 'Write tasks',
	},
	roles: {},
} as const

const policies = {
	projects: { scope: { dimension: 'project' }, actions: { read: 'projects.read' }, version: 'version' },
	tasks: {
		scope: { dimension: 'task' },
		actions: { read: 'tasks.read', insert: 'tasks.write', delete: 'tasks.write' },
		insert: ['open'],
		version: 'version',
		memberReveals: { task: { to: 'project', actions: ['projects.read'], when: { open: { eq: true } } } },
	},
	docs: { scope: { child: 'projects' }, actions: { read: 'projects.read' } },
	doc_titles: { scope: { child: 'projects' }, actions: { read: 'projects.read' } },
} as const

const tables = defineTables(vocabulary, columns)(policies)

/** A move is a method of a store, as `src/db/stores/*.ts` defines one, not of a site's handles. */
const newLayer = () => scoped(tables)

function taskStore(layer: ReturnType<typeof newLayer>) {
	return defineStore(layer, 'tasks', (t) => ({ move: (task: Ref<'task', 'tasks.write'>, to: Ref<'project', 'tasks.write'>) => t.move(task, to) }))
}

const alice = new TestAuthority('user:alice')
let storage: BunSqliteStorage
let data: DataAccess
let tasks: ReturnType<typeof taskStore>

beforeEach(() => {
	storage = bunSqliteStorage()
	storage.sql.exec(migration)
	storage.sql.exec(`
		insert into projects (id, name, version) values ('p1', 'one', 1), ('p2', 'two', 1), ('p3', 'three', 1);
		insert into tasks (id, project_id, open, version) values ('t1', 'p1', 1, 1), ('t2', 'p2', 0, 1), ('t3', 'p3', 1, 1);
		insert into docs (id, project_id, title) values ('d1', 'p1', 'one'), ('d2', 'p2', 'two'), ('d3', 'p3', 'three');
	`)
	const layer = newLayer()
	bindScopedDatabaseProvisionally(layer, { database: openSqlite(storage), capabilities: alice })
	data = dataAccessOf(layer)
	tasks = taskStore(layer)
})

async function invoke<T>(kind: DataKind, work: (handles: DataHandles) => Promise<T>): Promise<T> {
	const transaction = data.invocation(kind === 'query')
	const site: DataSite = {
		kind,
		unscoped: {},
		principal: 'user:alice',
		check() {
			if (transaction.ended) throw new QueryRefusedError('ended', 'this invocation has ended')
		},
		session: () => transaction.session(),
	}
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
	if (typeof method !== 'function') throw new TypeError(`${path} is not a method of the handle`)
	return Reflect.apply(method, target, args)
}

function ids(page: unknown): string[] {
	const items: unknown = typeof page === 'object' && page !== null ? Reflect.get(page, 'items') : undefined
	return Array.isArray(items) ? items.map((row: unknown) => String(typeof row === 'object' && row !== null ? Reflect.get(row, 'id') : '')).sort() : []
}

const listed = (table: string, revealing: readonly ContainerGrant[], values: readonly string[] = []) =>
	invoke('query', (db) => call(db.within(alice.within('project', 'projects.read', values, [], [], [], revealing)), `${table}.list`)).then(ids)

const atTasks = (...values: string[]): ContainerGrant[] => [{ dimension: 'task', values }]

describe('a Within that carries a grant at a row which reveals its ancestor', () => {
	test("lists the row's ancestor node and the rows under it, and no other node", async () => {
		expect(await listed('projects', atTasks('t1'))).toEqual(['p1'])
		expect(await listed('docs', atTasks('t1'))).toEqual(['d1'])
	})

	test("lists a child view's rows through the revealed parent row, and follows the row", async () => {
		expect(await listed('doc_titles', atTasks('t1'))).toEqual(['d1'])
		expect(await listed('doc_titles', atTasks('t2'))).toEqual([])
		storage.sql.exec("update tasks set project_id = 'p3' where id = 't1'")
		expect(await listed('doc_titles', atTasks('t1'))).toEqual(['d3'])
	})

	test("reveals nothing for a row the reveal's condition excludes, or for a node with no row", async () => {
		expect(await listed('projects', atTasks('t2'))).toEqual([])
		expect(await listed('projects', atTasks('t9'))).toEqual([])
	})

	test('follows the row: a task moved to another project reveals that one, and a deleted task nothing', async () => {
		storage.sql.exec("update tasks set project_id = 'p3' where id = 't1'")
		expect(await listed('projects', atTasks('t1'))).toEqual(['p3'])
		storage.sql.exec("delete from tasks where id = 't1'")
		expect(await listed('projects', atTasks('t1'))).toEqual([])
	})

	test("adds to the Within's own values", async () => {
		expect(await listed('projects', atTasks('t1'), ['p2'])).toEqual(['p1', 'p2'])
	})

	test('a grant at a dimension whose rows reveal no node for the action is unenforceable', async () => {
		await expect(listed('projects', [{ dimension: 'project', values: ['p2'] }])).rejects.toThrow(CapabilityError)
		const docs = () => invoke('query', (db) => call(db.within(alice.within('project', 'docs.read', [], [], [], [], atTasks('t1'))), 'projects.list'))
		await expect(docs()).rejects.toThrow(CapabilityError)
	})

	test("the grant's values count towards the Within's limit", async () => {
		const many = Array.from({ length: 1001 }, (_, index) => `t${index}`)
		await expect(listed('projects', atTasks(...many))).rejects.toThrow('at most 1000')
	})
})

describe('a revealing row is written through a capability only, and never moves', () => {
	test("refuses an insert that picks the row's key, which could revive a node a stale grant still names", async () => {
		const transaction = data.invocation(false)
		const sql = data.sql({ mode: 'write', check() {}, session: () => transaction.session(), fail: () => transaction.fail() })
		const revive = () => sql(z.strictObject({}))`insert into tasks (id, project_id, open, version) values (${'t-old'}, ${'p2'}, ${true}, ${1})`
		await expect(revive()).rejects.toThrow("'tasks' at line 1 hands out access")
		await transaction.rollback()
		expect(storage.sql.exec("select id from tasks where id = 't-old'").toArray()).toEqual([])
	})

	test('refuses an unscoped write, which places the row without the bound of an insert under a Ref', async () => {
		const transaction = data.invocation(false)
		const site: DataSite = { kind: 'mutation', unscoped: { tasks: 'write' }, principal: 'user:alice', check() {}, session: () => transaction.session() }
		const insert = () => call(data.handles(site).unscoped, 'tasks.insert', { project_id: 'p2', open: true })
		await expect(insert()).rejects.toThrow('tasks hands out access, so it is written through a capability only, never unscoped')
		await transaction.rollback()
		expect(storage.sql.exec("select count(*) as n from tasks where project_id = 'p2'").toArray()).toEqual([{ n: 1 }])
	})

	test("refuses a move, which would reveal the new project to the task's members", async () => {
		const move = () => tasks.move(alice.ref('task', 'tasks.write', 't1'), alice.ref('project', 'tasks.write', 'p3'))
		await expect(move()).rejects.toThrow('tasks hands out access, so a row is never moved')
		expect(storage.sql.exec("select project_id from tasks where id = 't1'").toArray()).toEqual([{ project_id: 'p1' }])
	})
})

describe('the artifact', () => {
	test('carries a member reveal, and no field for a table without one', () => {
		const artifact = tablePolicies(tables)
		expect(artifact['tasks']?.memberReveals).toEqual({ task: { to: 'project', actions: ['projects.read'], when: { open: { eq: true } } } })
		expect(artifact['projects']).not.toHaveProperty('memberReveals')
	})
})

describe('the policy bounds what a table may reveal to members', () => {
	const policy = (tasks: Record<string, unknown>, docs: Record<string, unknown> = {}) => () =>
		defineTables(vocabulary, columns)({
			projects: policies.projects,
			tasks: { scope: { dimension: 'task' }, actions: { read: 'tasks.read' }, version: 'version', ...tasks },
			docs: { scope: { child: 'projects' }, actions: { read: 'projects.read' }, ...docs },
		})
	const reveal = (fields: Record<string, unknown>) => ({ memberReveals: { task: { to: 'project', actions: ['projects.read'], ...fields } } })

	test("a reveal to an ancestor, under a condition on the row's own containment, is accepted", () => {
		expect(policy(reveal({}))).not.toThrow()
		expect(policy(reveal({ when: { 'project_id.name': { eq: 'one' } } }))).not.toThrow()
	})

	test('a not in its condition follows no key the column list does not declare NOT NULL', () => {
		expect(policy(reveal({ when: { not: { 'project_id.name': { eq: 'one' } } } }))).toThrow(
			'tasks: memberReveals.task.when.not.project_id.name: tasks.project_id may be null',
		)
	})

	test('a node outside the chain, no action, an action outside the vocabulary or an unknown field is refused', () => {
		expect(policy(reveal({ to: 'task' }))).toThrow("not a dimension of tasks's chain")
		expect(policy(reveal({ actions: [] }))).toThrow('names no action')
		expect(policy(reveal({ actions: ['projects.delete'] }))).toThrow('not an action of the vocabulary')
		expect(policy(reveal({ assign: {} }))).toThrow(PolicyError)
	})

	test("a dimension other than the table's own, or a child table, is refused", () => {
		expect(policy({ memberReveals: { project: { to: 'project', actions: ['projects.read'] } } })).toThrow("not tasks's own dimension")
		expect(policy({}, { memberReveals: { project: { to: 'project', actions: ['projects.read'] } } })).toThrow('reveals nothing to members')
	})
})
