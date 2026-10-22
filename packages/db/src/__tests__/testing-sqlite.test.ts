// `@fabrika/db/testing-sqlite`: the test database on SQLite, the isolation fixtures over it and the table probe. It
// needs no backend, so nothing here skips. The release and production refusals run in a child process.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CapabilityError, QueryRefusedError } from '../errors'
import { bindScopedDatabase } from '../framework'
import { defineTables } from '../policy'
import { scoped } from '../store'
import { tableProbe, type TestDatabase, testDatabase, type WorldRow } from '../testing-sqlite'
import type { TypedColumnList } from '../vocabulary-tables'
import { TestAuthority } from './fixtures/authority'
import { tables } from './fixtures/tables'

/** The Postgres fixture's schema (`fixtures/schema.ts`) in SQLite's forms. */
const migration = `
create table organizations (id text primary key, name text not null);
create table workspaces (
	id text primary key,
	organization_id text not null references organizations (id),
	name text not null,
	created_by text not null,
	unique (id, organization_id)
);
create table notes (
	id text primary key,
	workspace_id text not null,
	organization_id text not null,
	title text not null,
	body text,
	word_count integer not null default 0,
	internal text,
	created_by text not null,
	version integer not null,
	created_at timestamp not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	unique (id, workspace_id, organization_id),
	foreign key (workspace_id, organization_id) references workspaces (id, organization_id) on update cascade
);
create table note_comments (
	id text primary key,
	note_id text not null,
	workspace_id text not null,
	organization_id text not null,
	body text not null,
	foreign key (note_id, workspace_id, organization_id) references notes (id, workspace_id, organization_id) on update cascade on delete cascade
);
create table note_flags (
	id text primary key,
	note_id text not null,
	workspace_id text not null,
	organization_id text not null,
	reason text not null,
	foreign key (note_id, workspace_id, organization_id) references notes (id, workspace_id, organization_id) on update cascade on delete cascade
);
create table secrets (id text primary key, value text not null);
create table settings (id text primary key, value text not null);
create table countries (code text primary key, name text not null);
`

const migrations = mkdtempSync(join(tmpdir(), 'fabrika-db-testing-sqlite-'))
writeFileSync(join(migrations, '20261009120000_init.sql'), migration)

afterAll(() => {
	rmSync(migrations, { recursive: true, force: true })
})

type ChildResult = { readonly code: number; readonly stdout: string; readonly stderr: string }

/** Runs `lines` as a Bun program in a child process with only `env` set. */
async function runChild(lines: readonly string[], env: Readonly<Record<string, string>>): Promise<ChildResult> {
	const child = Bun.spawn(['bun', '-e', lines.join('\n')], {
		cwd: join(import.meta.dir, '..', '..'),
		env: { PATH: process.env['PATH'] ?? '', ...env },
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
	return { code, stdout, stderr }
}

/** Every value a seeded row holds of its place and its text: its key, its chain and its markers. */
function valuesOf(row: WorldRow): string[] {
	return [row.key, row.scope, ...row.chain.map((link) => link.value), ...row.markers]
}

describe('where the kit loads', () => {
	test('it needs no backend: without FABRIKA_TEST_POSTGRES_URL it answers a database, and prints no skip', async () => {
		const result = await runChild([
			"const { testDatabase } = await import('@fabrika/db/testing-sqlite')",
			`const database = await testDatabase({ migrations: ${JSON.stringify(migrations)}, label: 'child.test.ts' })`,
			"console.log(database === null ? 'null' : database.schema)",
			'await database.close()',
		], {})
		expect(result).toMatchObject({ code: 0, stdout: 'main\n', stderr: '' })
	})

	test('the kit refuses to load in a release', async () => {
		const result = await runChild(["await import('@fabrika/db/testing-sqlite')"], { FABRIKA_RELEASE: 'r1' })
		expect(result.code).not.toBe(0)
		expect(result.stderr).toContain('@fabrika/db/testing-sqlite is a test helper and does not load in a release (FABRIKA_RELEASE is set)')
	})

	test('the kit refuses to load once the process is marked', async () => {
		const result = await runChild([
			"const { markProductionProcess } = await import('@fabrika/db/production')",
			'markProductionProcess()',
			"await import('@fabrika/db/testing-sqlite')",
		], {})
		expect(result.code).not.toBe(0)
		expect(result.stderr).toContain('@fabrika/db/testing-sqlite is a test helper; this process serves an application')
	})

	test('a kit loaded before the mark refuses to run after it', async () => {
		const result = await runChild([
			"const { testDatabase, tableProbe } = await import('@fabrika/db/testing-sqlite')",
			"const { markProductionProcess } = await import('@fabrika/db/production')",
			'markProductionProcess()',
			'const refused = (run) => { try { run(); return false } catch (error) { return String(error).includes("serves an application") } }',
			`const database = await testDatabase({ migrations: ${
				JSON.stringify(migrations)
			}, label: 'child.test.ts' }).then(() => false, (error) => String(error).includes('serves an application'))`,
			"console.log(JSON.stringify([database, refused(() => tableProbe({}, 'notes'))]))",
		], {})
		expect(result).toMatchObject({ code: 0, stdout: '[true,true]\n' })
	})
})

describe('the migrations', () => {
	test('a migration that fails rejects, naming it', async () => {
		const failing = mkdtempSync(join(tmpdir(), 'fabrika-db-testing-sqlite-failing-'))
		writeFileSync(join(failing, '20261009120000_partial.sql'), 'CREATE TABLE partial (id TEXT); SELECT * FROM missing_table;')
		try {
			await expect(testDatabase({ migrations: failing, label: 'failing.test.ts' })).rejects.toThrow(
				'SQLite migration app/20261009120000_partial.sql failed',
			)
		} finally {
			rmSync(failing, { recursive: true, force: true })
		}
	})

	test('a missing directory is refused', async () => {
		await expect(testDatabase({ migrations: join(migrations, 'missing'), label: 'missing.test.ts' })).rejects.toThrow('No migrations directory at')
	})

	test('every database is a fresh one', async () => {
		const first = await testDatabase({ migrations, label: 'first.test.ts' })
		const second = await testDatabase({ migrations, label: 'second.test.ts' })
		try {
			const worlds = await first.seedWorlds(tables, 'organizations')
			const layer = scoped(tables)
			const authority = new TestAuthority()
			bindScopedDatabase(layer, { database: second.database, capabilities: authority })
			const probe = tableProbe(layer, 'organizations')
			expect(await probe.count(authority.within('organization', 'notes.read', [worlds.own.key, worlds.other.key]))).toBe('0')
		} finally {
			await first.close()
			await second.close()
		}
	})
})

describe('a test database on SQLite', () => {
	let sqlite: TestDatabase
	const authority = new TestAuthority()
	const layer = scoped(tables)

	beforeAll(async () => {
		sqlite = await testDatabase({ migrations, label: 'testing-sqlite.test.ts' })
		bindScopedDatabase(layer, { database: sqlite.database, capabilities: authority })
	})

	afterAll(() => sqlite.close())

	test("is migrated by the object's runner, the framework's bundle first", async () => {
		const probe = tableProbe(layer, 'settings')
		await sqlite.seedRow(tables, 'settings')
		expect(await probe.count(authority.app('settings.read'))).toBe('1')
		expect(sqlite.schema).toBe('main')
	})

	test('seeds two rows of a contained table in chains that share no value, with every container row', async () => {
		const worlds = await sqlite.seedWorlds(tables, 'notes')
		expect(worlds.dimension).toBe('workspace')
		expect(worlds.own.parent).toBeNull()
		expect(Object.keys(worlds.own.updates).sort()).toEqual(['body', 'title', 'word_count'])
		expect(worlds.own.chain.map((link) => link.type)).toEqual(['note', 'workspace', 'organization'])
		const own = valuesOf(worlds.own)
		for (const value of valuesOf(worlds.other)) expect(own).not.toContain(value)
		expect(worlds.own.chain[2]?.value).toEqual(expect.stringContaining('organization-own-'))
		expect(worlds.other.chain[2]?.value).toEqual(expect.stringContaining('organization-other-'))
	})

	test('every marker is distinct, in a row, across its containers and across worlds', async () => {
		const worlds = await sqlite.seedWorlds(tables, 'notes')
		const markers = [...worlds.own.markers, ...worlds.other.markers]
		// A note's title and body, its workspace's name, its organization's name.
		expect(worlds.own.markers).toHaveLength(5)
		expect(new Set(markers).size).toBe(markers.length)
	})

	test('a scoped read through the bound layer sees only its own world', async () => {
		const worlds = await sqlite.seedWorlds(tables, 'notes')
		const probe = tableProbe(layer, 'notes')
		const within = authority.within('workspace', 'notes.read', [worlds.own.scope])
		const rows = await probe.select(within)
		expect(rows.map((row) => row['id'])).toEqual([worlds.own.key])
		const answered = JSON.stringify(rows)
		for (const marker of worlds.other.markers) expect(answered).not.toContain(marker)
		expect(answered).toContain(String(worlds.own.updates['title']))
		expect(await probe.count(within)).toBe('1')
		expect(rows[0]?.['created_at']).toBeInstanceOf(Date)
	})

	test('seeds a child row under its own parent; the grant dimension is the parent’s container', async () => {
		const worlds = await sqlite.seedWorlds(tables, 'note_comments')
		expect(worlds.dimension).toBe('workspace')
		expect(worlds.own.parent).toEqual(expect.stringContaining('note-own-'))
		expect(worlds.other.parent).toEqual(expect.stringContaining('note-other-'))
	})

	test('seeds a row under a seeded row, in its chain', async () => {
		const worlds = await sqlite.seedWorlds(tables, 'notes')
		const comment = await sqlite.seedUnder(tables, 'note_comments', worlds.own)
		expect(comment.markers).toHaveLength(1)
		const probe = tableProbe(layer, 'note_comments')
		const rows = await probe.select(authority.within('workspace', 'notes.read', [worlds.own.scope]))
		expect(rows.map((row) => row['id'])).toEqual([comment.key])
		expect(await probe.select(authority.within('workspace', 'notes.read', [worlds.other.scope]))).toEqual([])
	})

	test('a top-level table is scoped by its own dimension: the row is the scope value', async () => {
		const worlds = await sqlite.seedWorlds(tables, 'organizations')
		expect(worlds.dimension).toBe('organization')
		expect(worlds.own.scope).toBe(worlds.own.key)
	})

	test('a table no store reaches has no worlds', async () => {
		await expect(sqlite.seedWorlds(tables, 'countries')).rejects.toThrow('no store reaches it')
	})

	test('samples the required insert columns only', async () => {
		const values = await sqlite.sampleInsert(tables, 'notes')
		expect(Object.keys(values)).toEqual(['title'])
	})

	test('the probe runs every runtime check of a store: kind, dimension and action', async () => {
		const probe = tableProbe(layer, 'notes')
		const worlds = await sqlite.seedWorlds(tables, 'notes')
		const chain = Object.fromEntries(worlds.own.chain.slice(1).map((link) => [link.type, link.value]))
		const read = authority.ref('note', 'notes.read', worlds.own.key, chain)
		expect(await probe.get(read)).toMatchObject({ id: worlds.own.key })
		expect(Object.keys(await probe.get(read))).not.toContain('internal')
		await expect(probe.remove(read)).rejects.toThrow(CapabilityError)
		await expect(probe.get(authority.within('workspace', 'notes.read', [worlds.own.scope]))).rejects.toThrow(CapabilityError)
		await expect(probe.get(read, 'a-key')).rejects.toThrow(QueryRefusedError)
		expect(await probe.count(authority.within('workspace', 'notes.read', []))).toBe('0')
	})
})

describe('the seed over the types of an application on SQLite', () => {
	const typed = `
CREATE TABLE tasks (
	id UUID PRIMARY KEY,
	project_id TEXT NOT NULL,
	title VARCHAR(80) NOT NULL,
	due_on DATE NOT NULL,
	remind_at TIMESTAMP NOT NULL,
	done BOOLEAN NOT NULL,
	weight REAL NOT NULL,
	priority INTEGER NOT NULL DEFAULT 3,
	attachment BLOB,
	version INTEGER NOT NULL
);
CREATE TABLE blobs (id TEXT PRIMARY KEY, payload BLOB NOT NULL);
`

	interface DB {
		tasks: {
			id: string
			project_id: string
			title: string
			due_on: string
			remind_at: Date
			done: boolean
			weight: number
			priority: number
			attachment: Uint8Array | null
			version: number
		}
		blobs: { id: string; payload: Uint8Array }
	}

	const columns: TypedColumnList<DB> = {
		tasks: {
			columns: ['id', 'project_id', 'title', 'due_on', 'remind_at', 'done', 'weight', 'priority', 'attachment', 'version'],
			foreignKeys: [],
			dates: ['due_on'],
			timestamps: ['remind_at'],
			booleans: ['done'],
		},
		blobs: { columns: ['id', 'payload'], foreignKeys: [] },
	}
	const vocabulary = {
		dimensions: { project: {}, task: { in: 'project' }, blob: {} },
		actions: { 'tasks.read': 'Read tasks', 'tasks.write': 'Write tasks' },
	} as const
	const typedTables = defineTables(vocabulary, columns)({
		tasks: {
			scope: { dimension: 'task', key: 'id', in: { dimension: 'project', column: 'project_id' } },
			actions: { read: 'tasks.read', insert: 'tasks.write', update: 'tasks.write', delete: 'tasks.write' },
			insert: ['title', 'due_on', 'remind_at', 'done', 'weight', 'priority'],
			update: ['title', 'due_on', 'remind_at', 'done', 'weight', 'priority'],
			version: 'version',
		},
		blobs: { scope: { dimension: 'blob' }, actions: { read: 'tasks.read' } },
	})

	const directory = mkdtempSync(join(tmpdir(), 'fabrika-db-testing-sqlite-types-'))
	writeFileSync(join(directory, '20261009120000_tasks.sql'), typed)
	let sqlite: TestDatabase
	const authority = new TestAuthority()
	const layer = scoped(typedTables)

	beforeAll(async () => {
		sqlite = await testDatabase({ migrations: directory, label: 'testing-sqlite.test.ts' })
		bindScopedDatabase(layer, { database: sqlite.database, capabilities: authority })
	})

	afterAll(async () => {
		await sqlite.close()
		rmSync(directory, { recursive: true, force: true })
	})

	test('a required uuid, day, timestamp, boolean and number are seeded with values the layer reads back', async () => {
		const worlds = await sqlite.seedWorlds(typedTables, 'tasks')
		expect(worlds.own.key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/)
		const [row] = await tableProbe(layer, 'tasks').select(authority.within('project', 'tasks.read', [worlds.own.scope]))
		expect(row).toMatchObject({
			id: worlds.own.key,
			due_on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
			remind_at: expect.any(Date),
			done: false,
			weight: 1,
			priority: 3,
			attachment: null,
		})
		expect([row?.['title']]).toEqual([...worlds.own.markers])
	})

	test('an updatable column the seed left to its default is updated with a sample, never with null', async () => {
		const worlds = await sqlite.seedWorlds(typedTables, 'tasks')
		expect(worlds.own.updates['priority']).toBe(1)
		expect(worlds.own.updates['due_on']).toEqual(expect.any(String))
		expect(worlds.own.updates['done']).toBe(false)
	})

	test('a seed of a boolean is written as the layer binds it', async () => {
		const worlds = await sqlite.seedWorlds(typedTables, 'tasks', { done: true })
		const [row] = await tableProbe(layer, 'tasks').select(authority.within('project', 'tasks.read', [worlds.other.scope]))
		expect(row?.['done']).toBe(true)
	})

	test('a required BLOB is a seed limit naming the column', async () => {
		await expect(sqlite.seedWorlds(typedTables, 'blobs')).rejects.toThrow('the isolation fixture cannot fill blobs.payload (BLOB)')
	})
})
