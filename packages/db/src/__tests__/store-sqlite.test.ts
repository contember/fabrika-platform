// The stores and the table probe on SQLite (ADR-0065), over a bun:sqlite stand-in for a Durable Object's storage: a
// select, a join and an aggregate answer the values they answer on Postgres, and the fixture's column list is the one
// `generateSqliteSchema` renders for its migration.

import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Ref, Within } from '../capability'
import { generateSqliteSchema } from '../codegen-sqlite'
import { bindScopedDatabase } from '../framework'
import { openSqlite } from '../sqlite'
import { bunSqliteStorage } from '../sqlite-bun'
import { defineChildStore, defineStore, scoped } from '../store'
import { tableProbe } from '../testing'
import { TestAuthority } from './fixtures/authority'
import { sqliteColumns, sqliteMigration, sqliteTables } from './fixtures/sqlite-layer'

const alice = new TestAuthority('user:alice')

function open() {
	const storage = bunSqliteStorage()
	storage.sql.exec(sqliteMigration)
	storage.sql.exec("insert into organizations (id, name) values ('o1', 'One'), ('o2', 'Two')")
	const database = scoped(sqliteTables)
	bindScopedDatabase(database, { database: openSqlite(storage), capabilities: alice })
	const projects = defineStore(database, 'projects', (t) => ({
		create: (organization: Ref<'organization', 'projects.write'>, values: Parameters<typeof t.insert>[1]) => t.insert(organization, values),
		get: (ref: Ref<'project', 'projects.read'>) => t.get(ref),
		withEvents: (within: Within<'organization', 'projects.read'>) =>
			t.select(within, (q) =>
				q.columns(['id', 'name', 'starts_at', 'archived'])
					.where('starts_at', '<', new Date('2026-10-12T10:45:00+02:00'))
					.join('events', (c) => c.columns(['at', 'urgent']).where('at', '>=', new Date('2026-10-12T10:00:00+02:00')))
					.orderBy('name')),
		ranked: (within: Within<'organization', 'projects.read'>) => t.select(within, (q) => q.columns(['name', 'rank']).orderBy('rank').orderBy('name')),
		byArchived: (within: Within<'organization', 'projects.read'>) =>
			t.aggregate(within, { groupBy: ['archived'], count: true, sum: ['rank'], min: ['due_on'], max: ['starts_at'] }),
	}))
	const events = defineChildStore(database, 'events', (t) => ({
		add: (parent: Ref<'project', 'projects.write'>, values: Parameters<typeof t.insert>[1]) => t.insert(parent, values),
	}))
	return { database, projects, events }
}

let stores: ReturnType<typeof open>

beforeEach(() => {
	stores = open()
})

const organization = (id = 'o1') => alice.ref('organization', 'projects.write', id)
const project = <const A extends string>(action: A, id: string, org = 'o1') => alice.ref('project', action, id, { organization: org })
const within = (ids: readonly string[] = ['o1']) => alice.within('organization', 'projects.read', ids)

describe('a store on SQLite', () => {
	test('get answers a Date, a boolean and a day', async () => {
		const { id } = await stores.projects.create(organization(), {
			name: 'p',
			archived: true,
			due_on: '2026-10-12',
			starts_at: '2026-10-12T10:30:00+02:00',
		})
		expect(await stores.projects.get(project('projects.read', id))).toMatchObject({
			archived: true,
			due_on: '2026-10-12',
			starts_at: new Date('2026-10-12T08:30:00.000Z'),
		})
	})

	test("a join answers the child's timestamp and boolean under their alias, and compares each table's timestamp by time", async () => {
		const early = await stores.projects.create(organization(), { name: 'early', starts_at: '2026-10-12T10:30:00+02:00' })
		await stores.projects.create(organization(), { name: 'late', starts_at: '2026-10-12T09:00:00Z' })
		await stores.events.add(project('projects.write', early.id), { at: '2026-10-12T08:15:00Z', urgent: true })
		await stores.events.add(project('projects.write', early.id), { at: '2026-10-12T07:45:00Z', urgent: false })
		expect(await stores.projects.withEvents(within())).toEqual([
			{
				id: early.id,
				name: 'early',
				starts_at: new Date('2026-10-12T08:30:00.000Z'),
				archived: false,
				'events.at': new Date('2026-10-12T08:15:00.000Z'),
				'events.urgent': true,
			},
		])
	})

	test('an order puts nulls last ascending, as Postgres does', async () => {
		for (const [name, rank] of [['b', null], ['c', 1], ['a', null], ['d', 0]] as const) {
			await stores.projects.create(organization(), { name, rank })
		}
		expect((await stores.projects.ranked(within())).map((row) => row.name)).toEqual(['d', 'c', 'a', 'b'])
	})

	test('an aggregate answers count and an integer sum as text, a day as YYYY-MM-DD and a timestamp as a Date', async () => {
		await stores.projects.create(organization(), { name: 'a', archived: true, rank: 2, due_on: '2026-10-20', starts_at: '2026-10-12T08:00:00Z' })
		await stores.projects.create(organization(), { name: 'b', archived: true, rank: 3, due_on: '2026-10-12', starts_at: '2026-10-12T11:00:00+02:00' })
		await stores.projects.create(organization(), { name: 'c', archived: false })
		const groups = await stores.projects.byArchived(within())
		expect([...groups].sort((left, right) => Number(left.archived) - Number(right.archived))).toEqual([
			{ archived: false, count: '1', sum_rank: null, min_due_on: null, max_starts_at: null },
			{ archived: true, count: '2', sum_rank: '5', min_due_on: '2026-10-12', max_starts_at: new Date('2026-10-12T09:00:00.000Z') },
		])
		expect(await stores.projects.byArchived(within(['o2']))).toEqual([])
	})
})

describe('the table probe on SQLite', () => {
	test("counts and groups an organization's rows with the count as text, and nothing of another's", async () => {
		await stores.projects.create(organization('o1'), { name: 'a', archived: true })
		await stores.projects.create(organization('o1'), { name: 'b', archived: false })
		await stores.projects.create(organization('o2'), { name: 'c', archived: true })
		const probe = tableProbe(stores.database, 'projects')
		expect(await probe.count(within(['o1']))).toBe('2')
		expect(await probe.count(within(['o2']))).toBe('1')
		const groups = await probe.group(within(['o1']), ['archived'])
		expect([...groups].sort((left, right) => Number(left['archived']) - Number(right['archived']))).toEqual([
			{ archived: false, count: '1' },
			{ archived: true, count: '1' },
		])
	})
})

test("the fixture's column list is what generateSqliteSchema renders for its migration", async () => {
	const rendered = await generateSqliteSchema([{ bundle: 'app', migrations: [{ name: '0001_init.sql', sql: sqliteMigration }] }])
	const directory = await mkdtemp(join(tmpdir(), 'sqlite-layer-'))
	try {
		const file = join(directory, 'schema.generated.ts')
		await writeFile(file, rendered)
		const generated: unknown = await import(file)
		expect(typeof generated === 'object' && generated !== null ? Reflect.get(generated, 'columns') : undefined).toEqual(sqliteColumns)
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})
