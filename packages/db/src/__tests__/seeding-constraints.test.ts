// What the isolation fixture writes where a schema constrains a row past one column: a CHECK over an IN list of numbers,
// a range, two columns tied to each other (`(a IS NULL) = (b IS NULL)`, `a <> b`, a value that requires another), a
// required foreign key to a row that needs its own rows several levels deep or lies in a scope of its own, and a unique
// index over foreign keys, a day or a boolean that rows seeded one after another must not repeat. The fixture tries the
// values a constraint names, null and fresh referenced rows, and the database judges each row; it never asks the schema
// to drop a constraint. On SQLite always, on Postgres when FABRIKA_TEST_POSTGRES_URL is set (it skips cleanly otherwise).

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bindScopedDatabase } from '../framework'
import { defineTables } from '../policy'
import { scoped } from '../store'
import { tableProbe, type TestDatabase, testDatabase as postgresDatabase } from '../testing'
import { testDatabase as sqliteDatabase } from '../testing-sqlite'
import type { TypedColumnList } from '../vocabulary-tables'
import { TestAuthority } from './fixtures/authority'

const migration = `
CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE memberships (
	id TEXT PRIMARY KEY,
	group_id TEXT NOT NULL REFERENCES groups (id),
	person_id TEXT NOT NULL REFERENCES people (id),
	UNIQUE (group_id, person_id)
);
CREATE TABLE profiles (id TEXT PRIMARY KEY, person_id TEXT NOT NULL UNIQUE REFERENCES people (id));
CREATE TABLE shipments (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('parcel', 'pallet')),
	tracking INTEGER UNIQUE CHECK (tracking > 0),
	CHECK ((kind = 'parcel') = (tracking IS NOT NULL))
);
CREATE TABLE rates (id TEXT PRIMARY KEY, percent INTEGER NOT NULL CHECK (percent IN (0, 10, 20)));
CREATE TABLE seasons (
	id TEXT PRIMARY KEY,
	year INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2100),
	week INTEGER NOT NULL CHECK (week >= 3 AND week <= 53)
);
CREATE TABLE claims (
	id TEXT PRIMARY KEY,
	witness_id TEXT REFERENCES people (id),
	witness_name TEXT CHECK (witness_name IS NULL OR length(witness_name) > 2),
	CHECK ((witness_id IS NULL) <> (witness_name IS NULL))
);
CREATE TABLE invoices (
	id TEXT PRIMARY KEY,
	supplier_id TEXT REFERENCES people (id),
	document_id UUID REFERENCES fabrika_files (id),
	CHECK ((supplier_id IS NULL) = (document_id IS NULL))
);
CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE variants (
	id TEXT PRIMARY KEY,
	item_id TEXT NOT NULL UNIQUE REFERENCES items (id),
	base_item_id TEXT NOT NULL REFERENCES items (id),
	CHECK (item_id <> base_item_id)
);
CREATE TABLE days (id TEXT PRIMARY KEY, day DATE NOT NULL UNIQUE);
CREATE TABLE flags (id TEXT PRIMARY KEY, flag BOOLEAN NOT NULL UNIQUE);
CREATE TABLE level1 (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE level2 (id TEXT PRIMARY KEY, up_id TEXT NOT NULL REFERENCES level1 (id), name TEXT NOT NULL, UNIQUE (up_id, name));
CREATE TABLE level3 (id TEXT PRIMARY KEY, up_id TEXT NOT NULL REFERENCES level2 (id));
CREATE TABLE level4 (id TEXT PRIMARY KEY, up_id TEXT NOT NULL REFERENCES level3 (id));
CREATE TABLE level5 (id TEXT PRIMARY KEY, up_id TEXT NOT NULL REFERENCES level4 (id));
CREATE TABLE level6 (id TEXT PRIMARY KEY, up_id TEXT NOT NULL REFERENCES level5 (id));
CREATE TABLE level7 (id TEXT PRIMARY KEY, up_id TEXT NOT NULL REFERENCES level6 (id));
CREATE TABLE boards (id TEXT PRIMARY KEY, title TEXT NOT NULL);
CREATE TABLE notes (id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES boards (id), body TEXT NOT NULL);
`

interface DB {
	people: { id: string; name: string }
	groups: { id: string; name: string }
	memberships: { id: string; group_id: string; person_id: string }
	profiles: { id: string; person_id: string }
	shipments: { id: string; kind: string; tracking: number | null }
	rates: { id: string; percent: number }
	seasons: { id: string; year: number; week: number }
	claims: { id: string; witness_id: string | null; witness_name: string | null }
	invoices: { id: string; supplier_id: string | null; document_id: string | null }
	items: { id: string; name: string }
	variants: { id: string; item_id: string; base_item_id: string }
	days: { id: string; day: string }
	flags: { id: string; flag: boolean }
	level1: { id: string; name: string }
	level2: { id: string; up_id: string; name: string }
	level3: { id: string; up_id: string }
	level4: { id: string; up_id: string }
	level5: { id: string; up_id: string }
	level6: { id: string; up_id: string }
	level7: { id: string; up_id: string }
	boards: { id: string; title: string }
	notes: { id: string; board_id: string; body: string }
}

const columns: TypedColumnList<DB> = {
	people: { columns: ['id', 'name'], foreignKeys: [] },
	groups: { columns: ['id', 'name'], foreignKeys: [] },
	memberships: {
		columns: ['id', 'group_id', 'person_id'],
		foreignKeys: [{ columns: ['group_id'], table: 'groups', references: ['id'] }, { columns: ['person_id'], table: 'people', references: ['id'] }],
	},
	profiles: { columns: ['id', 'person_id'], foreignKeys: [{ columns: ['person_id'], table: 'people', references: ['id'] }] },
	shipments: { columns: ['id', 'kind', 'tracking'], foreignKeys: [] },
	rates: { columns: ['id', 'percent'], foreignKeys: [] },
	seasons: { columns: ['id', 'year', 'week'], foreignKeys: [] },
	claims: { columns: ['id', 'witness_id', 'witness_name'], foreignKeys: [{ columns: ['witness_id'], table: 'people', references: ['id'] }] },
	invoices: { columns: ['id', 'supplier_id', 'document_id'], foreignKeys: [{ columns: ['supplier_id'], table: 'people', references: ['id'] }] },
	items: { columns: ['id', 'name'], foreignKeys: [] },
	variants: {
		columns: ['id', 'item_id', 'base_item_id'],
		foreignKeys: [{ columns: ['item_id'], table: 'items', references: ['id'] }, { columns: ['base_item_id'], table: 'items', references: ['id'] }],
	},
	days: { columns: ['id', 'day'], foreignKeys: [] },
	flags: { columns: ['id', 'flag'], foreignKeys: [] },
	level1: { columns: ['id', 'name'], foreignKeys: [] },
	level2: { columns: ['id', 'up_id', 'name'], foreignKeys: [{ columns: ['up_id'], table: 'level1', references: ['id'] }] },
	level3: { columns: ['id', 'up_id'], foreignKeys: [{ columns: ['up_id'], table: 'level2', references: ['id'] }] },
	level4: { columns: ['id', 'up_id'], foreignKeys: [{ columns: ['up_id'], table: 'level3', references: ['id'] }] },
	level5: { columns: ['id', 'up_id'], foreignKeys: [{ columns: ['up_id'], table: 'level4', references: ['id'] }] },
	level6: { columns: ['id', 'up_id'], foreignKeys: [{ columns: ['up_id'], table: 'level5', references: ['id'] }] },
	level7: { columns: ['id', 'up_id'], foreignKeys: [{ columns: ['up_id'], table: 'level6', references: ['id'] }] },
	boards: { columns: ['id', 'title'], foreignKeys: [] },
	notes: { columns: ['id', 'board_id', 'body'], foreignKeys: [{ columns: ['board_id'], table: 'boards', references: ['id'] }] },
}

const vocabulary = {
	dimensions: { board: {}, note: {} },
	actions: { 'rows.read': 'Read', 'rows.write': 'Write' },
} as const

function app<const I extends readonly string[] = []>(why: string, insert?: I) {
	return { scope: { app: why }, actions: { read: 'rows.read', insert: 'rows.write' }, insert: insert ?? [] } as const
}

const tables = defineTables(vocabulary, columns)({
	people: app('people'),
	groups: app('groups'),
	memberships: app('who is in a group', ['group_id', 'person_id']),
	profiles: app('one per person', ['person_id']),
	shipments: app('a kind ties the tracking number', ['kind', 'tracking']),
	rates: app('a rate is one of a list'),
	seasons: app('a year in a range'),
	claims: app('a witness by key or by name'),
	invoices: app('a supplier with its document'),
	items: app('items'),
	variants: app('a variant of another item'),
	days: app('one row a day'),
	flags: app('one row a flag'),
	level1: app('the root of a chain'),
	level2: app('a chain, two deep'),
	level3: app('a chain, three deep'),
	level4: app('a chain, four deep'),
	level5: app('a chain, five deep'),
	level6: app('a chain, six deep'),
	level7: app('a chain, seven deep'),
	boards: { scope: { dimension: 'board' }, actions: { read: 'rows.read' } },
	notes: { scope: { dimension: 'note' }, actions: { read: 'rows.read' } },
})

const directory = mkdtempSync(join(tmpdir(), 'fabrika-db-seeding-constraints-'))
writeFileSync(join(directory, '20261120120000_constraints.sql'), migration)
const label = 'seeding-constraints.test.ts'
const sqlite = await sqliteDatabase({ migrations: directory, label })
const postgres = await postgresDatabase({ migrations: directory, label })

afterAll(async () => {
	await sqlite.close()
	await postgres?.close()
	rmSync(directory, { recursive: true, force: true })
})

for (const [dialect, database] of [['SQLite', sqlite], ['Postgres', postgres]] as const) {
	describe.skipIf(database === null)(`the isolation seed over constraints that tie columns and rows, on ${dialect}`, () => {
		const authority = new TestAuthority()
		const layer = scoped(tables)
		const reads = authority.app('rows.read')
		let bound: TestDatabase | undefined
		const seeded = async (table: string, key: string): Promise<Readonly<Record<string, unknown>>> => {
			if (database === null) throw new Error('no database')
			if (bound !== database) {
				bindScopedDatabase(layer, { database: database.database, capabilities: authority })
				bound = database
			}
			return tableProbe(layer, table).get(reads, key)
		}
		const row = async (table: string): Promise<Readonly<Record<string, unknown>>> => {
			if (database === null) throw new Error('no database')
			const { key } = await database.seedRow(tables, table)
			return seeded(table, key)
		}

		test('a CHECK over an IN list of numbers, and a range, take a value they admit', async () => {
			expect([0, 10, 20]).toContain(Number((await row('rates'))['percent']))
			const season = await row('seasons')
			expect(Number(season['year'])).toBeGreaterThanOrEqual(2000)
			expect(Number(season['year'])).toBeLessThanOrEqual(2100)
			expect(Number(season['week'])).toBeGreaterThanOrEqual(3)
		})

		test('a value that requires another column fills both consistently', async () => {
			for (let round = 0; round < 3; round++) {
				const shipment = await row('shipments')
				expect(String(shipment['kind'])).toMatch(/^(?:parcel|pallet)$/)
				expect(shipment['kind'] === 'parcel').toBe(shipment['tracking'] !== null)
			}
		})

		test('two nullable columns a CHECK ties are both filled or one of them, as it asks', async () => {
			const claim = await row('claims')
			expect(claim['witness_id'] === null).not.toBe(claim['witness_name'] === null)
			// The document is a file column, which the fixture fills: the supplier then has to be there too.
			const invoice = await row('invoices')
			expect(invoice['supplier_id'] === null).toBe(invoice['document_id'] === null)
		})

		test('two foreign keys a CHECK keeps apart reference two rows', async () => {
			for (let round = 0; round < 2; round++) {
				const variant = await row('variants')
				expect(variant['item_id']).not.toBe(variant['base_item_id'])
			}
		})

		test('a required foreign key seeds the rows it needs, seven levels deep', async () => {
			expect((await row('level7'))['up_id']).toEqual(expect.any(String))
		})

		test('a unique index over foreign keys, a day or a boolean holds for every row seeded after another', async () => {
			for (let round = 0; round < 3; round++) {
				await row('memberships')
				await row('profiles')
			}
			const days = [await row('days'), await row('days')].map((seededDay) => seededDay['day'])
			expect(new Set(days).size).toBe(2)
			const flags = [await row('flags'), await row('flags')].map((seededFlag) => seededFlag['flag'])
			expect(new Set(flags).size).toBe(2)
		})

		test('a required foreign key to a dimension table seeds a row of it in a scope of its own', async () => {
			if (database === null) return
			const worlds = await database.seedWorlds(tables, 'notes')
			await seeded('people', (await database.seedRow(tables, 'people')).key)
			const own = await tableProbe(layer, 'notes').get(authority.ref('note', 'rows.read', worlds.own.key))
			const other = await tableProbe(layer, 'notes').get(authority.ref('note', 'rows.read', worlds.other.key))
			expect(own['board_id']).toEqual(expect.any(String))
			expect(own['board_id']).not.toBe(other['board_id'])
			await worlds.remove()
		})

		test('a probe insert takes values the constraints admit, again and again', async () => {
			if (database === null) return
			const write = authority.app('rows.write')
			for (const table of ['shipments', 'memberships', 'profiles']) {
				for (let round = 0; round < 2; round++) {
					await row(table)
					const values = await database.sampleInsert(tables, table)
					expect(await tableProbe(layer, table).insert(write, values)).toEqual(expect.objectContaining({ id: expect.any(String) }))
				}
			}
		})
	})
}
