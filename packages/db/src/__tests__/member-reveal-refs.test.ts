// A Ref held through a member reveal: a grant at a task's own node reveals the task's project, so the framework mints a
// Ref of the project (or of anything under it) that carries the grant. Every statement of the Ref re-reads the revealing
// row, and an insert rechecks it: the destination row locked under it, or, where no table owns the destination, the
// revealing row itself locked `FOR SHARE`. Every case runs on SQLite and, with FABRIKA_TEST_POSTGRES_URL, on Postgres:
//
//   docker run --rm -d -p 55433:5432 -e POSTGRES_PASSWORD=postgres postgres:17
//   FABRIKA_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55433/postgres bun test packages/db
//
// The URL is a credential: it is never logged.

import type { TypedColumnList } from '@fabrika/db'
import { openPostgres } from '@fabrika/db/postgres'
import { SQL } from 'bun'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { ColumnType } from 'kysely'
import { z } from 'zod/v4'
import type { ContainerGrant } from '../capability'
import type { Database } from '../database'
import { CapabilityError, NotFoundError, QueryRefusedError } from '../errors'
import { bindScopedDatabaseProvisionally, type DataAccess, dataAccessOf, type DataHandles, type DataSite, type MemberRevealCheck } from '../framework'
import type { DataKind } from '../orm-types'
import { defineTables } from '../policy'
import { openSqlite } from '../sqlite'
import { bunSqliteStorage } from '../sqlite-bun'
import { scoped } from '../store'
import { TestAuthority } from './fixtures/authority'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR]
const hasPostgres = url !== undefined && url !== ''

if (!hasPostgres) {
	console.warn(`member-reveal-refs.test.ts: the Postgres half is skipped; set ${URL_VAR} to run it`)
}

const migration = `
create table projects (id text not null primary key, name text not null, version integer not null);
create table tasks (id text not null primary key, project_id text not null references projects (id), open boolean not null, version integer not null);
create table docs (id text not null primary key, project_id text not null references projects (id), title text not null);
create table seats (id text not null primary key, space_id text not null, open boolean not null, version integer not null);
create table notes (id text not null primary key, space_id text not null, body text not null, version integer not null);
`

const seed = `
delete from notes;
delete from seats;
delete from docs;
delete from tasks;
delete from projects;
insert into projects (id, name, version) values ('p1', 'one', 1), ('p2', 'two', 1), ('p3', 'three', 1);
insert into tasks (id, project_id, open, version) values ('t1', 'p1', true, 1), ('t2', 'p2', false, 1), ('t3', 'p3', true, 1);
insert into docs (id, project_id, title) values ('d1', 'p1', 'one'), ('d2', 'p2', 'two'), ('d3', 'p3', 'three');
insert into seats (id, space_id, open, version) values ('st1', 'sp1', true, 1), ('st2', 'sp1', true, 1), ('st3', 'sp2', true, 1);
`

interface DB {
	projects: { id: string; name: string; version: number }
	tasks: { id: string; project_id: string; open: ColumnType<boolean, boolean, boolean>; version: number }
	docs: { id: string; project_id: string; title: string }
	seats: { id: string; space_id: string; open: ColumnType<boolean, boolean, boolean>; version: number }
	notes: { id: string; space_id: string; body: string; version: number }
}

const columns: TypedColumnList<DB> = {
	projects: { columns: ['id', 'name', 'version'], foreignKeys: [], notNull: ['id', 'name', 'version'] },
	tasks: {
		columns: ['id', 'project_id', 'open', 'version'],
		foreignKeys: [{ columns: ['project_id'], table: 'projects', references: ['id'] }],
		booleans: ['open'],
		notNull: ['id', 'project_id', 'open', 'version'],
	},
	docs: {
		columns: ['id', 'project_id', 'title'],
		foreignKeys: [{ columns: ['project_id'], table: 'projects', references: ['id'] }],
		notNull: ['id', 'project_id', 'title'],
	},
	seats: { columns: ['id', 'space_id', 'open', 'version'], foreignKeys: [], booleans: ['open'], notNull: ['id', 'space_id', 'open', 'version'] },
	notes: { columns: ['id', 'space_id', 'body', 'version'], foreignKeys: [], notNull: ['id', 'space_id', 'body', 'version'] },
}

const vocabulary = {
	app: 'revealed',
	dimensions: { project: {}, task: { in: 'project' }, space: {}, seat: { in: 'space' }, note: { in: 'space' } },
	actions: {
		'projects.read': 'Read projects',
		'docs.write': 'Write documents',
		'docs.delete': 'Delete documents',
		'notes.write': 'Write notes',
		'tasks.read': 'Read tasks',
	},
	roles: {},
} as const

const tables = defineTables(vocabulary, columns)({
	projects: { scope: { dimension: 'project' }, actions: { read: 'projects.read' }, version: 'version' },
	tasks: {
		scope: { dimension: 'task' },
		actions: { read: 'tasks.read' },
		version: 'version',
		memberReveals: { task: { to: 'project', actions: ['projects.read', 'docs.write', 'docs.delete'], when: { open: { eq: true } } } },
	},
	docs: {
		scope: { child: 'projects' },
		actions: { read: ['projects.read', 'docs.write'], insert: 'docs.write', update: 'docs.write', delete: 'docs.delete' },
		insert: ['title'],
		update: ['title'],
	},
	// No table owns a space: an insert into one rechecks the seat that reveals it.
	seats: {
		scope: { dimension: 'seat' },
		actions: { read: 'notes.write' },
		version: 'version',
		memberReveals: { seat: { to: 'space', actions: ['notes.write'], when: { open: { eq: true } } } },
	},
	notes: { scope: { dimension: 'note' }, actions: { read: 'notes.write', insert: 'notes.write' }, insert: ['body'], version: 'version' },
})

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

const atTasks = (...values: string[]): ContainerGrant[] => [{ dimension: 'task', values }]
const atSeats = (...values: string[]): ContainerGrant[] => [{ dimension: 'seat', values }]

function suite(dialect: 'sqlite' | 'postgres', open: () => Promise<Backend>, close: () => Promise<void>): void {
	describe.skipIf(dialect === 'postgres' && !hasPostgres)(`on ${dialect}`, () => {
		let backend: Backend
		let data: DataAccess
		let revealsToMembers: MemberRevealCheck
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
			revealsToMembers = binding.revealsToMembers
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

		const project = (action: string, id: string, revealing: readonly ContainerGrant[]) => alice.ref('project', action, id, {}, [], revealing)
		const get = (id: string, revealing: readonly ContainerGrant[]) =>
			invoke('query', (db) => call(db.target(project('projects.read', id, revealing), 'on'), 'get'))
		const docs = (id: string, revealing: readonly ContainerGrant[]) =>
			invoke('query', async (db) => ids(await call(db.target(project('projects.read', id, revealing), 'on'), 'docs.list')))
		const titles = async (): Promise<string[]> => (await backend.rows('select title from docs order by title')).map((row) => String(row['title']))

		test('reads the revealed project and the rows under it, while its task stays open', async () => {
			expect(await get('p1', atTasks('t1'))).toMatchObject({ id: 'p1', name: 'one' })
			expect(await docs('p1', atTasks('t1'))).toEqual(['d1'])
			// A closed task reveals nothing, and an open task of another project does not reveal this one.
			await expect(get('p2', atTasks('t2'))).rejects.toThrow(NotFoundError)
			await expect(get('p1', atTasks('t3'))).rejects.toThrow(NotFoundError)
			expect(await docs('p1', atTasks('t3'))).toEqual([])
		})

		test("re-reads the revealing row at every statement: a closed task ends the Ref's reach at the next one", async () => {
			const ref = project('projects.read', 'p1', atTasks('t1'))
			await invoke('query', async (db) => {
				const target = db.target(ref, 'on')
				expect(await call(target, 'get')).toMatchObject({ id: 'p1' })
				await backend.exec("update tasks set open = false where id = 't1'")
				await expect(call(target, 'get')).rejects.toThrow(NotFoundError)
			})
		})

		test('writes under the revealed node: inserts, updates and removes a document, and nothing once the task closes', async () => {
			const writer = (action: string) => project(action, 'p1', atTasks('t1'))
			const created = await invoke('mutation', (db) => call(db.target(writer('docs.write'), 'on'), 'docs.insert', { title: 'added' }))
			const id = String(typeof created === 'object' && created !== null ? Reflect.get(created, 'id') : '')
			await invoke('mutation', (db) => call(db.target(writer('docs.write'), 'on'), 'docs.update', 'd1', { title: 'renamed' }))
			await invoke('mutation', (db) => call(db.target(writer('docs.delete'), 'on'), 'docs.remove', id))
			expect(await titles()).toEqual(['renamed', 'three', 'two'])
			// Another project's document is out of the Ref's reach.
			await expect(invoke('mutation', (db) => call(db.target(writer('docs.write'), 'on'), 'docs.update', 'd3', { title: 'x' }))).rejects.toThrow(
				NotFoundError,
			)
			await backend.exec("update tasks set open = false where id = 't1'")
			await expect(invoke('mutation', (db) => call(db.target(writer('docs.write'), 'on'), 'docs.insert', { title: 'late' }))).rejects.toThrow(
				NotFoundError,
			)
			await expect(invoke('mutation', (db) => call(db.target(writer('docs.write'), 'on'), 'docs.update', 'd1', { title: 'late' }))).rejects.toThrow(
				NotFoundError,
			)
			expect(await titles()).toEqual(['renamed', 'three', 'two'])
		})

		test('a revealing grant at a dimension that reveals nothing for the action is unenforceable', async () => {
			const ref = alice.ref('project', 'projects.read', 'p1', {}, [], [{ dimension: 'seat', values: ['st1'] }])
			await expect(invoke('query', (db) => call(db.target(ref, 'on'), 'get'))).rejects.toThrow(CapabilityError)
		})

		test('an insert into a node no table owns rechecks the seat that reveals it', async () => {
			const write = (space: string, revealing: readonly ContainerGrant[], body: string) =>
				invoke('mutation', (db) => call(db.target(alice.ref('space', 'notes.write', space, {}, [], revealing), 'in'), 'notes.insert', { body }))
			await write('sp1', atSeats('st1'), 'held')
			await expect(write('sp2', atSeats('st1'), 'not revealed')).rejects.toThrow('no row holds notes.write')
			await backend.exec("update seats set open = false where id = 'st1'")
			await expect(write('sp1', atSeats('st1'), 'closed')).rejects.toThrow('no row holds notes.write')
			await write('sp1', atSeats('st1', 'st2'), 'by the other seat')
			const bodies = (await backend.rows('select body from notes order by body')).map((row) => String(row['body']))
			expect(bodies).toEqual(['by the other seat', 'held'])
		})

		test.skipIf(dialect !== 'postgres')('an insert into a node no table owns locks the revealing seat until it commits', async () => {
			let resume: () => void = () => {}
			const held = new Promise<void>((resolve) => {
				resume = resolve
			})
			let inserted: () => void = () => {}
			const written = new Promise<void>((resolve) => {
				inserted = resolve
			})
			const insert = invoke('mutation', async (db) => {
				await call(db.target(alice.ref('space', 'notes.write', 'sp1', {}, [], atSeats('st1')), 'in'), 'notes.insert', { body: 'held' })
				inserted()
				await held
			})
			await written
			const close = (id: string) =>
				backend.exec(`set lock_timeout = '300ms'; update seats set open = false where id = '${id}'`).then(() => 'written', () => 'blocked')
			try {
				expect({ revealing: await close('st1'), other: await close('st2') }).toEqual({ revealing: 'blocked', other: 'written' })
			} finally {
				resume()
			}
			await insert
		})

		test('the binding answers the grants whose row reveals the node for the action, now', async () => {
			expect(await revealsToMembers('task', ['t1', 't2', 't3'], 'project', 'p1', 'projects.read')).toEqual(['t1'])
			expect(await revealsToMembers('task', ['t2'], 'project', 'p2', 'projects.read')).toEqual([])
			expect(await revealsToMembers('task', ['t1'], 'project', 'p1', 'tasks.read')).toEqual([])
			expect(await revealsToMembers('task', [], 'project', 'p1', 'projects.read')).toEqual([])
			await expect(revealsToMembers('task', Array.from({ length: 1001 }, (_, index) => `t${index}`), 'project', 'p1', 'projects.read')).rejects
				.toThrow(QueryRefusedError)
		})

		test('ctx.sql.scope refuses a Ref held through a member reveal: its fragment would leave the revealing row out', async () => {
			const transaction = data.invocation(true)
			const sql = data.sql({ mode: 'read', check() {}, session: () => transaction.session(), fail: () => transaction.fail() })
			try {
				const scope = () => sql.scope(project('projects.read', 'p1', atTasks('t1')), 'docs')
				expect(scope).toThrow('cannot render a relation, a member reveal, a secondary path or a condition')
			} finally {
				await transaction.rollback()
			}
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
