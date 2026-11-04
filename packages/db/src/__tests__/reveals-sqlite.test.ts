// A relation's reveals on SQLite: a row the relation reaches reveals its ancestor node, for the actions the reveal lists,
// while the reveal's condition admits the row, and only while the row lies under that node.

import type { TypedColumnList } from '@fabrika/db'
import { beforeEach, describe, expect, test } from 'bun:test'
import type { ColumnType } from 'kysely'
import { CapabilityError, PolicyError, QueryRefusedError } from '../errors'
import { bindScopedDatabaseProvisionally, type DataAccess, dataAccessOf, type DataHandles, type DataSite } from '../framework'
import type { DataKind } from '../orm-types'
import { defineTables } from '../policy'
import type { RevealCheck } from '../registry'
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
	version integer not null,
	unique (id, project_id)
);
create table task_assignees (
	id text not null primary key,
	task_id text not null,
	project_id text not null,
	principal_id text not null,
	foreign key (task_id, project_id) references tasks (id, project_id) on update cascade on delete cascade
);
create table docs (id text not null primary key, project_id text not null references projects (id), title text not null);
`

interface DB {
	projects: { id: string; name: string; version: number }
	tasks: { id: string; project_id: string; open: ColumnType<boolean, boolean | undefined, boolean>; version: number }
	task_assignees: { id: string; task_id: string; project_id: string; principal_id: string }
	docs: { id: string; project_id: string; title: string }
}

const columns: TypedColumnList<DB> = {
	projects: { columns: ['id', 'name', 'version'], foreignKeys: [] },
	tasks: {
		columns: ['id', 'project_id', 'open', 'version'],
		foreignKeys: [{ columns: ['project_id'], table: 'projects', references: ['id'] }],
		booleans: ['open'],
	},
	task_assignees: {
		columns: ['id', 'task_id', 'project_id', 'principal_id'],
		foreignKeys: [{ columns: ['task_id', 'project_id'], table: 'tasks', references: ['id', 'project_id'] }],
	},
	docs: { columns: ['id', 'project_id', 'title'], foreignKeys: [{ columns: ['project_id'], table: 'projects', references: ['id'] }] },
}

const vocabulary = {
	app: 'reveals',
	dimensions: { project: {}, task: { in: 'project' } },
	actions: {
		'projects.read': 'Read projects',
		'projects.write': 'Write projects',
		'tasks.read': 'Read tasks',
		'tasks.assign': 'Assign a task',
	},
	relations: { assignee: { dimension: 'task' } },
	roles: {},
} as const

const policies = {
	projects: {
		scope: { dimension: 'project' },
		actions: { read: 'projects.read', update: 'projects.write' },
		update: ['name'],
		version: 'version',
	},
	tasks: {
		scope: { dimension: 'task' },
		actions: { read: 'tasks.read' },
		version: 'version',
		reveals: { assignee: { to: 'project', actions: ['projects.read'], when: { open: { eq: true } } } },
	},
	task_assignees: {
		scope: { child: 'tasks' },
		actions: { read: 'tasks.read', insert: 'tasks.assign' },
		insert: ['principal_id'],
		confers: { assignee: { principal: 'principal_id', assign: {} } },
	},
	docs: { scope: { child: 'projects' }, actions: { read: 'projects.read' } },
} as const

const tables = defineTables(vocabulary, columns)(policies)

const alice = new TestAuthority('user:alice')
let storage: BunSqliteStorage
let data: DataAccess
let reveals: RevealCheck

beforeEach(() => {
	storage = bunSqliteStorage()
	storage.sql.exec(migration)
	storage.sql.exec(`
		insert into projects (id, name, version) values ('p1', 'one', 1), ('p2', 'two', 1), ('p3', 'three', 1);
		insert into tasks (id, project_id, open, version) values ('t1', 'p1', 1, 1), ('t2', 'p2', 0, 1), ('t3', 'p3', 1, 1);
		insert into docs (id, project_id, title) values ('d1', 'p1', 'one'), ('d2', 'p2', 'two'), ('d3', 'p3', 'three');
	`)
	const layer = scoped(tables)
	reveals = bindScopedDatabaseProvisionally(layer, { database: openSqlite(storage), capabilities: alice }).reveals
	data = dataAccessOf(layer)
})

function assign(id: string, task: string, principal: string): void {
	storage.sql.exec(
		'insert into task_assignees (id, task_id, project_id, principal_id) select ?, id, project_id, ? from tasks where id = ?',
		id,
		principal,
		task,
	)
}

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

const listed = (table: string, action = 'projects.read') =>
	invoke('query', (db) => call(db.within(alice.within('project', action, [], [], [], ['assignee'])), `${table}.list`)).then(ids)

const viaAssignee = (action: string, id: string) => alice.ref('project', action, id, {}, ['assignee'])

describe('a Within held through a relation that a contained row reveals', () => {
	test('lists the ancestor nodes of the rows the relation reaches, and their other contained rows', async () => {
		assign('a1', 't1', 'user:alice')
		assign('a3', 't3', 'user:bob')
		expect(await listed('projects')).toEqual(['p1'])
		expect(await listed('docs')).toEqual(['d1'])
	})

	test("reveals nothing for a row the reveal's condition excludes", async () => {
		assign('a2', 't2', 'user:alice')
		expect(await listed('projects')).toEqual([])
	})

	test('follows the row: a task moved to another project reveals that one, and a deleted assignment nothing', async () => {
		assign('a1', 't1', 'user:alice')
		storage.sql.exec("update tasks set project_id = 'p3' where id = 't1'")
		expect(await listed('projects')).toEqual(['p3'])
		storage.sql.exec("delete from task_assignees where id = 'a1'")
		expect(await listed('projects')).toEqual([])
	})
})

describe('a Ref held through a reveal', () => {
	test('reads its node while a revealing row stands, and 404s once the assignment is gone', async () => {
		assign('a1', 't1', 'user:alice')
		const read = () => invoke('query', (db) => call(db.target(viaAssignee('projects.read', 'p1'), 'on'), 'get'))
		expect(await read()).toMatchObject({ id: 'p1' })
		storage.sql.exec("delete from task_assignees where id = 'a1'")
		await expect(read()).rejects.toThrow('not found')
	})

	test('a Ref of an action the reveal does not list is unenforceable, and writes nothing', async () => {
		assign('a1', 't1', 'user:alice')
		const rename = () =>
			invoke('mutation', (db) => call(db.target(viaAssignee('projects.write', 'p1'), 'on'), 'update', { name: 'x' }, { expectVersion: 1 }))
		await expect(rename()).rejects.toThrow(CapabilityError)
		expect(storage.sql.exec("select name from projects where id = 'p1'").toArray()).toEqual([{ name: 'one' }])
	})

	test('the reveal check answers a revealing row of the principal only', async () => {
		assign('a1', 't1', 'user:alice')
		assign('a2', 't2', 'user:alice')
		expect(await reveals('assignee', 'project', 'p1', 'user:alice')).toBe(true)
		expect(await reveals('assignee', 'project', 'p1', 'user:bob')).toBe(false)
		expect(await reveals('assignee', 'project', 'p2', 'user:alice')).toBe(false)
		expect(await reveals('assignee', 'project', 'p3', 'user:alice')).toBe(false)
	})
})

describe('the artifact', () => {
	test('carries a reveal, and no field for a table without one', () => {
		const artifact = tablePolicies(tables)
		expect(artifact['tasks']?.reveals).toEqual({ assignee: { to: 'project', actions: ['projects.read'], when: { open: { eq: true } } } })
		expect(artifact['projects']).not.toHaveProperty('reveals')
	})
})

describe('the policy bounds what a table may reveal', () => {
	const policy = (tasks: Record<string, unknown>, docs: Record<string, unknown> = {}) => () =>
		defineTables(vocabulary, columns)({
			projects: { scope: { dimension: 'project' }, actions: { read: 'projects.read' }, version: 'version' },
			tasks: { scope: { dimension: 'task' }, actions: { read: 'tasks.read' }, version: 'version', ...tasks },
			task_assignees: policies.task_assignees,
			docs: { scope: { child: 'projects' }, actions: { read: 'projects.read' }, ...docs },
		})
	const reveal = (fields: Record<string, unknown>) => ({ reveals: { assignee: { to: 'project', actions: ['projects.read'], ...fields } } })

	test("a reveal to an ancestor, under a condition on the row's own containment, is accepted", () => {
		expect(policy(reveal({}))).not.toThrow()
		expect(policy(reveal({ when: { 'project_id.name': { eq: 'one' } } }))).not.toThrow()
	})

	test('a node outside the chain, no action, an action outside the vocabulary or an unknown field is refused', () => {
		expect(policy(reveal({ to: 'task' }))).toThrow("not a dimension above task in tasks's chain")
		expect(policy(reveal({ actions: [] }))).toThrow('names no action')
		expect(policy(reveal({ actions: ['projects.delete'] }))).toThrow('not an action of the vocabulary')
		expect(policy(reveal({ scope: 'all' }))).toThrow(PolicyError)
	})

	test('a relation outside the vocabulary, or of another dimension than the table, is refused', () => {
		expect(policy({ reveals: { owner: { to: 'project', actions: ['projects.read'] } } })).toThrow('not a relation of the vocabulary')
		expect(policy({}, reveal({}))).toThrow('reveals nothing')
	})
})

describe('an insert into a node no table owns, through a reveal', () => {
	interface Unowned {
		tasks: { id: string; project_id: string; version: number }
		task_assignees: { id: string; task_id: string; project_id: string; principal_id: string }
		notes: { id: string; project_id: string; body: string; version: number }
	}
	const unownedColumns: TypedColumnList<Unowned> = {
		tasks: { columns: ['id', 'project_id', 'version'], foreignKeys: [] },
		task_assignees: {
			columns: ['id', 'task_id', 'project_id', 'principal_id'],
			foreignKeys: [{ columns: ['task_id', 'project_id'], table: 'tasks', references: ['id', 'project_id'] }],
		},
		notes: { columns: ['id', 'project_id', 'body', 'version'], foreignKeys: [] },
	}
	const unownedVocabulary = {
		app: 'unowned',
		dimensions: { project: {}, task: { in: 'project' }, note: { in: 'project' } },
		actions: { 'tasks.read': 'Read tasks', 'tasks.assign': 'Assign a task', 'notes.read': 'Read notes', 'notes.write': 'Write notes' },
		relations: { assignee: { dimension: 'task' } },
		roles: {},
	} as const
	const unowned = defineTables(unownedVocabulary, unownedColumns)({
		tasks: {
			scope: { dimension: 'task' },
			actions: { read: 'tasks.read' },
			version: 'version',
			reveals: { assignee: { to: 'project', actions: ['notes.write'] } },
		},
		task_assignees: { scope: { child: 'tasks' }, actions: { read: 'tasks.read' }, confers: { assignee: { principal: 'principal_id' } } },
		notes: { scope: { dimension: 'note' }, actions: { read: 'notes.read', insert: 'notes.write' }, insert: ['body'], version: 'version' },
	})

	test('inserts while a revealing row stands, and writes nothing once the assignment is gone', async () => {
		const store = bunSqliteStorage()
		store.sql.exec(`
			create table tasks (id text not null primary key, project_id text not null, version integer not null, unique (id, project_id));
			create table task_assignees (
				id text not null primary key, task_id text not null, project_id text not null, principal_id text not null,
				foreign key (task_id, project_id) references tasks (id, project_id)
			);
			create table notes (id text not null primary key, project_id text not null, body text not null, version integer not null);
			insert into tasks (id, project_id, version) values ('t1', 'p1', 1);
			insert into task_assignees (id, task_id, project_id, principal_id) values ('a1', 't1', 'p1', 'user:alice');
		`)
		const layer = scoped(unowned)
		bindScopedDatabaseProvisionally(layer, { database: openSqlite(store), capabilities: alice })
		const access = dataAccessOf(layer)
		const write = async (body: string) => {
			const transaction = access.invocation(false)
			const site: DataSite = { kind: 'mutation', unscoped: {}, principal: 'user:alice', check() {}, session: () => transaction.session() }
			try {
				const ref = alice.ref('project', 'notes.write', 'p1', {}, ['assignee'])
				await call(access.handles(site).target(ref, 'in'), 'notes.insert', { body })
				await transaction.commit()
			} catch (error) {
				await transaction.rollback()
				throw error
			}
		}
		await write('held')
		store.sql.exec("delete from task_assignees where id = 'a1'")
		await expect(write('revoked')).rejects.toThrow('no row holds notes.write')
		expect(store.sql.exec('select body, project_id from notes').toArray()).toEqual([{ body: 'held', project_id: 'p1' }])
	})
})
