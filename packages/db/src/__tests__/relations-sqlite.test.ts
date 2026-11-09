// Relation grants and action conditions on SQLite: a capability held through a relation reaches the rows a source row
// names its principal at, while that row is unexpired and its own condition holds; an action's `when` narrows every
// grant; inserting a source row is delegation, bounded by the table's `assign`.

import type { TypedColumnList } from '@fabrika/db'
import { beforeEach, describe, expect, test } from 'bun:test'
import type { ColumnType } from 'kysely'
import { CapabilityError, ConflictError, PolicyError, QueryRefusedError } from '../errors'
import { bindScopedDatabaseProvisionally, type DataAccess, dataAccessOf, type DataHandles, type DataSite } from '../framework'
import type { DataKind } from '../orm-types'
import { defineTables } from '../policy'
import type { RelationCheck } from '../registry'
import { openSqlite } from '../sqlite'
import { type BunSqliteStorage, bunSqliteStorage } from '../sqlite-bun'
import { scoped } from '../store'
import { TestAuthority } from './fixtures/authority'

const migration = `
create table projects (
	id text not null primary key,
	tenant text not null,
	name text not null,
	archived boolean not null default 0,
	version integer not null
);
create table project_members (
	id text not null primary key,
	project_id text not null references projects (id) on delete cascade,
	principal_id text not null,
	role text not null,
	expires_at timestamp,
	version integer not null default 1,
	due timestamp,
	attempts integer not null default 0
);
create table bookmarks (
	id text not null primary key,
	project_id text references projects (id),
	slug text not null unique,
	archived boolean not null default 0,
	version integer not null
);
`

interface DB {
	projects: { id: string; tenant: string; name: string; archived: ColumnType<boolean, boolean | undefined, boolean>; version: number }
	project_members: {
		id: string
		project_id: string
		principal_id: string
		role: string
		expires_at: ColumnType<Date | null, Date | string | null, Date | string | null>
		version: ColumnType<number, number | undefined, number>
		due: ColumnType<Date | null, Date | string | null, Date | string | null>
		attempts: ColumnType<number, number | undefined, number>
	}
	bookmarks: { id: string; project_id: string | null; slug: string; archived: ColumnType<boolean, boolean | undefined, boolean>; version: number }
}

const columns: TypedColumnList<DB> = {
	projects: {
		columns: ['id', 'tenant', 'name', 'archived', 'version'],
		foreignKeys: [],
		booleans: ['archived'],
	},
	project_members: {
		columns: ['id', 'project_id', 'principal_id', 'role', 'expires_at', 'version', 'due', 'attempts'],
		foreignKeys: [{ columns: ['project_id'], table: 'projects', references: ['id'] }],
		timestamps: ['expires_at', 'due'],
	},
	bookmarks: {
		columns: ['id', 'project_id', 'slug', 'archived', 'version'],
		foreignKeys: [{ columns: ['project_id'], table: 'projects', references: ['id'] }],
		booleans: ['archived'],
	},
}

const vocabulary = {
	app: 'projects',
	dimensions: { project: {} },
	actions: {
		'projects.read': 'Read projects',
		'projects.write': 'Write projects',
		'members.assign': 'Add a project member',
		'projects.audit': 'Audit the open projects',
	},
	relations: { member: { dimension: 'project' } },
	roles: {},
} as const

const tables = defineTables(vocabulary, columns)({
	projects: {
		scope: { dimension: 'project' },
		actions: { read: ['projects.read', 'projects.audit'], insert: 'projects.write', update: 'projects.write', delete: 'projects.write' },
		insert: ['name', 'archived'],
		update: ['name', 'archived'],
		version: 'version',
		when: { 'projects.write': { archived: { eq: false } }, 'projects.audit': { archived: { eq: false } } },
	},
	project_members: {
		scope: { child: 'projects' },
		actions: { read: 'projects.read', insert: 'members.assign', delete: 'members.assign' },
		insert: ['principal_id', 'role', 'expires_at'],
		when: { 'members.assign': { role: { in: ['editor', 'viewer'] } } },
		confers: {
			member: { principal: 'principal_id', expires: 'expires_at', when: { role: { in: ['editor', 'viewer'] } }, assign: { maxDays: 30 } },
		},
	},
	bookmarks: {
		scope: { app: 'saved links' },
		actions: { read: ['projects.read', 'projects.audit'], insert: 'projects.write', update: 'projects.write' },
		insert: ['slug', 'archived'],
		update: ['archived'],
		version: 'version',
		when: { 'projects.write': { archived: { eq: false } }, 'projects.audit': { archived: { eq: false } } },
	},
})

const alice = new TestAuthority('user:alice')
const DAY = 86_400_000
let storage: BunSqliteStorage
let data: DataAccess
let relates: RelationCheck

beforeEach(() => {
	storage = bunSqliteStorage()
	storage.sql.exec(migration)
	storage.sql.exec(`
		insert into projects (id, tenant, name, archived, version) values
			('p1', 't1', 'shared', 0, 1), ('p2', 't1', 'private', 0, 1), ('p3', 't2', 'other tenant', 0, 1), ('p4', 't1', 'archived', 1, 1);
		insert into bookmarks (id, slug, archived, version) values ('b1', 'live', 0, 1), ('b2', 'old', 1, 1);
	`)
	const layer = scoped(tables)
	relates = bindScopedDatabaseProvisionally(layer, { database: openSqlite(storage), capabilities: alice }).relates
	data = dataAccessOf(layer)
})

function member(id: string, project: string, principal: string, role: string, expires: Date | null): void {
	storage.sql.exec(
		'insert into project_members (id, project_id, principal_id, role, expires_at) values (?, ?, ?, ?, ?)',
		id,
		project,
		principal,
		role,
		expires === null ? null : expires.toISOString(),
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

function ids(page: unknown): string[] {
	const items: unknown = typeof page === 'object' && page !== null ? Reflect.get(page, 'items') : undefined
	return Array.isArray(items) ? items.map((row: unknown) => String(typeof row === 'object' && row !== null ? Reflect.get(row, 'id') : '')).sort() : []
}

/** `projects.read` on project values `values`, plus whatever `member` rows name alice. */
const listed = (values: readonly string[] | 'all', relations: readonly string[], action = 'projects.read') =>
	invoke('query', (db) => call(db.within(alice.within('project', action, values, [], [], relations)), 'projects.list')).then(ids)

const viaMember = (action: string, id: string) => alice.ref('project', action, id, {}, ['member'])

describe('a Within held through a relation', () => {
	test('reaches exactly the nodes an active source row names the principal at', async () => {
		member('m1', 'p1', 'user:alice', 'editor', null)
		member('m2', 'p2', 'user:bob', 'editor', null)
		expect(await listed([], ['member'])).toEqual(['p1'])
		expect(await invoke('query', (db) => call(db.within(alice.within('project', 'projects.read', [], [], [], ['member'])), 'projects.count'))).toBe(1)
	})

	test('composes with the IAM values as a union, never an intersection', async () => {
		member('m1', 'p1', 'user:alice', 'editor', null)
		expect(await listed(['p2'], ['member'])).toEqual(['p1', 'p2'])
		expect(await listed(['p2'], [])).toEqual(['p2'])
	})

	test("another principal's row confers nothing, and a row at another tenant's node confers that node only", async () => {
		member('m1', 'p3', 'user:alice', 'viewer', null)
		member('m2', 'p1', 'user:bob', 'editor', null)
		expect(await listed([], ['member'])).toEqual(['p3'])
		expect(await listed(['p2'], ['member'])).toEqual(['p2', 'p3'])
	})

	test('an expired row, a row outside the relation condition and a deleted row confer nothing', async () => {
		member('m1', 'p1', 'user:alice', 'editor', new Date(Date.now() - 1000))
		member('m2', 'p2', 'user:alice', 'guest', null)
		member('m4', 'p4', 'user:alice', 'viewer', new Date(Date.now() + DAY))
		expect(await listed([], ['member'])).toEqual(['p4'])
		storage.sql.exec("delete from project_members where id = 'm4'")
		expect(await listed([], ['member'])).toEqual([])
	})

	test('a Within with no values and no relations reaches nothing', async () => {
		member('m1', 'p1', 'user:alice', 'editor', null)
		expect(await listed([], [])).toEqual([])
	})

	test('a relation the layer does not confer is unenforceable, never ignored', async () => {
		await expect(listed([], ['owner'])).rejects.toThrow(CapabilityError)
	})
})

describe('a Ref held through a relation', () => {
	test('reads its node while the row confers, and 404s once it is revoked', async () => {
		member('m1', 'p1', 'user:alice', 'editor', null)
		const read = () => invoke('query', (db) => call(db.target(viaMember('projects.read', 'p1'), 'on'), 'get'))
		expect(await read()).toMatchObject({ id: 'p1' })
		storage.sql.exec("delete from project_members where id = 'm1'")
		await expect(read()).rejects.toThrow('not found')
	})

	test('a Ref of a node no row names is refused, though its chain is right', async () => {
		member('m1', 'p1', 'user:bob', 'editor', null)
		await expect(invoke('query', (db) => call(db.target(viaMember('projects.read', 'p1'), 'on'), 'get'))).rejects.toThrow('not found')
	})

	test('an update through the relation writes only while the row confers', async () => {
		member('m1', 'p1', 'user:alice', 'editor', new Date(Date.now() - 1000))
		const update = () =>
			invoke('mutation', (db) => call(db.target(viaMember('projects.write', 'p1'), 'on'), 'update', { name: 'renamed' }, { expectVersion: 1 }))
		await expect(update()).rejects.toThrow('not found')
		expect(storage.sql.exec("select name from projects where id = 'p1'").toArray()).toEqual([{ name: 'shared' }])
	})
})

describe('relates: the existence check the framework runs before minting a relation Ref', () => {
	test('answers an active row only', async () => {
		member('m1', 'p1', 'user:alice', 'editor', null)
		member('m2', 'p2', 'user:alice', 'editor', new Date(Date.now() - 1000))
		member('m3', 'p4', 'user:alice', 'guest', null)
		expect(await relates('member', 'p1', 'user:alice')).toBe(true)
		expect(await relates('member', 'p1', 'user:bob')).toBe(false)
		expect(await relates('member', 'p2', 'user:alice')).toBe(false)
		expect(await relates('member', 'p4', 'user:alice')).toBe(false)
		expect(await relates('member', 'p3', 'user:alice')).toBe(false)
		await expect(relates('owner', 'p1', 'user:alice')).rejects.toThrow(CapabilityError)
	})
})

describe("an action's when narrows every grant", () => {
	const rename = (capability: unknown) =>
		invoke('mutation', (db) => call(db.target(capability, 'on'), 'update', { name: 'renamed' }, { expectVersion: 1 }))
	const name = (id: string) => storage.sql.exec('select name from projects where id = ?', id).toArray()

	test("a global grant lists no row its action's condition excludes; another read action's grant does", async () => {
		expect(await listed('all', [], 'projects.audit')).toEqual(['p1', 'p2', 'p3'])
		expect(await listed('all', [])).toEqual(['p1', 'p2', 'p3', 'p4'])
		member('m4', 'p4', 'user:alice', 'editor', null)
		expect(await listed([], ['member'], 'projects.audit')).toEqual([])
	})

	test('an IAM Ref and a relation Ref are narrowed alike; the read action is not', async () => {
		member('m4', 'p4', 'user:alice', 'editor', null)
		await expect(rename(alice.ref('project', 'projects.write', 'p4'))).rejects.toThrow('not found')
		await expect(rename(viaMember('projects.write', 'p4'))).rejects.toThrow('not found')
		expect(name('p4')).toEqual([{ name: 'archived' }])
		expect(await listed([], ['member'])).toEqual(['p4'])
	})

	test('an insert outside the condition is a conflict, and writes nothing', async () => {
		const assigning = alice.ref('project', 'members.assign', 'p1')
		const insert = () =>
			invoke(
				'mutation',
				(db) =>
					call(db.target(assigning, 'on'), 'project_members.insert', { principal_id: 'user:bob', role: 'owner', expires_at: new Date(Date.now() + DAY) }),
			)
		await expect(insert()).rejects.toThrow('outside what members.assign inserts')
		expect(storage.sql.exec('select count(*) as n from project_members').toArray()).toEqual([{ n: 0 }])
	})

	test('a child row addressed by its key is narrowed too: a remove outside the condition finds nothing, one inside removes it', async () => {
		member('m1', 'p1', 'user:bob', 'owner', null)
		member('m2', 'p1', 'user:carol', 'editor', null)
		const remove = (id: string) =>
			invoke('mutation', (db) => call(db.target(alice.ref('project', 'members.assign', 'p1'), 'on'), 'project_members.remove', id))
		await expect(remove('m1')).rejects.toThrow('not found')
		await remove('m2')
		expect(storage.sql.exec('select id from project_members').toArray()).toEqual([{ id: 'm1' }])
	})
})

describe("an application table's rows are narrowed by the action's when on every path", () => {
	const archived = () => storage.sql.exec('select archived, version from bookmarks where id = ?', 'b2').toArray()

	test('a read by key, and a locked read, of an excluded row is not found; another read action reads it', async () => {
		await expect(invoke('query', (db) => call(db.app(alice.app('projects.audit')), 'bookmarks.get', 'b2'))).rejects.toThrow('not found')
		await expect(invoke('mutation', (db) => call(db.app(alice.app('projects.write')), 'bookmarks.getForUpdate', 'b2'))).rejects.toThrow(
			'not found',
		)
		expect(await invoke('query', (db) => call(db.app(alice.app('projects.read')), 'bookmarks.get', 'b2'))).toMatchObject({ id: 'b2' })
	})

	test('an update of an excluded row writes nothing', async () => {
		await expect(
			invoke('mutation', (db) => call(db.app(alice.app('projects.write')), 'bookmarks.update', 'b2', { archived: false }, { expectVersion: 1 })),
		).rejects
			.toThrow('not found')
		expect(archived()).toEqual([{ archived: 1, version: 1 }])
	})

	test("an upsert does not update a conflicting row outside the action's condition", async () => {
		const upsert = () =>
			invoke(
				'mutation',
				(db) =>
					call(db.app(alice.app('projects.write')), 'bookmarks.insert', { slug: 'old', archived: false }, {
						onConflict: { columns: ['slug'], do: 'update' },
					}),
			)
		await expect(upsert()).rejects.toThrow('does not reach')
		expect(archived()).toEqual([{ archived: 1, version: 1 }])
	})
})

describe("a condition's path through the parent column", () => {
	test("narrows a child's rows by its parent's column, through the guard", async () => {
		const hopping = defineTables(vocabulary, columns)({
			projects: { scope: { dimension: 'project' }, actions: { read: 'projects.read' }, version: 'version' },
			project_members: {
				scope: { child: 'projects' },
				actions: { read: 'projects.read' },
				when: { 'projects.read': { 'project_id.archived': { eq: false } } },
				confers: { member: { principal: 'principal_id' } },
			},
			bookmarks: { scope: { app: 'saved links' }, actions: { read: 'projects.read' } },
		})
		const layer = scoped(hopping)
		bindScopedDatabaseProvisionally(layer, { database: openSqlite(storage), capabilities: alice })
		const access = dataAccessOf(layer)
		member('m1', 'p1', 'user:bob', 'editor', null)
		member('m4', 'p4', 'user:bob', 'editor', null)
		const transaction = access.invocation(true)
		const site: DataSite = { kind: 'query', unscoped: {}, principal: 'user:alice', check() {}, session: () => transaction.session() }
		const page = await call(access.handles(site).within(alice.within('project', 'projects.read', 'all')), 'project_members.list')
		await transaction.commit()
		expect(ids(page)).toEqual(['m1'])
	})
})

describe('inserting a source row is delegation', () => {
	const assigning = (id = 'p1') => alice.ref('project', 'members.assign', id)
	const assign = (values: Record<string, unknown>) =>
		invoke('mutation', (db) => call(db.target(assigning(), 'on'), 'project_members.insert', { role: 'editor', ...values }))

	test('stamps the node from the Ref and keeps the expiry within maxDays', async () => {
		await assign({ principal_id: 'user:bob', expires_at: new Date(Date.now() + 10 * DAY) })
		expect(storage.sql.exec('select project_id, principal_id from project_members').toArray()).toEqual([{ project_id: 'p1', principal_id: 'user:bob' }])
	})

	test('refuses an expiry past maxDays, and an open one', async () => {
		await expect(assign({ principal_id: 'user:bob', expires_at: new Date(Date.now() + 31 * DAY) })).rejects.toThrow(ConflictError)
		await expect(assign({ principal_id: 'user:bob', expires_at: null })).rejects.toThrow('at most 30 days ahead')
		expect(storage.sql.exec('select count(*) as n from project_members').toArray()).toEqual([{ n: 0 }])
	})

	test('refuses a row naming its writer without assign.self', async () => {
		await expect(assign({ principal_id: 'user:alice', expires_at: new Date(Date.now() + DAY) })).rejects.toThrow('assign.self')
	})

	test('a source row is never moved to another node', async () => {
		member('m1', 'p1', 'user:bob', 'editor', null)
		const source = alice.ref('project', 'members.assign', 'p1')
		const target = alice.ref('project', 'members.assign', 'p2')
		await expect(invoke('mutation', (db) => call(db.target(source, 'on'), 'project_members.move', 'm1', target))).rejects.toThrow()
		expect(storage.sql.exec("select project_id from project_members where id = 'm1'").toArray()).toEqual([{ project_id: 'p1' }])
	})
})

describe('the policy bounds what a source table may do', () => {
	const policy = (members: Record<string, unknown>, bookmarks: Record<string, unknown> = {}) => () =>
		defineTables(vocabulary, columns)({
			projects: { scope: { dimension: 'project' }, actions: { read: 'projects.read' }, version: 'version' },
			project_members: { scope: { child: 'projects' }, actions: { read: 'projects.read', insert: 'members.assign' }, ...members },
			bookmarks: { scope: { app: 'saved links' }, actions: { read: 'projects.read' }, ...bookmarks },
		})

	test("a condition's path follows a row's parent column, and no foreign key out of its containment", () => {
		const source = { confers: { member: { principal: 'principal_id', assign: {} } } }
		expect(policy({ ...source, when: { 'projects.read': { 'project_id.archived': { eq: false } } } })).not.toThrow()
		// A hop reads its target unscoped: an application row pointing into a project would read that project's columns.
		expect(policy(source, { when: { 'projects.read': { 'project_id.archived': { eq: false } } } })).toThrow("outside the row's own containment")
	})

	test('an update of a column that decides what a row confers is refused', () => {
		expect(policy({
			actions: { read: 'projects.read', update: 'projects.write' },
			update: ['principal_id'],
			confers: { member: { principal: 'principal_id' } },
		})).toThrow('replace the row instead')
		expect(policy({
			actions: { read: 'projects.read', update: 'projects.write' },
			update: ['role'],
			confers: { member: { principal: 'principal_id', when: { role: { eq: 'editor' } } } },
		})).toThrow('replace the row instead')
	})

	test('a queue table, and a condition on the version column, are refused: the layer rewrites both', () => {
		expect(policy({
			actions: { read: 'projects.read', insert: 'members.assign', update: 'members.assign' },
			insert: ['principal_id', 'expires_at'],
			version: 'version',
			queue: { attempts: 'attempts', due: 'due' },
			confers: { member: { principal: 'principal_id', expires: 'expires_at', assign: { maxDays: 30 } } },
		})).toThrow('a queue table confers no relation')
		expect(policy({
			version: 'version',
			confers: { member: { principal: 'principal_id', when: { version: { eq: 1 } } } },
		})).toThrow('the version column')
	})

	test('an insertable source states its assign bound', () => {
		expect(policy({ insert: ['principal_id'], confers: { member: { principal: 'principal_id' } } })).toThrow('state assign')
	})

	test('a node off the column the Ref stamps, and an unknown relation, are refused', () => {
		expect(policy({ confers: { member: { principal: 'principal_id', node: 'role' } } })).toThrow(PolicyError)
		expect(policy({ confers: { owner: { principal: 'principal_id' } } })).toThrow('not a relation of the vocabulary')
	})

	test('a relation with no source is refused', () => {
		expect(policy({})).toThrow('has no source')
	})
})

describe('a relation stays where its row was written', () => {
	interface Nested {
		orgs: { id: string; name: string }
		projects: { id: string; org_id: string; version: number }
		project_members: { id: string; project_id: string; org_id: string; principal_id: string; expires_at: Date | null }
		vaults: { id: string; flag: boolean }
	}
	const nested: TypedColumnList<Nested> = {
		orgs: { columns: ['id', 'name'], foreignKeys: [] },
		projects: { columns: ['id', 'org_id', 'version'], foreignKeys: [{ columns: ['org_id'], table: 'orgs', references: ['id'] }] },
		project_members: {
			columns: ['id', 'project_id', 'org_id', 'principal_id', 'expires_at'],
			foreignKeys: [{ columns: ['project_id', 'org_id'], table: 'projects', references: ['id', 'org_id'] }],
			timestamps: ['expires_at'],
		},
		vaults: { columns: ['id', 'flag'], foreignKeys: [], booleans: ['flag'] },
	}
	const words = {
		app: 'nested',
		dimensions: { org: {}, project: { in: 'org' }, vault: {} },
		actions: { 'projects.read': 'Read projects', 'members.assign': 'Assign' },
		relations: { colleague: { dimension: 'org' } },
		roles: {},
	} as const
	const base = {
		orgs: { scope: { dimension: 'org' }, actions: { read: 'projects.read' } },
		projects: { scope: { dimension: 'project' }, actions: { read: 'projects.read' }, version: 'version' },
		vaults: { scope: { dimension: 'vault' }, actions: { read: 'projects.read' } },
	} as const

	test("a node above the row's own container is refused: a move of the container would rewrite it", () => {
		expect(() =>
			defineTables(words, nested)({
				...base,
				project_members: {
					scope: { child: 'projects' },
					actions: { read: 'projects.read' },
					confers: { colleague: { principal: 'principal_id' } },
				},
			})
		).toThrow('a move of an ancestor rewrites org_id')
	})

	test("a path along a container column must reach the container's own table", () => {
		const columns: TypedColumnList<Omit<Nested, 'orgs'>> = {
			projects: { columns: ['id', 'org_id', 'version'], foreignKeys: [{ columns: ['org_id'], table: 'vaults', references: ['id'] }] },
			project_members: { columns: ['id', 'project_id', 'org_id', 'principal_id', 'expires_at'], foreignKeys: [], timestamps: ['expires_at'] },
			vaults: { columns: ['id', 'flag'], foreignKeys: [], booleans: ['flag'] },
		}
		const unowned = { ...words, relations: {} }
		expect(() =>
			defineTables(unowned, columns)({
				projects: {
					scope: { dimension: 'project' },
					actions: { read: 'projects.read' },
					version: 'version',
					when: { 'projects.read': { 'org_id.flag': { eq: true } } },
				},
				vaults: base.vaults,
				project_members: { scope: { child: 'projects' }, actions: { read: 'projects.read' } },
			})
		).toThrow("outside the row's own containment")
	})
})
