// Access views (spike): a relation whose reach a view's SQL decides. The layer binds the caller's principal,
// or the nodes it holds the relation inside, and the guard admits the subquery by the view and its row column only.
// Each world is one shape no structured declaration expresses: a row read and written by the principal a view names,
// a published row read across tenants, a grant that is active by the clock, and a row reached through two containers.
// Every case runs on SQLite and, with FABRIKA_TEST_POSTGRES_URL, on Postgres.

import type { TypedColumnList } from '@fabrika/db'
import { openPostgres } from '@fabrika/db/postgres'
import { SQL } from 'bun'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import type { Database } from '../database'
import { CapabilityError, NotFoundError, PolicyError, QueryRefusedError } from '../errors'
import { bindScopedDatabaseProvisionally, type DataAccess, dataAccessOf, type DataHandles, type DataSite, type PathCheck } from '../framework'
import type { DataKind } from '../orm-types'
import { defineTables, readTables } from '../policy'
import type { RelationCheck } from '../registry'
import { openSqlite } from '../sqlite'
import { bunSqliteStorage } from '../sqlite-bun'
import { scoped } from '../store'
import { tablePolicies } from '../tables'
import { TestAuthority, type TestHold } from './fixtures/authority'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR]
const hasPostgres = url !== undefined && url !== ''

if (!hasPostgres) {
	console.warn(`access-views.test.ts: the Postgres half is skipped; set ${URL_VAR} to run it`)
}

const migrationOf = (now: string, timestamp: string) => `
create table accounts (id text not null primary key, name text not null);
create table profiles (
	id text not null primary key,
	principal_id text not null,
	display_name text not null,
	version integer not null default 1
);
create view own_profiles as select id, principal_id from profiles;

create table companies (id text not null primary key, account_id text not null references accounts (id), name text not null);
create table modules (
	id text not null primary key,
	company_id text not null references companies (id),
	title text not null,
	published_at ${timestamp}
);
create view module_cards as select id as module_id, company_id, title from modules;
create view published_modules as
	select m.id as module_id, c.id as company_id from modules m cross join companies c
	where m.published_at is not null and m.published_at <= ${now};

create table cases (id text not null primary key, title text not null);
create table case_grants (
	id text not null primary key,
	case_id text not null references cases (id),
	principal_id text not null,
	valid_until ${timestamp},
	revoked_at ${timestamp}
);
create table case_notes (id text not null primary key, case_id text not null references cases (id), body text not null);
create view active_case_access as
	select case_id, principal_id from case_grants
	where revoked_at is null and (valid_until is null or valid_until > ${now});

create table billing (id text not null primary key, account_id text not null references accounts (id));
create table items (
	id text not null primary key,
	company_id text not null references companies (id),
	billing_id text references billing (id),
	label text not null
);
create view item_accounts as
	select i.id as item_id, c.account_id from items i join companies c on c.id = i.company_id
	union
	select i.id, b.account_id from items i join billing b on b.id = i.billing_id;
`

interface DB {
	profiles: { id: string; principal_id: string; display_name: string; version: number }
	own_profiles: { id: string | null; principal_id: string | null }
	accounts: { id: string; name: string }
	companies: { id: string; account_id: string; name: string }
	modules: { id: string; company_id: string; title: string; published_at: string | null }
	published_modules: { module_id: string | null; company_id: string | null }
	module_cards: { module_id: string | null; company_id: string | null; title: string | null }
	cases: { id: string; title: string }
	case_grants: { id: string; case_id: string; principal_id: string; valid_until: string | null; revoked_at: string | null }
	case_notes: { id: string; case_id: string; body: string }
	active_case_access: { case_id: string | null; principal_id: string | null }
	billing: { id: string; account_id: string }
	items: { id: string; company_id: string; billing_id: string | null; label: string }
	item_accounts: { item_id: string | null; account_id: string | null }
}

type Views = 'own_profiles' | 'published_modules' | 'module_cards' | 'active_case_access' | 'item_accounts'

const columns: TypedColumnList<DB, Views> = {
	profiles: { columns: ['id', 'principal_id', 'display_name', 'version'], foreignKeys: [] },
	own_profiles: { columns: ['id', 'principal_id'], foreignKeys: [], view: true },
	accounts: { columns: ['id', 'name'], foreignKeys: [] },
	companies: { columns: ['id', 'account_id', 'name'], foreignKeys: [{ columns: ['account_id'], table: 'accounts', references: ['id'] }] },
	modules: {
		columns: ['id', 'company_id', 'title', 'published_at'],
		foreignKeys: [{ columns: ['company_id'], table: 'companies', references: ['id'] }],
		timestamps: ['published_at'],
	},
	published_modules: { columns: ['module_id', 'company_id'], foreignKeys: [], view: true },
	module_cards: { columns: ['module_id', 'company_id', 'title'], foreignKeys: [], view: true },
	cases: { columns: ['id', 'title'], foreignKeys: [] },
	case_grants: {
		columns: ['id', 'case_id', 'principal_id', 'valid_until', 'revoked_at'],
		foreignKeys: [{ columns: ['case_id'], table: 'cases', references: ['id'] }],
		timestamps: ['valid_until', 'revoked_at'],
	},
	case_notes: { columns: ['id', 'case_id', 'body'], foreignKeys: [{ columns: ['case_id'], table: 'cases', references: ['id'] }] },
	active_case_access: { columns: ['case_id', 'principal_id'], foreignKeys: [], view: true },
	billing: { columns: ['id', 'account_id'], foreignKeys: [{ columns: ['account_id'], table: 'accounts', references: ['id'] }] },
	items: {
		columns: ['id', 'company_id', 'billing_id', 'label'],
		foreignKeys: [
			{ columns: ['company_id'], table: 'companies', references: ['id'] },
			{ columns: ['billing_id'], table: 'billing', references: ['id'] },
		],
	},
	item_accounts: { columns: ['item_id', 'account_id'], foreignKeys: [], view: true },
}

const vocabulary = {
	app: 'access-views',
	dimensions: { person: {}, account: {}, company: {}, module: { in: 'company' }, case: {} },
	actions: {
		'profiles.read': 'Read a profile',
		'profiles.write': 'Edit a profile',
		'accounts.read': 'Read accounts',
		'companies.read': 'Read companies',
		'modules.read': 'Read modules',
		'cases.read': 'Read cases',
		'cases.admin': 'Manage case grants',
		'notes.insert': 'Add a note to a case',
		'billing.read': 'Read billing',
		'items.read': 'Read items',
	},
	relations: {
		self: { dimension: 'person' },
		marketplace: { dimension: 'company' },
		grantee: { dimension: 'case' },
		billed: { dimension: 'account' },
	},
	roles: {},
} as const

const policies = {
	profiles: {
		scope: { dimension: 'person' },
		actions: { read: 'profiles.read', update: 'profiles.write' },
		update: ['display_name'],
		version: 'version',
		access: { self: { view: 'own_profiles', row: 'id', principal: 'principal_id' } },
	},
	accounts: { scope: { dimension: 'account' }, actions: { read: 'accounts.read' } },
	companies: { scope: { dimension: 'company' }, actions: { read: 'companies.read' } },
	modules: {
		scope: { dimension: 'module' },
		actions: { read: 'modules.read' },
		access: { marketplace: { view: 'published_modules', row: 'module_id', member: 'company_id' } },
	}, // A view as the target: its access lists rows beside what its parent's reach reads.
	module_cards: {
		scope: { child: 'companies', key: 'module_id', column: 'company_id' },
		actions: { read: 'modules.read' },
		access: { marketplace: { view: 'published_modules', row: 'module_id', member: 'company_id' } },
	},

	cases: {
		scope: { dimension: 'case' },
		actions: { read: 'cases.read' },
		access: { grantee: { view: 'active_case_access', row: 'case_id', principal: 'principal_id' } },
	},
	case_grants: { scope: { child: 'cases' }, actions: { read: 'cases.admin', insert: 'cases.admin' }, insert: ['principal_id', 'valid_until'] },
	case_notes: { scope: { child: 'cases' }, actions: { read: 'cases.read', insert: 'notes.insert' }, insert: ['body'] },
	billing: { scope: { app: 'billing records' }, actions: { read: 'billing.read' } },
	items: {
		scope: { child: 'companies' },
		actions: { read: 'items.read' },
		access: { billed: { view: 'item_accounts', row: 'item_id', member: 'account_id' } },
		relationWhen: { billed: { 'items.read': { label: { notEq: 'hidden' } } } },
	},
} as const

const tables = defineTables(vocabulary, columns)(policies)

const alice = new TestAuthority('user:alice')
const HOUR = 3_600_000
interface Backend {
	readonly database: Database
	exec(text: string): Promise<void>
	rows(text: string): Promise<readonly Record<string, unknown>[]>
}

/** Who an invocation runs for: the data access of a layer bound to that principal's authority. */
interface Caller {
	readonly data: DataAccess
	readonly principal: string
}

const rowList = z.array(z.record(z.string(), z.unknown()))

async function postgresAdmin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
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

const inside = (relation: string, dimension: string, values: readonly string[]) => ({ relation, inside: { dimension, values } })

function suite(dialect: 'sqlite' | 'postgres', open: () => Promise<Backend>, close: () => Promise<void>): void {
	describe.skipIf(dialect === 'postgres' && !hasPostgres)(`on ${dialect}`, () => {
		let backend: Backend
		let data: DataAccess
		let relates: RelationCheck
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
			const past = new Date(Date.now() - HOUR).toISOString()
			const future = new Date(Date.now() + HOUR).toISOString()
			await backend.exec(`
				delete from items; delete from billing; delete from case_notes; delete from case_grants; delete from cases; delete from modules;
				delete from companies; delete from profiles; delete from accounts;
				insert into accounts (id, name) values ('a1', 'one'), ('a2', 'two');
				insert into profiles (id, principal_id, display_name) values ('pa', 'user:alice', 'Alice'), ('pb', 'user:bob', 'Bob');
				insert into companies (id, account_id, name) values ('c1', 'a1', 'mine'), ('c2', 'a2', 'theirs'), ('c3', 'a2', 'billed to me');
				insert into modules (id, company_id, title, published_at) values
					('m1', 'c1', 'my draft', null), ('m2', 'c1', 'my published', '${past}'),
					('m3', 'c2', 'their draft', null), ('m4', 'c2', 'their published', '${past}'), ('m5', 'c2', 'their scheduled', '${future}');
				insert into cases (id, title) values ('k1', 'open grant'), ('k2', 'expired'), ('k3', 'revoked'), ('k4', 'someone else');
				insert into case_grants (id, case_id, principal_id, valid_until, revoked_at) values
					('g1', 'k1', 'user:alice', '${future}', null), ('g2', 'k2', 'user:alice', '${past}', null),
					('g3', 'k3', 'user:alice', null, '${past}'), ('g4', 'k4', 'user:bob', null, null);
				insert into billing (id, account_id) values ('b1', 'a1');
				insert into items (id, company_id, billing_id, label) values
					('i1', 'c1', null, 'my company'), ('i2', 'c3', 'b1', 'billed to my account'), ('i3', 'c2', null, 'not mine'),
					('i4', 'c2', 'b1', 'hidden');
			`)
			release()
			const layer = scoped(tables)
			const binding = bindScopedDatabaseProvisionally(layer, { database: backend.database, capabilities: alice })
			release = () => binding.release()
			relates = binding.relates
			holdsThrough = binding.holdsThrough
			data = dataAccessOf(layer)
		})

		async function invoke<T>(
			kind: DataKind,
			work: (handles: DataHandles) => Promise<T>,
			caller: Caller = { data, principal: 'user:alice' },
		): Promise<T> {
			const transaction = caller.data.invocation(kind === 'query')
			const site: DataSite = {
				kind,
				unscoped: {},
				principal: caller.principal,
				check() {
					if (transaction.ended) throw new QueryRefusedError('ended', 'this invocation has ended')
				},
				session: () => transaction.session(),
			}
			try {
				const result = await work(caller.data.handles(site))
				await transaction.commit()
				return result
			} catch (error) {
				await transaction.rollback()
				throw error
			}
		}

		/** Runs `work` for another principal, over a layer bound to its own authority, which mints its capabilities. */
		async function asCaller<T>(principal: string, work: (authority: TestAuthority, caller: Caller) => Promise<T>): Promise<T> {
			const authority = new TestAuthority(principal)
			const layer = scoped(tables)
			const binding = bindScopedDatabaseProvisionally(layer, { database: backend.database, capabilities: authority })
			try {
				return await work(authority, { data: dataAccessOf(layer), principal })
			} finally {
				binding.release()
			}
		}

		describe('a principal-bound access view: the caller reads and edits the record the view names it in', () => {
			const listed = () =>
				invoke('query', (db) => call(db.within(alice.within('person', 'profiles.read', [], [], [], ['self'])), 'profiles.list')).then(ids)
			const ref = (action: string, id: string) => alice.ref('person', action, id, {}, ['self'])

			test('a Within held through the relation lists only the row the view names the caller in', async () => {
				expect(await listed()).toEqual(['pa'])
			})

			test('a Ref through the relation updates the own row, and finds no other', async () => {
				await invoke('mutation', (db) => call(db.target(ref('profiles.write', 'pa'), 'on'), 'update', { display_name: 'A.' }, { expectVersion: 1 }))
				expect(await backend.rows("select display_name from profiles where id = 'pa'")).toEqual([{ display_name: 'A.' }])
				await expect(
					invoke('mutation', (db) => call(db.target(ref('profiles.write', 'pb'), 'on'), 'update', { display_name: 'x' }, { expectVersion: 1 })),
				)
					.rejects.toThrow('not found')
				expect(await backend.rows("select display_name from profiles where id = 'pb'")).toEqual([{ display_name: 'Bob' }])
			})

			test('relates answers the node the view lists for the principal, and no other', async () => {
				expect(await relates('self', 'pa', 'user:alice')).toBe(true)
				expect(await relates('self', 'pb', 'user:alice')).toBe(false)
				expect(await relates('self', 'pa', 'user:bob')).toBe(false)
			})

			test('a change of the row the view reads takes effect at the next statement', async () => {
				await backend.exec("update profiles set principal_id = 'user:carol' where id = 'pa'")
				expect(await listed()).toEqual([])
			})

			// A person directory: each entry names the identity it belongs to, and the rule "read and update the entry whose
			// identity is the caller" is this one view.
			test('each principal lists only its own entry, and one the view names nowhere lists nothing', async () => {
				const listedBy = (principal: string) =>
					asCaller(
						principal,
						(authority, caller) =>
							invoke('query', (db) => call(db.within(authority.within('person', 'profiles.read', [], [], [], ['self'])), 'profiles.list'), caller).then(ids),
					)
				expect(await listedBy('user:bob')).toEqual(['pb'])
				expect(await listedBy('user:carol')).toEqual([])
			})

			test('a Ref through the relation reads the own entry, and finds no other', async () => {
				await asCaller('user:bob', async (authority, caller) => {
					const read = (id: string) =>
						invoke('query', (db) => call(db.target(authority.ref('person', 'profiles.read', id, {}, ['self']), 'on'), 'get'), caller)
					expect(await read('pb')).toMatchObject({ id: 'pb', display_name: 'Bob' })
					await expect(read('pa')).rejects.toThrow(NotFoundError)
				})
			})

			test('another principal edits its own entry and not the caller’s', async () => {
				await asCaller('user:bob', async (authority, caller) => {
					const update = (id: string) =>
						invoke(
							'mutation',
							(db) =>
								call(db.target(authority.ref('person', 'profiles.write', id, {}, ['self']), 'on'), 'update', { display_name: 'B.' }, { expectVersion: 1 }),
							caller,
						)
					await update('pb')
					await expect(update('pa')).rejects.toThrow(NotFoundError)
				})
				expect(await backend.rows('select id, display_name from profiles order by id')).toEqual([{ id: 'pa', display_name: 'Alice' }, {
					id: 'pb',
					display_name: 'B.',
				}])
			})
		})

		describe('a member-bound access view: a published row read across tenants', () => {
			const listed = (values: readonly string[], holds: readonly TestHold[]) =>
				invoke('query', (db) => call(db.within(alice.within('company', 'modules.read', values, [], [], holds)), 'modules.list')).then(ids)

			test('a member of c1 reads every module of c1 and the published modules of every other company', async () => {
				expect(await listed(['c1'], [inside('marketplace', 'company', ['c1'])])).toEqual(['m1', 'm2', 'm4'])
			})

			test('without the relation the membership reads its own company only', async () => {
				expect(await listed(['c1'], [])).toEqual(['m1', 'm2'])
			})

			test('a hold inside a node of another dimension lists nothing through a member binding', async () => {
				expect(await listed([], [inside('marketplace', 'account', ['c1'])])).toEqual([])
			})

			test('a hold anywhere lists nothing through a view bound to member nodes', async () => {
				expect(await listed([], ['marketplace'])).toEqual([])
			})

			test('a view as the target lists through its own access view beside its parent', async () => {
				const cards = (values: readonly string[], holds: readonly TestHold[]) =>
					invoke('query', (db) => call(db.within(alice.within('company', 'modules.read', values, [], [], holds)), 'module_cards.list')).then((page) => {
						const items: unknown = typeof page === 'object' && page !== null ? Reflect.get(page, 'items') : undefined
						return Array.isArray(items)
							? items.map((row: unknown) => String(typeof row === 'object' && row !== null ? Reflect.get(row, 'module_id') : '')).sort()
							: []
					})
				expect(await cards(['c1'], [inside('marketplace', 'company', ['c1'])])).toEqual(['m1', 'm2', 'm4'])
				expect(await cards([], [inside('marketplace', 'company', ['c1'])])).toEqual(['m2', 'm4'])
				expect(await cards(['c1'], [])).toEqual(['m1', 'm2'])
			})

			test('an on or in binding counts the hold only for a row inside its node: no Ref of a row the view maps elsewhere', async () => {
				const held = (id: string) => holdsThrough('module', id, 'modules.read', 'user:alice', [inside('marketplace', 'company', ['c1'])], [])
				expect(await held('m2')).toEqual({ relations: [inside('marketplace', 'company', ['c1'])], paths: [] })
				expect(await held('m4')).toEqual({ relations: [], paths: [] })
			})

			test('relates finds nothing through a view bound to member nodes: a hold anywhere names no node', async () => {
				expect(await relates('marketplace', 'c1', 'user:alice')).toBe(false)
				expect(await relates('marketplace', 'c2', 'user:alice')).toBe(false)
			})

			test('a row the clock has not published yet is out until it is', async () => {
				expect(await listed([], [inside('marketplace', 'company', ['c1'])])).toEqual(['m2', 'm4'])
				await backend.exec(`update modules set published_at = '${new Date(Date.now() - 1000).toISOString()}' where id = 'm5'`)
				expect(await listed([], [inside('marketplace', 'company', ['c1'])])).toEqual(['m2', 'm4', 'm5'])
			})
		})

		describe('a view as the source: a grant active by the clock and not revoked', () => {
			const listed = () => invoke('query', (db) => call(db.within(alice.within('case', 'cases.read', [], [], [], ['grantee'])), 'cases.list')).then(ids)

			test('reads the cases of active grants only', async () => {
				expect(await listed()).toEqual(['k1'])
			})

			test('a revocation takes effect at the next statement', async () => {
				await backend.exec(`update case_grants set revoked_at = '${new Date().toISOString()}' where id = 'g1'`)
				expect(await listed()).toEqual([])
			})

			test('an insert under a Ref held through the view writes only into a case the view grants', async () => {
				const into = (id: string, body: string) =>
					invoke('mutation', (db) => call(db.target(alice.ref('case', 'notes.insert', id, {}, ['grantee']), 'on'), 'case_notes.insert', { body }))
				expect(await into('k1', 'granted')).toMatchObject({ id: expect.any(String) })
				await expect(into('k3', 'revoked')).rejects.toThrow(NotFoundError)
				await expect(into('k4', 'someone else')).rejects.toThrow(NotFoundError)
				expect(await backend.rows('select case_id, body from case_notes')).toEqual([{ case_id: 'k1', body: 'granted' }])
			})
		})

		describe('a row reached through two containers', () => {
			const listed = (holds: readonly ReturnType<typeof inside>[]) =>
				invoke('query', (db) => call(db.within(alice.within('company', 'items.read', [], [], [], holds)), 'items.list')).then(ids)

			test('an account member reads items of its companies and items billed to it in another account', async () => {
				expect(await listed([inside('billed', 'account', ['a1'])])).toEqual(['i1', 'i2'])
				expect(await listed([inside('billed', 'account', ['a2'])])).toEqual(['i2', 'i3'])
			})

			test("the relation's own condition narrows what the view reaches, in a list and a count", async () => {
				await backend.exec("update items set label = 'shown' where id = 'i4'")
				expect(await listed([inside('billed', 'account', ['a1'])])).toEqual(['i1', 'i2', 'i4'])
				await backend.exec("update items set label = 'hidden' where id = 'i4'")
				expect(await listed([inside('billed', 'account', ['a1'])])).toEqual(['i1', 'i2'])
				const counted = await invoke(
					'query',
					(db) => call(db.within(alice.within('company', 'items.read', [], [], [], [inside('billed', 'account', ['a1'])])), 'items.count'),
				)
				expect(Number(counted)).toBe(2)
			})
		})

		describe('what an access relation does not do', () => {
			test('a relation the layer does not serve stays unenforceable', async () => {
				await expect(invoke('query', (db) => call(db.within(alice.within('case', 'cases.read', [], [], [], ['other'])), 'cases.list'))).rejects.toThrow(
					CapabilityError,
				)
			})
		})
	})
}

suite('sqlite', async () => {
	const storage = bunSqliteStorage()
	storage.sql.exec(migrationOf("strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", 'timestamp'))
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
		await sql.unsafe(`set search_path to ${schema}; ${migrationOf('now()', 'timestamptz')}`)
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

describe('the contract artifact', () => {
	test('carries each access view with its bindings, and nothing for a table without one', () => {
		const artifact = tablePolicies(tables)
		expect(artifact['cases']?.access).toEqual({ grantee: { view: 'active_case_access', row: 'case_id', principal: 'principal_id', member: null } })
		expect(artifact['modules']?.access).toEqual({ marketplace: { view: 'published_modules', row: 'module_id', principal: null, member: 'company_id' } })
		expect(artifact['companies']).not.toHaveProperty('access')
	})
})

describe('what the parse refuses', () => {
	const withPolicy = (patch: Record<string, unknown>) => readTables(columns, { ...policies, ...patch }, vocabulary)

	test('a view bound to neither the principal nor a member node', () => {
		expect(() => withPolicy({ cases: { ...policies.cases, access: { grantee: { view: 'active_case_access', row: 'case_id' } } } }))
			.toThrow(/binds neither principal nor member/)
	})

	test('a source that is not a view', () => {
		expect(() => withPolicy({ cases: { ...policies.cases, access: { grantee: { view: 'case_grants', row: 'case_id', principal: 'principal_id' } } } }))
			.toThrow(PolicyError)
	})

	test('an access view with a policy, which a store would read directly', () => {
		expect(() => withPolicy({ active_case_access: { scope: { child: 'cases', key: 'case_id', column: 'case_id' }, actions: { read: 'cases.read' } } }))
			.toThrow(/an access view takes none/)
	})

	test('a column the view does not have', () => {
		expect(() =>
			withPolicy({ cases: { ...policies.cases, access: { grantee: { view: 'active_case_access', row: 'id', principal: 'principal_id' } } } })
		)
			.toThrow(/not a column of active_case_access/)
	})

	test('nothing when a relation has a source table and an access view, in either order of the column list', () => {
		const grants = { scope: { child: 'cases' }, actions: { read: 'cases.admin' }, confers: { grantee: { principal: 'principal_id' } } }
		const reversed = Object.fromEntries(Object.entries(columns).reverse())
		expect(() => withPolicy({ case_grants: grants })).not.toThrow()
		expect(() => readTables(reversed, { ...policies, case_grants: grants }, vocabulary)).not.toThrow()
	})

	test('a reveal of a relation that access views alone serve, which has no row to match it through', () => {
		const curated = { ...vocabulary, relations: { ...vocabulary.relations, curator: { dimension: 'module' } } }
		const modules = {
			...policies.modules,
			access: { curator: { view: 'published_modules', row: 'module_id', member: 'company_id' } },
			reveals: { curator: { to: 'company', actions: ['modules.read'] } },
		}
		expect(() => readTables(columns, { ...policies, modules }, curated)).toThrow(/only access views serve it/)
	})

	test('a relation the vocabulary does not declare', () => {
		expect(() =>
			withPolicy({ cases: { ...policies.cases, access: { owner: { view: 'active_case_access', row: 'case_id', principal: 'principal_id' } } } })
		)
			.toThrow(/does not declare/)
	})
})
