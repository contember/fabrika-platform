// An insert's condition along a foreign key, against a REAL Postgres: until the insert commits, no other transaction
// changes a row its condition read, on any hop of the path, whether the row met the test or not. Skips cleanly (with a
// reason) when FABRIKA_TEST_POSTGRES_URL is unset:
//
//   docker run --rm -d -p 55433:5432 -e POSTGRES_PASSWORD=postgres postgres:17
//   FABRIKA_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55433/postgres bun test packages/db
//
// The URL is a credential: it is never logged.

import type { TypedColumnList } from '@fabrika/db'
import { openPostgres } from '@fabrika/db/postgres'
import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ColumnType } from 'kysely'
import type { ConditionPolicy } from '../conditions'
import type { Database } from '../database'
import { QueryRefusedError } from '../errors'
import { bindScopedDatabaseProvisionally, dataAccessOf, type DataSite } from '../framework'
import { defineTables } from '../policy'
import { scoped } from '../store'
import { TestAuthority } from './fixtures/authority'
import { call } from './fixtures/harness'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR]
const hasPostgres = url !== undefined && url !== ''

if (!hasPostgres) {
	console.warn(`insert-paths.test.ts skipped: set ${URL_VAR} to run the Postgres-backed tests`)
}

const schema = `db_${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
const alice = new TestAuthority('user:alice')
let database: Database

const migration = `
create table projects (id text not null primary key, version integer not null);
create table kinds (id text not null primary key, open boolean not null);
create table labels (
	id text not null primary key,
	project_id text not null references projects (id),
	kind_id text not null references kinds (id),
	public boolean not null,
	unique (id, project_id)
);
create table tasks (
	id text not null primary key,
	project_id text not null references projects (id),
	label_id text references labels (id),
	title text not null,
	foreign key (label_id, project_id) references labels (id, project_id)
);
insert into projects (id, version) values ('p1', 1);
insert into kinds (id, open) values ('k-open', true), ('k-spare', true);
insert into labels (id, project_id, kind_id, public) values ('l-public', 'p1', 'k-open', true), ('l-spare', 'p1', 'k-spare', true);
`

interface DB {
	projects: { id: string; version: number }
	kinds: { id: string; open: ColumnType<boolean, boolean, boolean> }
	labels: { id: string; project_id: string; kind_id: string; public: ColumnType<boolean, boolean, boolean> }
	tasks: { id: string; project_id: string; label_id: string | null; title: string }
}

const columns: TypedColumnList<DB> = {
	projects: { columns: ['id', 'version'], foreignKeys: [] },
	kinds: { columns: ['id', 'open'], foreignKeys: [], booleans: ['open'] },
	labels: {
		columns: ['id', 'project_id', 'kind_id', 'public'],
		foreignKeys: [
			{ columns: ['project_id'], table: 'projects', references: ['id'] },
			{ columns: ['kind_id'], table: 'kinds', references: ['id'] },
		],
		booleans: ['public'],
	},
	tasks: {
		columns: ['id', 'project_id', 'label_id', 'title'],
		foreignKeys: [
			{ columns: ['project_id'], table: 'projects', references: ['id'] },
			{ columns: ['label_id'], table: 'labels', references: ['id'] },
			{ columns: ['label_id', 'project_id'], table: 'labels', references: ['id', 'project_id'] },
		],
	},
}

const vocabulary = {
	app: 'inserts',
	dimensions: { project: {} },
	actions: { 'tasks.read': 'Read tasks', 'tasks.write': 'Write tasks' },
	roles: {},
} as const

function tablesWith(when: ConditionPolicy<keyof DB['tasks'] & string>) {
	return defineTables(vocabulary, columns)({
		projects: { scope: { dimension: 'project' }, actions: { read: 'tasks.read' }, version: 'version' },
		kinds: { scope: { reference: 'a fixed list of label kinds' }, actions: { read: 'tasks.read' } },
		labels: { scope: { child: 'projects' }, actions: { read: 'tasks.read' } },
		tasks: {
			scope: { child: 'projects' },
			actions: { read: 'tasks.read', insert: 'tasks.write' },
			insert: ['label_id', 'title'],
			when: { 'tasks.write': when },
		},
	})
}

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

/** Runs `statement` in a transaction of its own that waits at most 300 ms for a lock: what a concurrent writer gets. */
function concurrently(statement: string): Promise<string> {
	return admin((sql) =>
		sql.begin(async (tx) => {
			await tx.unsafe(`set local search_path to ${schema}; set local lock_timeout = '300ms'`)
			await tx.unsafe(statement)
		})
	).then(() => 'written', () => 'blocked')
}

/** Inserts a task under `when` and keeps its transaction open while `meanwhile` runs; then commits. */
async function whileInserting<T>(
	when: ConditionPolicy<keyof DB['tasks'] & string>,
	values: Record<string, unknown>,
	meanwhile: () => Promise<T>,
): Promise<T> {
	const layer = scoped(tablesWith(when))
	bindScopedDatabaseProvisionally(layer, { database, capabilities: alice })
	const data = dataAccessOf(layer)
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
		await call(Reflect.get(data.handles(site).target(alice.ref('project', 'tasks.write', 'p1'), 'on'), 'tasks'), 'insert', values)
		const result = await meanwhile()
		await transaction.commit()
		return result
	} catch (error) {
		await transaction.rollback()
		throw error
	}
}

beforeAll(async () => {
	if (!hasPostgres) return
	await admin(async (sql) => {
		await sql.unsafe(`create schema ${schema}`)
		await sql.unsafe(`set search_path to ${schema}; ${migration}`)
	})
	database = openPostgres({ url: url ?? '', schema, max: 2 })
})

afterAll(async () => {
	if (!hasPostgres) return
	await database.close()
	await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
})

describe.skipIf(!hasPostgres)("an insert's condition holds the rows it read until the commit", () => {
	test('a row that the test refused under not, which a read of it would not have locked', async () => {
		const outcome = await whileInserting({ not: { 'label_id.public': { eq: false } } }, { label_id: 'l-public', title: 'one' }, async () => ({
			named: await concurrently("update labels set public = false where id = 'l-public'"),
			other: await concurrently("update labels set public = false where id = 'l-spare'"),
		}))
		expect(outcome).toEqual({ named: 'blocked', other: 'written' })
	})

	test('every hop of a path, not only the first', async () => {
		const outcome = await whileInserting({ 'label_id.kind_id.open': { eq: true } }, { label_id: 'l-public', title: 'two' }, async () => ({
			named: await concurrently("update kinds set open = false where id = 'k-open'"),
			other: await concurrently("update kinds set open = false where id = 'k-spare'"),
		}))
		expect(outcome).toEqual({ named: 'blocked', other: 'written' })
	})
})
