// A relation held inside a node (`~relin`, a scoped grant of a role with `via`): the relation reaches only the rows that
// lie inside the grant's node, by each table's own column for the node's dimension. A table with no such column, and a
// reveal to a dimension above the node, reach nothing through it. Every case runs on SQLite and, with
// FABRIKA_TEST_POSTGRES_URL, on Postgres:
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
import type { RelationHold } from '../capability'
import type { Database } from '../database'
import { CapabilityError, NotFoundError, QueryRefusedError } from '../errors'
import { bindScopedDatabaseProvisionally, type DataAccess, dataAccessOf, type DataHandles, type DataSite, type PathCheck } from '../framework'
import type { DataKind } from '../orm-types'
import { defineTables } from '../policy'
import { openSqlite } from '../sqlite'
import { bunSqliteStorage } from '../sqlite-bun'
import { scoped } from '../store'
import { TestAuthority, type TestHold } from './fixtures/authority'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR]
const hasPostgres = url !== undefined && url !== ''

if (!hasPostgres) {
	console.warn(`relation-inside.test.ts: the Postgres half is skipped; set ${URL_VAR} to run it`)
}

const migration = `
create table orgs (id text not null primary key, name text not null);
create table projects (id text not null primary key, org_id text not null references orgs (id), name text not null, unique (id, org_id));
create table project_members (
	id text not null primary key,
	project_id text not null,
	org_id text not null,
	principal_id text not null,
	foreign key (project_id, org_id) references projects (id, org_id)
);
create table tasks (
	id text not null primary key,
	project_id text not null,
	org_id text not null,
	title text not null,
	foreign key (project_id, org_id) references projects (id, org_id)
);
`

const seed = `
delete from tasks;
delete from project_members;
delete from projects;
delete from orgs;
insert into orgs (id, name) values ('o1', 'one'), ('o2', 'two');
insert into projects (id, org_id, name) values ('p1', 'o1', 'one'), ('p2', 'o1', 'two'), ('p3', 'o2', 'three');
insert into project_members (id, project_id, org_id, principal_id) values
	('m1', 'p1', 'o1', 'user:alice'), ('m2', 'p2', 'o1', 'user:alice'), ('m3', 'p3', 'o2', 'user:alice');
insert into tasks (id, project_id, org_id, title) values ('k1', 'p1', 'o1', 'one'), ('k2', 'p2', 'o1', 'two'), ('k3', 'p3', 'o2', 'three');
`

interface DB {
	orgs: { id: string; name: string }
	projects: { id: string; org_id: string; name: string }
	project_members: { id: string; project_id: string; org_id: string; principal_id: string }
	tasks: { id: string; project_id: string; org_id: string; title: string }
}

const columns: TypedColumnList<DB> = {
	orgs: { columns: ['id', 'name'], foreignKeys: [], notNull: ['id', 'name'] },
	projects: {
		columns: ['id', 'org_id', 'name'],
		foreignKeys: [{ columns: ['org_id'], table: 'orgs', references: ['id'] }],
		notNull: ['id', 'org_id', 'name'],
	},
	project_members: {
		columns: ['id', 'project_id', 'org_id', 'principal_id'],
		foreignKeys: [{ columns: ['project_id', 'org_id'], table: 'projects', references: ['id', 'org_id'] }],
		notNull: ['id', 'project_id', 'org_id', 'principal_id'],
	},
	tasks: {
		columns: ['id', 'project_id', 'org_id', 'title'],
		foreignKeys: [{ columns: ['project_id', 'org_id'], table: 'projects', references: ['id', 'org_id'] }],
		notNull: ['id', 'project_id', 'org_id', 'title'],
	},
}

const vocabulary = {
	app: 'relation-inside',
	dimensions: { org: {}, project: { in: 'org' }, task: { in: 'project' } },
	actions: {
		'orgs.read': 'Read organizations',
		'projects.read': 'Read projects',
		'tasks.read': 'Read tasks',
		'tasks.insert': 'Create tasks',
		'tasks.write': 'Write tasks',
	},
	relations: { member: { dimension: 'project' } },
	roles: {},
} as const

const tables = defineTables(vocabulary, columns)({
	orgs: { scope: { dimension: 'org' }, actions: { read: 'orgs.read' } },
	projects: {
		scope: { dimension: 'project' },
		actions: { read: 'projects.read' },
		reveals: { member: { to: 'org', actions: ['orgs.read'] } },
	},
	project_members: { scope: { child: 'projects' }, actions: { read: 'projects.read' }, confers: { member: { principal: 'principal_id' } } },
	tasks: {
		scope: { dimension: 'task' },
		actions: { read: 'tasks.read', insert: 'tasks.insert', update: 'tasks.write' },
		insert: ['title'],
		update: ['title'],
	},
})

const alice = new TestAuthority('user:alice')

const inside = (dimension: string, ...values: string[]): RelationHold => ({ relation: 'member', inside: { dimension, values } })

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
		let holdsThrough: PathCheck
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
			holdsThrough = binding.holdsThrough
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

		const listed = async (dimension: string, action: string, table: string, relations: readonly TestHold[]) =>
			ids(await invoke('query', (db) => call(db.within(alice.within(dimension, action, [], [], [], relations)), `${table}.list`)))
		const task = (action: string, id: string, project: string, org: string, relations: readonly TestHold[]) =>
			alice.ref('task', action, id, { project, org }, relations)
		const titles = async (): Promise<string[]> => (await backend.rows('select title from tasks order by title')).map((row) => String(row['title']))

		test('a list reaches only the rows inside the node, by the dimension the node is in', async () => {
			expect(await listed('project', 'tasks.read', 'tasks', ['member'])).toEqual(['k1', 'k2', 'k3'])
			expect(await listed('project', 'tasks.read', 'tasks', [inside('project', 'p1')])).toEqual(['k1'])
			expect(await listed('project', 'tasks.read', 'tasks', [inside('org', 'o1')])).toEqual(['k1', 'k2'])
			expect(await listed('project', 'tasks.read', 'tasks', [inside('org', 'o2'), inside('project', 'p1')])).toEqual(['k1', 'k3'])
			expect(await listed('org', 'projects.read', 'projects', [inside('org', 'o1')])).toEqual(['p1', 'p2'])
			// A membership row outside the node reaches nothing, even where it names the caller.
			expect(await listed('project', 'tasks.read', 'tasks', [inside('org', 'o9')])).toEqual([])
		})

		test('a reveal to the dimension above the node reaches nothing; at the node it reaches the node alone', async () => {
			expect(await listed('org', 'orgs.read', 'orgs', ['member'])).toEqual(['o1', 'o2'])
			// Orgs carry no column for a project: a project's hold reveals no org.
			expect(await listed('org', 'orgs.read', 'orgs', [inside('project', 'p1')])).toEqual([])
			expect(await listed('org', 'orgs.read', 'orgs', [inside('org', 'o2')])).toEqual(['o2'])
		})

		test('a Ref held inside a node reaches its object only inside it, and each statement judges the row again', async () => {
			expect(await invoke('query', (db) => call(db.target(task('tasks.read', 'k1', 'p1', 'o1', [inside('org', 'o1')]), 'on'), 'get')))
				.toMatchObject({ id: 'k1' })
			await expect(invoke('query', (db) => call(db.target(task('tasks.read', 'k1', 'p1', 'o1', [inside('project', 'p2')]), 'on'), 'get')))
				.rejects.toThrow(NotFoundError)
			await expect(
				invoke('mutation', (db) => call(db.target(task('tasks.write', 'k3', 'p3', 'o2', [inside('org', 'o1')]), 'on'), 'update', { title: 'x' })),
			).rejects.toThrow(NotFoundError)
			await invoke('query', async (db) => {
				const target = db.target(task('tasks.read', 'k1', 'p1', 'o1', [inside('project', 'p1')]), 'on')
				expect(await call(target, 'get')).toMatchObject({ id: 'k1' })
				await backend.exec("delete from project_members where id = 'm1'")
				await expect(call(target, 'get')).rejects.toThrow(NotFoundError)
			})
			expect(await titles()).toEqual(['one', 'three', 'two'])
		})

		test('an insert under a Ref held inside another node writes nothing', async () => {
			const into = (project: string, org: string, relations: readonly TestHold[], title: string) =>
				invoke('mutation', (db) => call(db.target(alice.ref('project', 'tasks.insert', project, { org }, relations), 'on'), 'tasks.insert', { title }))
			expect(await into('p1', 'o1', [inside('org', 'o1')], 'inside')).toMatchObject({ id: expect.any(String) })
			await expect(into('p3', 'o2', [inside('org', 'o1')], 'outside')).rejects.toThrow(NotFoundError)
			await expect(into('p2', 'o1', [inside('project', 'p1')], 'other project')).rejects.toThrow(NotFoundError)
			expect(await titles()).toEqual(['inside', 'one', 'three', 'two'])
		})

		test('the binding answers the holds that reach the object, compared in the statement', async () => {
			expect(await holdsThrough('task', 'k1', 'tasks.write', 'user:alice', [inside('org', 'o1'), inside('org', 'o2')], [])).toEqual({
				relations: [inside('org', 'o1')],
				paths: [],
			})
			expect(await holdsThrough('task', 'k1', 'tasks.write', 'user:alice', [inside('project', 'p2')], [])).toEqual({ relations: [], paths: [] })
			expect(await holdsThrough('task', 'k1', 'tasks.write', 'user:bob', [inside('org', 'o1')], [])).toEqual({ relations: [], paths: [] })
			const many = [inside('org', ...Array.from({ length: 1001 }, (_, index) => `o${index}`))]
			await expect(holdsThrough('task', 'k1', 'tasks.write', 'user:alice', many, [])).rejects.toThrow(QueryRefusedError)
			const malformed = [{ relation: 'member', inside: { dimension: 'org', values: [''] } }]
			await expect(holdsThrough('task', 'k1', 'tasks.write', 'user:alice', malformed, [])).rejects.toThrow(QueryRefusedError)
		})

		test('a Ref of another dimension or action is refused before any statement', async () => {
			const project = alice.ref('project', 'tasks.read', 'p1', { org: 'o1' }, [inside('org', 'o1')])
			await expect(invoke('query', (db) => call(db.target(project, 'on'), 'get'))).rejects.toThrow(CapabilityError)
		})
	})
}

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
