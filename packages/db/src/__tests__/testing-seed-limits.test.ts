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
insert into codes (code, label) values ('cz', 'Czechia'), ('sk', 'Slovakia');
create table colors (id uuid primary key default gen_random_uuid(), name text not null, active boolean not null default true);
create table shades (id uuid primary key, color_id uuid not null references colors (id), name text not null unique);
create table swatches (id text primary key, shade_id uuid not null references shades (id));
create table inks (id uuid primary key, name text not null);
create table prints (id uuid primary key, ink_id uuid not null references inks (id), copies int not null default 1 check (copies > 0));
create table ink_notes (id uuid primary key references inks (id), body text not null);
create table posters (id uuid primary key, image uuid not null references fabrika_files (id));
create table threads (id uuid primary key, pinned uuid);
create table posts (id uuid primary key, thread_id uuid not null references threads (id), parent uuid references posts (id));
alter table threads add foreign key (pinned) references posts (id);
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
	origin text not null default 'sk' references codes (code)
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
	colors: { id: string; name: string; active: boolean }
	shades: { id: string; color_id: string; name: string }
	swatches: { id: string; shade_id: string }
	inks: { id: string; name: string }
	prints: { id: string; ink_id: string; copies: number }
	ink_notes: { id: string; body: string }
	posters: { id: string; image: string }
	threads: { id: string; pinned: string | null }
	posts: { id: string; thread_id: string; parent: string | null }
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
	}
	team_tasks: { id: string; team_id: string; title: string }
	badges: { id: string; code: string }
	links: { id: string; team_id: string }
}

const columns: TypedColumnList<DB> = {
	codes: { columns: ['code', 'label'], foreignKeys: [] },
	colors: { columns: ['id', 'name', 'active'], foreignKeys: [] },
	shades: { columns: ['id', 'color_id', 'name'], foreignKeys: [{ columns: ['color_id'], table: 'colors', references: ['id'] }] },
	swatches: { columns: ['id', 'shade_id'], foreignKeys: [{ columns: ['shade_id'], table: 'shades', references: ['id'] }] },
	inks: { columns: ['id', 'name'], foreignKeys: [] },
	prints: { columns: ['id', 'ink_id', 'copies'], foreignKeys: [{ columns: ['ink_id'], table: 'inks', references: ['id'] }] },
	ink_notes: { columns: ['id', 'body'], foreignKeys: [{ columns: ['id'], table: 'inks', references: ['id'] }] },
	posters: { columns: ['id', 'image'], foreignKeys: [] },
	threads: { columns: ['id', 'pinned'], foreignKeys: [{ columns: ['pinned'], table: 'posts', references: ['id'] }] },
	posts: {
		columns: ['id', 'thread_id', 'parent'],
		foreignKeys: [{ columns: ['thread_id'], table: 'threads', references: ['id'] }, { columns: ['parent'], table: 'posts', references: ['id'] }],
	},
	teams: {
		columns: ['id', 'name', 'size', 'mood', 'code', 'backup_code', 'color_id', 'status', 'region', 'origin'],
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
	shades: { scope: { app: 'the shades of a color' }, actions: { read: 'teams.read' } },
	swatches: { scope: { app: 'the swatches a handler cuts of a shade' }, actions: { read: 'teams.read' } },
	inks: { scope: { app: 'the inks a print takes' }, actions: { read: 'teams.read' } },
	prints: { scope: { app: 'the prints of an ink' }, actions: { read: 'teams.read' } },
	ink_notes: { scope: { app: "an ink's note, keyed by its ink" }, actions: { read: 'teams.read' } },
	posters: { scope: { app: 'the posters of the app' }, actions: { read: 'teams.read' }, files: { image: 'posters' } },
	threads: { scope: { app: 'the threads of the app' }, actions: { read: 'teams.read' } },
	posts: { scope: { app: 'the posts of a thread' }, actions: { read: 'teams.read' } },
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

	test('a foreign key with a database default keeps it, nullable or required', async () => {
		const worlds = await postgres.seedWorlds(tables, 'teams')
		expect(await row('teams', worlds.own.key)).toMatchObject({ region: 'sk', origin: 'sk' })
	})

	test('an explicit null of a seed stays null, though a CHECK names the column', async () => {
		const worlds = await postgres.seedWorlds(tables, 'teams', { status: null })
		expect(await row('teams', worlds.own.key)).toMatchObject({ status: null })
		const unseeded = await postgres.seedWorlds(tables, 'teams', { status: 'closed' })
		expect(await row('teams', unseeded.own.key)).toMatchObject({ status: 'closed' })
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

	test("an application row takes the author's values, a text column's too, but not its key", async () => {
		const color = await postgres.seedRow(tables, 'colors', { active: false })
		expect(await row('colors', color.key)).toMatchObject({ active: false })
		expect(color.markers).toHaveLength(1)
		const named = await postgres.seedRow(tables, 'colors', { name: 'Red' })
		expect(await row('colors', named.key)).toMatchObject({ name: 'Red', active: true })
		expect(named.markers).toEqual([])
		await expect(postgres.seedRow(tables, 'colors', { id: crypto.randomUUID() })).rejects.toThrow("the row's key, version or creator")
		await expect(postgres.seedRow(tables, 'colors', { shade: 'dark' })).rejects.toThrow('colors.shade is no column')
	})

	test('application rows seeded together are linked by their foreign keys and removed with the rows that refer to them', async () => {
		const seeded = await postgres.seedApplicationRows(tables, { shades: { name: 'Dark red' }, colors: { name: 'Red' } })
		const color = seeded.keys['colors'] ?? ''
		const shade = seeded.keys['shades'] ?? ''
		expect(await row('shades', shade)).toMatchObject({ color_id: color, name: 'Dark red' })
		// What a handler writes about the rows: a second shade of the color, and a swatch of the given shade.
		const sql = new SQL({ url, adapter: 'postgres', max: 1 })
		try {
			await sql.unsafe(`INSERT INTO ${postgres.schema}.shades (id, color_id, name) VALUES ($1, $2, 'Pink')`, [crypto.randomUUID(), color])
			await sql.unsafe(`INSERT INTO ${postgres.schema}.swatches (id, shade_id) VALUES ('s1', $1)`, [shade])
			await seeded.remove()
			const left: unknown = await sql.unsafe(
				`SELECT (SELECT count(*) FROM ${postgres.schema}.colors WHERE id = $1)::int AS colors, (SELECT count(*) FROM ${postgres.schema}.shades)::int AS shades, (SELECT count(*) FROM ${postgres.schema}.swatches)::int AS swatches`,
				[color],
			)
			expect(left).toEqual([{ colors: 0, shades: 0, swatches: 0 }])
		} finally {
			await sql.close()
		}
		// The unique name is free again for the next case's row.
		const again = await postgres.seedApplicationRows(tables, { colors: {}, shades: { name: 'Dark red' } })
		await again.remove()
		await expect(postgres.seedApplicationRows(tables, { teams: {} })).rejects.toThrow('an application row is seeded only in an application table')
	})

	test('application rows leave nothing behind: not the row a required foreign key needed, nor a seed that failed partway', async () => {
		const sql = new SQL({ url, adapter: 'postgres', max: 1 })
		const count = async (table: string): Promise<unknown> => {
			const rows: unknown = await sql.unsafe(`SELECT count(*)::int AS n FROM ${postgres.schema}.${table}`)
			return rows
		}
		try {
			// No ink is given, so the print's required key makes the fixture insert one, and the removal deletes it too.
			const print = await postgres.seedApplicationRows(tables, { prints: {} })
			expect(await count('inks')).toEqual([{ n: 1 }])
			await print.remove()
			expect(await count('inks')).toEqual([{ n: 0 }])
			// A value no table takes is refused before the first insert; a CHECK the print fails removes the ink seeded before it.
			await expect(postgres.seedApplicationRows(tables, { inks: {}, prints: { colour: 'red' } })).rejects.toThrow('prints.colour is no column')
			await expect(postgres.seedApplicationRows(tables, { inks: {}, prints: { copies: 0 } })).rejects.toThrow(SeedLimitError)
			expect(await count('inks')).toEqual([{ n: 0 }])
			// A table keyed by the row it refers to keeps that key, and is found and removed by it.
			const noted = await postgres.seedApplicationRows(tables, { ink_notes: {}, inks: {} })
			expect(noted.keys['ink_notes']).toBe(noted.keys['inks'] ?? '')
			await noted.remove()
			expect([await count('inks'), await count('ink_notes')]).toEqual([[{ n: 0 }], [{ n: 0 }]])
			// The live file a file column holds goes with its row.
			const poster = await postgres.seedApplicationRows(tables, { posters: {} })
			const files = `SELECT count(*)::int AS n FROM ${postgres.schema}.fabrika_files WHERE kind = 'posters'`
			expect(await sql.unsafe(files)).toEqual([{ n: 1 }])
			await poster.remove()
			expect([await count('posters'), await sql.unsafe(files)]).toEqual([[{ n: 0 }], [{ n: 0 }]])
		} finally {
			await sql.close()
		}
	})

	test('a cycle the values break is seeded, and rows that refer to each other, however deep, are removed together', async () => {
		await expect(postgres.seedApplicationRows(tables, { threads: {}, posts: {} })).rejects.toThrow('form a cycle')
		const seeded = await postgres.seedApplicationRows(tables, { threads: { pinned: null }, posts: {} })
		const thread = seeded.keys['threads'] ?? ''
		expect(await row('posts', seeded.keys['posts'] ?? '')).toMatchObject({ thread_id: thread, parent: null })
		// What a handler writes: twenty replies, each to the one before, and the thread pins the last.
		const sql = new SQL({ url, adapter: 'postgres', max: 1 })
		try {
			let parent = seeded.keys['posts'] ?? ''
			for (let reply = 0; reply < 20; reply++) {
				const id = crypto.randomUUID()
				await sql.unsafe(`INSERT INTO ${postgres.schema}.posts (id, thread_id, parent) VALUES ($1, $2, $3)`, [id, thread, parent])
				parent = id
			}
			await sql.unsafe(`UPDATE ${postgres.schema}.threads SET pinned = $1 WHERE id = $2`, [parent, thread])
			await seeded.remove()
			const left: unknown = await sql.unsafe(
				`SELECT (SELECT count(*) FROM ${postgres.schema}.threads)::int AS threads, (SELECT count(*) FROM ${postgres.schema}.posts)::int AS posts`,
			)
			expect(left).toEqual([{ threads: 0, posts: 0 }])
		} finally {
			await sql.close()
		}
	})

	test('a probe insert samples a required foreign key and an IN list too', async () => {
		expect(await postgres.sampleInsert(tables, 'team_tasks')).toEqual({ title: expect.any(String) })
	})
})
