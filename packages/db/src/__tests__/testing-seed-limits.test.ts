// What the isolation fixture writes where a schema constrains a column: a foreign key outside the containment chain, a
// CHECK, a row named under another. A schema it cannot seed is a `SeedLimitError` that names the constraint, never a
// row the database refuses. Needs FABRIKA_TEST_POSTGRES_URL and skips cleanly without it.

import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TypedColumnList } from '../index'
import { defineTables } from '../policy'
import { SeedLimitError, type TestDatabase, testDatabase } from '../testing'

const url = process.env['FABRIKA_TEST_POSTGRES_URL'] ?? ''
const hasPostgres = url !== ''

if (!hasPostgres) {
	console.warn('testing-seed-limits.test.ts skipped: set FABRIKA_TEST_POSTGRES_URL to run the Postgres-backed tests')
}

const migration = `
create table codes (code text primary key, label text not null);
insert into codes (code, label) values ('cz', 'Czechia');
create table colors (id uuid primary key default gen_random_uuid(), name text not null);
create table teams (
	id text primary key,
	name text not null,
	size text not null check (size in ('small', 'large')),
	mood text check (length(mood) > 40),
	code text not null references codes (code),
	backup_code text references codes (code),
	color_id uuid not null references colors (id)
);
create table team_tasks (
	id text primary key,
	team_id text not null references teams (id),
	title text not null
);
create table badges (id text primary key, code text not null check (length(code) = 2));
create table links (id text primary key, team_id text not null references teams (id));
`

interface DB {
	codes: { code: string; label: string }
	colors: { id: string; name: string }
	teams: { id: string; name: string; size: string; mood: string | null; code: string; backup_code: string | null; color_id: string }
	team_tasks: { id: string; team_id: string; title: string }
	badges: { id: string; code: string }
	links: { id: string; team_id: string }
}

const columns: TypedColumnList<DB> = {
	codes: { columns: ['code', 'label'], foreignKeys: [] },
	colors: { columns: ['id', 'name'], foreignKeys: [] },
	teams: {
		columns: ['id', 'name', 'size', 'mood', 'code', 'backup_code', 'color_id'],
		foreignKeys: [
			{ columns: ['code'], table: 'codes', references: ['code'] },
			{ columns: ['backup_code'], table: 'codes', references: ['code'] },
			{ columns: ['color_id'], table: 'colors', references: ['id'] },
		],
	},
	team_tasks: { columns: ['id', 'team_id', 'title'], foreignKeys: [{ columns: ['team_id'], table: 'teams', references: ['id'] }] },
	badges: { columns: ['id', 'code'], foreignKeys: [] },
	links: { columns: ['id', 'team_id'], foreignKeys: [{ columns: ['team_id'], table: 'teams', references: ['id'] }] },
}

const vocabulary = {
	app: 'teams',
	dimensions: { team: {}, badge: {}, link: {} },
	actions: { 'teams.read': 'Read', 'teams.write': 'Write' },
	roles: {},
} as const

const tables = defineTables(vocabulary, columns)({
	codes: { scope: { reference: 'a code list' }, actions: { read: 'teams.read' } },
	colors: { scope: { app: 'the palette' }, actions: { read: 'teams.read' } },
	teams: {
		scope: { dimension: 'team' },
		actions: { read: 'teams.read', update: 'teams.write' },
		update: ['size', 'mood', 'backup_code'],
	},
	team_tasks: { scope: { child: 'teams' }, actions: { read: 'teams.read', insert: 'teams.write' }, insert: ['title'] },
	badges: { scope: { dimension: 'badge' }, actions: { read: 'teams.read' } },
	links: { scope: { dimension: 'link' }, actions: { read: 'teams.read' } },
})

describe.skipIf(!hasPostgres)('the isolation fixture over constrained columns', () => {
	let postgres: TestDatabase
	const directory = mkdtempSync(join(tmpdir(), 'fabrika-db-seed-limits-'))
	writeFileSync(join(directory, '20261014120000_teams.sql'), migration)

	beforeAll(async () => {
		const opened = await testDatabase({ migrations: directory, label: 'testing-seed-limits.test.ts' })
		if (opened === null) throw new Error('a test database was expected')
		postgres = opened
	})

	afterAll(async () => {
		await postgres.close()
		rmSync(directory, { recursive: true, force: true })
	})

	const row = async (table: string, key: string): Promise<Record<string, unknown>> => {
		const sql = new SQL({ url, adapter: 'postgres', max: 1 })
		try {
			const rows: unknown = await sql.unsafe(`SELECT * FROM ${postgres.schema}.${table} WHERE id = $1`, [key])
			if (!Array.isArray(rows) || typeof rows[0] !== 'object' || rows[0] === null) throw new Error(`no ${table} row ${key}`)
			return { ...rows[0] }
		} finally {
			await sql.close()
		}
	}

	test('a foreign key outside the chain holds null where it may, else an existing or a seeded row of an unscoped table', async () => {
		const worlds = await postgres.seedWorlds(tables, 'teams')
		const seeded = await row('teams', worlds.own.key)
		expect(seeded).toMatchObject({ code: 'cz', backup_code: null, color_id: expect.any(String) })
		expect(worlds.own.markers).not.toContain(seeded['code'])
		expect(worlds.own.markers).not.toContain(seeded['color_id'])
	})

	test("a CHECK's IN list gives its first value, and a nullable column another CHECK names stays null", async () => {
		const worlds = await postgres.seedWorlds(tables, 'teams')
		expect(await row('teams', worlds.own.key)).toMatchObject({ size: 'small', mood: null })
		expect(worlds.own.updates).toMatchObject({ size: 'small', mood: null, backup_code: null })
	})

	test('a seed may set a text column a CHECK lists the values of; a marked text column it may not', async () => {
		const worlds = await postgres.seedWorlds(tables, 'teams', { size: 'large' })
		expect(await row('teams', worlds.other.key)).toMatchObject({ size: 'large' })
		await expect(postgres.seedWorlds(tables, 'teams', { name: 'Team' })).rejects.toThrow('holds a text marker')
	})

	test('a child row is seeded under a seeded row, in its chain, with markers of its own', async () => {
		const worlds = await postgres.seedWorlds(tables, 'teams')
		const task = await postgres.seedUnder(tables, 'team_tasks', worlds.own)
		expect(await row('team_tasks', task.key)).toMatchObject({ team_id: worlds.own.key })
		expect(task.markers).toHaveLength(1)
		await expect(postgres.seedUnder(tables, 'badges', worlds.own)).rejects.toThrow('badges does not lie in a team')
	})

	test('an unsatisfiable CHECK and a required key to a scoped table are generator limits, named', async () => {
		const badge = postgres.seedWorlds(tables, 'badges')
		await expect(badge).rejects.toBeInstanceOf(SeedLimitError)
		await expect(postgres.seedWorlds(tables, 'badges')).rejects.toThrow('cannot satisfy the CHECK badges_code_check of badges')
		await expect(postgres.seedWorlds(tables, 'links')).rejects.toThrow(
			'cannot fill links.team_id: a required foreign key to teams outside the containment chain',
		)
	})

	test('a probe insert samples a required foreign key and an IN list too', async () => {
		expect(await postgres.sampleInsert(tables, 'team_tasks')).toEqual({ title: expect.any(String) })
	})
})
