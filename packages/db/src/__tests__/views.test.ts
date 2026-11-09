// A view read as a read-only table (ADR-0072), on SQLite over bun:sqlite and on Postgres: a Ref of its parent reads
// its rows, a Within lists them, both through the parent row its parent column names, a column's own read action hides
// a column, a reference view lists for every site, and every write is refused before a statement. The Postgres half skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset:
//
//   docker run --rm -d -p 55433:5432 -e POSTGRES_PASSWORD=postgres postgres:17
//   FABRIKA_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55433/postgres bun test packages/db
//
// The URL is a credential: it is never logged.

import { openPostgres } from '@fabrika/db/postgres'
import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSqliteSchema } from '../codegen-sqlite'
import type { Database } from '../database'
import { QueryRefusedError } from '../errors'
import { bindScopedDatabase, type DataAccess, dataAccessOf, type DataHandles, type DataSite } from '../framework'
import type { DataKind, UnscopedMode } from '../orm-types'
import { defineTables, readTables } from '../policy'
import { openSqlite } from '../sqlite'
import { bunSqliteStorage } from '../sqlite-bun'
import { defineStore, scoped } from '../store'
import { tablePolicies } from '../tables'
import { TestAuthority } from './fixtures/authority'
import { viewColumns, viewMigration, viewPolicies, viewTables, viewVocabulary } from './fixtures/view-layer'

const alice = new TestAuthority('user:alice')
const SEED = `
insert into organizations (id, name) values ('o1', 'One'), ('o2', 'Two');
insert into projects (id, organization_id, name) values ('p1', 'o1', 'Apollo'), ('p2', 'o2', 'Gemini');
insert into events (id, project_id, organization_id, at, note) values
	('e1', 'p1', 'o1', '2026-10-12T08:30:00.000Z', 'own note'),
	('e2', 'p1', 'o1', '2026-10-12T09:30:00.000Z', null),
	('e3', 'p2', 'o2', '2026-10-12T10:30:00.000Z', 'other note');
`

/** Calls `path` (`project_summaries.list`, `get`) on an untyped handle, as the framework's typed `ctx.db` does. */
async function call(handle: unknown, path: string, ...args: unknown[]): Promise<unknown> {
	const parts = path.split('.')
	const name = parts.pop() ?? ''
	const target = parts.reduce<unknown>((node, part) => (typeof node === 'object' && node !== null ? Reflect.get(node, part) : undefined), handle)
	const method: unknown = typeof target === 'object' && target !== null ? Reflect.get(target, name) : undefined
	if (typeof method !== 'function') {
		throw new TypeError(`${path} is not a method of the handle`)
	}
	return Reflect.apply(method, target, args)
}

function itemsOf(page: unknown): unknown[] {
	const items: unknown = typeof page === 'object' && page !== null ? Reflect.get(page, 'items') : undefined
	return Array.isArray(items) ? items : []
}

function idsOf(page: unknown): string[] {
	return itemsOf(page).map((row) => String(typeof row === 'object' && row !== null ? Reflect.get(row, 'id') : '')).sort()
}

const project = (action: string, id: string, org: string) => alice.ref('project', action, id, { organization: org })

/** The cases both dialects run, over a layer `open` binds to a database migrated with `viewMigration` and `SEED`. */
function viewCases(open: () => Database): void {
	let data: DataAccess
	const viewTablesLayer = scoped(viewTables)
	// The same tables, but the parent's own read narrowed by a condition: a view's read is not narrowed by it.
	let narrowedParent: DataAccess
	// The same tables, with a condition on the read of a child table and of a child view: a join from the parent holds it.
	const noted = { when: { 'projects.read': { note: { isNull: false } } } } as const
	const conditioned = scoped(
		defineTables(viewVocabulary, viewColumns)({
			...viewPolicies,
			events: { ...viewPolicies.events, ...noted },
			event_titles: { ...viewPolicies.event_titles, ...noted },
		}),
	)

	beforeAll(() => {
		const database = open()
		bindScopedDatabase(viewTablesLayer, { database, capabilities: alice })
		data = dataAccessOf(viewTablesLayer)
		const projects = { ...viewPolicies.projects, when: { 'projects.read': { name: { notEq: 'Gemini' } } } }
		const narrowed = scoped(readTables(viewColumns, { ...viewPolicies, projects }, viewVocabulary))
		bindScopedDatabase(narrowed, { database, capabilities: alice })
		narrowedParent = dataAccessOf(narrowed)
		bindScopedDatabase(conditioned, { database, capabilities: alice })
	})

	/** One invocation of `kind`, committed when `work` resolves and rolled back when it throws. */
	async function invoke<T>(
		kind: DataKind,
		work: (handles: DataHandles) => Promise<T>,
		unscoped: Record<string, UnscopedMode> = {},
		layer: DataAccess = data,
	): Promise<T> {
		const transaction = layer.invocation(kind === 'query')
		const site: DataSite = {
			kind,
			unscoped,
			principal: 'user:alice',
			check() {
				if (transaction.ended) {
					throw new QueryRefusedError('ended', 'this invocation has ended')
				}
			},
			session: () => transaction.session(),
		}
		try {
			const result = await work(layer.handles(site))
			await transaction.commit()
			return result
		} catch (error) {
			await transaction.rollback()
			throw error
		}
	}

	test("a Ref of the parent reads the view's row keyed by the parent, and no other parent's", async () => {
		const own = project('projects.read', 'p1', 'o1')
		expect(await invoke('query', (db) => call(db.target(own, 'on'), 'project_summaries.get', 'p1'))).toEqual({
			project_id: 'p1',
			organization_id: 'o1',
			name: 'Apollo',
			events: 2,
		})
		await expect(invoke('query', (db) => call(db.target(own, 'on'), 'project_summaries.get', 'p2'))).rejects.toThrow('not found')
		expect(itemsOf(await invoke('query', (db) => call(db.target(own, 'on'), 'project_summaries.list')))).toEqual([
			{ project_id: 'p1', organization_id: 'o1', name: 'Apollo', events: 2 },
		])
	})

	test('a Within lists only the rows of its scopes, counts them, and answers a timestamp as a Date', async () => {
		const within = alice.within('organization', 'projects.read', ['o1'])
		expect(itemsOf(await invoke('query', (db) => call(db.within(within), 'project_summaries.list')))).toEqual([
			{ project_id: 'p1', organization_id: 'o1', name: 'Apollo', events: 2 },
		])
		expect(await invoke('query', (db) => call(db.within(within), 'event_notes.count'))).toBe(2)
		const notes = itemsOf(await invoke('query', (db) => call(db.within(within), 'event_notes.list', { orderBy: [['at', 'asc']] })))
		expect(notes).toEqual([
			{ id: 'e1', project_id: 'p1', organization_id: 'o1', at: new Date('2026-10-12T08:30:00.000Z') },
			{ id: 'e2', project_id: 'p1', organization_id: 'o1', at: new Date('2026-10-12T09:30:00.000Z') },
		])
	})

	test('a view that carries no chain column reads under a Ref and a Within of every dimension its parent lies in', async () => {
		const own = project('projects.read', 'p1', 'o1')
		expect(idsOf(await invoke('query', (db) => call(db.target(own, 'on'), 'event_titles.list')))).toEqual(['e1', 'e2'])
		expect(await invoke('query', (db) => call(db.target(own, 'on'), 'event_titles.get', 'e1'))).toEqual({
			id: 'e1',
			project_id: 'p1',
			note: 'own note',
		})
		await expect(invoke('query', (db) => call(db.target(own, 'on'), 'event_titles.get', 'e3'))).rejects.toThrow('not found')
		const organization = alice.within('organization', 'projects.read', ['o1'])
		expect(idsOf(await invoke('query', (db) => call(db.within(organization), 'event_titles.list')))).toEqual(['e1', 'e2'])
		expect(await invoke('query', (db) => call(db.within(organization), 'event_titles.count'))).toBe(2)
		const projects = alice.within('project', 'projects.read', ['p2'])
		expect(idsOf(await invoke('query', (db) => call(db.within(projects), 'event_titles.list')))).toEqual(['e3'])
		const contained = alice.within('project', 'projects.read', [], [{ dimension: 'organization', values: ['o1'] }])
		expect(idsOf(await invoke('query', (db) => call(db.within(contained), 'event_titles.list')))).toEqual(['e1', 'e2'])
		const everywhere = alice.within('organization', 'projects.read', 'all')
		expect(idsOf(await invoke('query', (db) => call(db.within(everywhere), 'event_titles.list')))).toEqual(['e1', 'e2', 'e3'])
		expect(idsOf(await invoke('query', (db) => call(db.within(alice.within('organization', 'projects.read', [])), 'event_titles.list')))).toEqual([])
	})

	test("a row lies where its parent row lies, whatever the view's own organization column says", async () => {
		// stray_events names o1 for every event; e3's parent p2 lies in o2.
		const organization = (id: string) => alice.within('organization', 'projects.read', [id])
		expect(idsOf(await invoke('query', (db) => call(db.within(organization('o1')), 'stray_events.list')))).toEqual(['e1', 'e2'])
		expect(idsOf(await invoke('query', (db) => call(db.within(organization('o2')), 'stray_events.list')))).toEqual(['e3'])
		const forged = project('projects.read', 'p2', 'o1')
		expect(idsOf(await invoke('query', (db) => call(db.target(forged, 'on'), 'stray_events.list')))).toEqual([])
		await expect(invoke('query', (db) => call(db.target(forged, 'on'), 'stray_events.get', 'e3'))).rejects.toThrow('not found')
		const own = project('projects.read', 'p2', 'o2')
		expect(idsOf(await invoke('query', (db) => call(db.target(own, 'on'), 'stray_events.list')))).toEqual(['e3'])
	})

	test('ctx.sql.scope renders no read of a child view, which only its parent row places', async () => {
		const own = project('projects.read', 'p1', 'o1')
		const transaction = data.invocation(true)
		try {
			const sql = data.sql({ mode: 'read', check() {}, session: () => transaction.session(), fail: () => transaction.fail() })
			expect(() => sql.scope(own, 'event_titles')).toThrow('ctx.sql.scope cannot render the read of the view event_titles through its parent')
			expect(() => sql.scope(alice.within('organization', 'projects.read', ['o1']), 'event_notes')).toThrow(
				'ctx.sql.scope cannot render the read of the view event_notes through its parent',
			)
		} finally {
			await transaction.rollback()
		}
	})

	test("a view's condition narrows its read through its parent row; the parent's own condition does not", async () => {
		// named_events reads a row with a note whose project lies in the organization named One: e1 only.
		const own = project('projects.read', 'p1', 'o1')
		expect(idsOf(await invoke('query', (db) => call(db.target(own, 'on'), 'named_events.list')))).toEqual(['e1'])
		expect(await invoke('query', (db) => call(db.target(own, 'on'), 'named_events.get', 'e1'))).toEqual({
			id: 'e1',
			project_id: 'p1',
			note: 'own note',
		})
		await expect(invoke('query', (db) => call(db.target(own, 'on'), 'named_events.get', 'e2'))).rejects.toThrow('not found')
		const everywhere = alice.within('organization', 'projects.read', 'all')
		expect(idsOf(await invoke('query', (db) => call(db.within(everywhere), 'named_events.list')))).toEqual(['e1'])
		expect(await invoke('query', (db) => call(db.within(alice.within('organization', 'projects.read', ['o2'])), 'named_events.count'))).toBe(0)
		const other = alice.within('organization', 'projects.read', ['o2'])
		const narrowed = (table: string) => invoke('query', (db) => call(db.within(other), `${table}.list`), {}, narrowedParent).then(idsOf)
		expect(await narrowed('projects')).toEqual([])
		expect(await narrowed('event_titles')).toEqual(['e3'])
	})

	test("a store's join from the parent holds the child's condition of the held action, on a table and on a view", async () => {
		// e2 has no note, so the condition hides it from a read of events and of event_titles alike.
		const projects = defineStore(conditioned, 'projects', (t) => t)
		const within = alice.within('organization', 'projects.read', ['o1'])
		const events = await projects.select(within, (q) => q.join('events', (c) => c.columns(['id'])))
		expect(events.map((row) => row['events.id'])).toEqual(['e1'])
		const titles = await projects.select(within, (q) => q.join('event_titles', (c) => c.columns(['id'])))
		expect(titles.map((row) => row['event_titles.id'])).toEqual(['e1'])
		await expect(projects.select(within, (q) => q.join('named_events', (c) => c.columns(['id'])))).rejects.toThrow(
			'joining named_events cannot hold its condition of projects.read, which reads other rows; read named_events through its own handle',
		)
		const unconditioned = await defineStore(viewTablesLayer, 'projects', (t) => t).select(within, (q) => q.join('events', (c) => c.columns(['id'])))
		expect(unconditioned.map((row) => row['events.id']).sort()).toEqual(['e1', 'e2'])
	})

	test("a column with its own read action is read only by that action's Ref", async () => {
		const reader = project('notes.read', 'p1', 'o1')
		const row = await invoke('query', (db) => call(db.target(reader, 'on'), 'event_notes.get', 'e1'))
		expect(row).toMatchObject({ id: 'e1', note: 'own note' })
		const plain = await invoke('query', (db) => call(db.target(project('projects.read', 'p1', 'o1'), 'on'), 'event_notes.get', 'e1'))
		expect(plain).not.toHaveProperty('note')
	})

	test('a reference view lists for every site, and a view without a policy is no table of the layer', async () => {
		const names = itemsOf(await invoke('query', (db) => call(db.reference, 'organization_names.list', { orderBy: [['name', 'asc']] })))
		expect(names).toEqual([{ id: 'o1', name: 'One' }, { id: 'o2', name: 'Two' }])
		expect(Object.keys(tablePolicies(viewTables)).sort()).toEqual([
			'event_notes',
			'event_titles',
			'events',
			'named_events',
			'organization_names',
			'organizations',
			'project_summaries',
			'projects',
			'stray_events',
		])
		await expect(invoke('query', (db) => call(db.unscoped, 'project_names.list'), { project_names: 'read' })).rejects.toThrow(
			'unscoped declares project_names, which is not a table of src/db/tables.ts',
		)
	})

	test('every write of a view is refused, and nothing is written', async () => {
		const writer = project('projects.write', 'p1', 'o1')
		const unscoped = { event_notes: 'write' } as const
		const refusals: readonly [() => Promise<unknown>, string][] = [
			[
				() => invoke('mutation', (db) => call(db.target(writer, 'on'), 'project_summaries.insert', { name: 'x' })),
				'project_summaries allows no insert; its policy declares no insert action',
			],
			[
				() => invoke('mutation', (db) => call(db.target(writer, 'on'), 'event_notes.update', 'e1', { note: 'x' })),
				'event_notes allows no update; its policy declares no update action',
			],
			[
				() => invoke('mutation', (db) => call(db.target(writer, 'on'), 'event_notes.remove', 'e1')),
				'event_notes allows no delete; its policy declares no delete action',
			],
			[
				() => invoke('mutation', (db) => call(db.unscoped, 'event_notes.insert', { id: 'e9', project_id: 'p1', organization_id: 'o1' }), unscoped),
				'event_notes is a view, which no handler writes',
			],
			[() => invoke('mutation', (db) => call(db.unscoped, 'event_notes.update', 'e1', {}), unscoped), 'event_notes is a view, which no handler writes'],
			[() => invoke('mutation', (db) => call(db.unscoped, 'event_notes.remove', 'e1'), unscoped), 'event_notes is a view, which no handler writes'],
		]
		for (const [refusal, message] of refusals) {
			await expect(refusal()).rejects.toThrow(message)
		}
		const own = project('notes.read', 'p1', 'o1')
		expect(await invoke('query', (db) => call(db.target(own, 'on'), 'event_notes.get', 'e1'))).toMatchObject({ note: 'own note' })
		expect(itemsOf(await invoke('query', (db) => call(db.within(alice.within('organization', 'projects.read', ['o1'])), 'events.list')))).toHaveLength(
			2,
		)
	})
}

describe('a view on SQLite', () => {
	test('codegen renders the fixture column list from the migration', async () => {
		const { source, leftOut } = await generateSqliteSchema([{ bundle: 'app', migrations: [{ name: '20261104000000_views.sql', sql: viewMigration }] }])
		expect(leftOut).toEqual([])
		expect(source).toContain(
			"export type Views =\n\t| 'event_notes'\n\t| 'event_titles'\n\t| 'named_events'\n\t| 'organization_names'\n\t| 'project_names'\n\t| 'project_summaries'\n\t| 'stray_events'\n\nexport const columns: TypedColumnList<DB, Views> = {",
		)
		const directory = await mkdtemp(join(tmpdir(), 'view-layer-'))
		try {
			const file = join(directory, 'schema.generated.ts')
			await writeFile(file, source)
			const generated: unknown = await import(file)
			expect(typeof generated === 'object' && generated !== null ? Reflect.get(generated, 'columns') : undefined).toEqual(viewColumns)
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})

	viewCases(() => {
		const storage = bunSqliteStorage()
		storage.sql.exec(viewMigration)
		storage.sql.exec(SEED)
		return openSqlite(storage)
	})
})

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''

if (!hasPostgres) {
	console.warn(`views.test.ts skipped its Postgres half: set ${URL_VAR} to run it`)
}

const schema = `views_${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
let postgres: Database | undefined

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

describe.skipIf(!hasPostgres)('a view on Postgres', () => {
	beforeAll(async () => {
		await admin(async (sql) => {
			await sql.unsafe(`create schema ${schema}`)
			await sql.unsafe(`set search_path to ${schema}; ${viewMigration.replaceAll('timestamp not null', 'timestamptz not null')} ${SEED}`)
		})
	})

	afterAll(async () => {
		await postgres?.close()
		await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
	})

	viewCases(() => {
		postgres = openPostgres({ url, schema, max: 2 })
		return postgres
	})
})
