// Writes through a secondary path (`writeThrough`): a grant of an action at the team a task's `team_id` names, or above
// it, or a relation at that team, holds the action on the task for a Ref, and through a reveal matched through the path
// on its project. Every statement of such a Ref re-reads the path. Whoever inserts the path's column must hold every
// action it hands out at the team it names, checked under lock in the insert's transaction. Every case runs on SQLite
// and, with FABRIKA_TEST_POSTGRES_URL, on Postgres:
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
import type { ContainerGrant, WithinGrant } from '../capability'
import type { Database } from '../database'
import { CapabilityError, ConflictError, NotFoundError, PolicyError, QueryRefusedError } from '../errors'
import { bindScopedDatabaseProvisionally, type DataAccess, dataAccessOf, type DataHandles, type DataSite, type PathCheck } from '../framework'
import type { DataKind } from '../orm-types'
import { defineTables } from '../policy'
import { openSqlite } from '../sqlite'
import { bunSqliteStorage } from '../sqlite-bun'
import { defineStore, scoped } from '../store'
import { tablePolicies } from '../tables'
import { TestAuthority } from './fixtures/authority'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR]
const hasPostgres = url !== undefined && url !== ''

if (!hasPostgres) {
	console.warn(`write-through.test.ts: the Postgres half is skipped; set ${URL_VAR} to run it`)
}

const migration = `
create table orgs (id text not null primary key);
create table teams (id text not null primary key, org_id text not null references orgs (id), name text not null, unique (id, org_id));
create table team_members (
	id text not null primary key,
	team_id text not null,
	org_id text not null,
	principal_id text not null,
	foreign key (team_id, org_id) references teams (id, org_id)
);
create table projects (id text not null primary key, name text not null);
create table tasks (
	id text not null primary key,
	project_id text not null references projects (id),
	team_id text references teams (id),
	title text not null,
	unique (id, project_id)
);
create table comments (
	id text not null primary key,
	task_id text not null,
	project_id text not null,
	body text not null,
	foreign key (task_id, project_id) references tasks (id, project_id)
);
`

const seed = `
delete from comments;
delete from tasks;
delete from projects;
delete from team_members;
delete from teams;
delete from orgs;
insert into orgs (id) values ('o1'), ('o2');
insert into teams (id, org_id, name) values ('t1', 'o1', 'one'), ('t2', 'o1', 'two'), ('t3', 'o2', 'three');
insert into team_members (id, team_id, org_id, principal_id) values ('m1', 't1', 'o1', 'user:alice'), ('m2', 't2', 'o1', 'user:alice');
insert into projects (id, name) values ('p1', 'one'), ('p2', 'two');
insert into tasks (id, project_id, team_id, title) values ('k1', 'p1', 't1', 'one'), ('k2', 'p1', 't2', 'two'), ('k3', 'p2', null, 'three'), ('k4', 'p2', 't3', 'four');
insert into comments (id, task_id, project_id, body) values ('c1', 'k1', 'p1', 'one'), ('c2', 'k2', 'p1', 'two');
`

interface DB {
	orgs: { id: string }
	teams: { id: string; org_id: string; name: string }
	team_members: { id: string; team_id: string; org_id: string; principal_id: string }
	projects: { id: string; name: string }
	tasks: { id: string; project_id: string; team_id: string | null; title: string }
	comments: { id: string; task_id: string; project_id: string; body: string }
}

const columns: TypedColumnList<DB> = {
	orgs: { columns: ['id'], foreignKeys: [], notNull: ['id'] },
	teams: {
		columns: ['id', 'org_id', 'name'],
		foreignKeys: [{ columns: ['org_id'], table: 'orgs', references: ['id'] }],
		notNull: ['id', 'org_id', 'name'],
	},
	team_members: {
		columns: ['id', 'team_id', 'org_id', 'principal_id'],
		foreignKeys: [{ columns: ['team_id', 'org_id'], table: 'teams', references: ['id', 'org_id'] }],
		notNull: ['id', 'team_id', 'org_id', 'principal_id'],
	},
	projects: { columns: ['id', 'name'], foreignKeys: [], notNull: ['id', 'name'] },
	tasks: {
		columns: ['id', 'project_id', 'team_id', 'title'],
		foreignKeys: [{ columns: ['project_id'], table: 'projects', references: ['id'] }, { columns: ['team_id'], table: 'teams', references: ['id'] }],
		notNull: ['id', 'project_id', 'title'],
	},
	comments: {
		columns: ['id', 'task_id', 'project_id', 'body'],
		foreignKeys: [{ columns: ['task_id', 'project_id'], table: 'tasks', references: ['id', 'project_id'] }],
		notNull: ['id', 'task_id', 'project_id', 'body'],
	},
}

const vocabulary = {
	app: 'write-through',
	dimensions: { org: {}, team: { in: 'org' }, project: {}, task: { in: 'project' } },
	actions: {
		'teams.read': 'Read teams',
		'projects.read': 'Read projects',
		'projects.rename': 'Rename projects',
		'tasks.read': 'Read tasks',
		'tasks.insert': 'Create tasks',
		'tasks.write': 'Write tasks',
		'tasks.delete': 'Delete tasks',
		'comments.write': 'Write comments',
	},
	relations: { teamMember: { dimension: 'team' } },
	roles: {},
} as const

const others = {
	orgs: { scope: { dimension: 'org' }, actions: { read: 'teams.read' } },
	teams: { scope: { dimension: 'team' }, actions: { read: 'teams.read' } },
	team_members: { scope: { child: 'teams' }, actions: { read: 'teams.read' }, confers: { teamMember: { principal: 'principal_id' } } },
	projects: { scope: { dimension: 'project' }, actions: { read: 'projects.read', update: 'projects.rename' }, update: ['name'] },
	comments: {
		scope: { child: 'tasks' },
		actions: { read: 'tasks.read', insert: 'comments.write', update: 'comments.write' },
		insert: ['body'],
		update: ['body'],
		readThrough: { team: 'task_id.team_id' },
		writeThrough: { team: ['comments.write'] },
	},
} as const

const taskPolicy = {
	scope: { dimension: 'task' },
	actions: { read: 'tasks.read', insert: 'tasks.insert', update: 'tasks.write', delete: 'tasks.delete' },
	insert: ['title', 'team_id'],
	update: ['title'],
	readThrough: { team: 'team_id' },
	// Not tasks.delete, nor projects.read: those stay containment's for a Ref.
	writeThrough: { team: ['tasks.read', 'tasks.write', 'projects.rename'] },
	reveals: { teamMember: { to: 'project', actions: ['projects.read', 'projects.rename'], assign: { self: true } } },
} as const

const tables = defineTables(vocabulary, columns)({ ...others, tasks: taskPolicy })

/** Every action an insert of a task's `team_id` hands out: the task's own, and its comments' through its column. */
const HANDED_OUT = ['tasks.read', 'tasks.write', 'projects.rename', 'comments.write'] as const

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

const atTeam = (...values: string[]): ContainerGrant[] => [{ dimension: 'team', values }]

type Standing = Omit<WithinGrant, 'kind' | 'dimension' | 'action' | 'principal'>

/** What the writer holds at teams of each action an insert hands out; `only` narrows the actions. */
function standAt(standing: Standing, only: readonly string[] = HANDED_OUT): void {
	alice.standings.clear()
	for (const action of only) alice.standings.set(`team ${action}`, standing)
}

const byTeams = (...values: string[]): Standing => ({ values, containers: [], contained: [], relations: [], revealing: [] })

function suite(dialect: 'sqlite' | 'postgres', open: () => Promise<Backend>, close: () => Promise<void>): void {
	describe.skipIf(dialect === 'postgres' && !hasPostgres)(`on ${dialect}`, () => {
		let backend: Backend
		let data: DataAccess
		let layer = scoped(tables)
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
			alice.standings.clear()
			release()
			layer = scoped(tables)
			const binding = bindScopedDatabaseProvisionally(layer, { database: backend.database, capabilities: alice })
			holdsThrough = binding.holdsThrough
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

		const task = <A extends string>(action: A, id: string, project: string, paths: readonly ContainerGrant[], relations: readonly string[] = []) =>
			alice.ref('task', action, id, { project }, relations, [], paths)
		const titles = async (): Promise<string[]> => (await backend.rows('select title from tasks order by title')).map((row) => String(row['title']))

		test('a grant at the team a task names holds the listed actions on it, and on no other task', async () => {
			expect(await invoke('query', (db) => call(db.target(task('tasks.read', 'k1', 'p1', atTeam('t1')), 'on'), 'get'))).toMatchObject({ id: 'k1' })
			await expect(invoke('query', (db) => call(db.target(task('tasks.read', 'k2', 'p1', atTeam('t1')), 'on'), 'get'))).rejects.toThrow(NotFoundError)
			// A task whose team_id is null lies on no path.
			await expect(invoke('query', (db) => call(db.target(task('tasks.read', 'k3', 'p2', atTeam('t1')), 'on'), 'get'))).rejects.toThrow(NotFoundError)
			await invoke('mutation', (db) => call(db.target(task('tasks.write', 'k1', 'p1', atTeam('t1')), 'on'), 'update', { title: 'renamed' }))
			await expect(invoke('mutation', (db) => call(db.target(task('tasks.write', 'k2', 'p1', atTeam('t1')), 'on'), 'update', { title: 'x' })))
				.rejects.toThrow(NotFoundError)
			expect(await titles()).toEqual(['four', 'renamed', 'three', 'two'])
		})

		test('a grant at a container of the team reaches every task of its teams', async () => {
			const atOrg = [{ dimension: 'org', values: ['o1'] }]
			await invoke('mutation', (db) => call(db.target(task('tasks.write', 'k2', 'p1', atOrg), 'on'), 'update', { title: 'by org' }))
			await expect(invoke('mutation', (db) => call(db.target(task('tasks.write', 'k4', 'p2', atOrg), 'on'), 'update', { title: 'x' })))
				.rejects.toThrow(NotFoundError)
			expect(await titles()).toContain('by org')
		})

		test('an action the path does not list stays containment-only: the Ref is unenforceable', async () => {
			await expect(invoke('mutation', (db) => call(db.target(task('tasks.delete', 'k1', 'p1', atTeam('t1')), 'on'), 'remove'))).rejects.toThrow(
				CapabilityError,
			)
			expect(await titles()).toEqual(['four', 'one', 'three', 'two'])
		})

		test('a table below reaches the path only for the actions its own writeThrough lists', async () => {
			const writer = task('comments.write', 'k1', 'p1', atTeam('t1'))
			await invoke('mutation', (db) => call(db.target(writer, 'on'), 'comments.update', 'c1', { body: 'edited' }))
			const bodies = await backend.rows('select body from comments order by body')
			expect(bodies.map((row) => row['body'])).toEqual(['edited', 'two'])
			// comments lists no tasks.read through the path, so a reading Ref of the task reaches none of them.
			await expect(invoke('query', (db) => call(db.target(task('tasks.read', 'k1', 'p1', atTeam('t1')), 'on'), 'comments.list'))).rejects.toThrow(
				CapabilityError,
			)
		})

		test("a relation at the team holds the task through the path, and the next statement re-reads the relation's row", async () => {
			const ref = task('tasks.write', 'k1', 'p1', [], ['teamMember'])
			await invoke('mutation', (db) => call(db.target(ref, 'on'), 'update', { title: 'by member' }))
			await invoke('query', async (db) => {
				const target = db.target(task('tasks.read', 'k1', 'p1', [], ['teamMember']), 'on')
				expect(await call(target, 'get')).toMatchObject({ id: 'k1' })
				await backend.exec("delete from team_members where id = 'm1'")
				await expect(call(target, 'get')).rejects.toThrow(NotFoundError)
			})
			await expect(invoke('mutation', (db) => call(db.target(ref, 'on'), 'update', { title: 'gone' }))).rejects.toThrow(NotFoundError)
			expect(await titles()).toContain('by member')
		})

		test('a reveal matched through the path holds an action the path lists for a Ref of the revealed project, and no other', async () => {
			const project = (action: string, id: string) => alice.ref('project', action, id, {}, ['teamMember'])
			await invoke('mutation', (db) => call(db.target(project('projects.rename', 'p1'), 'on'), 'update', { name: 'renamed' }))
			expect((await backend.rows("select name from projects where id = 'p1'"))[0]?.['name']).toBe('renamed')
			// p2's only team is t3, where alice is no member.
			await expect(invoke('mutation', (db) => call(db.target(project('projects.rename', 'p2'), 'on'), 'update', { name: 'x' }))).rejects.toThrow(
				NotFoundError,
			)
			// The reveal lists projects.read, which the path does not hold for a Ref: a Within reads it, a Ref does not.
			await expect(invoke('query', (db) => call(db.target(project('projects.read', 'p1'), 'on'), 'get'))).rejects.toThrow(CapabilityError)
		})

		test('a Ref held through a relation and a path is enforced by the part that reaches the table, and refused when none does', async () => {
			// projects reads no path, so only the relation's reveal through the tasks' path reaches p1; the path part adds nothing.
			const mixed = (id: string) => alice.ref('project', 'projects.rename', id, {}, ['teamMember'], [], atTeam('t1'))
			await invoke('mutation', (db) => call(db.target(mixed('p1'), 'on'), 'update', { name: 'by mixed' }))
			expect((await backend.rows("select name from projects where id = 'p1'"))[0]?.['name']).toBe('by mixed')
			await expect(invoke('mutation', (db) => call(db.target(mixed('p2'), 'on'), 'update', { name: 'x' }))).rejects.toThrow(NotFoundError)
			// Neither part reaches projects for projects.read through a Ref: the path holds no read here.
			const reading = alice.ref('project', 'projects.read', 'p1', {}, ['teamMember'], [], atTeam('t1'))
			await expect(invoke('query', (db) => call(db.target(reading, 'on'), 'get'))).rejects.toThrow(CapabilityError)
		})

		test('the binding answers the candidates that reach the object through a path holding the action', async () => {
			const candidates = [{ dimension: 'team', values: ['t2'] }, { dimension: 'team', values: ['t1'] }, { dimension: 'org', values: ['o2'] }]
			expect(await holdsThrough('task', 'k1', 'tasks.write', 'user:alice', ['teamMember'], candidates)).toEqual({
				relations: ['teamMember'],
				paths: [{ dimension: 'team', values: ['t1'] }],
			})
			expect(await holdsThrough('task', 'k1', 'tasks.delete', 'user:alice', ['teamMember'], candidates)).toEqual({ relations: [], paths: [] })
			expect(await holdsThrough('task', 'k1', 'tasks.write', 'user:bob', ['teamMember'], [])).toEqual({ relations: [], paths: [] })
			const many = [{ dimension: 'team', values: Array.from({ length: 1001 }, (_, index) => `t${index}`) }]
			await expect(holdsThrough('task', 'k1', 'tasks.write', 'user:alice', [], many)).rejects.toThrow(QueryRefusedError)
		})

		describe("an insert that writes the path's column", () => {
			const insert = (team: string | null, title: string) =>
				invoke('mutation', (db) => call(db.target(alice.ref('project', 'tasks.insert', 'p1'), 'in'), 'tasks.insert', { title, team_id: team }))

			test('needs every action the column hands out held at the team it names, and writes nothing otherwise', async () => {
				await expect(insert('t1', 'no standing')).rejects.toThrow(ConflictError)
				standAt(byTeams('t1'))
				await insert('t1', 'held')
				await expect(insert('t2', 'other team')).rejects.toThrow(ConflictError)
				// The comments' action rides on the task's column: a writer without it is outside the bound.
				standAt(byTeams('t1'), ['tasks.read', 'tasks.write', 'projects.rename'])
				await expect(insert('t1', 'no comments.write')).rejects.toThrow(ConflictError)
				expect(await titles()).toEqual(['four', 'held', 'one', 'three', 'two'])
			})

			test('takes a grant at a container of the team, or everywhere', async () => {
				standAt({ ...byTeams(), containers: [{ dimension: 'org', values: ['o1'] }] })
				await insert('t2', 'by org')
				const third = insert('t3', 'other org')
				await expect(third).rejects.toThrow(ConflictError)
				standAt({ ...byTeams(), values: 'all' })
				await insert('t3', 'everywhere')
				expect(await titles()).toEqual(['by org', 'everywhere', 'four', 'one', 'three', 'two'])
			})

			test('takes a relation row at the team, judged before the write, and a null column hands out nothing', async () => {
				standAt({ ...byTeams(), relations: ['teamMember'] })
				await insert('t1', 'by member')
				await backend.exec("delete from team_members where id = 'm1'")
				await expect(insert('t1', 'former member')).rejects.toThrow(ConflictError)
				alice.standings.clear()
				await insert(null, 'no team')
				await expect(insert('t9', 'no such team')).rejects.toThrow(ConflictError)
				expect(await titles()).toEqual(['by member', 'four', 'no team', 'one', 'three', 'two'])
			})

			test.skipIf(dialect !== 'postgres')('locks the relation row it holds the team through until the insert commits', async () => {
				standAt({ ...byTeams(), relations: ['teamMember'] })
				let resume: () => void = () => {}
				const held = new Promise<void>((resolve) => {
					resume = resolve
				})
				let inserted: () => void = () => {}
				const written = new Promise<void>((resolve) => {
					inserted = resolve
				})
				const writing = invoke('mutation', async (db) => {
					await call(db.target(alice.ref('project', 'tasks.insert', 'p1'), 'in'), 'tasks.insert', { title: 'held', team_id: 't1' })
					inserted()
					await held
				})
				await written
				const remove = (id: string) =>
					backend.exec(`set lock_timeout = '300ms'; delete from team_members where id = '${id}'`).then(() => 'written', () => 'blocked')
				// The insert's own foreign key takes FOR KEY SHARE only when it runs: the bound locks the team FOR SHARE before it.
				const rename = (id: string) =>
					backend.exec(`set lock_timeout = '300ms'; update teams set name = 'renamed' where id = '${id}'`).then(() => 'written', () => 'blocked')
				try {
					expect({ holding: await remove('m1'), other: await remove('m2'), team: await rename('t1'), otherTeam: await rename('t2') }).toEqual({
						holding: 'blocked',
						other: 'written',
						team: 'blocked',
						otherTeam: 'written',
					})
				} finally {
					resume()
				}
				await writing
			})
		})

		test('a move follows containment: a Ref held through a path never moves a row, one held on the chain does', async () => {
			// Without the reveal through the path, which hands out the project and so keeps a row in place.
			release()
			const moving = scoped(defineTables(vocabulary, columns)({ ...others, tasks: { ...taskPolicy, reveals: undefined } }))
			const binding = bindScopedDatabaseProvisionally(moving, { database: backend.database, capabilities: alice })
			release = () => binding.release()
			const store = defineStore(moving, 'tasks', (t) => t)
			const through = () => store.move(task('tasks.delete', 'k1', 'p1', atTeam('t1')), alice.ref('project', 'tasks.insert', 'p2'))
			await expect(through()).rejects.toThrow('never moves a row')
			const destination = () => store.move(task('tasks.delete', 'k3', 'p2', []), alice.ref('project', 'tasks.insert', 'p1', {}, [], [], atTeam('t1')))
			await expect(destination()).rejects.toThrow('never moves a row')
			expect(await store.move(task('tasks.delete', 'k3', 'p2', []), alice.ref('project', 'tasks.insert', 'p1'))).toMatchObject({
				chain: { project: 'p1' },
			})
		})

		test('no unscoped or ctx.sql write sets the column past the bound', async () => {
			// Without the reveal through the path, which keeps them off the table already.
			release()
			const plain = scoped(defineTables(vocabulary, columns)({ ...others, tasks: { ...taskPolicy, reveals: undefined } }))
			const binding = bindScopedDatabaseProvisionally(plain, { database: backend.database, capabilities: alice })
			release = () => binding.release()
			data = dataAccessOf(plain)
			const transaction = data.invocation(false)
			const site: DataSite = {
				kind: 'mutation',
				unscoped: { tasks: 'write' },
				principal: 'user:alice',
				check() {},
				session: () => transaction.session(),
			}
			const sql = data.sql({ mode: 'write', check() {}, session: () => transaction.session(), fail: () => transaction.fail() })
			try {
				const unscoped = () => call(data.handles(site).unscoped, 'tasks.insert', { project_id: 'p1', team_id: 't1', title: 'raw' })
				await expect(unscoped()).rejects.toThrow('never unscoped')
				const raw = () => sql(z.strictObject({}))`update tasks set team_id = ${'t1'} where id = ${'k3'}`
				await expect(raw()).rejects.toThrow("'tasks' at line 1 hands out access")
				const scope = () => sql.scope(task('tasks.read', 'k1', 'p1', atTeam('t1')), 'tasks')
				expect(scope).toThrow('cannot render a relation, a member reveal, a secondary path or a condition')
			} finally {
				await transaction.rollback()
			}
		})

		test('lists through the path read as before: a Within reads every path', async () => {
			const within = alice.within('team', 'tasks.read', ['t1'])
			expect(await invoke('query', async (db) => ids(await call(db.within(within), 'tasks.list')))).toEqual(['k1'])
		})
	})
}

describe('the policy', () => {
	const policy = (tasks: Record<string, unknown>) => () =>
		defineTables(vocabulary, columns)({ ...others, tasks: { ...taskPolicy, reveals: undefined, ...tasks } })

	test('takes the actions of a dimension it reads through, and refuses anything else', () => {
		expect(policy({ writeThrough: { team: ['tasks.write'] } })).not.toThrow()
		expect(policy({ writeThrough: { org: ['tasks.write'] } })).toThrow(PolicyError)
		expect(policy({ writeThrough: { org: ['tasks.write'] } })).toThrow('reads no path to org; declare readThrough.org first')
		expect(policy({ writeThrough: { team: [] } })).toThrow('names no action')
		expect(policy({ writeThrough: { team: ['tasks.fly'] } })).toThrow('not an action of the vocabulary')
		expect(policy({ writeThrough: { team: 'tasks.write' } })).toThrow('takes a plain array')
	})

	test('the artifact carries the actions, and no field for a table without them', () => {
		const artifact = tablePolicies(tables)
		expect(artifact['tasks']?.writeThrough).toEqual({ team: ['tasks.read', 'tasks.write', 'projects.rename'] })
		expect(artifact['comments']?.writeThrough).toEqual({ team: ['comments.write'] })
		expect(artifact['projects']).not.toHaveProperty('writeThrough')
		const read = defineTables(vocabulary, columns)({ ...others, tasks: { ...taskPolicy, writeThrough: undefined } })
		expect(tablePolicies(read)['tasks']).not.toHaveProperty('writeThrough')
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
