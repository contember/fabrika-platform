// What the isolation fixture writes on SQLite where a schema constrains a column: a foreign key outside the containment
// chain, a CHECK as `sqlite_schema` stores it, a row named under another. A schema it cannot seed is a `SeedLimitError`
// that names the constraint, never a row the database refuses.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bindScopedDatabase } from '../framework'
import type { TypedColumnList } from '../index'
import { defineTables } from '../policy'
import { scoped } from '../store'
import { SeedLimitError, tableProbe, type TestDatabase, testDatabase } from '../testing-sqlite'
import { TestAuthority } from './fixtures/authority'

const migration = `
create table codes (code text primary key, label text not null);
insert into codes (code, label) values ('cz', 'Czechia'), ('sk', 'Slovakia');
create table colors (id uuid primary key default (lower(hex(randomblob(16)))), name text not null);
create table teams (
	id text primary key,
	name text not null,
	size text not null check (size in ('small', 'large')),
	mood text check (length(mood) > 40),
	code text not null references codes (code),
	backup_code text references codes (code),
	color_id uuid not null references colors (id),
	status text check (status in ('open', 'closed')),
	region text default 'sk' references codes (code),
	origin text not null default 'sk' references codes (code),
	-- a comment with check (kind in ('x')) in it
	"kind" text not null,
	constraint teams_kind check (("KIND") IN ('a,b', 'c)', 'it''s'))
);
create table team_tasks (
	id text primary key,
	team_id text not null references teams (id),
	title text not null
);
create table badges (id text primary key, code text not null constraint badges_code_check check (length(code) = 2));
create table stamps (id text primary key, code text not null check (length(code) = 3));
create table links (id text primary key, team_id text not null references teams (id));
`

interface DB {
	codes: { code: string; label: string }
	colors: { id: string; name: string }
	teams: {
		id: string
		name: string
		size: string
		mood: string | null
		code: string
		backup_code: string | null
		color_id: string
		status: string | null
		region: string | null
		origin: string
		kind: string
	}
	team_tasks: { id: string; team_id: string; title: string }
	badges: { id: string; code: string }
	stamps: { id: string; code: string }
	links: { id: string; team_id: string }
}

const columns: TypedColumnList<DB> = {
	codes: { columns: ['code', 'label'], foreignKeys: [] },
	colors: { columns: ['id', 'name'], foreignKeys: [] },
	teams: {
		columns: ['id', 'name', 'size', 'mood', 'code', 'backup_code', 'color_id', 'status', 'region', 'origin', 'kind'],
		foreignKeys: [
			{ columns: ['region'], table: 'codes', references: ['code'] },
			{ columns: ['origin'], table: 'codes', references: ['code'] },
			{ columns: ['code'], table: 'codes', references: ['code'] },
			{ columns: ['backup_code'], table: 'codes', references: ['code'] },
			{ columns: ['color_id'], table: 'colors', references: ['id'] },
		],
	},
	team_tasks: { columns: ['id', 'team_id', 'title'], foreignKeys: [{ columns: ['team_id'], table: 'teams', references: ['id'] }] },
	badges: { columns: ['id', 'code'], foreignKeys: [] },
	stamps: { columns: ['id', 'code'], foreignKeys: [] },
	links: { columns: ['id', 'team_id'], foreignKeys: [{ columns: ['team_id'], table: 'teams', references: ['id'] }] },
}

const vocabulary = {
	app: 'teams',
	dimensions: { team: {}, badge: {}, stamp: {}, link: {} },
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
	stamps: { scope: { dimension: 'stamp' }, actions: { read: 'teams.read' } },
	links: { scope: { dimension: 'link' }, actions: { read: 'teams.read' } },
})

describe('the isolation fixture over constrained columns on SQLite', () => {
	let sqlite: TestDatabase
	const authority = new TestAuthority()
	const layer = scoped(tables)
	const directory = mkdtempSync(join(tmpdir(), 'fabrika-db-sqlite-seed-limits-'))
	writeFileSync(join(directory, '20261014120000_teams.sql'), migration)

	beforeAll(async () => {
		sqlite = await testDatabase({ migrations: directory, label: 'testing-sqlite-seed-limits.test.ts' })
		bindScopedDatabase(layer, { database: sqlite.database, capabilities: authority })
	})

	afterAll(async () => {
		await sqlite.close()
		rmSync(directory, { recursive: true, force: true })
	})

	const team = (key: string): Promise<Readonly<Record<string, unknown>>> => tableProbe(layer, 'teams').get(authority.ref('team', 'teams.read', key))

	test('a foreign key outside the chain holds null where it may, else an existing or a seeded row of an unscoped table', async () => {
		const worlds = await sqlite.seedWorlds(tables, 'teams')
		const seeded = await team(worlds.own.key)
		expect(seeded).toMatchObject({ code: 'cz', backup_code: null, color_id: expect.stringMatching(/^[0-9a-f]{32}$/) })
		expect(worlds.own.markers).not.toContain(seeded['code'])
		expect(worlds.own.markers).not.toContain(seeded['color_id'])
	})

	test('a foreign key with a database default keeps it, nullable or required', async () => {
		const worlds = await sqlite.seedWorlds(tables, 'teams')
		expect(await team(worlds.own.key)).toMatchObject({ region: 'sk', origin: 'sk' })
	})

	test('an explicit null of a seed stays null, though a CHECK names the column', async () => {
		const worlds = await sqlite.seedWorlds(tables, 'teams', { status: null })
		expect(await team(worlds.own.key)).toMatchObject({ status: null })
		const unseeded = await sqlite.seedWorlds(tables, 'teams', { status: 'closed' })
		expect(await team(unseeded.own.key)).toMatchObject({ status: 'closed' })
	})

	test("a CHECK's IN list gives its first value, and a nullable column another CHECK names stays null", async () => {
		const worlds = await sqlite.seedWorlds(tables, 'teams')
		expect(await team(worlds.own.key)).toMatchObject({ size: 'small', mood: null })
		expect(worlds.own.updates).toMatchObject({ size: 'small', mood: null, backup_code: null })
	})

	test('a table CHECK over a quoted name, its literals holding a comma, a parenthesis and a quote, and a comment', async () => {
		const worlds = await sqlite.seedWorlds(tables, 'teams')
		expect(await team(worlds.own.key)).toMatchObject({ kind: 'a,b' })
		expect(worlds.own.markers).toHaveLength(1)
	})

	test('a seed may set a text column a CHECK lists the values of; a marked text column it may not', async () => {
		const worlds = await sqlite.seedWorlds(tables, 'teams', { size: 'large' })
		expect(await team(worlds.other.key)).toMatchObject({ size: 'large' })
		await expect(sqlite.seedWorlds(tables, 'teams', { name: 'Team' })).rejects.toThrow('holds a text marker')
	})

	test('a child row is seeded under a seeded row, in its chain, with markers of its own', async () => {
		const worlds = await sqlite.seedWorlds(tables, 'teams')
		const task = await sqlite.seedUnder(tables, 'team_tasks', worlds.own)
		const rows = await tableProbe(layer, 'team_tasks').select(authority.within('team', 'teams.read', [worlds.own.key]))
		expect(rows).toEqual([expect.objectContaining({ id: task.key, team_id: worlds.own.key })])
		expect(task.markers).toHaveLength(1)
		await expect(sqlite.seedUnder(tables, 'badges', worlds.own)).rejects.toThrow('badges does not lie in a team')
	})

	test('an unsatisfiable CHECK and a required key to a scoped table are generator limits, named', async () => {
		const badge = sqlite.seedWorlds(tables, 'badges')
		await expect(badge).rejects.toBeInstanceOf(SeedLimitError)
		await expect(sqlite.seedWorlds(tables, 'badges')).rejects.toThrow('cannot satisfy the CHECK badges_code_check of badges')
		await expect(sqlite.seedWorlds(tables, 'stamps')).rejects.toThrow('cannot satisfy the CHECK length(code) = 3 of stamps')
		await expect(sqlite.seedWorlds(tables, 'links')).rejects.toThrow(
			'cannot fill links.team_id: a required foreign key to teams outside the containment chain',
		)
	})

	test('a probe insert samples a required foreign key and an IN list too', async () => {
		expect(await sqlite.sampleInsert(tables, 'team_tasks')).toEqual({ title: expect.any(String) })
	})
})
