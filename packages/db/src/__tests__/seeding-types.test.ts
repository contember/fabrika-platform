// The isolation fixture's seed over the column types the generated tests meet in applications: a required date and
// timestamp, and an updatable column the seed leaves to its default. Needs FABRIKA_TEST_POSTGRES_URL; skips without it.

import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTables } from '../policy'
import { type TestDatabase, testDatabase } from '../testing'
import type { TypedColumnList } from '../vocabulary-tables'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''

if (!hasPostgres) {
	console.warn(`seeding-types.test.ts skipped: set ${URL_VAR} to run the Postgres-backed tests`)
}

const migration = `
CREATE TABLE tasks (
	id UUID PRIMARY KEY,
	project_id TEXT NOT NULL,
	title TEXT NOT NULL,
	due_on DATE NOT NULL,
	remind_at TIMESTAMPTZ NOT NULL,
	priority INTEGER NOT NULL DEFAULT 3,
	version INTEGER NOT NULL
);
`

interface DB {
	tasks: {
		id: string
		project_id: string
		title: string
		due_on: Date
		remind_at: Date
		priority: number
		version: number
	}
}

const columns: TypedColumnList<DB> = { tasks: ['id', 'project_id', 'title', 'due_on', 'remind_at', 'priority', 'version'] }
const vocabulary = {
	dimensions: { project: {}, task: { in: 'project' } },
	actions: { 'tasks.read': 'Read tasks', 'tasks.write': 'Write tasks' },
} as const

const tables = defineTables(vocabulary, columns)({
	tasks: {
		scope: { dimension: 'task', key: 'id', in: { dimension: 'project', column: 'project_id' } },
		actions: { read: 'tasks.read', insert: 'tasks.write', update: 'tasks.write', delete: 'tasks.write' },
		insert: ['title', 'due_on', 'remind_at', 'priority'],
		update: ['title', 'due_on', 'remind_at', 'priority'],
		version: 'version',
	},
})

const migrations = mkdtempSync(join(tmpdir(), 'fabrika-db-seeding-'))
writeFileSync(join(migrations, '20261009120000_tasks.sql'), migration)

afterAll(() => {
	rmSync(migrations, { recursive: true, force: true })
})

describe.skipIf(!hasPostgres)('the isolation seed on Postgres', () => {
	let postgres: TestDatabase

	beforeAll(async () => {
		const opened = await testDatabase({ migrations, label: 'seeding-types.test.ts' })
		if (opened === null) {
			throw new Error('a test database was expected')
		}
		postgres = opened
	})

	afterAll(() => postgres.close())

	test('a required date and timestamp column are seeded with a value Postgres accepts', async () => {
		const worlds = await postgres.seedWorlds(tables, 'tasks')
		const sql = new SQL({ url, adapter: 'postgres', max: 1 })
		try {
			const rows: unknown = await sql.unsafe(`SELECT due_on, remind_at FROM ${postgres.schema}.tasks WHERE id = $1`, [worlds.own.key])
			expect(rows).toEqual([{ due_on: expect.any(Date), remind_at: expect.any(Date) }])
		} finally {
			await sql.close()
		}
	})

	test('an updatable column the seed left to its default is updated with a sample, never with null', async () => {
		const worlds = await postgres.seedWorlds(tables, 'tasks')
		expect(worlds.own.updates['priority']).toBe(1)
		expect(worlds.own.updates['due_on']).toEqual(expect.any(String))
	})
})
