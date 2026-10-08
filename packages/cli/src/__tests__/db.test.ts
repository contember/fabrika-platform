// `fabrika db`. The migrate and codegen halves run against a REAL Postgres and skip cleanly without
// FABRIKA_TEST_POSTGRES_URL. The URL is a credential: no assertion prints it.

import { checkApplication, formatFinding, generatedTestHeader } from '@fabrika/check'
import { generateSchema } from '@fabrika/db/codegen'
import { applicationDatabaseSchema, definePostgresApplicationMigrations, PostgresDatabase } from '@fabrika/platform-node'
import { SQL } from 'bun'
import { afterAll, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '..'
import { type DbCommandDependencies, runDbCommand } from '../db'

const roots: string[] = []

const appRoot = (): string => {
	const root = mkdtempSync(join(tmpdir(), 'fabrika-db-cli-'))
	roots.push(root)
	return root
}

const run = async (
	root: string,
	command: string,
	argv: readonly string[] = [],
	options: { source?: DbCommandDependencies['source']; now?: Date } = {},
): Promise<string> => {
	const output: string[] = []
	await runDbCommand(command, argv, {
		cwd: root,
		source: options.source ?? {},
		now: () => options.now ?? new Date('2026-10-08T12:34:56.789Z'),
		write: (line) => output.push(line),
	})
	return output.join('')
}

const failure = async (work: Promise<unknown>): Promise<string> => {
	try {
		await work
	} catch (error) {
		return error instanceof Error ? error.message : String(error)
	}
	throw new Error('the command did not fail')
}

const writeMigration = (root: string, name: string, sql: string): void => {
	mkdirSync(join(root, 'db', 'migrations'), { recursive: true })
	writeFileSync(join(root, 'db', 'migrations', name), sql)
}

describe('fabrika db new', () => {
	test('writes a UTC-timestamped file the checker accepts', async () => {
		const root = appRoot()
		expect(await run(root, 'new', ['add_notes'])).toBe('db/migrations/20261008123456_add_notes.sql\n')
		const path = 'db/migrations/20261008123456_add_notes.sql'
		expect(readFileSync(join(root, path), 'utf8')).toBe('-- add_notes\n')
		const findings = await checkApplication({ root, files: new Map([[path, readFileSync(join(root, path), 'utf8')]]) })
		expect(findings.map(formatFinding)).toEqual([])
	})

	test('refuses a slug the checker would refuse, and overwrites nothing', async () => {
		const root = appRoot()
		for (const slug of ['Add_Notes', 'add-notes', 'add__notes', '_add', 'add notes']) {
			expect(await failure(run(root, 'new', [slug]))).toContain('is not a lowercase snake_case slug')
		}
		expect(await failure(run(root, 'new', []))).toContain('db new needs a slug')
		expect(await failure(run(root, 'new', ['a', 'b']))).toContain('db new takes no argument b')
		await run(root, 'new', ['add_notes'])
		expect(await failure(run(root, 'new', ['add_notes']))).toContain('could not be created')
		expect(readdirSync(join(root, 'db', 'migrations'))).toEqual(['20261008123456_add_notes.sql'])
	})
})

/** The fixture application whose generated isolation tests are committed and run with this suite. */
const ISOLATION_APP = join(import.meta.dir, 'fixtures', 'isolation-app')
const GENERATED = 'src/db/__tests__'
const SCAFFOLDED = ['note_comments', 'notes', 'organizations', 'workspaces'].map((table) => `${GENERATED}/${table}.isolation.test.ts`)

/** A copy of the fixture application outside the repository, for the scaffold to write into. */
const isolationApp = (): string => {
	const root = appRoot()
	cpSync(ISOLATION_APP, root, { recursive: true })
	return root
}

const findingsOf = async (root: string): Promise<string[]> => (await checkApplication({ root })).map(formatFinding)

describe('fabrika db test-scaffold', () => {
	test('writes one isolation test per table a store reaches, as committed in the fixture', async () => {
		const root = isolationApp()
		rmSync(join(root, GENERATED), { recursive: true })
		expect((await run(root, 'test-scaffold')).split('\n').filter((line) => line !== '')).toEqual(SCAFFOLDED)
		expect(readdirSync(join(root, GENERATED)).sort()).toEqual(SCAFFOLDED.map((path) => path.slice(GENERATED.length + 1)))
		for (const path of SCAFFOLDED) {
			expect(readFileSync(join(root, path), 'utf8')).toBe(readFileSync(join(ISOLATION_APP, path), 'utf8'))
		}
		expect(await findingsOf(root)).toEqual([])
	})

	test('a weakened generated test fails the check: its hash no longer matches', async () => {
		const root = isolationApp()
		const path = join(root, GENERATED, 'notes.isolation.test.ts')
		const text = readFileSync(path, 'utf8')
		const weakened = text.replace("expect((await kit.get('other')).status).toBe(404)", "expect((await kit.get('other')).status).toBeGreaterThan(0)")
		expect(weakened).not.toBe(text)
		writeFileSync(path, weakened)
		expect(await findingsOf(root)).toEqual([
			`${GENERATED}/notes.isolation.test.ts:1:1 generated-test-hash this generated test differs from what fabrika db test-scaffold wrote (allowed form: the file as generated; rerun fabrika db test-scaffold after a table change)`,
		])
		expect(await run(root, 'test-scaffold')).toContain(`${GENERATED}/notes.isolation.test.ts`)
		expect(await findingsOf(root)).toEqual([])
	})

	test('a test rewritten under a new hash, a deleted one and a stale one fail the check too', async () => {
		const root = isolationApp()
		const notes = join(root, GENERATED, 'notes.isolation.test.ts')
		const body = readFileSync(notes, 'utf8').split('\n').slice(1).join('\n').replace('toBe(403)', 'toBe(200)')
		writeFileSync(notes, `${await generatedTestHeader(body)}\n${body}`)
		rmSync(join(root, GENERATED, 'workspaces.isolation.test.ts'))
		const tables = join(root, 'src', 'db', 'tables.ts')
		writeFileSync(tables, readFileSync(tables, 'utf8').replace("delete: 'notes.write' },", '},'))
		expect((await findingsOf(root)).map((line) => line.slice(0, line.indexOf(' ('))).sort()).toEqual([
			`${GENERATED}/note_comments.isolation.test.ts:1:1 generated-test-hash this isolation test was written for another policy of its table`,
			`${GENERATED}/notes.isolation.test.ts:1:1 generated-test-hash this isolation test was written for another policy of its table`,
			`${GENERATED}/workspaces.isolation.test.ts:1:1 generated-test-hash the isolation test of this table is missing`,
		])
	})

	test('removes the generated test of a table no store reaches any more, and keeps hand-written tests', async () => {
		const root = isolationApp()
		const tables = join(root, 'src', 'db', 'tables.ts')
		writeFileSync(
			tables,
			readFileSync(tables, 'utf8').replace(
				"organizations: {\n\t\tscope: { dimension: 'organization', key: 'id' },",
				"organizations: {\n\t\tscope: { reference: 'the organization directory' },",
			).replace(
				"\t\tactions: { read: 'organizations.read', update: 'organizations.admin' },\n\t\tupdate: ['name'],",
				"\t\tactions: { read: 'organizations.read' },",
			),
		)
		writeFileSync(join(root, GENERATED, 'own.test.ts'), "import { expect, test } from 'bun:test'\n\ntest('mine', () => {\n\texpect(1).toBe(1)\n})\n")
		const output = await run(root, 'test-scaffold')
		expect(output).toContain(`removed ${GENERATED}/organizations.isolation.test.ts`)
		expect(existsSync(join(root, GENERATED, 'organizations.isolation.test.ts'))).toBe(false)
		expect(existsSync(join(root, GENERATED, 'own.test.ts'))).toBe(true)
	})

	test('refuses policies the reader refuses, and takes no argument', async () => {
		const root = isolationApp()
		const tables = join(root, 'src', 'db', 'tables.ts')
		writeFileSync(tables, readFileSync(tables, 'utf8').replace("insert: ['name'],", "insert: ['name', 'missing'],"))
		expect(await failure(run(root, 'test-scaffold'))).toContain('the contract cannot be read from source')
		expect(await failure(run(root, 'test-scaffold', ['--all']))).toContain('db test-scaffold takes no argument --all')
	})
})

describe('fabrika db configuration', () => {
	test('migrate and codegen read the application id and database URL from the environment only', async () => {
		const root = appRoot()
		writeMigration(root, '20261008120000_init.sql', 'SELECT 1')
		expect(await failure(run(root, 'migrate'))).toBe('FABRIKA_APP_ID is required')
		expect(await failure(run(root, 'migrate', [], { source: { FABRIKA_APP_ID: 'notes' } }))).toBe('FABRIKA_APP_DATABASE_URL is required')
		expect(await failure(run(root, 'codegen', [], { source: { FABRIKA_APP_ID: 'notes' } }))).toBe('FABRIKA_APP_DATABASE_URL is required')
		expect(await failure(run(root, 'migrate', ['--url=postgres://x'], { source: { FABRIKA_APP_ID: 'notes' } }))).toContain(
			'db migrate takes no argument --url=postgres://x',
		)
	})

	test('migrate refuses a migrations directory it cannot apply before it connects', async () => {
		const source = { FABRIKA_APP_ID: 'notes', FABRIKA_APP_DATABASE_URL: 'postgres://user:secret@127.0.0.1:1/db' }
		expect(await failure(run(appRoot(), 'migrate', [], { source }))).toContain('No migrations directory at')
		const misnamed = appRoot()
		writeMigration(misnamed, '0001_init.sql', 'SELECT 1')
		expect(await failure(run(misnamed, 'migrate', [], { source }))).toBe('Application migration 0001_init.sql is not named YYYYMMDDHHMMSS_slug.sql')
	})

	test('a connection failure does not repeat the URL', async () => {
		const root = appRoot()
		writeMigration(root, '20261008120000_init.sql', 'SELECT 1')
		const source = { FABRIKA_APP_ID: 'notes', FABRIKA_APP_DATABASE_URL: 'postgres://user:hunter2secret@127.0.0.1:1/db' }
		for (const command of ['migrate', 'codegen']) {
			const message = await failure(run(root, command, [], { source }))
			expect(message).toContain('the database connection failed')
			expect(message).not.toContain('hunter2secret')
		}
	})

	test('the router shows the db surface', async () => {
		const lines: string[] = []
		const info = console.info
		console.info = (message?: unknown): void => void lines.push(String(message))
		try {
			await runCli(['db', '--help'])
		} finally {
			console.info = info
		}
		expect(lines.join('\n')).toContain('fabrika db migrate')
		await expect(runCli(['db', 'drop'])).rejects.toThrow('Unknown db command: drop')
	})
})

const url = process.env['FABRIKA_TEST_POSTGRES_URL'] ?? ''
const hasPostgres = url !== ''
if (!hasPostgres) console.warn('db.test.ts skipped: set FABRIKA_TEST_POSTGRES_URL to run the Postgres-backed tests')

const schemas: string[] = []

afterAll(async () => {
	for (const root of roots) rmSync(root, { recursive: true, force: true })
	if (!hasPostgres) return
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	for (const schema of schemas) await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
	await sql.close()
})

const application = (): { root: string; source: DbCommandDependencies['source']; schema: string } => {
	const appId = `cli-${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`
	const schema = applicationDatabaseSchema(appId)
	schemas.push(schema)
	return { root: appRoot(), source: { FABRIKA_APP_ID: appId, FABRIKA_APP_DATABASE_URL: url }, schema }
}

describe.skipIf(!hasPostgres)('fabrika db against real Postgres', () => {
	test('migrate applies new files once and refuses an edited one', async () => {
		const { root, source } = application()
		writeMigration(root, '20261008120000_init.sql', 'CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL)')
		expect(await run(root, 'migrate', [], { source })).toBe(
			'migrations applied: fabrika/0001_webhooks.sql, fabrika/0002_job_leases.sql, app/20261008120000_init.sql\n',
		)
		expect(await run(root, 'migrate', [], { source })).toBe('migrations: already up to date\n')

		writeMigration(root, '20261008120000_init.sql', 'CREATE TABLE notes (id TEXT PRIMARY KEY)')
		expect(await failure(run(root, 'migrate', [], { source }))).toBe(
			'Postgres migration app/20261008120000_init.sql changed after it was applied; an applied migration is immutable, so write the change as a new migration',
		)
	})

	test('migrate reports the server error of a failing file', async () => {
		const { root, source } = application()
		writeMigration(root, '20261008120000_broken.sql', 'ALTER TABLE missing_table ADD COLUMN title TEXT')
		expect(await failure(run(root, 'migrate', [], { source }))).toBe(
			'Postgres migration app/20261008120000_broken.sql failed: relation "missing_table" does not exist (SQLSTATE 42P01)',
		)
	})

	test('the isolation fixture’s schema module is what codegen writes for its migrations', async () => {
		const appId = `cli-${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`
		schemas.push(applicationDatabaseSchema(appId))
		const migrations = definePostgresApplicationMigrations({ appId, directory: join(ISOLATION_APP, 'db', 'migrations') })
		const db = PostgresDatabase.connect(url, { max: 1 })
		try {
			await migrations.apply(db)
		} finally {
			await db.close()
		}
		expect(await generateSchema(url, migrations.schema)).toBe(readFileSync(join(ISOLATION_APP, 'src', 'db', 'schema.generated.ts'), 'utf8'))
	})

	test('codegen writes the schema module and --verify fails once it is stale', async () => {
		const { root, source, schema } = application()
		writeMigration(root, '20261008120000_init.sql', 'CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL)')
		expect(await failure(run(root, 'codegen', [], { source }))).toBe(`schema ${schema} does not exist; run fabrika db migrate first`)
		await run(root, 'migrate', [], { source })

		expect(await failure(run(root, 'codegen', ['--verify'], { source }))).toBe(
			'src/db/schema.generated.ts is stale; run fabrika db codegen and commit the result',
		)
		expect(await run(root, 'codegen', [], { source })).toBe('src/db/schema.generated.ts\n')
		const generated = readFileSync(join(root, 'src', 'db', 'schema.generated.ts'), 'utf8')
		expect(generated).toBe(await generateSchema(url, schema))
		expect(generated).toContain('export interface NotesTable {\n\tid: string\n\ttitle: string\n}\n')
		expect(await run(root, 'codegen', ['--verify'], { source })).toBe('src/db/schema.generated.ts is current\n')

		writeMigration(root, '20261009120000_body.sql', 'ALTER TABLE notes ADD COLUMN body TEXT')
		await run(root, 'migrate', [], { source })
		expect(await failure(run(root, 'codegen', ['--verify'], { source }))).toContain('is stale')
	})
})
