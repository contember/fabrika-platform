// A condition on one relation (`relationWhen`): a member of a project reads and writes only its open tasks, while an IAM
// grant, and another relation, reach every task. The condition narrows that relation's terms only, on every statement
// of a Ref minted through it; an insert held through it is judged on the written row; a child view takes its own and
// not its parent's. Every case runs on SQLite and, with FABRIKA_TEST_POSTGRES_URL, on Postgres:
//
//   docker run --rm -d -p 55433:5432 -e POSTGRES_PASSWORD=postgres postgres:17
//   FABRIKA_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55433/postgres bun test packages/db
//
// The URL is a credential: it is never logged.

import type { TypedColumnList } from '@fabrika/db'
import { openPostgres } from '@fabrika/db/postgres'
import { SQL } from 'bun'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import type { Database } from '../database'
import { ConflictError, NotFoundError, PolicyError, QueryRefusedError } from '../errors'
import { bindScopedDatabaseProvisionally, type DataAccess, dataAccessOf, type DataHandles, type DataSite } from '../framework'
import type { DataKind } from '../orm-types'
import { defineTables } from '../policy'
import { openSqlite } from '../sqlite'
import { bunSqliteStorage } from '../sqlite-bun'
import { scoped } from '../store'
import { tablePolicies } from '../tables'
import { TestAuthority } from './fixtures/authority'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR]
const hasPostgres = url !== undefined && url !== ''

if (!hasPostgres) {
	console.warn(`relation-when.test.ts: the Postgres half is skipped; set ${URL_VAR} to run it`)
}

const migration = `
create table projects (id text not null primary key, name text not null);
create table project_members (id text not null primary key, project_id text not null references projects (id), principal_id text not null);
create table project_leads (id text not null primary key, project_id text not null references projects (id), principal_id text not null);
create table categories (id text not null primary key, public text not null);
create table tasks (
	id text not null primary key,
	project_id text not null references projects (id),
	status text not null,
	title text not null,
	category_id text references categories (id),
	unique (id, project_id)
);
create table task_assignees (
	id text not null primary key,
	task_id text not null,
	project_id text not null,
	principal_id text not null,
	foreign key (task_id, project_id) references tasks (id, project_id)
);
create view task_digests as select id, id as task_id, title from tasks;
`

const seed = `
delete from task_assignees;
delete from tasks;
delete from categories;
delete from project_members;
delete from project_leads;
delete from projects;
insert into projects (id, name) values ('p1', 'one'), ('p2', 'two');
insert into project_members (id, project_id, principal_id) values ('m1', 'p1', 'user:alice');
insert into categories (id, public) values ('c-public', 'yes'), ('c-private', 'no');
insert into tasks (id, project_id, status, title, category_id) values
	('k1', 'p1', 'open', 'one', 'c-public'),
	('k2', 'p1', 'closed', 'two', 'c-public'),
	('k3', 'p1', 'open', 'hidden', null),
	('k4', 'p2', 'open', 'four', null);
`

interface DB {
	projects: { id: string; name: string }
	project_members: { id: string; project_id: string; principal_id: string }
	project_leads: { id: string; project_id: string; principal_id: string }
	categories: { id: string; public: string }
	tasks: { id: string; project_id: string; status: string; title: string; category_id: string | null }
	task_assignees: { id: string; task_id: string; project_id: string; principal_id: string }
	task_digests: { id: string | null; task_id: string | null; title: string | null }
}

const columns: TypedColumnList<DB> = {
	projects: { columns: ['id', 'name'], foreignKeys: [], notNull: ['id', 'name'] },
	project_members: {
		columns: ['id', 'project_id', 'principal_id'],
		foreignKeys: [{ columns: ['project_id'], table: 'projects', references: ['id'] }],
		notNull: ['id', 'project_id', 'principal_id'],
	},
	project_leads: {
		columns: ['id', 'project_id', 'principal_id'],
		foreignKeys: [{ columns: ['project_id'], table: 'projects', references: ['id'] }],
		notNull: ['id', 'project_id', 'principal_id'],
	},
	categories: { columns: ['id', 'public'], foreignKeys: [], notNull: ['id', 'public'] },
	tasks: {
		columns: ['id', 'project_id', 'status', 'title', 'category_id'],
		foreignKeys: [{ columns: ['project_id'], table: 'projects', references: ['id'] }, {
			columns: ['category_id'],
			table: 'categories',
			references: ['id'],
		}],
		notNull: ['id', 'project_id', 'status', 'title'],
	},
	task_assignees: {
		columns: ['id', 'task_id', 'project_id', 'principal_id'],
		foreignKeys: [{ columns: ['task_id', 'project_id'], table: 'tasks', references: ['id', 'project_id'] }],
		notNull: ['id', 'task_id', 'project_id', 'principal_id'],
	},
	task_digests: { columns: ['id', 'task_id', 'title'], foreignKeys: [], view: true },
}

const vocabulary = {
	app: 'relation-when',
	dimensions: { project: {}, task: { in: 'project' } },
	actions: {
		'projects.read': 'Read projects',
		'tasks.read': 'Read tasks',
		'tasks.insert': 'Create tasks',
		'tasks.write': 'Write tasks',
		'leads.insert': 'Name project leads',
	},
	relations: { member: { dimension: 'project' }, lead: { dimension: 'project' }, assignee: { dimension: 'task' } },
	roles: {},
} as const

const isOpen = { status: { eq: 'open' } } as const

const others = {
	projects: { scope: { dimension: 'project' }, actions: { read: 'projects.read' } },
	project_members: { scope: { child: 'projects' }, actions: { read: 'projects.read' }, confers: { member: { principal: 'principal_id' } } },
	project_leads: {
		scope: { child: 'projects' },
		actions: { read: 'projects.read', insert: 'leads.insert' },
		insert: ['principal_id'],
		confers: { lead: { principal: 'principal_id', assign: { self: true } } },
		relationWhen: { member: { 'leads.insert': { 'project_id.name': { eq: 'one' } } } },
	},
	categories: { scope: { reference: 'shared task categories' }, actions: { read: 'tasks.read' } },
	task_assignees: { scope: { child: 'tasks' }, actions: { read: 'tasks.read' }, confers: { assignee: { principal: 'principal_id' } } },
	task_digests: {
		scope: { child: 'tasks' },
		actions: { read: 'tasks.read' },
		relationWhen: { member: { 'tasks.read': { title: { notEq: 'hidden' } } } },
	},
} as const

const taskPolicy = {
	scope: { dimension: 'task' },
	actions: { read: 'tasks.read', insert: 'tasks.insert', update: 'tasks.write' },
	insert: ['status', 'title', 'category_id'],
	update: ['title'],
	relationWhen: { member: { 'tasks.read': isOpen, 'tasks.write': isOpen, 'tasks.insert': { 'category_id.public': { eq: 'yes' } } } },
} as const

const tables = defineTables(vocabulary, columns)({ ...others, tasks: taskPolicy })

const alice = new TestAuthority('user:alice')

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

interface Backend {
	readonly database: Database
	exec(text: string): Promise<void>
	rows(text: string): Promise<readonly Record<string, unknown>[]>
}

async function postgresAdmin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

const rowList = z.array(z.record(z.string(), z.unknown()))

function suite(dialect: 'sqlite' | 'postgres', open: () => Promise<Backend>, close: () => Promise<void>): void {
	describe.skipIf(dialect === 'postgres' && !hasPostgres)(`on ${dialect}`, () => {
		let backend: Backend
		let data: DataAccess
		let release: () => void = () => {}

		beforeAll(async () => {
			backend = await open()
		})

		afterAll(async () => {
			release()
			await close()
		})

		beforeEach(async () => {
			await backend.exec(seed)
			release()
			const layer = scoped(tables)
			const binding = bindScopedDatabaseProvisionally(layer, { database: backend.database, capabilities: alice })
			release = () => binding.release()
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

		const listed = async (values: readonly string[], relations: readonly string[], table = 'tasks') =>
			ids(await invoke('query', (db) => call(db.within(alice.within('project', 'tasks.read', values, [], [], relations)), `${table}.list`)))
		const task = (action: string, id: string, project: string, relations: readonly string[] = ['member']) =>
			alice.ref('task', action, id, { project }, relations)
		const titles = async (): Promise<string[]> => (await backend.rows('select title from tasks order by title')).map((row) => String(row['title']))

		test("a member lists only its project's open tasks; an IAM grant and the unnarrowed relation are not narrowed", async () => {
			expect(await listed([], ['member'])).toEqual(['k1', 'k3'])
			expect(await listed(['p1'], [])).toEqual(['k1', 'k2', 'k3'])
			expect(await listed(['p2'], ['member'])).toEqual(['k1', 'k3', 'k4'])
			await backend.exec("insert into task_assignees (id, task_id, project_id, principal_id) values ('a1', 'k2', 'p1', 'user:alice')")
			expect(await listed([], ['member', 'assignee'])).toEqual(['k1', 'k2', 'k3'])
		})

		test('a Ref through the relation reads and writes an open task only, and each statement judges the row again', async () => {
			expect(await invoke('query', (db) => call(db.target(task('tasks.read', 'k1', 'p1'), 'on'), 'get'))).toMatchObject({ id: 'k1' })
			await expect(invoke('query', (db) => call(db.target(task('tasks.read', 'k2', 'p1'), 'on'), 'get'))).rejects.toThrow(NotFoundError)
			await expect(invoke('mutation', (db) => call(db.target(task('tasks.write', 'k2', 'p1'), 'on'), 'update', { title: 'x' })))
				.rejects.toThrow(NotFoundError)
			// The IAM-held Ref of the same closed task is not narrowed.
			expect(await invoke('query', (db) => call(db.target(task('tasks.read', 'k2', 'p1', []), 'on'), 'get'))).toMatchObject({ id: 'k2' })
			await invoke('query', async (db) => {
				const target = db.target(task('tasks.read', 'k1', 'p1'), 'on')
				expect(await call(target, 'get')).toMatchObject({ id: 'k1' })
				await backend.exec("update tasks set status = 'closed' where id = 'k1'")
				await expect(call(target, 'get')).rejects.toThrow(NotFoundError)
			})
			expect(await titles()).toEqual(['four', 'hidden', 'one', 'two'])
		})

		test('an insert through the relation is judged on the written row, through its path, and writes nothing outside it', async () => {
			const into = (relations: readonly string[], category: string, title: string) =>
				invoke('mutation', (db) =>
					call(db.target(alice.ref('project', 'tasks.insert', 'p1', {}, relations), 'on'), 'tasks.insert', {
						status: 'open',
						title,
						category_id: category,
					}))
			expect(await into(['member'], 'c-public', 'public')).toMatchObject({ id: expect.any(String) })
			await expect(into(['member'], 'c-private', 'private')).rejects.toThrow(ConflictError)
			// An IAM grant at the project is not narrowed by the member's condition.
			expect(await into([], 'c-private', 'by grant')).toMatchObject({ id: expect.any(String) })
			expect(await titles()).toEqual(['by grant', 'four', 'hidden', 'one', 'public', 'two'])
		})

		test("an insert through the relation under a condition without a path is judged on the row's own values", async () => {
			const opened = scoped(
				defineTables(vocabulary, columns)({ ...others, tasks: { ...taskPolicy, relationWhen: { member: { 'tasks.insert': isOpen } } } }),
			)
			release()
			const binding = bindScopedDatabaseProvisionally(opened, { database: backend.database, capabilities: alice })
			release = () => binding.release()
			data = dataAccessOf(opened)
			const into = (relations: readonly string[], status: string, title: string) =>
				invoke(
					'mutation',
					(db) => call(db.target(alice.ref('project', 'tasks.insert', 'p1', {}, relations), 'on'), 'tasks.insert', { status, title, category_id: null }),
				)
			expect(await into(['member'], 'open', 'opened')).toMatchObject({ id: expect.any(String) })
			await expect(into(['member'], 'closed', 'closed')).rejects.toThrow(ConflictError)
			expect(await into([], 'closed', 'closed by grant')).toMatchObject({ id: expect.any(String) })
			expect(await titles()).toEqual(['closed by grant', 'four', 'hidden', 'one', 'opened', 'two'])
		})

		test('an insert whose row fails a narrowed relation stands only on what held its destination before the write', async () => {
			await backend.exec("insert into project_members (id, project_id, principal_id) values ('m2', 'p2', 'user:alice')")
			const lead = (project: string, relations: readonly string[]) =>
				invoke('mutation', (db) =>
					call(db.target(alice.ref('project', 'leads.insert', project, {}, relations), 'on'), 'project_leads.insert', {
						principal_id: 'user:alice',
					}))
			const leads = async (): Promise<string[]> =>
				(await backend.rows('select project_id from project_leads order by project_id')).map((row) => String(row['project_id']))
			// p2 fails the member's condition, and no lead row held p2 before the write: the written row holds nothing for itself.
			await expect(lead('p2', ['member'])).rejects.toThrow(ConflictError)
			await expect(lead('p2', ['member', 'lead'])).rejects.toThrow(ConflictError)
			expect(await leads()).toEqual([])
			expect(await lead('p1', ['member', 'lead'])).toMatchObject({ id: expect.any(String) })
			await backend.exec("insert into project_leads (id, project_id, principal_id) values ('l2', 'p2', 'user:alice')")
			expect(await lead('p2', ['member', 'lead'])).toMatchObject({ id: expect.any(String) })
			expect(await leads()).toEqual(['p1', 'p2', 'p2'])
		})

		test('with several narrowed relations, one the row meets holds the insert only if it held the destination before the write', async () => {
			const narrowed = scoped(
				defineTables(vocabulary, columns)({
					...others,
					tasks: taskPolicy,
					project_leads: {
						...others.project_leads,
						relationWhen: {
							member: { 'leads.insert': { 'project_id.name': { eq: 'one' } } },
							lead: { 'leads.insert': { 'project_id.name': { eq: 'two' } } },
						},
					},
				}),
			)
			release()
			const binding = bindScopedDatabaseProvisionally(narrowed, { database: backend.database, capabilities: alice })
			release = () => binding.release()
			data = dataAccessOf(narrowed)
			await backend.exec("insert into project_members (id, project_id, principal_id) values ('m2', 'p2', 'user:alice')")
			const lead = () =>
				invoke('mutation', (db) =>
					call(db.target(alice.ref('project', 'leads.insert', 'p2', {}, ['member', 'lead']), 'on'), 'project_leads.insert', {
						principal_id: 'user:alice',
					}))
			await expect(lead()).rejects.toThrow(ConflictError)
			expect(await backend.rows('select id from project_leads')).toEqual([])
			await backend.exec("insert into project_leads (id, project_id, principal_id) values ('l2', 'p2', 'user:alice')")
			expect(await lead()).toMatchObject({ id: expect.any(String) })
		})

		test("a child view takes its own relationWhen, never its parent's", async () => {
			// k2 is closed, which only the parent's condition refuses; k3's title is the one the view's condition refuses.
			expect(await listed([], ['member'], 'task_digests')).toEqual(['k1', 'k2'])
			expect(await listed(['p1'], [], 'task_digests')).toEqual(['k1', 'k2', 'k3'])
			expect(await listed(['p2'], ['member'], 'task_digests')).toEqual(['k1', 'k2', 'k4'])
			const digests = (id: string, relations?: readonly string[]) =>
				invoke('query', async (db) => ids(await call(db.target(task('tasks.read', id, 'p1', relations), 'on'), 'task_digests.list')))
			expect(await digests('k2')).toEqual(['k2'])
			expect(await digests('k3')).toEqual([])
			expect(await digests('k3', [])).toEqual(['k3'])
		})
	})
}

describe('the policy', () => {
	const policy = (tasks: Record<string, unknown>, digests: Record<string, unknown> = {}) => () =>
		defineTables(vocabulary, columns)({ ...others, task_digests: { ...others.task_digests, ...digests }, tasks: { ...taskPolicy, ...tasks } })

	test('names a relation of the vocabulary that reaches the table, and an action the table names', () => {
		expect(policy({})).not.toThrow()
		expect(policy({ relationWhen: { owner: { 'tasks.read': isOpen } } })).toThrow(PolicyError)
		expect(policy({ relationWhen: { owner: { 'tasks.read': isOpen } } })).toThrow('names a relation the vocabulary does not declare')
		expect(policy({ relationWhen: { member: { 'projects.read': isOpen } } })).toThrow('names an action the table does not name')
		expect(policy({ relationWhen: { member: {} } })).toThrow('names no action')
		const projects = () =>
			defineTables(vocabulary, columns)({
				...others,
				tasks: taskPolicy,
				projects: { ...others.projects, relationWhen: { assignee: { 'projects.read': { name: { eq: 'one' } } } } },
			})
		expect(projects).toThrow('names a relation that reaches no row of projects')
		const categories = () =>
			defineTables(vocabulary, columns)({
				...others,
				tasks: taskPolicy,
				categories: { ...others.categories, relationWhen: { member: { 'tasks.read': { public: { eq: 'yes' } } } } },
			})
		expect(categories).toThrow('a reference table takes no relationWhen')
	})

	test("parses a condition as when does, an insert's against its own rows", () => {
		expect(policy({ relationWhen: { member: { 'tasks.read': { colour: { eq: 'red' } } } } })).toThrow(PolicyError)
		expect(policy({ relationWhen: { member: { 'tasks.insert': { some: { task_assignees: {} } } } } })).toThrow(PolicyError)
		// A child view's relation is checked against its parent's reach.
		expect(policy({}, { relationWhen: { assignee: { 'tasks.read': { title: { eq: 'one' } } } } })).not.toThrow()
	})

	test('the artifact carries it, and a table without it has no field', () => {
		const artifact = tablePolicies(tables)
		expect(artifact['tasks']?.relationWhen).toEqual({
			member: {
				'tasks.read': { status: { eq: 'open' } },
				'tasks.write': { status: { eq: 'open' } },
				'tasks.insert': { 'category_id.public': { eq: 'yes' } },
			},
		})
		expect(artifact['task_digests']?.relationWhen).toEqual({ member: { 'tasks.read': { title: { notEq: 'hidden' } } } })
		expect(artifact['projects']).not.toHaveProperty('relationWhen')
	})
})

suite('sqlite', async () => {
	const storage = bunSqliteStorage()
	storage.sql.exec(migration)
	return {
		database: openSqlite(storage),
		exec: async (text) => {
			storage.sql.exec(text)
		},
		rows: async (text) => storage.sql.exec(text).toArray(),
	}
}, async () => {})

const schema = `db_${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
let postgres: Database | undefined

suite('postgres', async () => {
	await postgresAdmin(async (sql) => {
		await sql.unsafe(`create schema ${schema}`)
		await sql.unsafe(`set search_path to ${schema}; ${migration}`)
	})
	const database = openPostgres({ url: url ?? '', schema, max: 2 })
	postgres = database
	return {
		database,
		exec: (text) => postgresAdmin(async (sql) => void (await sql.unsafe(`set search_path to ${schema}; ${text}`))),
		rows: (text) =>
			postgresAdmin(async (sql) => {
				await sql.unsafe(`set search_path to ${schema}`)
				return rowList.parse(await sql.unsafe(text))
			}),
	}
}, async () => {
	await postgres?.close()
	await postgresAdmin((sql) => sql.unsafe(`drop schema if exists ${schema} cascade`))
})
