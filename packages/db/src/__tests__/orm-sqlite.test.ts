// The mini-ORM on SQLite (ADR-0065), over a bun:sqlite stand-in for a Durable Object's storage: a handler reads and
// writes the values it does on Postgres — timestamps as `Date`, booleans as `true`/`false`, days as `YYYY-MM-DD`, a
// count as a number — a keyset page orders nulls as Postgres does, and `ctx.sql` is refused.

import { beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { QueryRefusedError } from '../errors'
import { bindScopedDatabase, type DataAccess, dataAccessOf, type DataHandles, type DataSite } from '../framework'
import type { DataKind } from '../orm-types'
import { openSqlite } from '../sqlite'
import { type BunSqliteStorage, bunSqliteStorage } from '../sqlite-bun'
import { scoped } from '../store'
import { TestAuthority } from './fixtures/authority'
import { sqliteMigration, sqliteTables } from './fixtures/sqlite-layer'

const alice = new TestAuthority('user:alice')
let storage: BunSqliteStorage
let data: DataAccess

beforeEach(() => {
	storage = bunSqliteStorage()
	storage.sql.exec(sqliteMigration)
	storage.sql.exec("insert into organizations (id, name) values ('o1', 'One'), ('o2', 'Two')")
	const layer = scoped(sqliteTables)
	bindScopedDatabase(layer, { database: openSqlite(storage), capabilities: alice })
	data = dataAccessOf(layer)
})

/** One invocation of `kind`, committed when `work` resolves and rolled back when it throws. */
async function invoke<T>(kind: DataKind, work: (handles: DataHandles) => Promise<T>): Promise<T> {
	const transaction = data.invocation(kind === 'query')
	const site: DataSite = {
		kind,
		unscoped: {},
		principal: 'user:alice',
		check() {
			if (transaction.ended) {
				throw new QueryRefusedError('ended', 'this invocation has ended')
			}
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

/** Calls `path` (`projects.list`, `get`) on an untyped handle, as the framework's typed `ctx.db` does. */
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

const organization = (action: string, id = 'o1') => alice.ref('organization', action, id)
const project = (action: string, id: string, org = 'o1') => alice.ref('project', action, id, { organization: org })
const inOrganizations = (action: string, ids: readonly string[] = ['o1']) => alice.within('organization', action, ids)

function idOf(value: unknown): string {
	const id: unknown = typeof value === 'object' && value !== null ? Reflect.get(value, 'id') : undefined
	if (typeof id !== 'string') {
		throw new TypeError('the acknowledgement carries no id')
	}
	return id
}

function field(value: unknown, name: string): unknown {
	return typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined
}

function itemsOf(page: unknown): Record<string, unknown>[] {
	const items = field(page, 'items')
	return Array.isArray(items) ? items : []
}

async function insertProject(values: Record<string, unknown>, org = 'o1'): Promise<string> {
	return idOf(
		await invoke('mutation', (db) => call(db.target(organization('projects.write', org), 'in'), 'projects.insert', { name: 'p', ...values })),
	)
}

function stored(sql: string): Record<string, unknown>[] {
	return storage.sql.exec(sql).toArray()
}

describe('a row reads back with the types it has on Postgres', () => {
	test('a timestamp, a boolean and a day round-trip through insert, get, update and list', async () => {
		const id = await insertProject({ archived: true, due_on: '2026-10-12', starts_at: new Date('2026-10-12T08:30:00.123Z'), rank: 3 })
		const read = await invoke('query', (db) => call(db.target(project('projects.read', id), 'on'), 'get'))
		expect(read).toMatchObject({
			id,
			organization_id: 'o1',
			archived: true,
			due_on: '2026-10-12',
			starts_at: new Date('2026-10-12T08:30:00.123Z'),
			rank: 3,
			version: 1,
		})
		expect(field(read, 'created_at')).toBeInstanceOf(Date)

		const saved = await invoke(
			'mutation',
			(db) => call(db.target(project('projects.write', id), 'on'), 'update', { archived: false, due_on: null, starts_at: null }, { expectVersion: 1 }),
		)
		expect(saved).toEqual({ id, version: 2 })
		const [listed] = itemsOf(await invoke('query', (db) => call(db.within(inOrganizations('projects.read')), 'projects.list')))
		expect(listed).toMatchObject({ id, archived: false, due_on: null, starts_at: null, version: 2 })
		expect(stored(`select archived, due_on, starts_at from projects where id = '${id}'`)).toEqual([{ archived: 0, due_on: null, starts_at: null }])
	})

	test('a child row reads its timestamp and boolean back the same way', async () => {
		const id = await insertProject({})
		const parent = project('projects.write', id)
		const event = idOf(
			await invoke('mutation', (db) => call(db.target(parent, 'on'), 'events.insert', { at: '2026-10-12T10:30:00+02:00', urgent: true })),
		)
		const read = await invoke('query', (db) => call(db.target(project('projects.read', id), 'on'), 'events.get', event))
		expect(read).toMatchObject({ id: event, at: new Date('2026-10-12T08:30:00.000Z'), urgent: true, note: null })
	})

	test('a write in another offset stores the same instant as UTC text, and sorts and compares by time', async () => {
		// 10:30+02:00 is 08:30Z, before 09:00Z; as written, its text would sort after it.
		const offset = await insertProject({ name: 'offset', starts_at: '2026-10-12T10:30:00+02:00' })
		const utc = await insertProject({ name: 'utc', starts_at: '2026-10-12T09:00:00Z' })
		expect(stored(`select starts_at from projects where id = '${offset}'`)).toEqual([{ starts_at: '2026-10-12T08:30:00.000Z' }])
		const read = await invoke('query', (db) => call(db.target(project('projects.read', offset), 'on'), 'get'))
		expect(field(read, 'starts_at')).toEqual(new Date('2026-10-12T08:30:00.000Z'))

		const within = inOrganizations('projects.read')
		const ordered = await invoke('query', (db) => call(db.within(within), 'projects.list', { orderBy: [['starts_at', 'asc']] }))
		expect(itemsOf(ordered).map((row) => row['name'])).toEqual(['offset', 'utc'])
		// 10:45+02:00 is 08:45Z: only the offset row is before it.
		const before = await invoke('query', (db) => call(db.within(within), 'projects.list', { where: [['starts_at', '<', '2026-10-12T10:45:00+02:00']] }))
		expect(itemsOf(before).map((row) => row['id'])).toEqual([offset])
		const inList = await invoke(
			'query',
			(db) =>
				call(db.within(within), 'projects.list', { where: [['starts_at', 'in', ['2026-10-12T11:00:00+02:00', new Date('2026-10-12T08:30:00Z')]]] }),
		)
		expect(itemsOf(inList).map((row) => row['id']).sort()).toEqual([offset, utc].sort())
	})

	test('a timestamp write or comparison is refused for text that is not ISO 8601 with an offset, before anything is sent', async () => {
		await expect(insertProject({ starts_at: '2026-10-12 08:30:00' })).rejects.toThrow('takes a Date or ISO 8601 text with Z or an offset')
		await expect(insertProject({ starts_at: new Date('9999-12-31T23:00:00-02:00') })).rejects.toThrow('outside the years 0000-9999 UTC')
		await expect(invoke('query', (db) => call(db.within(inOrganizations('projects.read')), 'projects.list', { where: [['starts_at', '>', 'now']] })))
			.rejects.toThrow('takes a Date or ISO 8601 text with Z or an offset')
		expect(stored('select count(*) as n from projects')).toEqual([{ n: 0 }])
	})

	test('a stored value outside the column type form is refused, not answered as text or a number', async () => {
		const id = await insertProject({})
		storage.sql.exec(`update projects set starts_at = '2026-10-12 08:30:00' where id = '${id}'`)
		await expect(invoke('query', (db) => call(db.target(project('projects.read', id), 'on'), 'get'))).rejects.toThrow(
			'projects.starts_at came back as something other than UTC ISO text',
		)
		storage.sql.exec(`update projects set starts_at = null, archived = 2 where id = '${id}'`)
		await expect(invoke('query', (db) => call(db.target(project('projects.read', id), 'on'), 'get'))).rejects.toThrow(
			'projects.archived came back as something other than 0 or 1',
		)
	})

	test('a boolean and a day filter as on Postgres', async () => {
		const archived = await insertProject({ archived: true, due_on: '2026-10-01' })
		const open = await insertProject({ archived: false, due_on: '2026-10-20' })
		const within = inOrganizations('projects.read')
		const ids = async (where: unknown) =>
			itemsOf(await invoke('query', (db) => call(db.within(within), 'projects.list', { where }))).map((row) => row['id'])
		expect(await ids([['archived', '=', true]])).toEqual([archived])
		expect(await ids([['archived', '=', false]])).toEqual([open])
		expect(await ids([['due_on', '>=', '2026-10-12']])).toEqual([open])
	})

	test('count is a number, and an aggregate answers count and an integer sum as text, as Postgres does', async () => {
		await insertProject({ archived: true, rank: 2, starts_at: '2026-10-12T08:00:00Z' })
		await insertProject({ archived: true, rank: 5, starts_at: '2026-10-12T09:00:00Z' })
		await insertProject({ archived: false, rank: null })
		const within = inOrganizations('projects.read')
		expect(await invoke('query', (db) => call(db.within(within), 'projects.count'))).toBe(3)
		expect(await invoke('query', (db) => call(db.within(within), 'projects.count', { where: [['archived', '=', true]] }))).toBe(2)
		const groups = await invoke(
			'query',
			(db) =>
				call(db.within(within), 'projects.aggregate', { groupBy: ['archived'], count: true, sum: ['rank'], min: ['starts_at'], max: ['starts_at'] }),
		)
		const sorted = Array.isArray(groups) ? [...groups].sort((a, b) => Number(field(a, 'archived')) - Number(field(b, 'archived'))) : []
		expect(sorted).toEqual([
			{ archived: false, count: '1', sum_rank: null, min_starts_at: null, max_starts_at: null },
			{
				archived: true,
				count: '2',
				sum_rank: '7',
				min_starts_at: new Date('2026-10-12T08:00:00.000Z'),
				max_starts_at: new Date('2026-10-12T09:00:00.000Z'),
			},
		])
		const empty = await invoke('query', (db) => call(db.within(inOrganizations('projects.read', ['o2'])), 'projects.aggregate', { count: true }))
		expect(empty).toEqual([{ count: '0' }])
	})
})

describe('a keyset page over a nullable column', () => {
	/** Every page of the list, `limit` rows at a time, as the names of its rows. */
	async function pages(orderBy: unknown, limit: number): Promise<string[][]> {
		const within = inOrganizations('projects.read')
		const all: string[][] = []
		let after: unknown
		do {
			const page = await invoke('query', (db) => call(db.within(within), 'projects.list', { orderBy, limit, ...(after === undefined ? {} : { after }) }))
			all.push(itemsOf(page).map((row) => String(row['name'])))
			after = field(page, 'next')
		} while (after !== null)
		return all
	}

	beforeEach(async () => {
		for (const [name, rank] of [['c', 3], ['n1', null], ['a', 1], ['n2', null], ['b', 2]] as const) {
			await insertProject({ name, rank })
		}
	})

	test('ascending puts nulls last, as Postgres does, and no page skips or repeats a row', async () => {
		const ordered = await pages([['rank', 'asc'], ['name', 'asc']], 2)
		expect(ordered).toEqual([['a', 'b'], ['c', 'n1'], ['n2']])
	})

	test('descending puts nulls first, as Postgres does, and no page skips or repeats a row', async () => {
		const ordered = await pages([['rank', 'desc'], ['name', 'asc']], 2)
		expect(ordered).toEqual([['n1', 'n2'], ['c', 'b'], ['a']])
		expect((await pages([['rank', 'desc'], ['name', 'asc']], 1)).flat()).toEqual(['n1', 'n2', 'c', 'b', 'a'])
	})

	test('a page that ends inside the nulls continues among them', async () => {
		expect(await pages([['rank', 'asc'], ['name', 'desc']], 4)).toEqual([['a', 'b', 'c', 'n2'], ['n1']])
	})
})

describe('a scoped read still sees only its scope on SQLite', () => {
	test("a Within of one organization lists its projects and their events, never another organization's", async () => {
		const own = await insertProject({ name: 'own' }, 'o1')
		const other = await insertProject({ name: 'other' }, 'o2')
		await invoke('mutation', (db) => call(db.target(project('projects.write', own, 'o1'), 'on'), 'events.insert', { at: new Date(0), urgent: false }))
		await invoke('mutation', (db) => call(db.target(project('projects.write', other, 'o2'), 'on'), 'events.insert', { at: new Date(0), urgent: true }))
		const within = inOrganizations('projects.read', ['o1'])
		const projects = itemsOf(await invoke('query', (db) => call(db.within(within), 'projects.list')))
		expect(projects.map((row) => row['id'])).toEqual([own])
		const events = itemsOf(await invoke('query', (db) => call(db.within(within), 'events.list')))
		expect(events.map((row) => row['project_id'])).toEqual([own])
		expect(await invoke('query', (db) => call(db.within(within), 'events.count', { where: [['urgent', '=', true]] }))).toBe(0)
	})

	test("a project's Ref reads its own events only, and not another project's by key", async () => {
		const first = await insertProject({ name: 'first' })
		const second = await insertProject({ name: 'second' })
		await invoke('mutation', (db) => call(db.target(project('projects.write', first), 'on'), 'events.insert', { at: new Date(0), urgent: false }))
		const foreign = idOf(
			await invoke('mutation', (db) => call(db.target(project('projects.write', second), 'on'), 'events.insert', { at: new Date(0), urgent: true })),
		)
		const own = itemsOf(await invoke('query', (db) => call(db.target(project('projects.read', first), 'on'), 'events.list')))
		expect(own.map((row) => row['project_id'])).toEqual([first])
		await expect(invoke('query', (db) => call(db.target(project('projects.read', first), 'on'), 'events.get', foreign))).rejects.toThrow(
			'events not found',
		)
		// A Ref whose chain names another organization reaches nothing of the project.
		await expect(invoke('query', (db) => call(db.target(project('projects.read', first, 'o2'), 'on'), 'get'))).rejects.toThrow('projects not found')
	})
})

describe('ctx.sql on SQLite', () => {
	test('is refused before anything is sent, and fails the invocation', async () => {
		const transaction = data.invocation(false)
		let failed = false
		const tag = data.sql({
			mode: 'write',
			check() {},
			session: () => transaction.session(),
			fail() {
				failed = true
				transaction.fail()
			},
		})
		const error = await tag(z.object({ id: z.string() }))`select p.id from projects p`.catch((caught: unknown) => caught)
		expect(error).toBeInstanceOf(QueryRefusedError)
		expect(error).toMatchObject({ reason: 'sql_dialect' })
		expect(String(error)).toContain('raw SQL runs only on Postgres; an application on Cloudflare reads and writes through ctx.db')
		expect(failed).toBe(true)
		await transaction.rollback()
	})
})
