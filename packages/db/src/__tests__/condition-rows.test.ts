// The rows a condition reads past the row itself: `some` and `none` after a to-one path, nested, through a link table,
// and at the deepest the guard admits. Every runtime case runs on SQLite and, with FABRIKA_TEST_POSTGRES_URL, on a real
// Postgres:
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
import type { ConditionPolicy } from '../conditions'
import type { Database } from '../database'
import { QueryRefusedError } from '../errors'
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
	console.warn(`condition-rows.test.ts: the Postgres half is skipped; set ${URL_VAR} to run it`)
}

const migration = `
create table projects (id text not null primary key, name text not null, version integer not null);
create table tags (id text not null primary key, name text not null);
create table project_tags (
	id text not null primary key,
	project_id text not null references projects (id),
	tag_id text not null references tags (id)
);
create table tasks (
	id text not null primary key,
	project_id text not null references projects (id),
	open boolean not null,
	version integer not null,
	unique (id, project_id)
);
create table steps (
	id text not null primary key,
	task_id text not null references tasks (id),
	project_id text not null,
	done boolean not null,
	unique (id, task_id, project_id),
	foreign key (task_id, project_id) references tasks (id, project_id)
);
create table checks (
	id text not null primary key,
	step_id text not null references steps (id),
	task_id text not null,
	project_id text not null,
	blocker_id text references tasks (id),
	ok boolean not null,
	foreign key (task_id, project_id) references tasks (id, project_id),
	foreign key (step_id, task_id, project_id) references steps (id, task_id, project_id),
	foreign key (blocker_id, project_id) references tasks (id, project_id)
);
create table notes (
	id text not null primary key,
	task_id text not null references tasks (id),
	project_id text not null,
	flagged boolean not null,
	foreign key (task_id, project_id) references tasks (id, project_id)
);
create table assignments (
	id text not null primary key,
	task_id text not null,
	project_id text not null,
	principal_id text not null,
	foreign key (task_id, project_id) references tasks (id, project_id)
);
`

const seed = `
delete from assignments;
delete from notes;
delete from checks;
delete from steps;
delete from tasks;
delete from project_tags;
delete from tags;
delete from projects;
insert into projects (id, name, version) values ('p1', 'one', 1), ('p2', 'two', 1), ('p3', 'three', 1);
insert into tags (id, name) values ('g-urgent', 'urgent'), ('g-calm', 'calm');
insert into project_tags (id, project_id, tag_id) values ('pt1', 'p1', 'g-urgent'), ('pt2', 'p2', 'g-calm');
insert into tasks (id, project_id, open, version) values ('t1', 'p1', true, 1), ('t2', 'p2', false, 1), ('t3', 'p3', false, 1);
insert into steps (id, task_id, project_id, done) values ('s1', 't1', 'p1', false), ('s2', 't2', 'p2', true), ('s3', 't3', 'p3', false);
insert into checks (id, step_id, task_id, project_id, blocker_id, ok) values
	('c1', 's1', 't1', 'p1', 't1', true), ('c2', 's2', 't2', 'p2', null, false), ('c3', 's3', 't3', 'p3', 't3', true);
insert into notes (id, task_id, project_id, flagged) values ('n1', 't1', 'p1', true), ('n3', 't3', 'p3', false);
insert into assignments (id, task_id, project_id, principal_id) values ('a1', 't1', 'p1', 'user:alice'), ('a3', 't3', 'p3', 'user:alice');
`

type Flag = ColumnType<boolean, boolean, boolean>

interface DB {
	projects: { id: string; name: string; version: number }
	tags: { id: string; name: string }
	project_tags: { id: string; project_id: string; tag_id: string }
	tasks: { id: string; project_id: string; open: Flag; version: number }
	steps: { id: string; task_id: string; project_id: string; done: Flag }
	checks: { id: string; step_id: string; task_id: string; project_id: string; blocker_id: string | null; ok: Flag }
	notes: { id: string; task_id: string; project_id: string; flagged: Flag }
	assignments: { id: string; task_id: string; project_id: string; principal_id: string }
}

const columns: TypedColumnList<DB> = {
	projects: { columns: ['id', 'name', 'version'], foreignKeys: [], notNull: ['id', 'name', 'version'] },
	tags: { columns: ['id', 'name'], foreignKeys: [], notNull: ['id', 'name'] },
	project_tags: {
		columns: ['id', 'project_id', 'tag_id'],
		foreignKeys: [
			{ columns: ['project_id'], table: 'projects', references: ['id'] },
			{ columns: ['tag_id'], table: 'tags', references: ['id'] },
		],
		notNull: ['id', 'project_id', 'tag_id'],
	},
	tasks: {
		columns: ['id', 'project_id', 'open', 'version'],
		foreignKeys: [{ columns: ['project_id'], table: 'projects', references: ['id'] }],
		booleans: ['open'],
		notNull: ['id', 'project_id', 'open', 'version'],
	},
	steps: {
		columns: ['id', 'task_id', 'project_id', 'done'],
		foreignKeys: [
			{ columns: ['task_id'], table: 'tasks', references: ['id'] },
			{ columns: ['task_id', 'project_id'], table: 'tasks', references: ['id', 'project_id'] },
		],
		booleans: ['done'],
		notNull: ['id', 'task_id', 'project_id', 'done'],
	},
	checks: {
		columns: ['id', 'step_id', 'task_id', 'project_id', 'blocker_id', 'ok'],
		foreignKeys: [
			{ columns: ['step_id'], table: 'steps', references: ['id'] },
			{ columns: ['blocker_id'], table: 'tasks', references: ['id'] },
			{ columns: ['task_id', 'project_id'], table: 'tasks', references: ['id', 'project_id'] },
			{ columns: ['step_id', 'task_id', 'project_id'], table: 'steps', references: ['id', 'task_id', 'project_id'] },
			{ columns: ['blocker_id', 'project_id'], table: 'tasks', references: ['id', 'project_id'] },
		],
		booleans: ['ok'],
		notNull: ['id', 'step_id', 'task_id', 'project_id', 'ok'],
	},
	notes: {
		columns: ['id', 'task_id', 'project_id', 'flagged'],
		foreignKeys: [
			{ columns: ['task_id'], table: 'tasks', references: ['id'] },
			{ columns: ['task_id', 'project_id'], table: 'tasks', references: ['id', 'project_id'] },
		],
		booleans: ['flagged'],
		notNull: ['id', 'task_id', 'project_id', 'flagged'],
	},
	assignments: {
		columns: ['id', 'task_id', 'project_id', 'principal_id'],
		foreignKeys: [{ columns: ['task_id', 'project_id'], table: 'tasks', references: ['id', 'project_id'] }],
		notNull: ['id', 'task_id', 'project_id', 'principal_id'],
	},
}

const vocabulary = {
	app: 'rows',
	dimensions: { project: {}, task: { in: 'project' } },
	actions: { 'projects.read': 'Read projects', 'tasks.write': 'Write tasks' },
	relations: { assignee: { dimension: 'task' } },
	roles: {},
} as const

type Col<T extends keyof DB> = keyof DB[T] & string

interface Conditions {
	readonly projects?: ConditionPolicy<Col<'projects'>>
	readonly tasks?: ConditionPolicy<Col<'tasks'>>
	readonly steps?: ConditionPolicy<Col<'steps'>>
	readonly checks?: ConditionPolicy<Col<'checks'>>
	/** The condition under which an assigned task reveals its project to the assignee. */
	readonly reveal?: ConditionPolicy<Col<'tasks'>>
	/** The condition of the insert action of tasks. */
	readonly insert?: ConditionPolicy<Col<'tasks'>>
	/** The condition under which an assignment confers the relation. */
	readonly source?: ConditionPolicy<Col<'assignments'>>
}

const read = (condition: ConditionPolicy | undefined) => (condition === undefined ? {} : { when: { 'projects.read': condition } })

function tablesWith(conditions: Conditions = {}) {
	return defineTables(vocabulary, columns)({
		projects: { scope: { dimension: 'project' }, actions: { read: 'projects.read' }, version: 'version', ...read(conditions.projects) },
		tags: { scope: { reference: 'a fixed list of tags' }, actions: { read: 'projects.read' } },
		project_tags: { scope: { child: 'projects' }, actions: { read: 'projects.read' } },
		tasks: {
			scope: { dimension: 'task' },
			actions: { read: 'projects.read', insert: 'tasks.write' },
			insert: ['open'],
			version: 'version',
			...(conditions.tasks === undefined && conditions.insert === undefined
				? {}
				: {
					when: {
						...(conditions.tasks === undefined ? {} : { 'projects.read': conditions.tasks }),
						...(conditions.insert === undefined ? {} : { 'tasks.write': conditions.insert }),
					},
				}),
			...(conditions.reveal === undefined
				? {}
				: { reveals: { assignee: { to: 'project', actions: ['projects.read'], when: conditions.reveal } } }),
		},
		steps: { scope: { child: 'tasks' }, actions: { read: 'projects.read' }, ...read(conditions.steps) },
		checks: { scope: { child: 'tasks' }, actions: { read: 'projects.read' }, ...read(conditions.checks) },
		notes: { scope: { child: 'tasks' }, actions: { read: 'projects.read' } },
		assignments: {
			scope: { child: 'tasks' },
			actions: { read: 'projects.read' },
			confers: { assignee: { principal: 'principal_id', ...(conditions.source === undefined ? {} : { when: conditions.source }) } },
		},
	})
}

/** A task of an urgent project: a path, a `some` through the link table, and a path from it into a reference table. */
const URGENT_PROJECT: ConditionPolicy<Col<'tasks'>> = { project_id: { some: { project_tags: { 'tag_id.name': { eq: 'urgent' } } } } }

const alice = new TestAuthority('user:alice')

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
		})

		function use(conditions: Conditions): void {
			release()
			const layer = scoped(tablesWith(conditions))
			const binding = bindScopedDatabaseProvisionally(layer, { database: backend.database, capabilities: alice })
			release = () => binding.release()
			data = dataAccessOf(layer)
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

		const ids = (page: unknown): string[] => {
			const items: unknown = typeof page === 'object' && page !== null ? Reflect.get(page, 'items') : undefined
			return Array.isArray(items)
				? items.map((row: unknown) => String(typeof row === 'object' && row !== null ? Reflect.get(row, 'id') : '')).sort()
				: []
		}
		/** The rows of `table` a Within of every project reads, under `conditions`. */
		const listed = (conditions: Conditions, table: string) => {
			use(conditions)
			return invoke('query', async (db) => ids(await call(db.within(alice.within('project', 'projects.read', ['p1', 'p2', 'p3'])), `${table}.list`)))
		}
		/** The rows of `table` the assignee relation reaches, its reveals included. */
		const assigned = (conditions: Conditions, table: string) => {
			use(conditions)
			return invoke(
				'query',
				async (db) => ids(await call(db.within(alice.within('project', 'projects.read', [], [], [], ['assignee'])), `${table}.list`)),
			)
		}

		test('a some after a path reads the rows naming the row the path reaches, through a link table and a reference table', async () => {
			expect(await listed({ tasks: URGENT_PROJECT }, 'tasks')).toEqual(['t1'])
			expect(await listed({ steps: { 'task_id.project_id': { some: { project_tags: { tag_id: { eq: 'g-urgent' } } } } } }, 'steps')).toEqual(['s1'])
		})

		test('a none after a path holds where the reached row has no such row, and never where the path reaches no row', async () => {
			expect(await listed({ tasks: { project_id: { none: { project_tags: { 'tag_id.name': { eq: 'calm' } } } } } }, 'tasks')).toEqual(['t1', 't3'])
			// c2 names no blocker, so neither its none nor the negation of its some holds.
			expect(await listed({ checks: { blocker_id: { none: { notes: { flagged: { eq: true } } } } } }, 'checks')).toEqual(['c3'])
			expect(await listed({ checks: { not: { blocker_id: { some: { notes: { flagged: { eq: true } } } } } } }, 'checks')).toEqual(['c3'])
			await backend.exec(`update notes set flagged = false where id = 'n1'`)
			expect(await listed({ checks: { blocker_id: { none: { notes: { flagged: { eq: true } } } } } }, 'checks')).toEqual(['c1', 'c3'])
		})

		test('a some nests three deep, and a none nests inside a some', async () => {
			expect(await listed({ projects: { some: { tasks: { some: { steps: { some: { checks: { ok: { eq: true } } } } } } } } }, 'projects')).toEqual([
				'p1',
				'p3',
			])
			expect(await listed({ projects: { some: { tasks: { none: { steps: { done: { eq: true } } } } } } }, 'projects')).toEqual(['p1', 'p3'])
		})

		test("a reveal's condition with a path, a some and a path from it nests four deep, and the reveal follows its rows", async () => {
			expect(await assigned({}, 'tasks')).toEqual(['t1', 't3'])
			expect(await assigned({ reveal: URGENT_PROJECT }, 'projects')).toEqual(['p1'])
			await backend.exec(`insert into project_tags (id, project_id, tag_id) values ('pt3', 'p3', 'g-urgent')`)
			expect(await assigned({ reveal: URGENT_PROJECT }, 'projects')).toEqual(['p1', 'p3'])
			await backend.exec(`update tags set name = 'later' where id = 'g-urgent'`)
			expect(await assigned({ reveal: URGENT_PROJECT }, 'projects')).toEqual([])
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

describe('the policy bounds the rows a condition reads past a path', () => {
	test('the artifact records a some after a path as the policy writes it', () => {
		const artifact = tablePolicies(tablesWith({ tasks: URGENT_PROJECT, checks: { blocker_id: { none: { notes: { flagged: { eq: true } } } } } }))
		expect(artifact['tasks']?.when).toEqual({ 'projects.read': { project_id: { some: { project_tags: { 'tag_id.name': { eq: 'urgent' } } } } } })
		expect(artifact['checks']?.when).toEqual({ 'projects.read': { blocker_id: { none: { notes: { flagged: { eq: true } } } } } })
	})

	test('the path and the some count together towards the three foreign keys', () => {
		expect(() => tablesWith({ steps: { 'task_id.project_id': { some: { project_tags: { 'tag_id.name': { eq: 'urgent' } } } } } })).toThrow(
			'steps: when.projects.read.task_id.project_id.some.project_tags.tag_id.name: a path follows at most 3 foreign keys, a some or none counted as one',
		)
		expect(() => tablesWith({ projects: { some: { tasks: { some: { steps: { some: { checks: { 'blocker_id.open': { eq: true } } } } } } } } })).toThrow(
			'a path follows at most 3 foreign keys',
		)
	})

	test('each segment before the some is a foreign key the hop rule admits', () => {
		expect(() => tablesWith({ tasks: { open: { some: { notes: { flagged: { eq: true } } } } } })).toThrow(
			'tasks.open is not a single-column foreign key, so a path cannot follow it',
		)
		expect(() => tablesWith({ steps: { 'task_id.project_id': { none: { tags: { name: { eq: 'x' } } } } } })).toThrow(
			'tags has no single-column foreign key to projects',
		)
	})

	test("a source's condition reads the source row only, and an insert's takes no some", () => {
		expect(() => tablesWith({ source: { task_id: { some: { notes: { flagged: { eq: true } } } } } })).toThrow('follows no foreign key')
		expect(() => tablesWith({ insert: { some: { notes: { flagged: { eq: true } } } } })).toThrow('takes no some or none')
	})
})
