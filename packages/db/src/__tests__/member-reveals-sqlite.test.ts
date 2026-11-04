// Member reveals on SQLite: a grant at a dimension table's row reveals the row's ancestor node to a Within's read, for
// the actions the reveal lists, while its condition admits the row and only while the row lies under that node.

import type { TypedColumnList } from '@fabrika/db'
import { beforeEach, describe, expect, test } from 'bun:test'
import type { ColumnType } from 'kysely'
import type { ContainerGrant } from '../capability'
import { CapabilityError, PolicyError, QueryRefusedError } from '../errors'
import { bindScopedDatabaseProvisionally, type DataAccess, dataAccessOf, type DataHandles, type DataSite } from '../framework'
import type { DataKind } from '../orm-types'
import { defineTables } from '../policy'
import { openSqlite } from '../sqlite'
import { type BunSqliteStorage, bunSqliteStorage } from '../sqlite-bun'
import { scoped } from '../store'
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
`

interface DB {
	projects: { id: string; name: string; version: number }
	tasks: { id: string; project_id: string; open: ColumnType<boolean, boolean | undefined, boolean>; version: number }
	docs: { id: string; project_id: string; title: string }
}

const columns: TypedColumnList<DB> = {
	projects: { columns: ['id', 'name', 'version'], foreignKeys: [] },
	tasks: {
		columns: ['id', 'project_id', 'open', 'version'],
		foreignKeys: [{ columns: ['project_id'], table: 'projects', references: ['id'] }],
		booleans: ['open'],
	},
	docs: { columns: ['id', 'project_id', 'title'], foreignKeys: [{ columns: ['project_id'], table: 'projects', references: ['id'] }] },
}

const vocabulary = {
	app: 'members',
	dimensions: { project: {}, task: { in: 'project' } },
	actions: {
		'projects.read': 'Read projects',
		'docs.read': 'Read documents',
		'tasks.read': 'Read tasks',
	},
	roles: {},
} as const

const policies = {
	projects: { scope: { dimension: 'project' }, actions: { read: 'projects.read' }, version: 'version' },
	tasks: {
		scope: { dimension: 'task' },
		actions: { read: 'tasks.read' },
		version: 'version',
		memberReveals: { task: { to: 'project', actions: ['projects.read'], when: { open: { eq: true } } } },
	},
	docs: { scope: { child: 'projects' }, actions: { read: 'projects.read' } },
} as const

const tables = defineTables(vocabulary, columns)(policies)

const alice = new TestAuthority('user:alice')
let storage: BunSqliteStorage
let data: DataAccess

beforeEach(() => {
	storage = bunSqliteStorage()
	storage.sql.exec(migration)
	storage.sql.exec(`
		insert into projects (id, name, version) values ('p1', 'one', 1), ('p2', 'two', 1), ('p3', 'three', 1);
		insert into tasks (id, project_id, open, version) values ('t1', 'p1', 1, 1), ('t2', 'p2', 0, 1), ('t3', 'p3', 1, 1);
		insert into docs (id, project_id, title) values ('d1', 'p1', 'one'), ('d2', 'p2', 'two'), ('d3', 'p3', 'three');
	`)
	const layer = scoped(tables)
	bindScopedDatabaseProvisionally(layer, { database: openSqlite(storage), capabilities: alice })
	data = dataAccessOf(layer)
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
