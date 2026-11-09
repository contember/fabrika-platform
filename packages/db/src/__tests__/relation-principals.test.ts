// Who a relation's source row names: its own principal column, or the table's createdBy, which names the row's writer.
// Every case runs on SQLite and, with FABRIKA_TEST_POSTGRES_URL, on a real Postgres:
//
//   docker run --rm -d -p 55433:5432 -e POSTGRES_PASSWORD=postgres postgres:17
//   FABRIKA_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55433/postgres bun test packages/db
//
// The URL is a credential: it is never logged.

import type { TypedColumnList } from '@fabrika/db'
import { openPostgres } from '@fabrika/db/postgres'
import { SQL } from 'bun'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from '../database'
import { QueryRefusedError } from '../errors'
import { bindScopedDatabaseProvisionally, type DataAccess, dataAccessOf, type DataHandles, type DataSite, type RelationCheck } from '../framework'
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
	console.warn(`relation-principals.test.ts: the Postgres half is skipped; set ${URL_VAR} to run it`)
}

const migration = `
create table orgs (id text not null primary key, version integer not null);
create table projects (
	id text not null primary key,
	org_id text not null references orgs (id),
	name text not null,
	created_by text not null,
	version integer not null
);
`

const seed = `
delete from projects;
delete from orgs;
insert into orgs (id, version) values ('o1', 1);
insert into projects (id, org_id, name, created_by, version) values ('p-bob', 'o1', 'bob''s', 'user:bob', 1);
`

interface DB {
	orgs: { id: string; version: number }
	projects: { id: string; org_id: string; name: string; created_by: string; version: number }
}

const columns: TypedColumnList<DB> = {
	orgs: { columns: ['id', 'version'], foreignKeys: [], notNull: ['id', 'version'] },
	projects: {
		columns: ['id', 'org_id', 'name', 'created_by', 'version'],
		foreignKeys: [{ columns: ['org_id'], table: 'orgs', references: ['id'] }],
		notNull: ['id', 'org_id', 'name', 'created_by', 'version'],
	},
}

const vocabulary = {
	app: 'principals',
	dimensions: { org: {}, project: { in: 'org' } },
	actions: { 'projects.read': 'Read projects', 'projects.create': 'Create projects' },
	relations: { owner: { dimension: 'project' } },
	roles: {},
} as const

const tables = defineTables(vocabulary, columns)({
	orgs: { scope: { dimension: 'org' }, actions: { read: 'projects.read' }, version: 'version' },
	projects: {
		scope: { dimension: 'project' },
		actions: { read: 'projects.read', insert: 'projects.create' },
		insert: ['name'],
		version: 'version',
		createdBy: 'created_by',
		confers: { owner: { principal: 'created_by', assign: { self: true } } },
	},
})

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

		beforeAll(async () => {
			backend = await open()
		})

		afterAll(close)

		beforeEach(async () => {
			await backend.exec(seed)
			const layer = scoped(tables)
			relates = bindScopedDatabaseProvisionally(layer, { database: backend.database, capabilities: alice }).relates
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

		const owned = () =>
			invoke('query', async (db) => {
				const page = await call(db.within(alice.within('org', 'projects.read', [], [], [], ['owner'])), 'projects.list')
				const items: unknown = typeof page === 'object' && page !== null ? Reflect.get(page, 'items') : undefined
				return Array.isArray(items) ? items.map((row: unknown) => String(typeof row === 'object' && row !== null ? Reflect.get(row, 'id') : '')) : []
			})

		test('a createdBy owner relation reaches the row its writer created, and nothing another principal created', async () => {
			expect(await owned()).toEqual([])
			const created = await invoke(
				'mutation',
				(db) => call(db.target(alice.ref('org', 'projects.create', 'o1'), 'on'), 'projects.insert', { name: 'mine' }),
			)
			const id = String(typeof created === 'object' && created !== null ? Reflect.get(created, 'id') : '')
			expect(await owned()).toEqual([id])
			expect(await relates('owner', id, 'user:alice')).toBe(true)
			expect(await relates('owner', 'p-bob', 'user:alice')).toBe(false)
			const read = () => invoke('query', (db) => call(db.target(alice.ref('project', 'projects.read', id, { org: 'o1' }, ['owner']), 'on'), 'get'))
			expect(await read()).toMatchObject({ id, name: 'mine', created_by: 'user:alice' })
			await backend.exec(`delete from projects where id = '${id}'`)
			expect(await owned()).toEqual([])
			await expect(read()).rejects.toThrow('not found')
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

describe('the policy of a createdBy principal', () => {
	const policy = (projects: Record<string, unknown>) => () =>
		defineTables(vocabulary, columns)({
			orgs: { scope: { dimension: 'org' }, actions: { read: 'projects.read' }, version: 'version' },
			projects: { scope: { dimension: 'project' }, actions: { read: 'projects.read' }, version: 'version', createdBy: 'created_by', ...projects },
		})

	test('is accepted on a table without an insert, and with assign.self on one with an insert', () => {
		expect(policy({ confers: { owner: { principal: 'created_by' } } })).not.toThrow()
		expect(policy({
			actions: { read: 'projects.read', insert: 'projects.create' },
			confers: { owner: { principal: 'created_by', assign: { self: true } } },
		})).not.toThrow()
	})

	test('every inserted row names its writer, so an insert without assign.self is refused at parse', () => {
		const refused = 'is the createdBy column, so every inserted row names its writer: state assign: { self: true }'
		expect(policy({ actions: { read: 'projects.read', insert: 'projects.create' }, confers: { owner: { principal: 'created_by', assign: {} } } }))
			.toThrow(refused)
		expect(policy({ actions: { read: 'projects.read', insert: 'projects.create' }, confers: { owner: { principal: 'created_by' } } })).toThrow(
			'state assign',
		)
	})

	test('no update writes the createdBy column, so an owner is changed only by a new row', () => {
		expect(policy({
			actions: { read: 'projects.read', update: 'projects.create' },
			update: ['created_by'],
			confers: { owner: { principal: 'created_by' } },
		})).toThrow('stamped by the layer')
		expect(policy({
			actions: { read: 'projects.read', update: 'projects.create' },
			columns: { created_by: { write: 'projects.create' } },
			confers: { owner: { principal: 'created_by' } },
		})).toThrow()
	})
})
