// A widening condition (`admits`, ADR-0074): a `Within`'s read of a table also reaches the rows its condition admits
// inside the tenant partition nodes the caller holds the action in through a relation (`WithinGrant.admitting`). The
// table's `when` still narrows them, a node of another dimension admits nothing, and no write, lock, claim or ctx.sql
// fragment sees them. Every case runs on SQLite and, with FABRIKA_TEST_POSTGRES_URL, on Postgres:
//
//   docker run --rm -d -p 55433:5432 -e POSTGRES_PASSWORD=postgres postgres:17
//   FABRIKA_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55433/postgres bun test packages/db
//
// The URL is a credential: it is never logged.

import type { TypedColumnList } from '@fabrika/db'
import { openPostgres } from '@fabrika/db/postgres'
import { SQL } from 'bun'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { admitsTerms } from '../authority'
import { type ContainerGrant, MAX_WITHIN_VALUES, type RelationHold, type WithinGrant } from '../capability'
import type { Database } from '../database'
import { CapabilityError, PolicyError, QueryRefusedError } from '../errors'
import { bindScopedDatabaseProvisionally, type DataAccess, dataAccessOf, type DataHandles, type DataSite } from '../framework'
import { assertAllowedTree } from '../guard'
import { FRAMEWORK_MIGRATIONS } from '../migrations'
import { existsNode } from '../nodes'
import type { DataKind } from '../orm-types'
import { defineTables, readTables, type Tables } from '../policy'
import { frameworkSideOf } from '../registry'
import { guard, type Runner, scoped, selectOne, updateRow } from '../store'
import { tablePolicies } from '../tables'
import { TestAuthority } from './fixtures/authority'
import { sqliteFramework } from './fixtures/sqlite-framework'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR]
const hasPostgres = url !== undefined && url !== ''

if (!hasPostgres) {
	console.warn(`admits.test.ts: the Postgres half is skipped; set ${URL_VAR} to run it`)
}

// uuid keys: Postgres reads every spelling of one as the same node, so the partition's nodes are compared in SQL.
const O1 = '0195f0c2-7a10-7000-8000-0000000000a1'
const O2 = '0195f0c2-7a10-7000-8000-0000000000a2'

const migration = `
create table orgs (id uuid not null primary key, name text not null);
create table projects (id text not null primary key, org_id uuid not null references orgs (id), name text not null, unique (id, org_id));
create table project_members (
	id text not null primary key,
	project_id text not null,
	org_id uuid not null,
	principal_id text not null,
	foreign key (project_id, org_id) references projects (id, org_id)
);
create table categories (id text not null primary key, org_id uuid not null references orgs (id), public text not null, unique (id, org_id));
create table tasks (
	id text not null primary key,
	project_id text not null,
	org_id uuid not null,
	visibility text not null,
	title text not null,
	category_id text references categories (id),
	foreign key (project_id, org_id) references projects (id, org_id),
	foreign key (category_id, org_id) references categories (id, org_id)
);
create table reviews (
	id text not null primary key,
	project_id text not null,
	org_id uuid not null,
	visibility text not null,
	result text,
	attempts integer not null default 0,
	due timestamp,
	version integer not null default 1,
	foreign key (project_id, org_id) references projects (id, org_id)
);
create view task_digests as select id, id as task_id, title from tasks;
`

const seed = `
delete from reviews;
delete from tasks;
delete from categories;
delete from project_members;
delete from projects;
delete from orgs;
insert into orgs (id, name) values ('${O1}', 'one'), ('${O2}', 'two');
insert into projects (id, org_id, name) values ('p1', '${O1}', 'one'), ('p2', '${O1}', 'two'), ('p3', '${O2}', 'three');
insert into project_members (id, project_id, org_id, principal_id) values ('m1', 'p1', '${O1}', 'user:alice');
insert into categories (id, org_id, public) values ('c1', '${O1}', 'yes'), ('c2', '${O1}', 'no'), ('c3', '${O2}', 'yes');
insert into tasks (id, project_id, org_id, visibility, title, category_id) values
	('k1', 'p1', '${O1}', 'private', 'one', null),
	('k2', 'p2', '${O1}', 'public', 'two', null),
	('k3', 'p2', '${O1}', 'private', 'three', null),
	('k4', 'p3', '${O2}', 'public', 'four', null),
	('k5', 'p2', '${O1}', 'public', 'secret', null),
	('k6', 'p2', '${O1}', 'private', 'six', 'c1'),
	('k7', 'p2', '${O1}', 'private', 'seven', 'c2');
insert into reviews (id, project_id, org_id, visibility, due) values
	('r1', 'p1', '${O1}', 'private', '2000-01-01T00:00:00.000Z'),
	('r2', 'p2', '${O1}', 'public', '2000-01-01T00:00:00.000Z'),
	('r3', 'p3', '${O2}', 'public', '2000-01-01T00:00:00.000Z');
`

interface DB {
	orgs: { id: string; name: string }
	projects: { id: string; org_id: string; name: string }
	project_members: { id: string; project_id: string; org_id: string; principal_id: string }
	categories: { id: string; org_id: string; public: string }
	tasks: { id: string; project_id: string; org_id: string; visibility: string; title: string; category_id: string | null }
	reviews: {
		id: string
		project_id: string
		org_id: string
		visibility: string
		result: string | null
		attempts: number
		due: Date | null
		version: number
	}
	task_digests: { id: string | null; task_id: string | null; title: string | null }
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
	categories: {
		columns: ['id', 'org_id', 'public'],
		foreignKeys: [{ columns: ['org_id'], table: 'orgs', references: ['id'] }],
		notNull: ['id', 'org_id', 'public'],
	},
	tasks: {
		columns: ['id', 'project_id', 'org_id', 'visibility', 'title', 'category_id'],
		foreignKeys: [
			{ columns: ['project_id', 'org_id'], table: 'projects', references: ['id', 'org_id'] },
			{ columns: ['category_id'], table: 'categories', references: ['id'] },
			{ columns: ['category_id', 'org_id'], table: 'categories', references: ['id', 'org_id'] },
		],
		notNull: ['id', 'project_id', 'org_id', 'visibility', 'title'],
	},
	reviews: {
		columns: ['id', 'project_id', 'org_id', 'visibility', 'result', 'attempts', 'due', 'version'],
		foreignKeys: [{ columns: ['project_id', 'org_id'], table: 'projects', references: ['id', 'org_id'] }],
		notNull: ['id', 'project_id', 'org_id', 'visibility', 'attempts', 'version'],
		timestamps: ['due'],
	},
	task_digests: { columns: ['id', 'task_id', 'title'], foreignKeys: [], view: true },
}

const vocabulary = {
	app: 'admits',
	dimensions: { org: { partition: true }, project: { in: 'org' }, task: { in: 'project' } },
	actions: { 'projects.read': 'Read projects', 'tasks.read': 'Read tasks', 'tasks.write': 'Write tasks' },
	relations: { member: { dimension: 'project' } },
	roles: {},
} as const

const isPublic = { visibility: { eq: 'public' } } as const

const others = {
	orgs: { scope: { dimension: 'org' }, actions: { read: 'projects.read' } },
	projects: { scope: { dimension: 'project' }, actions: { read: 'projects.read' } },
	project_members: { scope: { child: 'projects' }, actions: { read: 'projects.read' }, confers: { member: { principal: 'principal_id' } } },
	categories: { scope: { child: 'orgs' }, actions: { read: 'projects.read' } },
	reviews: {
		scope: { child: 'projects' },
		actions: { read: 'tasks.read', update: 'tasks.read' },
		update: ['result'],
		queue: { attempts: 'attempts', due: 'due' },
		version: 'version',
		admits: { 'tasks.read': isPublic },
	},
	task_digests: { scope: { child: 'tasks' }, actions: { read: 'tasks.read' } },
} as const

const taskPolicy = {
	scope: { dimension: 'task' },
	actions: { read: 'tasks.read', update: 'tasks.write' },
	update: ['title'],
	when: { 'tasks.read': { title: { notEq: 'secret' } } },
	admits: { 'tasks.read': { anyOf: [isPublic, { 'category_id.public': { eq: 'yes' } }] } },
} as const

const tables = defineTables(vocabulary, columns)({ ...others, tasks: taskPolicy })

const alice = new TestAuthority('user:alice')

/** `member` held inside an org: what a membership role with `via` at the org carries (`~relin`). */
const memberIn = (org: string): RelationHold => ({ relation: 'member', inside: { dimension: 'org', values: [org] } })
const atOrgs = (...orgs: string[]): ContainerGrant[] => [{ dimension: 'org', values: orgs }]

async function call(handle: unknown, path: string, ...args: unknown[]): Promise<unknown> {
	const parts = path.split('.')
	const name = parts.pop() ?? ''
	const target = parts.reduce<unknown>((node, part) => (typeof node === 'object' && node !== null ? Reflect.get(node, part) : undefined), handle)
	const method: unknown = typeof target === 'object' && target !== null ? Reflect.get(target, name) : undefined
	if (typeof method !== 'function') throw new TypeError(`${path} is not a method of the handle`)
	return Reflect.apply(method, target, args)
}

const idsOf = (rows: unknown): string[] =>
	Array.isArray(rows) ? rows.map((row: unknown) => String(typeof row === 'object' && row !== null ? Reflect.get(row, 'id') : '')).sort() : []

function ids(page: unknown): string[] {
	return idsOf(typeof page === 'object' && page !== null ? Reflect.get(page, 'items') : undefined)
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
		let layer: object = {}

		const bind = <P>(layerTables: Tables<DB, P>) => {
			release()
			layer = scoped(layerTables)
			const binding = bindScopedDatabaseProvisionally(layer, { database: backend.database, capabilities: alice })
			release = () => binding.release()
			data = dataAccessOf(layer)
		}

		beforeAll(async () => {
			backend = await open()
		})

		afterAll(async () => {
			release()
			await close()
		})

		beforeEach(async () => {
			await backend.exec(seed)
			bind(tables)
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

		const within = (admitting: readonly ContainerGrant[], relations: readonly RelationHold[] = [memberIn(O1)], values: readonly string[] = []) =>
			alice.within('project', 'tasks.read', values, [], [], relations, [], admitting)
		const listed = async (admitting: readonly ContainerGrant[], relations?: readonly RelationHold[], table = 'tasks') =>
			ids(await invoke('query', (db) => call(db.within(within(admitting, relations)), `${table}.list`)))

		test("lists the member's rows and, in the partition node it holds the relation in, every row the condition admits", async () => {
			expect(await listed([])).toEqual(['k1'])
			expect(await listed(atOrgs(O1))).toEqual(['k1', 'k2', 'k6'])
			// Admitted rows need no relation row at all, and an IAM value beside them is not narrowed.
			expect(await listed(atOrgs(O1), [])).toEqual(['k2', 'k6'])
			expect(ids(await invoke('query', (db) => call(db.within(within(atOrgs(O1), [], ['p2'])), 'tasks.list')))).toEqual(['k2', 'k3', 'k6', 'k7'])
		})

		test('another partition node admits only its own rows', async () => {
			expect(await listed(atOrgs(O2), [])).toEqual(['k4'])
			expect(await listed(atOrgs(O1, O2), [])).toEqual(['k2', 'k4', 'k6'])
		})

		test("the table's when still narrows the admitted rows", async () => {
			// k5 is public, and its title is the one the table's condition for tasks.read refuses.
			expect(await listed(atOrgs(O1), [])).not.toContain('k5')
			await backend.exec("update tasks set title = 'secret' where id = 'k2'")
			expect(await listed(atOrgs(O1), [])).toEqual(['k6'])
		})

		test('a relation held anywhere admits nothing: it holds no partition node', async () => {
			expect(await listed([], [{ relation: 'member', inside: null }])).toEqual(['k1'])
		})

		test('a node of a dimension that is no partition admits nothing, whatever value it names', async () => {
			for (const values of [['p2'], [O1]]) {
				expect(await listed([{ dimension: 'project', values }], [])).toEqual([])
				expect(await listed([{ dimension: 'project', values }])).toEqual(['k1'])
			}
		})

		test("another tenant's rows never decide: a hop reads the row's own partition, and each statement reads it again", async () => {
			// c3 is public but lies in o2; k7's own category c2 is not, so k7 stays out.
			expect(await listed(atOrgs(O1), [])).not.toContain('k7')
			await backend.exec("update categories set public = 'no' where id = 'c1'")
			expect(await listed(atOrgs(O1), [])).toEqual(['k2'])
		})

		test.skipIf(dialect !== 'postgres')('a node spelled in another case is the node the database equates with it', async () => {
			expect(await listed(atOrgs(O1.toUpperCase()), [])).toEqual(['k2', 'k6'])
		})

		test('a count and an aggregate see the admitted rows', async () => {
			const capability = within(atOrgs(O1))
			expect(await invoke('query', (db) => call(db.within(capability), 'tasks.count'))).toBe(3)
			expect(await invoke('query', (db) => call(db.within(capability), 'tasks.aggregate', { groupBy: ['visibility'], count: true }))).toEqual([
				{ visibility: 'private', count: '2' },
				{ visibility: 'public', count: '1' },
			])
		})

		test("a child view takes no admits, and its parent's do not reach it", async () => {
			expect(await listed(atOrgs(O1), undefined, 'task_digests')).toEqual(['k1'])
			expect(await listed(atOrgs(O1), [], 'task_digests')).toEqual([])
		})

		test('a Within carries its admitting nodes within its value bound', async () => {
			const many = Array.from({ length: MAX_WITHIN_VALUES + 1 }, (_, index) => `0195f0c2-7a10-7000-8000-${String(index).padStart(12, '0')}`)
			await expect(listed(atOrgs(...many), [])).rejects.toThrow(CapabilityError)
		})

		test('ctx.db.app reads as it did without admits', async () => {
			const app = async () => ids(await invoke('query', (db) => call(db.app(alice.app('tasks.read')), 'tasks.list')))
			const widened = await app()
			bind(
				defineTables(vocabulary, columns)({
					...others,
					tasks: { scope: taskPolicy.scope, actions: taskPolicy.actions, update: taskPolicy.update, when: taskPolicy.when },
				}),
			)
			expect(await app()).toEqual(widened)
		})

		test('a queue claim does not see the admitted rows; a list does', async () => {
			const capability = within(atOrgs(O1))
			expect(ids(await invoke('query', (db) => call(db.within(capability), 'reviews.list')))).toEqual(['r1', 'r2'])
			const site: DataSite = {
				kind: 'job',
				unscoped: {},
				principal: 'user:alice',
				tickMs: 60_000,
				check: () => undefined,
				session: async () => data.direct(),
			}
			expect(idsOf(await call(data.handles(site).within(capability), 'reviews.claim', { limit: 10 }))).toEqual(['r1'])
		})

		test("the guard admits the widened term only on a Within's list: a Ref's read, a write's row and an unchanged update refuse it", async () => {
			const side = frameworkSideOf(layer)
			if (side === undefined) throw new TypeError('the test layer has no framework side')
			const context = side.tableContext('tasks', 'dimension')
			const grant: WithinGrant = {
				kind: 'within',
				dimension: 'project',
				action: 'tasks.read',
				principal: 'user:alice',
				values: [],
				containers: [],
				contained: [],
				relations: [],
				revealing: [],
				admitting: atOrgs(O1),
			}
			const [widened] = admitsTerms(context.model, grant, new Date())
			if (widened === undefined) throw new TypeError('tasks admits no row for tasks.read')
			const session = data.direct()
			const run: Runner = { read: async () => session, write: (work) => data.transaction(work) }
			// The term no builder puts there, handed to each statement that is no Within's list.
			await expect(selectOne(context, run, widened)).rejects.toThrow(QueryRefusedError)
			await expect(updateRow(context, run, { scope: widened }, new Map(), undefined)).rejects.toThrow(QueryRefusedError)
			const existing = existsNode('tasks', 'id', widened)
			expect(() => assertAllowedTree(existing, guard(context, 'SelectQueryNode', widened))).toThrow('the scope predicate must be true')
			expect(() => assertAllowedTree(existing, guard(context, 'SelectQueryNode', widened, true))).not.toThrow()
		})

		test('ctx.sql.scope refuses a Within that admits rows of the table, and renders one that admits none', async () => {
			const transaction = data.invocation(true)
			const sql = data.sql({ mode: 'read', check() {}, session: () => transaction.session(), fail: () => transaction.fail() })
			try {
				expect(() => sql.scope(alice.within('project', 'tasks.read', ['p1']), 'reviews')).not.toThrow()
				expect(() => sql.scope(alice.within('project', 'tasks.read', ['p1'], [], [], [], [], [{ dimension: 'project', values: ['p2'] }]), 'reviews'))
					.not.toThrow()
				const scope = () => sql.scope(alice.within('project', 'tasks.read', ['p1'], [], [], [], [], atOrgs(O1)), 'reviews')
				expect(scope).toThrow(CapabilityError)
				expect(scope).toThrow('cannot render a relation, a member reveal, a secondary path, admits or a condition')
			} finally {
				await transaction.rollback()
			}
		})
	})
}

describe('the policy', () => {
	// The reader's parse: the same one defineTables runs, over values nobody type-checked.
	const policy =
		(tasks: Record<string, unknown>, more: Record<string, unknown> = {}, dimensions: Record<string, unknown> = vocabulary.dimensions) => () =>
			readTables(columns, { ...others, ...more, tasks: { ...taskPolicy, ...tasks } }, { ...vocabulary, dimensions })

	const task = { in: 'project' }

	test('a partition is a top-level dimension, declared true', () => {
		expect(policy({})).not.toThrow()
		expect(policy({}, {}, { org: { partition: false }, project: { in: 'org' }, task })).toThrow(PolicyError)
		expect(policy({}, {}, { org: {}, project: { in: 'org', partition: true }, task })).toThrow('only a top-level dimension is a tenant partition')
	})

	test('only a dimension or child table in a partition takes admits, for one of its read actions', () => {
		expect(policy({}, {}, { org: {}, project: { in: 'org' }, task })).toThrow('which the vocabulary does not declare partition: true')
		expect(policy({ admits: { 'tasks.write': isPublic } })).toThrow('names no read action of the table')
		expect(policy({ admits: {} })).toThrow('admits names no action')
		expect(policy({}, { categories: { scope: { reference: 'shared' }, actions: { read: 'projects.read' }, admits: { 'projects.read': {} } } }))
			.toThrow('a reference table takes no admits')
		expect(policy({}, { task_digests: { ...others.task_digests, admits: { 'tasks.read': {} } } })).toThrow('a view takes no admits')
	})

	test('parses its condition as when does: a hop holds the row tenant, so it never reads another partition', () => {
		expect(policy({ admits: { 'tasks.read': { colour: { eq: 'red' } } } })).toThrow(PolicyError)
		const looseColumns: TypedColumnList<DB> = {
			...columns,
			tasks: { ...columns.tasks, foreignKeys: columns.tasks.foreignKeys.filter((key) => key.columns.length === 1 || key.table === 'projects') },
		}
		expect(() => defineTables(vocabulary, looseColumns)({ ...others, tasks: taskPolicy })).toThrow(
			"tasks.category_id leads to categories, outside the row's own containment",
		)
	})

	test('the artifact carries it, and a table without it has no field', () => {
		const artifact = tablePolicies(tables)
		expect(artifact['tasks']?.admits).toEqual({ 'tasks.read': { anyOf: [isPublic, { 'category_id.public': { eq: 'yes' } }] } })
		expect(artifact['projects']).not.toHaveProperty('admits')
	})
})

suite('sqlite', async () => {
	const framework = await sqliteFramework(migration)
	return {
		database: framework.database,
		exec: async (text) => {
			framework.storage.sql.exec(text)
		},
	}
}, async () => {})

const schema = `db_${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
let postgres: Database | undefined

suite('postgres', async () => {
	await postgresAdmin(async (sql) => {
		await sql.unsafe(`create schema ${schema}`)
		const framework = FRAMEWORK_MIGRATIONS.map((file) => file.sql).join('\n')
		await sql.unsafe(`set search_path to ${schema}; ${framework} ${migration.replace('due timestamp,', 'due timestamptz,')}`)
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
