// Who a relation's source row names: its own principal column, the table's createdBy, which names the row's writer, or
// the column of the row one foreign key of the source references (`person_id.principal_id`). Every runtime case runs on
// SQLite and, with FABRIKA_TEST_POSTGRES_URL, on a real Postgres:
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
import { ConflictError, QueryRefusedError } from '../errors'
import {
	bindScopedDatabaseProvisionally,
	type DataAccess,
	dataAccessOf,
	type DataHandles,
	type DataSite,
	type RelationCheck,
	type RevealCheck,
} from '../framework'
import type { DataKind } from '../orm-types'
import { defineTables, readTables } from '../policy'
import { openSqlite } from '../sqlite'
import { bunSqliteStorage } from '../sqlite-bun'
import { scoped } from '../store'
import { tablePolicies } from '../tables'
import { TestAuthority } from './fixtures/authority'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR]
const hasPostgres = url !== undefined && url !== ''

if (!hasPostgres) {
	console.warn(`relation-principals.test.ts: the Postgres half is skipped; set ${URL_VAR} to run it`)
}

const migration = `
create table orgs (id text not null primary key, version integer not null);
create table projects (
	id text not null primary key,
	org_id text not null references orgs (id),
	name text not null,
	created_by text not null,
	version integer not null,
	unique (id, org_id)
);
create table people (
	id text not null primary key,
	org_id text not null references orgs (id),
	principal_id text,
	created_by text not null,
	version integer not null
);
create table project_staff (
	id text not null primary key,
	project_id text not null,
	org_id text not null,
	person_id text references people (id) on delete set null,
	foreign key (project_id, org_id) references projects (id, org_id) on delete cascade
);
create table tickets (
	id text not null primary key,
	org_id text not null references orgs (id),
	project_id text,
	title text not null,
	version integer not null,
	foreign key (project_id, org_id) references projects (id, org_id)
);
create table boards (
	id text not null primary key,
	project_id text not null,
	org_id text not null,
	version integer not null,
	unique (id, org_id),
	foreign key (project_id, org_id) references projects (id, org_id)
);
create table cards (
	id text not null primary key,
	org_id text not null references orgs (id),
	board_id text,
	version integer not null,
	foreign key (board_id, org_id) references boards (id, org_id)
);
`

const seed = `
delete from cards;
delete from boards;
delete from tickets;
delete from project_staff;
delete from people;
delete from projects;
delete from orgs;
insert into orgs (id, version) values ('o1', 1);
insert into projects (id, org_id, name, created_by, version) values
	('p-bob', 'o1', 'bob''s', 'user:bob', 1), ('p1', 'o1', 'one', 'user:carol', 1), ('p2', 'o1', 'two', 'user:carol', 1);
insert into people (id, org_id, principal_id, created_by, version) values
	('pe-alice', 'o1', 'user:alice', 'user:carol', 1),
	('pe-alice-2', 'o1', 'user:alice', 'user:carol', 1),
	('pe-bob', 'o1', 'user:bob', 'user:carol', 1),
	('pe-carol', 'o1', 'user:carol', 'user:carol', 1);
`

interface DB {
	orgs: { id: string; version: number }
	projects: { id: string; org_id: string; name: string; created_by: string; version: number }
	people: { id: string; org_id: string; principal_id: string | null; created_by: string; version: number }
	project_staff: { id: string; project_id: string; org_id: string; person_id: string | null }
	tickets: { id: string; org_id: string; project_id: string | null; title: string; version: number }
	boards: { id: string; project_id: string; org_id: string; version: number }
	cards: { id: string; org_id: string; board_id: string | null; version: number }
}

const columns: TypedColumnList<DB> = {
	orgs: { columns: ['id', 'version'], foreignKeys: [], notNull: ['id', 'version'] },
	projects: {
		columns: ['id', 'org_id', 'name', 'created_by', 'version'],
		foreignKeys: [{ columns: ['org_id'], table: 'orgs', references: ['id'] }],
		notNull: ['id', 'org_id', 'name', 'created_by', 'version'],
	},
	people: {
		columns: ['id', 'org_id', 'principal_id', 'created_by', 'version'],
		foreignKeys: [{ columns: ['org_id'], table: 'orgs', references: ['id'] }],
		notNull: ['id', 'org_id', 'created_by', 'version'],
	},
	project_staff: {
		columns: ['id', 'project_id', 'org_id', 'person_id'],
		foreignKeys: [
			{ columns: ['project_id', 'org_id'], table: 'projects', references: ['id', 'org_id'] },
			{ columns: ['person_id'], table: 'people', references: ['id'] },
		],
		notNull: ['id', 'project_id', 'org_id'],
	},
	tickets: {
		columns: ['id', 'org_id', 'project_id', 'title', 'version'],
		foreignKeys: [
			{ columns: ['org_id'], table: 'orgs', references: ['id'] },
			{ columns: ['project_id', 'org_id'], table: 'projects', references: ['id', 'org_id'] },
		],
		notNull: ['id', 'org_id', 'title', 'version'],
	},
	boards: {
		columns: ['id', 'project_id', 'org_id', 'version'],
		foreignKeys: [{ columns: ['project_id', 'org_id'], table: 'projects', references: ['id', 'org_id'] }],
		notNull: ['id', 'project_id', 'org_id', 'version'],
	},
	cards: {
		columns: ['id', 'org_id', 'board_id', 'version'],
		foreignKeys: [
			{ columns: ['org_id'], table: 'orgs', references: ['id'] },
			{ columns: ['board_id', 'org_id'], table: 'boards', references: ['id', 'org_id'] },
		],
		notNull: ['id', 'org_id', 'version'],
	},
}

const vocabulary = {
	app: 'principals',
	dimensions: { org: {}, project: { in: 'org' }, board: { in: 'project' } },
	actions: {
		'projects.read': 'Read projects',
		'projects.create': 'Create projects',
		'people.add': 'Add people',
		'staff.assign': 'Staff a project',
		'tickets.write': 'File tickets',
	},
	relations: { owner: { dimension: 'project' }, staff: { dimension: 'project' } },
	roles: {},
} as const

/**
 * The layer's tables; `self` lets a writer staff itself, `reveal` makes a staffed project reveal its org. A ticket lies in
 * an org and names a project it is read through, where staff see it and its org's other tickets. A card names a board of
 * a project, so its reveal reads the card, the board, the staff row and the person: the deepest scope the layer builds.
 */
function tablesWith(options: { readonly self?: true; readonly reveal?: true } = {}) {
	return defineTables(vocabulary, columns)({
		orgs: { scope: { dimension: 'org' }, actions: { read: 'projects.read' }, version: 'version' },
		projects: {
			scope: { dimension: 'project' },
			actions: { read: 'projects.read', insert: 'projects.create' },
			insert: ['name'],
			version: 'version',
			createdBy: 'created_by',
			confers: { owner: { principal: 'created_by', assign: { self: true } } },
			...(options.reveal === true ? { reveals: { staff: { to: 'org', actions: ['projects.read'] } } } : {}),
		},
		people: {
			scope: { child: 'orgs' },
			actions: { read: 'projects.read', insert: 'people.add' },
			insert: ['principal_id'],
			version: 'version',
			createdBy: 'created_by',
		},
		project_staff: {
			scope: { child: 'projects' },
			actions: { read: 'projects.read', insert: 'staff.assign', delete: 'staff.assign' },
			insert: ['person_id'],
			confers: { staff: { principal: 'person_id.principal_id', assign: options.self === true ? { self: true } : {} } },
		},
		tickets: {
			scope: { child: 'orgs' },
			actions: { read: 'projects.read', insert: 'tickets.write' },
			insert: ['project_id', 'title'],
			version: 'version',
			readThrough: { project: 'project_id' },
			reveals: { staff: { to: 'org', actions: ['projects.read'], assign: {} } },
		},
		boards: { scope: { dimension: 'board' }, actions: { read: 'projects.read' }, version: 'version' },
		cards: {
			scope: { child: 'orgs' },
			actions: { read: 'projects.read' },
			version: 'version',
			readThrough: { board: 'board_id' },
			reveals: { staff: { to: 'org', actions: ['projects.read'] } },
		},
	})
}

const tables = tablesWith()

const alice = new TestAuthority('user:alice')

/** Calls a handle method by its dotted path, with arguments the types would refuse. */
async function call(handle: unknown, path: string, ...args: unknown[]): Promise<unknown> {
	const parts = path.split('.')
	const name = parts.pop() ?? ''
	const target = parts.reduce<unknown>((node, part) => (typeof node === 'object' && node !== null ? Reflect.get(node, part) : undefined), handle)
	const method: unknown = typeof target === 'object' && target !== null ? Reflect.get(target, name) : undefined
	if (typeof method !== 'function') throw new TypeError(`${path} is not a method of the handle`)
	return Reflect.apply(method, target, args)
}

interface Backend {
	readonly database: Database
	exec(text: string): Promise<void>
}

async function postgresAdmin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

function suite(dialect: 'sqlite' | 'postgres', open: () => Promise<Backend>, close: () => Promise<void>): void {
	describe.skipIf(dialect === 'postgres' && !hasPostgres)(`on ${dialect}`, () => {
		let backend: Backend
		let data: DataAccess
		let relates: RelationCheck
		let reveals: RevealCheck
		let release: () => void = () => {}

		beforeAll(async () => {
			backend = await open()
		})

		afterAll(async () => {
			release()
			await close()
		})

		/** Binds a fresh layer of the given tables, releasing the one bound before. */
		function use(layerTables: typeof tables): void {
			release()
			const layer = scoped(layerTables)
			const binding = bindScopedDatabaseProvisionally(layer, { database: backend.database, capabilities: alice })
			relates = binding.relates
			reveals = binding.reveals
			release = () => binding.release()
			data = dataAccessOf(layer)
		}

		beforeEach(async () => {
			await backend.exec(seed)
			use(tables)
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

		const ids = (page: unknown): string[] => {
			const items: unknown = typeof page === 'object' && page !== null ? Reflect.get(page, 'items') : undefined
			const listed = Array.isArray(items)
				? items.map((row: unknown) => String(typeof row === 'object' && row !== null ? Reflect.get(row, 'id') : ''))
				: []
			return listed.sort()
		}
		const listed = (table: string, relation: string) =>
			invoke('query', async (db) => ids(await call(db.within(alice.within('org', 'projects.read', [], [], [], [relation])), `${table}.list`)))
		const readThrough = (relation: string, id: string) =>
			invoke('query', (db) => call(db.target(alice.ref('project', 'projects.read', id, { org: 'o1' }, [relation]), 'on'), 'get'))
		const staff = (rows: readonly (readonly [id: string, project: string, person: string])[]) =>
			backend.exec(
				`insert into project_staff (id, project_id, org_id, person_id) values ${
					rows.map(([id, project, person]) => `('${id}', '${project}', 'o1', '${person}')`).join(', ')
				}`,
			)
		const assign = (person: string) =>
			invoke(
				'mutation',
				(db) => call(db.target(alice.ref('project', 'staff.assign', 'p1', { org: 'o1' }), 'on'), 'project_staff.insert', { person_id: person }),
			)
		const staffCount = async (): Promise<number> => {
			const rows = await invoke('query', async (db) => {
				const page = await call(db.within(alice.within('org', 'projects.read', ['o1'])), 'project_staff.list')
				return ids(page)
			})
			return rows.length
		}

		test('a createdBy owner relation reaches the row its writer created, and nothing another principal created', async () => {
			expect(await listed('projects', 'owner')).toEqual([])
			const created = await invoke(
				'mutation',
				(db) => call(db.target(alice.ref('org', 'projects.create', 'o1'), 'on'), 'projects.insert', { name: 'mine' }),
			)
			const id = String(typeof created === 'object' && created !== null ? Reflect.get(created, 'id') : '')
			expect(await listed('projects', 'owner')).toEqual([id])
			expect(await relates('owner', id, 'user:alice')).toBe(true)
			expect(await relates('owner', 'p-bob', 'user:alice')).toBe(false)
			expect(await readThrough('owner', id)).toMatchObject({ id, name: 'mine', created_by: 'user:alice' })
			await backend.exec(`delete from projects where id = '${id}'`)
			expect(await listed('projects', 'owner')).toEqual([])
			await expect(readThrough('owner', id)).rejects.toThrow('not found')
		})

		test('a relation reaches the node of a source row whose referenced row names the caller', async () => {
			await staff([['s1', 'p1', 'pe-alice'], ['s2', 'p2', 'pe-alice-2'], ['s3', 'p-bob', 'pe-bob']])
			expect(await listed('projects', 'staff')).toEqual(['p1', 'p2'])
			expect(await relates('staff', 'p1', 'user:alice')).toBe(true)
			expect(await relates('staff', 'p-bob', 'user:alice')).toBe(false)
			expect(await relates('staff', 'p-bob', 'user:bob')).toBe(true)
			expect(await readThrough('staff', 'p1')).toMatchObject({ id: 'p1', name: 'one' })
			await expect(readThrough('staff', 'p-bob')).rejects.toThrow('not found')
		})

		test('deleting the source row, or the row its principal is read from, ends access at the next statement', async () => {
			await staff([['s1', 'p1', 'pe-alice'], ['s2', 'p2', 'pe-alice-2']])
			expect(await readThrough('staff', 'p1')).toMatchObject({ id: 'p1' })
			await backend.exec(`delete from project_staff where id = 's1'`)
			expect(await listed('projects', 'staff')).toEqual(['p2'])
			await expect(readThrough('staff', 'p1')).rejects.toThrow('not found')
			await backend.exec(`delete from people where id = 'pe-alice-2'`)
			expect(await listed('projects', 'staff')).toEqual([])
			expect(await relates('staff', 'p2', 'user:alice')).toBe(false)
			await expect(readThrough('staff', 'p2')).rejects.toThrow('not found')
			expect(await staffCount()).toBe(1)
		})

		test('the principal is read at every statement, so a changed person row moves the access with it', async () => {
			await staff([['s1', 'p1', 'pe-bob']])
			expect(await listed('projects', 'staff')).toEqual([])
			await backend.exec(`update people set principal_id = 'user:alice' where id = 'pe-bob'`)
			expect(await listed('projects', 'staff')).toEqual(['p1'])
		})

		test('assign.self refuses a row whose referenced row names the writer, and writes nothing', async () => {
			await expect(assign('pe-alice')).rejects.toThrow(ConflictError)
			await expect(assign('pe-alice')).rejects.toThrow('names its writer in staff through person_id, which assign.self does not allow')
			expect(await staffCount()).toBe(0)
			await assign('pe-bob')
			expect(await staffCount()).toBe(1)
			expect(await relates('staff', 'p1', 'user:bob')).toBe(true)
			expect(await relates('staff', 'p1', 'user:alice')).toBe(false)
		})

		test('with assign.self a writer names itself through the path', async () => {
			use(tablesWith({ self: true }))
			await assign('pe-alice')
			expect(await relates('staff', 'p1', 'user:alice')).toBe(true)
		})

		test('a reveal nested on a path relation follows the path', async () => {
			use(tablesWith({ reveal: true }))
			expect(await listed('orgs', 'staff')).toEqual([])
			await staff([['s1', 'p1', 'pe-alice']])
			expect(await listed('orgs', 'staff')).toEqual(['o1'])
			expect(await reveals('staff', 'org', 'o1', 'user:alice')).toBe(true)
			expect(await reveals('staff', 'org', 'o1', 'user:bob')).toBe(false)
			await backend.exec(`delete from people where id = 'pe-alice'`)
			expect(await listed('orgs', 'staff')).toEqual([])
			expect(await reveals('staff', 'org', 'o1', 'user:alice')).toBe(false)
		})

		test('a reveal matched through readThrough follows the path, and its assign refuses a node where the writer holds the relation', async () => {
			const file = (id: string, project: string | null) =>
				invoke('mutation', (db) => call(db.target(alice.ref('org', 'tickets.write', 'o1'), 'on'), 'tickets.insert', { project_id: project, title: id }))
			await staff([['s1', 'p1', 'pe-alice'], ['s3', 'p2', 'pe-bob']])
			await expect(file('one', 'p1')).rejects.toThrow(
				"names in project_id a node where its writer holds staff, which the reveal's assign.self does not allow",
			)
			await file('two', 'p2')
			await file('loose', null)
			expect(await listed('tickets', 'staff')).toEqual([])
			await backend.exec(`insert into tickets (id, org_id, project_id, title, version) values ('t1', 'o1', 'p1', 'one', 1)`)
			expect(await listed('tickets', 'staff')).toHaveLength(3)
			await backend.exec(`delete from people where id = 'pe-alice'`)
			expect(await listed('tickets', 'staff')).toEqual([])
		})

		test("a reveal matched through a path below the relation's dimension nests four deep, and follows the principal path", async () => {
			await staff([['s1', 'p1', 'pe-alice']])
			await backend.exec(`
				insert into boards (id, project_id, org_id, version) values ('b1', 'p1', 'o1', 1), ('b2', 'p2', 'o1', 1);
				insert into cards (id, org_id, board_id, version) values ('c2', 'o1', 'b2', 1), ('c3', 'o1', null, 1)
			`)
			expect(await listed('orgs', 'staff')).toEqual([])
			expect(await listed('cards', 'staff')).toEqual([])
			await backend.exec(`insert into cards (id, org_id, board_id, version) values ('c1', 'o1', 'b1', 1)`)
			expect(await listed('orgs', 'staff')).toEqual(['o1'])
			expect(await listed('cards', 'staff')).toEqual(['c1', 'c2', 'c3'])
			await backend.exec(`delete from people where id = 'pe-alice'`)
			expect(await listed('orgs', 'staff')).toEqual([])
			expect(await listed('cards', 'staff')).toEqual([])
		})

		test('a writing ctx.sql statement never names the table a principal path reads', async () => {
			const transaction = data.invocation(false)
			const sql = data.sql({ mode: 'write', check() {}, session: () => transaction.session(), fail: () => transaction.fail() })
			const rename = () => sql(z.strictObject({}))`update people set principal_id = ${'user:alice'} where id = ${'pe-bob'}`
			try {
				await expect(rename()).rejects.toThrow("'people' at line 1 hands out access")
			} finally {
				await transaction.rollback()
			}
			await staff([['s1', 'p1', 'pe-bob']])
			expect(await listed('projects', 'staff')).toEqual([])
		})

		test.skipIf(dialect !== 'postgres')('assign.self locks the referenced row until the insert commits', async () => {
			let resume: () => void = () => {}
			const held = new Promise<void>((resolve) => {
				resume = resolve
			})
			let inserted: () => void = () => {}
			const written = new Promise<void>((resolve) => {
				inserted = resolve
			})
			const insert = invoke('mutation', async (db) => {
				await call(db.target(alice.ref('project', 'staff.assign', 'p1', { org: 'o1' }), 'on'), 'project_staff.insert', { person_id: 'pe-bob' })
				inserted()
				await held
			})
			await written
			const rename = (id: string) => backend.exec(`set lock_timeout = '300ms'; update people set principal_id = 'user:alice' where id = '${id}'`)
			try {
				await expect(rename('pe-bob')).rejects.toThrow()
				await rename('pe-carol')
			} finally {
				resume()
			}
			await insert
			expect(await relates('staff', 'p1', 'user:bob')).toBe(true)
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
	}
}, async () => {
	await postgres?.close()
	await postgresAdmin((sql) => sql.unsafe(`drop schema if exists ${schema} cascade`))
})

describe('an insert into a node no table owns, through a path relation', () => {
	interface Unowned {
		people: { id: string; principal_id: string }
		seats: { id: string; space_id: string; person_id: string }
		notes: { id: string; space_id: string; body: string; version: number }
	}
	const unownedColumns: TypedColumnList<Unowned> = {
		people: { columns: ['id', 'principal_id'], foreignKeys: [] },
		seats: { columns: ['id', 'space_id', 'person_id'], foreignKeys: [{ columns: ['person_id'], table: 'people', references: ['id'] }] },
		notes: { columns: ['id', 'space_id', 'body', 'version'], foreignKeys: [] },
	}
	const unownedVocabulary = {
		app: 'unowned',
		dimensions: { space: {}, seat: { in: 'space' }, note: { in: 'space' } },
		actions: { 'spaces.read': 'Read spaces', 'notes.write': 'Write notes' },
		relations: { guest: { dimension: 'space' } },
		roles: {},
	} as const
	const unowned = defineTables(unownedVocabulary, unownedColumns)({
		people: { scope: { app: 'the directory a seat names its person from' }, actions: { read: 'spaces.read' } },
		seats: { scope: { dimension: 'seat' }, actions: { read: 'spaces.read' }, confers: { guest: { principal: 'person_id.principal_id' } } },
		notes: { scope: { dimension: 'note' }, actions: { read: 'spaces.read', insert: 'notes.write' }, insert: ['body'], version: 'version' },
	})

	test("inserts while a seat's person names the writer, and writes nothing once the person row is gone", async () => {
		const store = bunSqliteStorage()
		store.sql.exec(`
			create table people (id text not null primary key, principal_id text not null);
			create table seats (
				id text not null primary key, space_id text not null,
				person_id text not null references people (id) on delete cascade
			);
			create table notes (id text not null primary key, space_id text not null, body text not null, version integer not null);
			insert into people (id, principal_id) values ('pe-alice', 'user:alice'), ('pe-bob', 'user:bob');
			insert into seats (id, space_id, person_id) values ('st1', 'sp1', 'pe-alice'), ('st2', 'sp2', 'pe-bob');
		`)
		const layer = scoped(unowned)
		const binding = bindScopedDatabaseProvisionally(layer, { database: openSqlite(store), capabilities: alice })
		const access = dataAccessOf(layer)
		const write = async (space: string, body: string) => {
			const transaction = access.invocation(false)
			const site: DataSite = { kind: 'mutation', unscoped: {}, principal: 'user:alice', check() {}, session: () => transaction.session() }
			try {
				const ref = alice.ref('space', 'notes.write', space, {}, ['guest'])
				await call(access.handles(site).target(ref, 'in'), 'notes.insert', { body })
				await transaction.commit()
			} catch (error) {
				await transaction.rollback()
				throw error
			}
		}
		try {
			await write('sp1', 'held')
			await expect(write('sp2', 'not hers')).rejects.toThrow('no row holds notes.write')
			store.sql.exec("delete from people where id = 'pe-alice'")
			await expect(write('sp1', 'revoked')).rejects.toThrow('no row holds notes.write')
			expect(store.sql.exec('select body, space_id from notes').toArray()).toEqual([{ body: 'held', space_id: 'sp1' }])
		} finally {
			binding.release()
		}
	})
})

/** The tables a principal path could start at, beside the fixture's: a view, a queue table, a reference table. */
const pathColumns = {
	orgs: { columns: ['id', 'owner_principal_id', 'version'], foreignKeys: [], notNull: ['id', 'version'] },
	projects: columns.projects,
	people: {
		columns: ['id', 'org_id', 'principal_id', 'alias', 'manager_principal_id', 'profile', 'created_by', 'version'],
		foreignKeys: [
			{ columns: ['org_id'], table: 'orgs', references: ['id'] },
			{ columns: ['manager_principal_id'], table: 'people', references: ['alias'] },
		],
		notNull: ['id', 'org_id', 'created_by', 'version'],
		json: ['profile'],
	},
	crews: { columns: ['id', 'org_id', 'principal_id'], foreignKeys: [], view: true },
	jobs: { columns: ['id', 'principal_id', 'attempts', 'due_at', 'version'], foreignKeys: [], timestamps: ['due_at'] },
	countries: { columns: ['code', 'principal_id'], foreignKeys: [] },
	members: {
		columns: ['id', 'org_id', 'principal_id'],
		foreignKeys: [{ columns: ['org_id'], table: 'orgs', references: ['id'] }, { columns: ['id'], table: 'countries', references: ['code'] }],
		notNull: ['id', 'org_id'],
	},
	project_staff: {
		columns: [
			'id',
			'project_id',
			'org_id',
			'person_id',
			'alias_id',
			'crew_id',
			'job_id',
			'country_code',
			'added_by',
			'org_ref',
			'lead_project_id',
			'mentor_id',
			'buddy_id',
			'peer_id',
			'member_id',
		],
		foreignKeys: [
			{ columns: ['project_id', 'org_id'], table: 'projects', references: ['id', 'org_id'] },
			{ columns: ['mentor_id'], table: 'people', references: ['id'] },
			{ columns: ['mentor_id'], table: 'countries', references: ['code'] },
			{ columns: ['buddy_id'], table: 'people', references: ['id'] },
			{ columns: ['buddy_id', 'org_id'], table: 'crews', references: ['id', 'org_id'] },
			{ columns: ['peer_id'], table: 'people', references: ['id'] },
			{ columns: ['peer_id', 'org_id'], table: 'people', references: ['id', 'org_id'] },
			{ columns: ['member_id'], table: 'members', references: ['id'] },
			{ columns: ['org_id'], table: 'orgs', references: ['id'] },
			{ columns: ['org_ref'], table: 'orgs', references: ['id'] },
			{ columns: ['lead_project_id'], table: 'projects', references: ['id'] },
			{ columns: ['person_id'], table: 'people', references: ['id'] },
			{ columns: ['alias_id'], table: 'people', references: ['alias'] },
			{ columns: ['crew_id'], table: 'crews', references: ['id'] },
			{ columns: ['job_id'], table: 'jobs', references: ['id'] },
			{ columns: ['country_code'], table: 'countries', references: ['code'] },
			{ columns: ['added_by'], table: 'people', references: ['id'] },
		],
		notNull: ['id', 'project_id', 'org_id'],
	},
}

const pathPolicies = {
	orgs: { scope: { dimension: 'org' }, actions: { read: 'projects.read' }, version: 'version' },
	projects: {
		scope: { dimension: 'project' },
		actions: { read: 'projects.read' },
		version: 'version',
		createdBy: 'created_by',
		confers: { owner: { principal: 'created_by' } },
	},
	people: {
		scope: { child: 'orgs' },
		actions: { read: 'projects.read', insert: 'people.add' },
		insert: ['principal_id', 'alias'],
		version: 'version',
		createdBy: 'created_by',
	},
	crews: { scope: { child: 'orgs' }, actions: { read: 'projects.read' } },
	jobs: {
		scope: { app: 'work goes out through one job' },
		actions: { read: 'projects.read', insert: 'people.add', update: 'people.add' },
		insert: ['principal_id', 'due_at'],
		queue: { attempts: 'attempts', due: 'due_at' },
		version: 'version',
	},
	countries: { scope: { reference: 'lookup data' }, actions: { read: 'projects.read' } },
	members: { scope: { child: 'orgs' }, actions: { read: 'projects.read' } },
	project_staff: {
		scope: { child: 'projects' },
		actions: { read: 'projects.read', insert: 'staff.assign', delete: 'staff.assign' },
		insert: ['person_id'],
		confers: { staff: { principal: 'person_id.principal_id', assign: {} } },
	},
}

/** The policies with `staff` conferring through `principal`, and any table's fields replaced. */
function readPath(principal: string, changes: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {}): ReturnType<typeof readTables> {
	const policies: Record<string, Record<string, unknown>> = {}
	for (const [name, policy] of Object.entries(pathPolicies)) {
		policies[name] = { ...policy, ...changes[name] }
	}
	policies['project_staff'] = { ...policies['project_staff'], confers: { staff: { principal, assign: {} } } }
	return readTables(pathColumns, policies, vocabulary)
}

describe('the policy of a principal reached through a to-one path', () => {
	test('names a single-column foreign key to the key of a table, and a column of that table', () => {
		expect(() => readPath('person_id.principal_id')).not.toThrow()
		expect(() => readPath('person_id.created_by')).not.toThrow()
		expect(() => readPath('lead_project_id.created_by')).not.toThrow()
	})

	test('starts at no column the layer stamps or a move rewrites', () => {
		const refused = 'which the layer stamps or a move rewrites; a principal path starts at a foreign key no update writes'
		// org_id is the source's inherited chain column: a move of the project to another org rewrites it by cascade.
		expect(() => readPath('org_id.owner_principal_id')).toThrow(`project_staff.org_id is a key, a containment, a version or a file column, ${refused}`)
		expect(() => readPath('project_id.created_by')).toThrow(refused)
		expect(() => readPath('id.principal_id')).toThrow(refused)
	})

	test("starts at no container column, even one that also references its container's key alone", () => {
		// A board confers at its own node, and its container column project_id references the project's key twice: alone,
		// and with org_id. Only the chain check refuses the path: a move of the board rewrites project_id.
		const boardVocabulary = {
			...vocabulary,
			dimensions: { ...vocabulary.dimensions, board: { in: 'project' } },
			relations: { ...vocabulary.relations, crew: { dimension: 'board' } },
		}
		const boards = {
			columns: ['id', 'project_id', 'org_id', 'version'],
			foreignKeys: [
				{ columns: ['project_id', 'org_id'], table: 'projects', references: ['id', 'org_id'] },
				{ columns: ['project_id'], table: 'projects', references: ['id'] },
			],
			notNull: ['id', 'project_id', 'org_id', 'version'],
		}
		const crew = (principal: string) =>
			readTables({ ...pathColumns, boards }, {
				...pathPolicies,
				boards: { scope: { dimension: 'board' }, actions: { read: 'projects.read' }, version: 'version', confers: { crew: { principal } } },
			}, boardVocabulary)
		expect(() => crew('project_id.created_by')).toThrow(
			'boards.project_id is a key, a containment, a version or a file column, which the layer stamps or a move rewrites',
		)
	})

	test('starts at a column no other foreign key holds, but a tenant-holding key to the same row', () => {
		const refused = 'starts the principal path and is a column of a foreign key to'
		expect(() => readPath('mentor_id.principal_id')).toThrow(`project_staff.mentor_id ${refused} countries, which an update there may rewrite`)
		expect(() => readPath('buddy_id.principal_id')).toThrow(`project_staff.buddy_id ${refused} crews, which an update there may rewrite`)
		expect(() => readPath('peer_id.principal_id')).not.toThrow()
	})

	test("follows a key that no foreign key of the principal's table holds", () => {
		expect(() => readPath('member_id.principal_id')).toThrow(
			'members.id is the key the principal path follows and is a column of a foreign key to countries, which an update there may rewrite',
		)
	})

	test('reads no principal from a top-level dimension table, whose key an insert takes from its Ref', () => {
		expect(() => readPath('org_ref.owner_principal_id')).toThrow('orgs is a top-level dimension table, whose key an insert takes from its Ref')
	})

	test('a column that holds the principal is a column of no foreign key, on the source or on the table the path reads', () => {
		expect(() => readPath('person_id.manager_principal_id')).toThrow(
			'people.manager_principal_id holds the principal and is a column of a foreign key to people, which an update there may rewrite',
		)
		expect(() => readPath('person_id')).toThrow(
			'project_staff.person_id holds the principal and is a column of a foreign key to people, which an update there may rewrite',
		)
		expect(() => readPath('person_id.principal_id')).not.toThrow()
	})

	test('follows exactly one foreign key', () => {
		expect(() => readPath('person_id.principal_id.id')).toThrow('follows more than one foreign key')
		expect(() => readPath('nobody.principal_id')).toThrow()
		expect(() => readPath('project_id.created_by')).toThrow()
		expect(() => readPath('alias_id.principal_id')).toThrow('references people.alias, not its key id')
		expect(() => readPath('person_id.nothing')).toThrow('nothing is not a column of people')
	})

	test('refuses a view, a queue table and a reference table as the table the principal is read from', () => {
		expect(() => readPath('crew_id.principal_id')).toThrow('crews is a view')
		expect(() => readPath('job_id.principal_id')).toThrow('jobs is a queue table')
		expect(() => readPath('country_code.principal_id')).toThrow('countries is a reference table')
	})

	test('refuses a column of that table that an update writes, or that holds no principal', () => {
		const updating = { actions: { read: 'projects.read', insert: 'people.add', update: 'people.add' } }
		expect(() => readPath('person_id.principal_id', { people: { ...updating, update: ['principal_id'] } })).toThrow(
			'people.principal_id decides whom a row names, so no update of people writes it; replace the row instead',
		)
		expect(() => readPath('person_id.principal_id', { people: { ...updating, columns: { principal_id: { write: 'staff.assign' } } } })).toThrow(
			'no update of people writes it',
		)
		expect(() => readPath('person_id.version')).toThrow('people.version is the version column')
		expect(() => readPath('person_id.id')).toThrow('it holds no principal')
		expect(() => readPath('person_id.org_id')).toThrow('it holds no principal')
		expect(() => readPath('person_id.profile')).toThrow('it holds no principal')
	})

	test('no update of the source writes the column the path starts at', () => {
		const updating = { actions: { read: 'projects.read', insert: 'staff.assign', update: 'staff.assign' }, update: ['person_id'] }
		expect(() => readPath('person_id.principal_id', { project_staff: updating })).toThrow(
			'person_id decides what a row confers, so no update writes it',
		)
	})

	test('the artifact keeps the principal as its dotted text', () => {
		const staff = { principal: 'person_id.principal_id', node: 'project_id', expires: null, assign: { maxDays: null, self: false } }
		expect(tablePolicies(tables)['project_staff']?.confers).toEqual({ staff })
		expect(tablePolicies(readPath('person_id.principal_id'))['project_staff']?.confers).toEqual({ staff })
	})
})

describe('the policy of a createdBy principal', () => {
	const readOwner = (projects: Readonly<Record<string, unknown>>) => () =>
		readTables(pathColumns, { ...pathPolicies, projects: { ...pathPolicies.projects, ...projects } }, vocabulary)

	test('is accepted on a table without an insert, and with assign.self on one with an insert', () => {
		expect(readOwner({ confers: { owner: { principal: 'created_by' } } })).not.toThrow()
		expect(readOwner({
			actions: { read: 'projects.read', insert: 'projects.create' },
			confers: { owner: { principal: 'created_by', assign: { self: true } } },
		})).not.toThrow()
	})

	test('every inserted row names its writer, so an insert without assign.self is refused at parse', () => {
		const refused = 'is the createdBy column, so every inserted row names its writer: state assign: { self: true }'
		expect(readOwner({ actions: { read: 'projects.read', insert: 'projects.create' }, confers: { owner: { principal: 'created_by', assign: {} } } }))
			.toThrow(refused)
		expect(readOwner({ actions: { read: 'projects.read', insert: 'projects.create' }, confers: { owner: { principal: 'created_by' } } })).toThrow(
			'state assign',
		)
	})

	test('no update writes the createdBy column, so an owner is changed only by a new row', () => {
		expect(readOwner({
			actions: { read: 'projects.read', update: 'projects.create' },
			update: ['created_by'],
			confers: { owner: { principal: 'created_by' } },
		})).toThrow('stamped by the layer')
		expect(readOwner({
			actions: { read: 'projects.read', update: 'projects.create' },
			columns: { created_by: { write: 'projects.create' } },
			confers: { owner: { principal: 'created_by' } },
		})).toThrow()
	})

	test('a principal path does not start at the createdBy column', () => {
		expect(() => readPath('added_by.principal_id', { project_staff: { createdBy: 'added_by' } })).toThrow(
			'added_by is the createdBy column, which holds a principal; a principal path starts at a foreign key',
		)
	})
})
