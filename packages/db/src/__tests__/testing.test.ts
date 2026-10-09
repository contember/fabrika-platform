// `@fabrika/db/testing`: the test database, the isolation fixtures and the table probe. The skip, the required flag and
// the release refusal run in a child process with a controlled environment; the rest needs FABRIKA_TEST_POSTGRES_URL
// and skips cleanly without it. The URL is a credential: no assertion prints it.

import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CapabilityError, QueryRefusedError } from '../errors'
import { bindScopedDatabase } from '../framework'
import { scoped } from '../store'
import { tableProbe, type TestDatabase, testDatabase } from '../testing'
import { TestAuthority } from './fixtures/authority'
import { migration } from './fixtures/schema'
import { tables } from './fixtures/tables'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''

if (!hasPostgres) {
	console.warn(`testing.test.ts skipped: set ${URL_VAR} to run the Postgres-backed tests`)
}

const migrations = mkdtempSync(join(tmpdir(), 'fabrika-db-testing-'))
writeFileSync(join(migrations, '20261009120000_init.sql'), migration)

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

/** Loads `@fabrika/db/testing` in a child process with only `env` set and calls `testDatabase`. */
function inChild(env: Readonly<Record<string, string>>): Promise<ChildResult> {
	return runChild([
		"const { testDatabase } = await import('@fabrika/db/testing')",
		`const database = await testDatabase({ migrations: ${JSON.stringify(migrations)}, label: 'child.test.ts' })`,
		"console.log(database === null ? 'null' : 'database')",
	], env)
}

afterAll(() => {
	rmSync(migrations, { recursive: true, force: true })
})

describe('without a test database', () => {
	test('it answers null after the standard skip message', async () => {
		const result = await inChild({})
		expect(result).toMatchObject({ code: 0, stdout: 'null\n' })
		expect(result.stderr).toContain('child.test.ts skipped: set FABRIKA_TEST_POSTGRES_URL to run the Postgres-backed tests')
	})

	test('FABRIKA_TEST_POSTGRES_REQUIRED=1 turns the skip into a failure', async () => {
		const result = await inChild({ FABRIKA_TEST_POSTGRES_REQUIRED: '1' })
		expect(result.code).not.toBe(0)
		expect(result.stderr).toContain('FABRIKA_TEST_POSTGRES_REQUIRED=1, but FABRIKA_TEST_POSTGRES_URL is unset')
	})

	test('the kit refuses to load in a release', async () => {
		const result = await inChild({ FABRIKA_RELEASE: 'r1' })
		expect(result.code).not.toBe(0)
		expect(result.stderr).toContain('does not load in a release (FABRIKA_RELEASE is set)')
	})
})

describe('in a process that serves an application', () => {
	test('the kit refuses to load once the process is marked, whatever the environment says', async () => {
		const result = await runChild([
			"const { markProductionProcess } = await import('@fabrika/db/production')",
			'markProductionProcess()',
			"await import('@fabrika/db/testing')",
		], {})
		expect(result.code).not.toBe(0)
		expect(result.stderr).toContain('@fabrika/db/testing is a test helper; this process serves an application')
	})

	test('a kit loaded before the mark refuses to run after it', async () => {
		const result = await runChild([
			"const { testDatabase, tableProbe } = await import('@fabrika/db/testing')",
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

describe('the table probe', () => {
	test('reaches only a data layer scoped(tables) created', () => {
		expect(() => tableProbe({ tables: {} }, 'notes')).toThrow(TypeError)
	})

	test('reaches only a table a store reaches', () => {
		const layer = scoped(tables)
		expect(() => tableProbe(layer, 'countries')).toThrow(QueryRefusedError)
		expect(() => tableProbe(layer, 'contact_messages')).toThrow(QueryRefusedError)
		expect(() => tableProbe(layer, 'missing')).toThrow(QueryRefusedError)
		expect(tableProbe(layer, 'notes').mode).toBe('dimension')
		expect(tableProbe(layer, 'note_comments').mode).toBe('child')
	})
})

describe.skipIf(!hasPostgres)('a test database on Postgres', () => {
	let postgres: TestDatabase

	beforeAll(async () => {
		const opened = await testDatabase({ migrations, label: 'testing.test.ts' })
		if (opened === null) {
			throw new Error('a test database was expected')
		}
		postgres = opened
	})

	afterAll(async () => {
		const schema = postgres.schema
		await postgres.close()
		const sql = new SQL({ url, adapter: 'postgres', max: 1 })
		try {
			const namespaces: unknown = await sql.unsafe('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema])
			expect(namespaces).toEqual([])
		} finally {
			await sql.close()
		}
	})

	test('a migration that fails leaves no schema behind', async () => {
		const failing = mkdtempSync(join(tmpdir(), 'fabrika-db-testing-failing-'))
		writeFileSync(join(failing, '20261009120000_partial.sql'), 'CREATE TABLE partial (id TEXT); SELECT * FROM missing_a11_table;')
		const sql = new SQL({ url, adapter: 'postgres', max: 1 })
		const schemas = async (): Promise<unknown> => sql.unsafe("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'app_test_%' ORDER BY nspname")
		try {
			const before = await schemas()
			await expect(testDatabase({ migrations: failing, label: 'failing.test.ts' })).rejects.toThrow()
			expect(await schemas()).toEqual(before)
		} finally {
			await sql.close()
			rmSync(failing, { recursive: true, force: true })
		}
	})

	test('is a fresh app_ schema the real runner migrated, ledger included', async () => {
		expect(postgres.schema).toMatch(/^app_test_[0-9a-f]{16}$/)
		const sql = new SQL({ url, adapter: 'postgres', max: 1 })
		try {
			const ledger: unknown = await sql.unsafe(`SELECT bundle, name FROM ${postgres.schema}.fabrika_migrations`)
			expect(ledger).toEqual([{ bundle: 'app', name: '20261009120000_init.sql' }])
		} finally {
			await sql.close()
		}
	})

	test('seeds two rows of a contained table in chains that share no value, with every container row', async () => {
		const worlds = await postgres.seedWorlds(tables, 'notes')
		expect(worlds.dimension).toBe('workspace')
		expect(worlds.own.scope).not.toBe(worlds.other.scope)
		expect(worlds.own.key).not.toBe(worlds.other.key)
		expect(worlds.own.parent).toBeNull()
		expect(Object.keys(worlds.own.updates).sort()).toEqual(['body', 'title', 'word_count'])
		const sql = new SQL({ url, adapter: 'postgres', max: 1 })
		try {
			const rows: unknown = await sql.unsafe(
				`SELECT n.workspace_id, w.organization_id AS workspace_organization, n.organization_id, n.version, n.created_by
				FROM ${postgres.schema}.notes n JOIN ${postgres.schema}.workspaces w ON w.id = n.workspace_id WHERE n.id = $1`,
				[worlds.own.key],
			)
			expect(rows).toEqual([expect.objectContaining({ workspace_id: worlds.own.scope, version: 1, created_by: 'isolation-fixture' })])
			expect(rows).toEqual([expect.objectContaining({ organization_id: expect.stringContaining('organization-own-') })])
		} finally {
			await sql.close()
		}
	})

	test('seeds a child row under its own parent; the grant dimension is the parent’s container', async () => {
		const worlds = await postgres.seedWorlds(tables, 'note_comments')
		expect(worlds.dimension).toBe('workspace')
		expect(worlds.own.parent).toEqual(expect.stringContaining('note-own-'))
		expect(worlds.other.parent).toEqual(expect.stringContaining('note-other-'))
	})

	test('a top-level table is scoped by its own dimension: the row is the scope value', async () => {
		const worlds = await postgres.seedWorlds(tables, 'organizations')
		expect(worlds.dimension).toBe('organization')
		expect(worlds.own.scope).toBe(worlds.own.key)
	})

	test('a table no store reaches has no worlds', async () => {
		await expect(postgres.seedWorlds(tables, 'countries')).rejects.toThrow('no store reaches it')
	})

	test('samples the required insert columns only', async () => {
		const values = await postgres.sampleInsert(tables, 'notes')
		expect(Object.keys(values)).toEqual(['title'])
	})

	test('the probe runs every runtime check of a store: kind, dimension and action', async () => {
		const authority = new TestAuthority()
		const layer = scoped(tables)
		bindScopedDatabase(layer, { database: postgres.database, capabilities: authority })
		const probe = tableProbe(layer, 'notes')
		const worlds = await postgres.seedWorlds(tables, 'notes')
		const chain = { workspace: worlds.own.scope }
		const read = authority.ref('note', 'notes.read', worlds.own.key, {
			...chain,
			organization: await organizationOf(postgres.schema, worlds.own.scope),
		})
		expect(await probe.get(read)).toMatchObject({ id: worlds.own.key })
		expect(Object.keys(await probe.get(read))).not.toContain('internal')
		await expect(probe.remove(read)).rejects.toThrow(CapabilityError)
		await expect(probe.get(authority.within('workspace', 'notes.read', [worlds.own.scope]))).rejects.toThrow(CapabilityError)
		await expect(probe.get(read, 'a-key')).rejects.toThrow(QueryRefusedError)
		expect(await probe.count(authority.within('workspace', 'notes.read', [worlds.own.scope]))).toBe('1')
		expect(await probe.count(authority.within('workspace', 'notes.read', []))).toBe('0')
	})
})

async function organizationOf(schema: string, workspace: string): Promise<string> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		const [row]: unknown[] = await sql.unsafe(`SELECT organization_id FROM ${schema}.workspaces WHERE id = $1`, [workspace])
		const value: unknown = typeof row === 'object' && row !== null ? Reflect.get(row, 'organization_id') : undefined
		if (typeof value !== 'string') {
			throw new Error('the seeded workspace has no organization')
		}
		return value
	} finally {
		await sql.close()
	}
}
