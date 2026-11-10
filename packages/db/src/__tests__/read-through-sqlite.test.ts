// A secondary read path on SQLite: a table that names a node of a dimension outside its chain through a foreign key
// is read by a Within of that dimension, by its containers and by a relation at it, and so is a view of such a table,
// through its parent row. Every write still follows the table's containment only.

import type { TypedColumnList } from '@fabrika/db'
import { beforeEach, describe, expect, test } from 'bun:test'
import { CapabilityError, ConflictError, PolicyError, QueryRefusedError } from '../errors'
import { bindScopedDatabaseProvisionally, type DataAccess, dataAccessOf, type DataHandles, type DataSite } from '../framework'
import type { DataKind } from '../orm-types'
import { defineTables } from '../policy'
import type { RevealCheck } from '../registry'
import { openSqlite } from '../sqlite'
import { type BunSqliteStorage, bunSqliteStorage } from '../sqlite-bun'
import { scoped } from '../store'
import { tablePolicies } from '../tables'
import { TestAuthority } from './fixtures/authority'

const migration = `
create table orgs (id text not null primary key, name text not null);
create table projects (id text not null primary key, org_id text not null references orgs (id), name text not null, unique (id, org_id));
create table squads (id text not null primary key, org_id text not null references orgs (id), name text not null, unique (id, org_id));
create table squad_leads (
	id text not null primary key,
	squad_id text not null,
	org_id text not null,
	principal_id text not null,
	foreign key (squad_id, org_id) references squads (id, org_id)
);
create table teams (
	id text not null primary key,
	squad_id text not null,
	org_id text not null,
	name text not null,
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
create table tasks (
	id text not null primary key,
	project_id text not null,
	org_id text not null,
	team_id text,
	title text not null,
	version integer not null,
	foreign key (project_id, org_id) references projects (id, org_id),
	foreign key (team_id, org_id) references teams (id, org_id)
);
create table boards (
	id text not null primary key,
	org_id text not null references orgs (id),
	team_id text not null,
	name text not null,
	foreign key (team_id, org_id) references teams (id, org_id)
);
create view board_names as select b.id as board_id, b.name from boards b;
`

interface DB {
	orgs: { id: string; name: string }
	projects: { id: string; org_id: string; name: string }
	squads: { id: string; org_id: string; name: string }
	squad_leads: { id: string; squad_id: string; org_id: string; principal_id: string }
	teams: { id: string; squad_id: string; org_id: string; name: string }
	team_members: { id: string; team_id: string; squad_id: string; org_id: string; principal_id: string }
	tasks: { id: string; project_id: string; org_id: string; team_id: string | null; title: string; version: number }
	boards: { id: string; org_id: string; team_id: string; name: string }
	board_names: { board_id: string | null; name: string | null }
}

const teamKey = { columns: ['team_id', 'org_id'], table: 'teams', references: ['id', 'org_id'] } as const

type TaskColumn = keyof DB['tasks'] & string

function columnsWith(
	taskKeys: TypedColumnList<DB>['tasks']['foreignKeys'],
	taskNotNull: readonly TaskColumn[] = ['id', 'project_id', 'org_id', 'title', 'version'],
): TypedColumnList<DB, 'board_names'> {
	return {
		orgs: { columns: ['id', 'name'], foreignKeys: [], notNull: ['id', 'name'] },
		projects: {
			columns: ['id', 'org_id', 'name'],
			foreignKeys: [{ columns: ['org_id'], table: 'orgs', references: ['id'] }],
			notNull: ['id', 'org_id', 'name'],
		},
		squads: {
			columns: ['id', 'org_id', 'name'],
			foreignKeys: [{ columns: ['org_id'], table: 'orgs', references: ['id'] }],
			notNull: ['id', 'org_id', 'name'],
		},
		squad_leads: {
			columns: ['id', 'squad_id', 'org_id', 'principal_id'],
			foreignKeys: [{ columns: ['squad_id', 'org_id'], table: 'squads', references: ['id', 'org_id'] }],
			notNull: ['id', 'squad_id', 'org_id', 'principal_id'],
		},
		teams: {
			columns: ['id', 'squad_id', 'org_id', 'name'],
			foreignKeys: [{ columns: ['squad_id', 'org_id'], table: 'squads', references: ['id', 'org_id'] }],
			notNull: ['id', 'squad_id', 'org_id', 'name'],
		},
		team_members: {
			columns: ['id', 'team_id', 'squad_id', 'org_id', 'principal_id'],
			foreignKeys: [{ columns: ['team_id', 'squad_id', 'org_id'], table: 'teams', references: ['id', 'squad_id', 'org_id'] }],
			notNull: ['id', 'team_id', 'squad_id', 'org_id', 'principal_id'],
		},
		tasks: { columns: ['id', 'project_id', 'org_id', 'team_id', 'title', 'version'], foreignKeys: taskKeys, notNull: taskNotNull },
		boards: {
			columns: ['id', 'org_id', 'team_id', 'name'],
			foreignKeys: [{ columns: ['org_id'], table: 'orgs', references: ['id'] }, teamKey],
			notNull: ['id', 'org_id', 'team_id', 'name'],
		},
		board_names: { columns: ['board_id', 'name'], foreignKeys: [], view: true },
	}
}

const columns = columnsWith([{ columns: ['project_id', 'org_id'], table: 'projects', references: ['id', 'org_id'] }, teamKey])

const vocabulary = {
	app: 'read-through',
	dimensions: { org: {}, project: { in: 'org' }, squad: { in: 'org' }, team: { in: 'squad' }, guild: { in: 'org' }, board: { in: 'org' } },
	actions: {
		'orgs.read': 'Read organizations',
		'projects.read': 'Read projects',
		'teams.read': 'Read teams',
		'tasks.read': 'Read tasks',
		'tasks.write': 'Write tasks',
	},
	relations: { member: { dimension: 'team' }, lead: { dimension: 'squad' } },
	roles: {},
} as const

const taskPolicy = {
	scope: { child: 'projects' },
	actions: { read: 'tasks.read', insert: 'tasks.write', update: 'tasks.write' },
	insert: ['team_id', 'title'],
	update: ['title'],
	version: 'version',
	readThrough: { team: 'team_id' },
	reveals: {
		member: { to: 'project', actions: ['projects.read', 'tasks.read'], when: { title: { notEq: 'one' } }, assign: {} },
		lead: { to: 'project', actions: ['tasks.read'], when: { title: { notEq: 'two' } }, assign: {} },
	},
} as const

const others = {
	orgs: { scope: { dimension: 'org' }, actions: { read: 'orgs.read' } },
	projects: { scope: { dimension: 'project' }, actions: { read: 'projects.read' } },
	squads: { scope: { dimension: 'squad' }, actions: { read: 'teams.read' } },
	squad_leads: { scope: { child: 'squads' }, actions: { read: 'teams.read' }, confers: { lead: { principal: 'principal_id' } } },
	teams: { scope: { dimension: 'team' }, actions: { read: 'teams.read' } },
	team_members: { scope: { child: 'teams' }, actions: { read: 'teams.read' }, confers: { member: { principal: 'principal_id' } } },
	boards: { scope: { dimension: 'board' }, actions: { read: 'tasks.read' }, readThrough: { team: 'team_id' } },
	board_names: { scope: { child: 'boards', key: 'board_id' }, actions: { read: 'tasks.read' } },
} as const

const tables = defineTables(vocabulary, columns)({ ...others, tasks: taskPolicy })

const alice = new TestAuthority('user:alice')
let storage: BunSqliteStorage
let data: DataAccess
let reveals: RevealCheck

beforeEach(() => {
	storage = bunSqliteStorage()
	storage.sql.exec(migration)
	storage.sql.exec(`
		insert into orgs (id, name) values ('o1', 'one'), ('o2', 'two');
		insert into projects (id, org_id, name) values ('p1', 'o1', 'one'), ('p2', 'o1', 'two'), ('p3', 'o2', 'three');
		insert into squads (id, org_id, name) values ('s1', 'o1', 'one'), ('s2', 'o1', 'two'), ('s3', 'o2', 'three');
		insert into teams (id, squad_id, org_id, name) values ('tm1', 's1', 'o1', 'one'), ('tm2', 's2', 'o1', 'two'), ('tm3', 's3', 'o2', 'three');
		insert into tasks (id, project_id, org_id, team_id, title, version) values
			('k1', 'p1', 'o1', 'tm1', 'one', 1),
			('k2', 'p2', 'o1', 'tm2', 'two', 1),
			('k3', 'p3', 'o2', 'tm3', 'three', 1),
			('k4', 'p2', 'o1', null, 'four', 1),
			('k5', 'p1', 'o1', null, 'five', 1);
		insert into boards (id, org_id, team_id, name) values ('b1', 'o1', 'tm1', 'one'), ('b2', 'o1', 'tm2', 'two');
	`)
	const layer = scoped(tables)
	reveals = bindScopedDatabaseProvisionally(layer, { database: openSqlite(storage), capabilities: alice }).reveals
	data = dataAccessOf(layer)
})

function join(id: string, team: string, principal: string): void {
	storage.sql.exec(
		'insert into team_members (id, team_id, squad_id, org_id, principal_id) select ?, id, squad_id, org_id, ? from teams where id = ?',
		id,
		principal,
		team,
	)
}

function lead(id: string, squad: string, principal: string): void {
	storage.sql.exec(
		'insert into squad_leads (id, squad_id, org_id, principal_id) select ?, id, org_id, ? from squads where id = ?',
		id,
		principal,
		squad,
	)
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

async function call(handle: unknown, path: string, ...args: unknown[]): Promise<unknown> {
	const parts = path.split('.')
	const name = parts.pop() ?? ''
	const target = parts.reduce<unknown>((node, part) => (typeof node === 'object' && node !== null ? Reflect.get(node, part) : undefined), handle)
	const method: unknown = typeof target === 'object' && target !== null ? Reflect.get(target, name) : undefined
	if (typeof method !== 'function') throw new TypeError(`${path} is not a method of the handle`)
	return Reflect.apply(method, target, args)
}

function ids(page: unknown, key = 'id'): string[] {
	const items: unknown = typeof page === 'object' && page !== null ? Reflect.get(page, 'items') : undefined
	return Array.isArray(items) ? items.map((row: unknown) => String(typeof row === 'object' && row !== null ? Reflect.get(row, key) : '')).sort() : []
}

const listed = (within: unknown, table: string) => invoke('query', (db) => call(db.within(within), `${table}.list`)).then(ids)

describe('a Within of a dimension a table reads through', () => {
	test("lists the rows that name one of the Within's nodes", async () => {
		expect(await listed(alice.within('team', 'tasks.read', ['tm1']), 'tasks')).toEqual(['k1'])
	})

	test('a Within of a dimension above that node lists the rows whose node lies under one of its nodes', async () => {
		expect(await listed(alice.within('squad', 'tasks.read', ['s2']), 'tasks')).toEqual(['k2'])
	})

	test("lists the rows whose node lies in one of the Within's containers, and none that names no node", async () => {
		expect(await listed(alice.within('team', 'tasks.read', [], [{ dimension: 'org', values: ['o1'] }]), 'tasks')).toEqual(['k1', 'k2'])
	})

	test('lists the rows at the nodes a relation holds the principal at, and none once the row is gone', async () => {
		join('m1', 'tm1', 'user:alice')
		join('m3', 'tm3', 'user:bob')
		const viaMember = alice.within('team', 'tasks.read', [], [], [], ['member'])
		expect(await listed(viaMember, 'tasks')).toEqual(['k1'])
		storage.sql.exec("delete from team_members where id = 'm1'")
		expect(await listed(viaMember, 'tasks')).toEqual([])
	})

	test('lists the rows whose node lies under a node a relation holds the principal at', async () => {
		lead('l2', 's2', 'user:alice')
		lead('l3', 's3', 'user:bob')
		expect(await listed(alice.within('team', 'tasks.read', [], [], [], ['lead']), 'tasks')).toEqual(['k2'])
	})

	test('lists the rows of a view whose parent row it reads through, by values and by a relation', async () => {
		const boards = (within: unknown) => invoke('query', (db) => call(db.within(within), 'board_names.list')).then((page) => ids(page, 'board_id'))
		expect(await boards(alice.within('team', 'tasks.read', ['tm2']))).toEqual(['b2'])
		expect(await boards(alice.within('squad', 'tasks.read', ['s1']))).toEqual(['b1'])
		join('m1', 'tm1', 'user:alice')
		expect(await boards(alice.within('team', 'tasks.read', [], [], [], ['member']))).toEqual(['b1'])
	})

	test('reaches no table that neither lies in the dimension nor reads through it', async () => {
		await expect(listed(alice.within('team', 'projects.read', ['tm1']), 'projects')).rejects.toThrow(TypeError)
	})
})

describe('a reveal matched through the read path', () => {
	test('lists every row under the ancestor node of a row the relation reaches through it', async () => {
		join('m1', 'tm2', 'user:alice')
		expect(await listed(alice.within('project', 'tasks.read', [], [], [], ['member']), 'tasks')).toEqual(['k2', 'k4'])
	})

	test('reveals the ancestor node of a row whose node lies under one the relation holds', async () => {
		lead('l1', 's1', 'user:alice')
		expect(await listed(alice.within('project', 'tasks.read', [], [], [], ['lead']), 'tasks')).toEqual(['k1', 'k5'])
	})

	test('mints no Ref: the reveal check answers false, and a Ref held through it is unenforceable', async () => {
		join('m1', 'tm2', 'user:alice')
		expect(await reveals('member', 'project', 'p2', 'user:alice', 'projects.read')).toBe(false)
		const read = () => invoke('query', (db) => call(db.target(alice.ref('project', 'projects.read', 'p2', { org: 'o1' }, ['member']), 'on'), 'get'))
		await expect(read()).rejects.toThrow(CapabilityError)
		await expect(read()).rejects.toThrow('reveals none of its nodes')
	})
})

describe("an insert picks the node a reveal holds at, under the reveal's assign", () => {
	const insert = (team: string) =>
		invoke(
			'mutation',
			(db) => call(db.target(alice.ref('project', 'tasks.write', 'p1', { org: 'o1' }), 'on'), 'tasks.insert', { team_id: team, title: 'new' }),
		)
	const count = () => storage.sql.exec("select count(*) as n from tasks where title = 'new'").toArray()

	test('inserts a row naming a node where its writer holds no relation', async () => {
		join('m2', 'tm2', 'user:bob')
		await insert('tm2')
		expect(count()).toEqual([{ n: 1 }])
	})

	test('refuses a row naming a node where its writer holds the relation, or holds it above that node', async () => {
		join('m1', 'tm1', 'user:alice')
		await expect(insert('tm1')).rejects.toThrow(ConflictError)
		await expect(insert('tm1')).rejects.toThrow('assign.self')
		lead('l2', 's2', 'user:alice')
		await expect(insert('tm2')).rejects.toThrow(ConflictError)
		expect(count()).toEqual([{ n: 0 }])
	})

	test('refuses an unscoped write, which would delegate past the bound', async () => {
		const transaction = data.invocation(false)
		const site: DataSite = { kind: 'mutation', unscoped: { tasks: 'write' }, principal: 'user:alice', check() {}, session: () => transaction.session() }
		const insert = () => call(data.handles(site).unscoped, 'tasks.insert', { project_id: 'p1', org_id: 'o1', team_id: 'tm1', title: 'new' })
		await expect(insert()).rejects.toThrow('never unscoped')
		await transaction.rollback()
		expect(count()).toEqual([{ n: 0 }])
	})
})

describe('the artifact', () => {
	test('carries the read path, and no field for a table without one', () => {
		const artifact = tablePolicies(tables)
		expect(artifact['tasks']?.readThrough).toEqual({ team: 'team_id' })
		expect(artifact['tasks']?.reveals?.['member']?.assign).toEqual({ self: false })
		expect(artifact['projects']).not.toHaveProperty('readThrough')
	})
})

describe('the policy bounds a read path', () => {
	const policy = (tasks: Record<string, unknown>, taskColumns: TypedColumnList<DB, 'board_names'> = columns) => () =>
		defineTables(vocabulary, taskColumns)({ ...others, tasks: { ...taskPolicy, ...tasks } })

	test('a dimension of the chain, outside the vocabulary or owned by no table is refused', () => {
		expect(policy({ readThrough: { org: 'team_id' }, reveals: undefined })).toThrow('already lies in org')
		expect(policy({ readThrough: { crew: 'team_id' }, reveals: undefined })).toThrow('not a dimension of the vocabulary')
		expect(policy({ readThrough: { guild: 'team_id' }, reveals: undefined })).toThrow('no table owns guild')
	})

	test('a column outside the table, one an update writes or the containment column is refused', () => {
		expect(policy({ readThrough: { team: 'crew_id' } })).toThrow('not a column of tasks')
		expect(policy({ update: ['title', 'team_id'] })).toThrow('no update writes it')
		expect(policy({ readThrough: { team: 'org_id' } })).toThrow(PolicyError)
	})

	test('a reveal through the path states its insert bound, and reveals the nearest container only', () => {
		expect(policy({ reveals: { member: { to: 'project', actions: ['tasks.read'] } } })).toThrow('state assign')
		expect(policy({ reveals: { member: { to: 'project', actions: ['tasks.read'], assign: { self: true } } } })).not.toThrow()
		expect(policy({ reveals: { member: { to: 'project', actions: ['tasks.read'], assign: { self: false } } } })).toThrow('assign.self takes true')
		expect(policy({ reveals: { member: { to: 'org', actions: ['tasks.read'], assign: {} } } })).toThrow('nearest container')
	})

	test('a foreign key with a column beyond the shared ancestors is refused: a null in it skips the whole key', () => {
		const wide = columnsWith([{ columns: ['project_id', 'org_id'], table: 'projects', references: ['id', 'org_id'] }, {
			columns: ['team_id', 'org_id', 'title'],
			table: 'teams',
			references: ['id', 'org_id', 'name'],
		}])
		expect(policy({}, wide)).toThrow('exactly these columns')
	})

	test('a foreign key that leaves out an ancestor the two chains share is refused', () => {
		const loose = columnsWith([{ columns: ['project_id', 'org_id'], table: 'projects', references: ['id', 'org_id'] }, {
			columns: ['team_id'],
			table: 'teams',
			references: ['id'],
		}])
		expect(policy({}, loose)).toThrow('must be one foreign key')
	})

	test('an ancestor column of the foreign key that may be null is refused: a null skips the whole key', () => {
		const keys = [{ columns: ['project_id', 'org_id'], table: 'projects', references: ['id', 'org_id'] } as const, teamKey]
		expect(policy({}, columnsWith(keys, ['id', 'project_id', 'title', 'version']))).toThrow('org_id of tasks may be null')
	})
})
