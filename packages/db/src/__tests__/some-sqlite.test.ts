// `some` and `none` in a condition, on SQLite: a row is narrowed by the rows of another table whose foreign key names
// it, read through a subquery the guard admits, and only along a key that keeps those rows in the row's own tenant.

import type { TypedColumnList } from '@fabrika/db'
import { beforeEach, describe, expect, test } from 'bun:test'
import type { ColumnType } from 'kysely'
import type { ConditionPolicy } from '../conditions'
import { QueryRefusedError } from '../errors'
import { bindScopedDatabaseProvisionally, dataAccessOf, type DataSite } from '../framework'
import { defineTables } from '../policy'
import { openSqlite } from '../sqlite'
import { type BunSqliteStorage, bunSqliteStorage } from '../sqlite-bun'
import { scoped } from '../store'
import { tablePolicies } from '../tables'
import { TestAuthority } from './fixtures/authority'

const migration = `
create table projects (id text not null primary key, name text not null, version integer not null);
create table tasks (id text not null primary key, project_id text references projects (id), open boolean not null, unique (id, project_id));
create table steps (
	id text not null primary key,
	project_id text not null references projects (id),
	task_id text not null,
	done boolean not null,
	foreign key (task_id, project_id) references tasks (id, project_id)
);
create table links (id text not null primary key, project_id text not null references projects (id), other_id text references projects (id));
`

interface DB {
	projects: { id: string; name: string; version: number }
	tasks: { id: string; project_id: string | null; open: ColumnType<boolean, boolean, boolean> }
	steps: { id: string; project_id: string; task_id: string; done: ColumnType<boolean, boolean, boolean> }
	links: { id: string; project_id: string; other_id: string | null }
}

const columns: TypedColumnList<DB> = {
	projects: { columns: ['id', 'name', 'version'], foreignKeys: [] },
	tasks: {
		columns: ['id', 'project_id', 'open'],
		foreignKeys: [{ columns: ['project_id'], table: 'projects', references: ['id'] }],
		booleans: ['open'],
	},
	steps: {
		columns: ['id', 'project_id', 'task_id', 'done'],
		foreignKeys: [
			{ columns: ['project_id'], table: 'projects', references: ['id'] },
			{ columns: ['task_id'], table: 'tasks', references: ['id'] },
			{ columns: ['task_id', 'project_id'], table: 'tasks', references: ['id', 'project_id'] },
		],
		booleans: ['done'],
	},
	links: {
		columns: ['id', 'project_id', 'other_id'],
		foreignKeys: [
			{ columns: ['project_id'], table: 'projects', references: ['id'] },
			{ columns: ['other_id'], table: 'projects', references: ['id'] },
		],
	},
}

const vocabulary = {
	app: 'some',
	dimensions: { project: {}, other: {} },
	actions: { 'projects.read': 'Read projects', 'projects.write': 'Write projects' },
	roles: {},
} as const

function tablesWith(when: ConditionPolicy<keyof DB['projects'] & string>) {
	return defineTables(vocabulary, columns)({
		projects: {
			scope: { dimension: 'project' },
			actions: { read: 'projects.read', insert: 'projects.write' },
			insert: ['name'],
			version: 'version',
			when: { 'projects.read': when },
		},
		tasks: { scope: { child: 'projects' }, actions: { read: 'projects.read' } },
		steps: { scope: { child: 'projects' }, actions: { read: 'projects.read' } },
		links: { scope: { child: 'projects' }, actions: { read: 'projects.read' } },
	})
}

const alice = new TestAuthority('user:alice')
let storage: BunSqliteStorage

beforeEach(() => {
	storage = bunSqliteStorage()
	storage.sql.exec(migration)
	storage.sql.exec(`
		insert into projects (id, name, version) values ('p1', 'one', 1), ('p2', 'two', 1), ('p3', 'three', 1);
		insert into tasks (id, project_id, open) values ('t1', 'p1', 1), ('t2', 'p2', 0), ('t9', null, 1);
		insert into steps (id, project_id, task_id, done) values ('s1', 'p1', 't1', 0), ('s2', 'p2', 't2', 1);
	`)
})

async function listed(when: ConditionPolicy<keyof DB['projects'] & string>): Promise<string[]> {
	const layer = scoped(tablesWith(when))
	bindScopedDatabaseProvisionally(layer, { database: openSqlite(storage), capabilities: alice })
	const data = dataAccessOf(layer)
	const transaction = data.invocation(true)
	const site: DataSite = {
		kind: 'query',
		unscoped: {},
		principal: 'user:alice',
		check() {
			if (transaction.ended) throw new QueryRefusedError('ended', 'this invocation has ended')
		},
		session: () => transaction.session(),
	}
	const within: unknown = Reflect.get(data.handles(site).within(alice.within('project', 'projects.read', ['p1', 'p2', 'p3'])), 'projects')
	const list: unknown = typeof within === 'object' && within !== null ? Reflect.get(within, 'list') : undefined
	if (typeof list !== 'function') throw new TypeError('projects.list is not a method of the handle')
	const page: unknown = await Reflect.apply(list, within, [])
	await transaction.commit()
	const items: unknown = typeof page === 'object' && page !== null ? Reflect.get(page, 'items') : undefined
	return Array.isArray(items) ? items.map((row: unknown) => String(typeof row === 'object' && row !== null ? Reflect.get(row, 'id') : '')).sort() : []
}

describe('a condition over the rows that name the row', () => {
	test('some: a project with an open task', async () => {
		expect(await listed({ some: { tasks: { open: { eq: true } } } })).toEqual(['p1'])
	})

	test('none: every other project, one without tasks included, whatever a task with no project holds', async () => {
		expect(await listed({ none: { tasks: { open: { eq: true } } } })).toEqual(['p2', 'p3'])
	})

	test('nests, and combines with the connectives', async () => {
		expect(await listed({ some: { tasks: { some: { steps: { done: { eq: true } } } } } })).toEqual(['p2'])
		expect(await listed({ anyOf: [{ name: { eq: 'three' } }, { some: { tasks: { open: { eq: true } } } }] })).toEqual(['p1', 'p3'])
	})

	test('the artifact records it in the policy form', () => {
		const artifact = tablePolicies(tablesWith({ none: { tasks: { open: { eq: true } } } }))
		expect(artifact['projects']?.when).toEqual({ 'projects.read': { none: { tasks: { open: { eq: true } } } } })
	})
})

describe('the policy bounds the rows a condition reads', () => {
	test('a table with no foreign key to the row, or with two, is refused', () => {
		expect(() => tablesWith({ some: { tasks: { some: { projects: { name: { eq: 'x' } } } } } })).toThrow(
			'projects has no single-column foreign key to tasks',
		)
		expect(() => tablesWith({ some: { links: { id: { eq: 'x' } } } })).toThrow('2 single-column foreign keys')
	})

	test("a key outside the row's containment is refused: it could name a row of another tenant", () => {
		const one = {
			...columns,
			links: { columns: ['id', 'project_id', 'other_id'], foreignKeys: [{ columns: ['project_id'], table: 'projects', references: ['id'] }] },
		} satisfies TypedColumnList<DB>
		expect(() =>
			defineTables(vocabulary, one)({
				projects: {
					scope: { dimension: 'project' },
					actions: { read: 'projects.read' },
					when: { 'projects.read': { some: { links: { id: { eq: 'x' } } } } },
				},
				tasks: { scope: { child: 'projects' }, actions: { read: 'projects.read' } },
				steps: { scope: { child: 'projects' }, actions: { read: 'projects.read' } },
				links: { scope: { dimension: 'other' }, actions: { read: 'projects.read' } },
			})
		).toThrow("outside projects's containment")
	})

	test("an insert's condition, judged on the row itself, reads no other row", () => {
		expect(() =>
			defineTables(vocabulary, columns)({
				projects: {
					scope: { dimension: 'project' },
					actions: { read: 'projects.read', insert: 'projects.write' },
					insert: ['name'],
					version: 'version',
					when: { 'projects.write': { some: { tasks: { open: { eq: true } } } } },
				},
				tasks: { scope: { child: 'projects' }, actions: { read: 'projects.read' } },
				steps: { scope: { child: 'projects' }, actions: { read: 'projects.read' } },
				links: { scope: { child: 'projects' }, actions: { read: 'projects.read' } },
			})
		).toThrow('judged on the row itself')
	})

	test('a some counts as one of the three foreign keys a path follows', () => {
		expect(() => tablesWith({ some: { tasks: { some: { steps: { 'task_id.project_id.name': { eq: 'x' } } } } } })).toThrow('at most 3 foreign keys')
	})
})
