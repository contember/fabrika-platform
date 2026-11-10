// A member reveal through a secondary path: a task names in `team_id` the team that works on it, and a grant at that
// team reveals the task's project to the grant's holder while the task is open. A link row of a task reveals the task
// to the members of the team it names. The task's writer picks the team, so `assign` bounds it: without `self` it never
// names a team where it holds a grant the reveal counts. Every case runs on SQLite and, with FABRIKA_TEST_POSTGRES_URL,
// on Postgres:
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
import { bindScopedDatabaseProvisionally, type DataAccess, dataAccessOf, type DataHandles, type DataSite, type MemberRevealCheck } from '../framework'
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
	console.warn(`member-reveal-paths.test.ts: the Postgres half is skipped; set ${URL_VAR} to run it`)
}

const migration = `
create table orgs (id text not null primary key);
create table teams (id text not null primary key, org_id text not null references orgs (id));
create table projects (id text not null primary key, name text not null);
create table tasks (
	id text not null primary key,
	project_id text not null references projects (id),
	team_id text references teams (id),
	title text not null,
	status text not null,
	unique (id, project_id)
);
create table task_teams (
	id text not null primary key,
	task_id text not null,
	project_id text not null,
	team_id text not null references teams (id),
	foreign key (task_id, project_id) references tasks (id, project_id)
);
create table notes (
	id text not null primary key,
	task_id text not null,
	project_id text not null,
	body text not null,
	foreign key (task_id, project_id) references tasks (id, project_id)
);
`

const seed = `
delete from notes;
delete from task_teams;
delete from tasks;
delete from projects;
delete from teams;
delete from orgs;
insert into orgs (id) values ('o1'), ('o2');
insert into teams (id, org_id) values ('t1', 'o1'), ('t2', 'o1'), ('t3', 'o2');
insert into projects (id, name) values ('p1', 'one'), ('p2', 'two'), ('p3', 'three');
insert into tasks (id, project_id, team_id, title, status) values
	('k1', 'p1', 't1', 'one', 'open'), ('k2', 'p1', 't2', 'two', 'open'), ('k3', 'p2', null, 'three', 'open'), ('k4', 'p2', 't1', 'four', 'done');
insert into task_teams (id, task_id, project_id, team_id) values ('l1', 'k3', 'p2', 't2');
insert into notes (id, task_id, project_id, body) values ('n1', 'k3', 'p2', 'three'), ('n2', 'k1', 'p1', 'one');
`

interface DB {
	orgs: { id: string }
	teams: { id: string; org_id: string }
	projects: { id: string; name: string }
	tasks: { id: string; project_id: string; team_id: string | null; title: string; status: string }
	task_teams: { id: string; task_id: string; project_id: string; team_id: string }
	notes: { id: string; task_id: string; project_id: string; body: string }
}

const columns: TypedColumnList<DB> = {
	orgs: { columns: ['id'], foreignKeys: [], notNull: ['id'] },
	teams: { columns: ['id', 'org_id'], foreignKeys: [{ columns: ['org_id'], table: 'orgs', references: ['id'] }], notNull: ['id', 'org_id'] },
	projects: { columns: ['id', 'name'], foreignKeys: [], notNull: ['id', 'name'] },
	tasks: {
		columns: ['id', 'project_id', 'team_id', 'title', 'status'],
		foreignKeys: [{ columns: ['project_id'], table: 'projects', references: ['id'] }, { columns: ['team_id'], table: 'teams', references: ['id'] }],
		notNull: ['id', 'project_id', 'title', 'status'],
	},
	task_teams: {
		columns: ['id', 'task_id', 'project_id', 'team_id'],
		foreignKeys: [
			{ columns: ['task_id', 'project_id'], table: 'tasks', references: ['id', 'project_id'] },
			{ columns: ['team_id'], table: 'teams', references: ['id'] },
		],
		notNull: ['id', 'task_id', 'project_id', 'team_id'],
	},
	notes: {
		columns: ['id', 'task_id', 'project_id', 'body'],
		foreignKeys: [{ columns: ['task_id', 'project_id'], table: 'tasks', references: ['id', 'project_id'] }],
		notNull: ['id', 'task_id', 'project_id', 'body'],
	},
}

const vocabulary = {
	app: 'member-reveal-paths',
	dimensions: { org: {}, team: { in: 'org' }, project: {}, task: { in: 'project' } },
	actions: {
		'teams.read': 'Read teams',
		'projects.read': 'Read projects',
		'projects.rename': 'Rename projects',
		'tasks.read': 'Read tasks',
		'tasks.insert': 'Create tasks',
		'tasks.write': 'Write tasks',
		'links.write': 'Link teams',
	},
	relations: {},
	roles: {},
} as const

const others = {
	orgs: { scope: { dimension: 'org' }, actions: { read: 'teams.read' } },
	teams: { scope: { dimension: 'team' }, actions: { read: 'teams.read' } },
	projects: { scope: { dimension: 'project' }, actions: { read: 'projects.read', update: 'projects.rename' }, update: ['name'] },
	notes: { scope: { child: 'tasks' }, actions: { read: 'tasks.read' }, readThrough: { team: 'task_id.team_id' } },
} as const

/** `self` lets a task's or a link's writer name a team where it is a member; without it, neither does. */
function tablesWith(options: { readonly self?: true } = {}) {
	const assign: { readonly self?: true } = options.self === true ? { self: true } : {}
	return defineTables(vocabulary, columns)({
		...others,
		tasks: {
			scope: { dimension: 'task' },
			actions: { read: 'tasks.read', insert: 'tasks.insert', update: 'tasks.write' },
			insert: ['title', 'team_id', 'status'],
			update: ['title'],
			readThrough: { team: 'team_id' },
			// The reveal holds a Ref for these only, as the path does; projects.read holds a Within's reads alone.
			writeThrough: { team: ['projects.rename', 'tasks.insert'] },
			memberReveals: {
				team: { to: 'project', actions: ['projects.read', 'projects.rename', 'tasks.insert'], when: { status: { eq: 'open' } }, assign },
			},
		},
		task_teams: {
			scope: { child: 'tasks' },
			actions: { read: 'tasks.read', insert: 'links.write', delete: 'links.write' },
			insert: ['team_id'],
			readThrough: { team: 'team_id' },
			memberReveals: { team: { to: 'task', actions: ['tasks.read'], assign } },
		},
	})
}

const tables = tablesWith()

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

const atTeams = (...values: string[]): ContainerGrant[] => [{ dimension: 'team', values }]

type Standing = Omit<WithinGrant, 'kind' | 'dimension' | 'action' | 'principal'>

const byTeams = (...values: string[]): Standing => ({ values, containers: [], contained: [], relations: [], revealing: [] })
const byOrg = (org: string): Standing => ({ ...byTeams(), containers: [{ dimension: 'org', values: [org] }] })

/** What the writer holds at teams, by action. */
function stand(held: Readonly<Record<string, Standing>>): void {
	alice.standings.clear()
	for (const [action, standing] of Object.entries(held)) alice.standings.set(`team ${action}`, standing)
}

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

		function use(layerTables: typeof tables): void {
			release()
			const layer = scoped(layerTables)
			const binding = bindScopedDatabaseProvisionally(layer, { database: backend.database, capabilities: alice })
			revealsToMembers = binding.revealsToMembers
			release = () => binding.release()
			data = dataAccessOf(layer)
		}

		beforeEach(async () => {
			await backend.exec(seed)
			alice.standings.clear()
			alice.caller = true
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

		const projects = async (...teams: string[]): Promise<string[]> =>
			ids(await invoke('query', (db) => call(db.within(alice.within('project', 'projects.read', [], [], [], [], atTeams(...teams))), 'projects.list')))

		describe('a Within', () => {
			test("reads the project of an open task that names a team the grant is at, and of no other task's", async () => {
				expect(await projects('t1')).toEqual(['p1'])
				expect(await projects('t2')).toEqual(['p1'])
				expect(await projects('t3')).toEqual([])
				await backend.exec("update tasks set status = 'open' where id = 'k4'")
				expect(await projects('t1')).toEqual(['p1', 'p2'])
				await backend.exec("update tasks set status = 'done' where id = 'k1'")
				expect(await projects('t1')).toEqual(['p2'])
			})

			test('reads the rows of a task a link row reveals to the members of the team it names', async () => {
				const notes = async (...teams: string[]) =>
					ids(await invoke('query', (db) => call(db.within(alice.within('task', 'tasks.read', [], [], [], [], atTeams(...teams))), 'notes.list')))
				expect(await notes('t2')).toEqual(['n1'])
				expect(await notes('t1')).toEqual([])
				await backend.exec("delete from task_teams where id = 'l1'")
				expect(await notes('t2')).toEqual([])
			})
		})

		describe('a Ref', () => {
			const project = (action: 'projects.read' | 'projects.rename', id: string, ...teams: string[]) =>
				alice.ref('project', action, id, {}, [], atTeams(...teams))
			const rename = (id: string, name: string, ...teams: string[]) =>
				invoke('mutation', (db) => call(db.target(project('projects.rename', id, ...teams), 'on'), 'update', { name }))

			test('is minted only for an action the path holds', async () => {
				expect(await revealsToMembers('team', ['t1', 't2', 't3'], 'project', 'p1', 'projects.rename')).toEqual(['t1', 't2'])
				expect(await revealsToMembers('team', ['t1'], 'project', 'p2', 'projects.rename')).toEqual([])
				expect(await revealsToMembers('team', ['t1', 't2'], 'project', 'p1', 'projects.read')).toEqual([])
				expect(await revealsToMembers('team', ['t2'], 'task', 'k3', 'tasks.read')).toEqual([])
			})

			test('acts through the revealing task, re-read at every statement', async () => {
				await rename('p1', 'renamed', 't1')
				await expect(rename('p2', 'x', 't1')).rejects.toThrow(NotFoundError)
				await backend.exec("update tasks set status = 'done' where id = 'k1'")
				await expect(rename('p1', 'again', 't1')).rejects.toThrow(NotFoundError)
				const named = await backend.rows("select name from projects where id = 'p1'")
				expect(named).toEqual([{ name: 'renamed' }])
			})

			test('of an action the path does not hold is unenforceable', async () => {
				const read = () => invoke('query', (db) => call(db.target(project('projects.read', 'p1', 't1'), 'on'), 'get'))
				await expect(read()).rejects.toThrow(CapabilityError)
				await expect(read()).rejects.toThrow('carries a grant on team, whose rows reveal no node for projects.read')
			})

			test.skipIf(dialect !== 'postgres')('an insert under it locks its destination under the member term until it commits', async () => {
				let resume: () => void = () => {}
				const held = new Promise<void>((resolve) => {
					resume = resolve
				})
				let inserted: () => void = () => {}
				const written = new Promise<void>((resolve) => {
					inserted = resolve
				})
				const ref = alice.ref('project', 'tasks.insert', 'p1', {}, [], atTeams('t1'))
				const writing = invoke('mutation', async (db) => {
					await call(db.target(ref, 'in'), 'tasks.insert', { title: 'held', team_id: null, status: 'open' })
					inserted()
					await held
				})
				await written
				const retitle = (id: string) =>
					backend.exec(`set lock_timeout = '300ms'; update projects set name = 'renamed' where id = '${id}'`).then(() => 'written', () => 'blocked')
				try {
					expect({ destination: await retitle('p1'), other: await retitle('p2') }).toEqual({ destination: 'blocked', other: 'written' })
				} finally {
					resume()
				}
				await writing
				expect(await backend.rows("select project_id from tasks where title = 'held'")).toEqual([{ project_id: 'p1' }])
			})
		})

		describe("the writer of the path's column, under assign", () => {
			const insert = (team: string | null, title: string) =>
				invoke(
					'mutation',
					(db) => call(db.target(alice.ref('project', 'tasks.insert', 'p3'), 'in'), 'tasks.insert', { title, team_id: team, status: 'open' }),
				)
			const titles = async (): Promise<string[]> =>
				(await backend.rows("select title from tasks where project_id = 'p3' order by title")).map((row) => String(row['title']))

			test('without self names no team where it holds an action the reveal counts', async () => {
				// The path's own bound needs what it hands out at the team: an org's grant holds it there, and is no member.
				stand({ 'projects.rename': byOrg('o1'), 'tasks.insert': byOrg('o1') })
				await insert('t1', 'by org')
				stand({ 'projects.rename': byOrg('o1'), 'tasks.insert': byOrg('o1'), 'projects.read': byTeams('t1') })
				await expect(insert('t1', 'member')).rejects.toThrow(ConflictError)
				await expect(insert('t1', 'member')).rejects.toThrow(
					"where its writer holds a grant the member reveal counts, which the reveal's assign.self does not allow",
				)
				await insert('t2', 'other team')
				stand({ 'projects.rename': { ...byOrg('o1'), values: ['t2'] }, 'tasks.insert': byOrg('o1') })
				await expect(insert('t2', 'renamer')).rejects.toThrow(ConflictError)
				expect(await titles()).toEqual(['by org', 'other team'])
			})

			test('a grant everywhere is no member, and a null column names no team', async () => {
				stand({
					'projects.rename': { ...byTeams(), values: 'all' },
					'tasks.insert': { ...byTeams(), values: 'all' },
					'projects.read': { ...byTeams(), values: 'all' },
				})
				await insert('t1', 'everywhere')
				alice.standings.clear()
				await insert(null, 'no team')
				expect(await titles()).toEqual(['everywhere', 'no team'])
			})

			test('work without a caller names no team: its grants cannot be seen', async () => {
				alice.caller = false
				await expect(insert('t1', 'job')).rejects.toThrow(ConflictError)
				await insert(null, 'job, no team')
				expect(await titles()).toEqual(['job, no team'])
			})

			test('with self a member names its own team', async () => {
				use(tablesWith({ self: true }))
				stand({ 'projects.rename': byTeams('t1'), 'tasks.insert': byTeams('t1'), 'projects.read': byTeams('t1') })
				await insert('t1', 'member')
				expect(await titles()).toEqual(['member'])
				expect(await projects('t1')).toEqual(['p1', 'p3'])
			})

			test("a link row's writer is bounded the same way", async () => {
				const link = (team: string) =>
					invoke(
						'mutation',
						(db) => call(db.target(alice.ref('task', 'links.write', 'k1', { project: 'p1' }), 'on'), 'task_teams.insert', { team_id: team }),
					)
				stand({ 'tasks.read': byTeams('t2') })
				await expect(link('t2')).rejects.toThrow(ConflictError)
				// No path bound here: only the reveal's assign judges the writer, and without a caller it sees no grants.
				alice.caller = false
				await expect(link('t3')).rejects.toThrow('cannot be judged under assign without self')
				alice.caller = true
				await link('t3')
				use(tablesWith({ self: true }))
				await link('t2')
				const linked = await backend.rows("select team_id from task_teams where task_id = 'k1' order by team_id")
				expect(linked).toEqual([{ team_id: 't2' }, { team_id: 't3' }])
			})
		})
	})
}

describe('the policy', () => {
	const parse = (tasks: Record<string, unknown>, rest: Record<string, unknown> = {}) => () =>
		defineTables(vocabulary, columns)({
			...others,
			tasks: {
				scope: { dimension: 'task' },
				actions: { read: 'tasks.read', insert: 'tasks.insert' },
				insert: ['title', 'team_id', 'status'],
				readThrough: { team: 'team_id' },
				...tasks,
			},
			task_teams: { scope: { child: 'tasks' }, actions: { read: 'tasks.read' } },
			...rest,
		})
	const reveal = { to: 'project', actions: ['projects.read'] }

	test('takes a dimension the table reads through, revealing its nearest container, with assign on an insertable table', () => {
		expect(parse({ memberReveals: { team: { ...reveal, assign: {} } } })).not.toThrow()
		expect(parse({ memberReveals: { team: reveal } })).toThrow('picks the team node the reveal holds at; state assign: { self? }')
		expect(parse({ actions: { read: 'tasks.read' }, insert: undefined, memberReveals: { team: { ...reveal, assign: {} } } })).toThrow(
			'has no insert action',
		)
		expect(parse({ actions: { read: 'tasks.read' }, insert: undefined, memberReveals: { team: reveal } })).not.toThrow()
		expect(parse({ memberReveals: { org: { ...reveal, assign: {} } } })).toThrow(PolicyError)
		expect(parse({ memberReveals: { org: { ...reveal, assign: {} } } })).toThrow(
			'org is neither the own dimension of tasks (task) nor one it reads through',
		)
		expect(parse({ memberReveals: { task: { ...reveal, assign: {} } } })).toThrow("the reveal matches the row's own key")
	})

	test('refuses a link row revealing past its nearest container, and a path through a container', () => {
		const link = (to: string) => ({
			task_teams: {
				scope: { child: 'tasks' },
				actions: { read: 'tasks.read' },
				readThrough: { team: 'team_id' },
				memberReveals: { team: { to, actions: ['projects.read'] } },
			},
		})
		expect(parse({}, link('task'))).not.toThrow()
		expect(parse({}, link('project'))).toThrow(
			'a move of an ancestor rewrites project_id, so a member reveal through a path reveals the nearest container only',
		)
		const through = {
			notes: { ...others.notes, memberReveals: { team: { to: 'task', actions: ['tasks.read'] } } },
		}
		expect(parse({}, through)).toThrow('reads team through its container tasks; declare the member reveal on tasks')
	})

	test('the artifact carries assign on a reveal through a path', () => {
		const artifact = tablePolicies(tablesWith({ self: true }))
		expect(artifact['tasks']?.memberReveals?.['team']).toMatchObject({ to: 'project', assign: { self: true } })
		expect(artifact['task_teams']?.memberReveals?.['team']).toEqual({ to: 'task', actions: ['tasks.read'], assign: { self: true } })
		expect(tablePolicies(tables)['tasks']?.memberReveals?.['team']).toMatchObject({ assign: { self: false } })
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
