// A read path that parts below the row: a row reads a dimension outside its chain through its nearest container's own
// read path (`readThrough: { team: 'project_id.team_id' }`), as `T.project_id in (select C.id from C where C.team_id in
// (…))`. Every runtime case runs on SQLite and, with FABRIKA_TEST_POSTGRES_URL, on a real Postgres:
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
	console.warn(`read-through-container.test.ts: the Postgres half is skipped; set ${URL_VAR} to run it`)
}

const migration = `
create table orgs (id text not null primary key, name text not null);
create table squads (id text not null primary key, org_id text not null references orgs (id), name text not null, unique (id, org_id));
create table squad_leads (
	id text not null primary key,
	squad_id text not null references squads (id),
	org_id text not null,
	principal_id text not null,
	foreign key (squad_id, org_id) references squads (id, org_id)
);
create table teams (
	id text not null primary key,
	squad_id text not null,
	org_id text not null,
	unique (id, org_id),
	unique (id, squad_id, org_id),
	foreign key (squad_id, org_id) references squads (id, org_id)
);
create table team_members (
	id text not null primary key,
	team_id text not null,
	squad_id text not null,
	org_id text not null,
	principal_id text not null,
	foreign key (team_id, squad_id, org_id) references teams (id, squad_id, org_id)
);
create table projects (
	id text not null primary key,
	org_id text not null references orgs (id),
	team_id text,
	unique (id, org_id),
	foreign key (team_id, org_id) references teams (id, org_id)
);
create table tasks (
	id text not null primary key,
	project_id text not null,
	org_id text not null,
	title text not null,
	foreign key (project_id, org_id) references projects (id, org_id)
);
create table boards (
	id text not null primary key,
	project_id text not null,
	org_id text not null,
	name text not null,
	unique (id, project_id, org_id),
	foreign key (project_id, org_id) references projects (id, org_id)
);
create table cards (
	id text not null primary key,
	board_id text not null,
	project_id text not null,
	org_id text not null,
	foreign key (board_id, project_id, org_id) references boards (id, project_id, org_id)
);
create view board_names as select b.id as board_id, b.name from boards b;
`

const seed = `
delete from cards;
delete from boards;
delete from tasks;
delete from projects;
delete from team_members;
delete from teams;
delete from squad_leads;
delete from squads;
delete from orgs;
insert into orgs (id, name) values ('o1', 'one');
insert into squads (id, org_id, name) values ('s1', 'o1', 'one'), ('s2', 'o1', 'two');
insert into teams (id, squad_id, org_id) values ('tm1', 's1', 'o1'), ('tm2', 's2', 'o1');
insert into projects (id, org_id, team_id) values ('p1', 'o1', 'tm1'), ('p2', 'o1', 'tm2'), ('p3', 'o1', null);
insert into tasks (id, project_id, org_id, title) values ('k1', 'p1', 'o1', 'one'), ('k2', 'p2', 'o1', 'two'), ('k3', 'p3', 'o1', 'three');
insert into boards (id, project_id, org_id, name) values ('b1', 'p1', 'o1', 'one'), ('b2', 'p2', 'o1', 'two'), ('b3', 'p3', 'o1', 'three');
`

interface DB {
	orgs: { id: string; name: string }
	squads: { id: string; org_id: string; name: string }
	squad_leads: { id: string; squad_id: string; org_id: string; principal_id: string }
	teams: { id: string; squad_id: string; org_id: string }
	team_members: { id: string; team_id: string; squad_id: string; org_id: string; principal_id: string }
	projects: { id: string; org_id: string; team_id: string | null }
	tasks: { id: string; project_id: string; org_id: string; title: string }
	boards: { id: string; project_id: string; org_id: string; name: string }
	cards: { id: string; board_id: string; project_id: string; org_id: string }
	board_names: { board_id: string | null; name: string | null }
}

const columns: TypedColumnList<DB, 'board_names'> = {
	orgs: { columns: ['id', 'name'], foreignKeys: [], notNull: ['id', 'name'] },
	squads: {
		columns: ['id', 'org_id', 'name'],
		foreignKeys: [{ columns: ['org_id'], table: 'orgs', references: ['id'] }],
		notNull: ['id', 'org_id', 'name'],
	},
	squad_leads: {
		columns: ['id', 'squad_id', 'org_id', 'principal_id'],
		foreignKeys: [
			{ columns: ['squad_id'], table: 'squads', references: ['id'] },
			{ columns: ['squad_id', 'org_id'], table: 'squads', references: ['id', 'org_id'] },
		],
		notNull: ['id', 'squad_id', 'org_id', 'principal_id'],
	},
	teams: {
		columns: ['id', 'squad_id', 'org_id'],
		foreignKeys: [{ columns: ['squad_id', 'org_id'], table: 'squads', references: ['id', 'org_id'] }],
		notNull: ['id', 'squad_id', 'org_id'],
	},
	team_members: {
		columns: ['id', 'team_id', 'squad_id', 'org_id', 'principal_id'],
		foreignKeys: [{ columns: ['team_id', 'squad_id', 'org_id'], table: 'teams', references: ['id', 'squad_id', 'org_id'] }],
		notNull: ['id', 'team_id', 'squad_id', 'org_id', 'principal_id'],
	},
	projects: {
		columns: ['id', 'org_id', 'team_id'],
		foreignKeys: [{ columns: ['org_id'], table: 'orgs', references: ['id'] }, {
			columns: ['team_id', 'org_id'],
			table: 'teams',
			references: ['id', 'org_id'],
		}],
		notNull: ['id', 'org_id'],
	},
	tasks: {
		columns: ['id', 'project_id', 'org_id', 'title'],
		foreignKeys: [{ columns: ['project_id', 'org_id'], table: 'projects', references: ['id', 'org_id'] }],
		notNull: ['id', 'project_id', 'org_id', 'title'],
	},
	boards: {
		columns: ['id', 'project_id', 'org_id', 'name'],
		foreignKeys: [{ columns: ['project_id', 'org_id'], table: 'projects', references: ['id', 'org_id'] }],
		notNull: ['id', 'project_id', 'org_id', 'name'],
	},
	cards: {
		columns: ['id', 'board_id', 'project_id', 'org_id'],
		foreignKeys: [{ columns: ['board_id', 'project_id', 'org_id'], table: 'boards', references: ['id', 'project_id', 'org_id'] }],
		notNull: ['id', 'board_id', 'project_id', 'org_id'],
	},
	board_names: { columns: ['board_id', 'name'], foreignKeys: [], view: true },
}

const vocabulary = {
	app: 'container-paths',
	dimensions: { org: {}, squad: { in: 'org' }, team: { in: 'squad' }, project: { in: 'org' }, board: { in: 'project' } },
	actions: { 'tasks.read': 'Read tasks' },
	relations: { member: { dimension: 'team' }, lead: { dimension: 'squad' } },
	roles: {},
} as const

type Through<T extends keyof DB> = keyof DB[T] & string | `${keyof DB[T] & string}.${string}`

interface Options {
	/** How projects read the team; `null` declares no path. */
	readonly projects?: Through<'projects'> | null
	/** How tasks read the team; through their project's path by default. */
	readonly tasks?: Through<'tasks'>
	/** How cards read the team, if at all. */
	readonly cards?: Through<'cards'>
	/** Tasks reveal their project to the team's members. */
	readonly reveal?: true
}

/** The layer's tables. A lead confers only while its squad is not closed: a source condition on the row it names. */
function tablesWith(options: Options = {}) {
	const read = { actions: { read: 'tasks.read' } } as const
	return defineTables(vocabulary, columns)({
		orgs: { scope: { dimension: 'org' }, ...read },
		squads: { scope: { dimension: 'squad' }, ...read },
		squad_leads: {
			scope: { child: 'squads' },
			...read,
			confers: { lead: { principal: 'principal_id', when: { 'squad_id.name': { notEq: 'closed' } } } },
		},
		teams: { scope: { dimension: 'team' }, ...read },
		team_members: { scope: { child: 'teams' }, ...read, confers: { member: { principal: 'principal_id' } } },
		projects: {
			scope: { dimension: 'project' },
			...read,
			...(options.projects === null ? {} : { readThrough: { team: options.projects ?? 'team_id' } }),
		},
		tasks: {
			scope: { child: 'projects' },
			...read,
			readThrough: { team: options.tasks ?? 'project_id.team_id' },
			...(options.reveal === true ? { reveals: { member: { to: 'project', actions: ['tasks.read'] } } } : {}),
		},
		boards: { scope: { dimension: 'board' }, ...read, readThrough: { team: 'project_id.team_id' } },
		cards: { scope: { child: 'boards' }, ...read, ...(options.cards === undefined ? {} : { readThrough: { team: options.cards } }) },
		board_names: { scope: { child: 'boards', key: 'board_id' }, ...read },
	})
}

const alice = new TestAuthority('user:alice')

async function call(handle: unknown, path: string, ...args: unknown[]): Promise<unknown> {
	const parts = path.split('.')
	const name = parts.pop() ?? ''
	const target = parts.reduce<unknown>((node, part) => (typeof node === 'object' && node !== null ? Reflect.get(node, part) : undefined), handle)
	const method: unknown = typeof target === 'object' && target !== null ? Reflect.get(target, name) : undefined
	if (typeof method !== 'function') throw new TypeError(`${path} is not a method of the handle`)
	return Reflect.apply(method, target, args)
}

function ids(page: unknown, key: string): string[] {
	const items: unknown = typeof page === 'object' && page !== null ? Reflect.get(page, 'items') : undefined
	return Array.isArray(items) ? items.map((row: unknown) => String(typeof row === 'object' && row !== null ? Reflect.get(row, key) : '')).sort() : []
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
			const layer = scoped(tablesWith())
			const binding = bindScopedDatabaseProvisionally(layer, { database: backend.database, capabilities: alice })
			release = () => binding.release()
			data = dataAccessOf(layer)
		})

		afterAll(async () => {
			release()
			await close()
		})

		beforeEach(async () => {
			await backend.exec(seed)
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

		const listed = (within: unknown, table = 'tasks', key = 'id') =>
			invoke('query', async (db) => ids(await call(db.within(within), `${table}.list`), key))
		const names = (within: unknown) => listed(within, 'board_names', 'board_id')
		const member = alice.within('team', 'tasks.read', [], [], [], ['member'])
		const lead = alice.within('team', 'tasks.read', [], [], [], ['lead'])

		test("a Within of the dimension reads the rows whose container names one of its nodes, or one under its containers' nodes", async () => {
			expect(await listed(alice.within('team', 'tasks.read', ['tm1']))).toEqual(['k1'])
			expect(await listed(alice.within('squad', 'tasks.read', ['s2']))).toEqual(['k2'])
			expect(await listed(alice.within('team', 'tasks.read', [], [{ dimension: 'org', values: ['o1'] }]))).toEqual(['k1', 'k2'])
			expect(await listed(alice.within('team', 'tasks.read', ['tm2']), 'boards')).toEqual(['b2'])
			expect(await names(alice.within('squad', 'tasks.read', ['s1']))).toEqual(['b1'])
		})

		test("the read takes the container's column at every statement, so a row moved, or a container given to another team, is read where it is now", async () => {
			const tm2 = alice.within('team', 'tasks.read', ['tm2'])
			expect(await listed(tm2)).toEqual(['k2'])
			await backend.exec(`update projects set team_id = 'tm2' where id = 'p1'`)
			expect(await listed(tm2)).toEqual(['k1', 'k2'])
			expect(await listed(alice.within('team', 'tasks.read', ['tm1']))).toEqual([])
			await backend.exec(`update tasks set project_id = 'p3' where id = 'k2'`)
			expect(await listed(tm2)).toEqual(['k1'])
		})

		test('a relation at the dimension reads the rows through the container while its source row stands', async () => {
			expect(await listed(member)).toEqual([])
			await backend.exec(`insert into team_members (id, team_id, squad_id, org_id, principal_id) values ('m1', 'tm1', 's1', 'o1', 'user:alice')`)
			expect(await listed(member)).toEqual(['k1'])
			expect(await names(member)).toEqual(['b1'])
			await backend.exec(`delete from team_members where id = 'm1'`)
			expect(await listed(member)).toEqual([])
		})

		test("a relation above it under its source's condition reads four subqueries deep, a view of it five", async () => {
			await backend.exec(
				`insert into squad_leads (id, squad_id, org_id, principal_id) values ('l2', 's2', 'o1', 'user:alice'), ('l1', 's1', 'o1', 'user:bob')`,
			)
			expect(await listed(lead)).toEqual(['k2'])
			expect(await names(lead)).toEqual(['b2'])
			await backend.exec(`update squads set name = 'closed' where id = 's2'`)
			expect(await listed(lead)).toEqual([])
			expect(await names(lead)).toEqual([])
			await backend.exec(`delete from squad_leads`)
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

describe("the policy of a read path through the row's container", () => {
	test('the artifact keeps the path as its dotted text', () => {
		const policies = tablePolicies(tablesWith())
		expect(policies['tasks']?.readThrough).toEqual({ team: 'project_id.team_id' })
		expect(policies['projects']?.readThrough).toEqual({ team: 'team_id' })
	})

	test("starts at the row's nearest containment column, of a child or of a contained table", () => {
		expect(() => tablesWith({ tasks: 'org_id.team_id' })).toThrow(
			"tasks: readThrough.team: org_id is not tasks's nearest containment column (project_id); a path through a container starts at the row's own container",
		)
		expect(() => tablesWith({ cards: 'project_id.team_id' })).toThrow(
			"cards: readThrough.team: project_id is not cards's nearest containment column (board_id)",
		)
	})

	test("follows the container's own path for the dimension, by its column, one container deep", () => {
		expect(() => tablesWith({ projects: null })).toThrow(
			'tasks: readThrough.team: projects declares no readThrough.team through a column of its own, so tasks has no container path to follow',
		)
		expect(() => tablesWith({ tasks: 'project_id.org_id' })).toThrow('tasks: readThrough.team: projects reads team through team_id, not org_id')
		expect(() => tablesWith({ cards: 'board_id.team_id' })).toThrow(
			'cards: readThrough.team: boards declares no readThrough.team through a column of its own, so cards has no container path to follow',
		)
		expect(() => tablesWith({ tasks: 'project_id.team_id.id' })).toThrow(
			'tasks: readThrough.team names project_id.team_id.id, which is not a column of tasks',
		)
	})

	test('a reveal is not matched through it: its relation would read past the bound', () => {
		expect(() => tablesWith({ reveal: true })).toThrow(
			'tasks: reveals.member: tasks reads team through its container projects, so a reveal matched through it reads too deep; reveal from projects instead',
		)
	})
})
