// `fabrika db`. The migrate and codegen halves run against a REAL Postgres and skip cleanly without
// FABRIKA_TEST_POSTGRES_URL. The URL is a credential: no assertion prints it.

import { checkApplication, formatFinding } from '@fabrika/check'
import { generateSchema } from '@fabrika/db/codegen'
import { FRAMEWORK_MIGRATION_BUNDLE, FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'
import {
	applicationDatabaseSchema,
	databaseCodeQuery,
	definePostgresApplicationMigrations,
	dropApplicationDatabase,
	PostgresDatabase,
} from '@fabrika/platform-node'
import { SQL } from 'bun'
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { runCli } from '..'
import { type DbCommandDependencies, runDbCommand } from '../db'

// A migrate against real Postgres applies the framework's bundle first: under a loaded host it outlasts the 5 s default.
setDefaultTimeout(30_000)

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

/** The fixture application whose committed schema module the codegen case compares. */
const DB_APP = join(import.meta.dir, 'fixtures', 'db-app')

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

	test('codegen names an empty migration bundle or file before it connects, not as a connection failure', async () => {
		const source = { FABRIKA_APP_ID: 'notes', FABRIKA_APP_DATABASE_URL: 'postgres://user:secret@127.0.0.1:1/db' }
		const empty = appRoot()
		mkdirSync(join(empty, 'db', 'migrations'), { recursive: true })
		expect(await failure(run(empty, 'codegen', [], { source }))).toBe('Postgres migration bundle app is empty')
		const blank = appRoot()
		writeMigration(blank, '20261008120000_init.sql', '  \n')
		expect(await failure(run(blank, 'codegen', [], { source }))).toBe('Postgres migration app/20261008120000_init.sql is empty')
	})

	test('a connection failure does not repeat the URL', async () => {
		const root = appRoot()
		writeMigration(root, '20261008120000_init.sql', 'CREATE TABLE notes (id TEXT)')
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

	test('test-isolation, which an older platform still runs as an init command, runs nothing and succeeds', async () => {
		const root = appRoot()
		expect(await run(root, 'test-isolation', ['--verbose'], { source: { FABRIKA_APP_ID: 'notes' } })).toBe(
			'db test-isolation: nothing to run; this release generates no tests\n',
		)
		expect(readdirSync(root)).toEqual([])
	})
})

const url = process.env['FABRIKA_TEST_POSTGRES_URL'] ?? ''
const hasPostgres = url !== ''
if (!hasPostgres) console.warn('db.test.ts skipped: set FABRIKA_TEST_POSTGRES_URL to run the Postgres-backed tests')

const appIds: string[] = []

afterAll(async () => {
	for (const root of roots) rmSync(root, { recursive: true, force: true })
	if (!hasPostgres) return
	for (const appId of appIds) await dropApplicationDatabase(url, appId)
})

const application = (): { root: string; source: DbCommandDependencies['source']; schema: string; appId: string } => {
	const appId = `cli-${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`
	const schema = applicationDatabaseSchema(appId)
	appIds.push(appId)
	return { root: appRoot(), source: { FABRIKA_APP_ID: appId, FABRIKA_APP_DATABASE_URL: url }, schema, appId }
}

/** The manifest `fabrika db codegen` checks the schema against: the framework's migrations, then the application's. */
const manifestOf = (root: string, appId: string) =>
	definePostgresApplicationMigrations({
		appId,
		directory: join(root, 'db', 'migrations'),
		framework: { bundle: FRAMEWORK_MIGRATION_BUNDLE, migrations: FRAMEWORK_MIGRATIONS },
	}).objects()

describe.skipIf(!hasPostgres)('fabrika db against real Postgres', () => {
	test('migrate applies new files once and refuses an edited one', async () => {
		const { root, source } = application()
		writeMigration(root, '20261008120000_init.sql', 'CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL)')
		expect(await run(root, 'migrate', [], { source })).toBe(
			'migrations applied: fabrika/0001_webhooks.sql, fabrika/0002_job_leases.sql, fabrika/0003_form_admissions.sql, fabrika/0004_job_kicks.sql, fabrika/0005_form_files.sql, fabrika/0006_form_bytes.sql, fabrika/0007_webhook_delivery_claims.sql, fabrika/0008_files.sql, fabrika/0009_job_wakes.sql, fabrika/0010_job_wakes_owned.sql, fabrika/0011_request_receipts.sql, fabrika/0012_list_cursor_key.sql, fabrika/0013_job_schedule.sql, app/20261008120000_init.sql\n',
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

	test('the fixture’s schema module is what codegen writes for its migrations', async () => {
		const appId = `cli-${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`
		appIds.push(appId)
		const migrations = definePostgresApplicationMigrations({ appId, directory: join(DB_APP, 'db', 'migrations') })
		const db = PostgresDatabase.connect(url, { max: 1 })
		try {
			await migrations.apply(db)
		} finally {
			await db.close()
		}
		expect((await generateSchema(url, migrations.schema, migrations.objects())).source).toBe(
			readFileSync(join(DB_APP, 'src', 'db', 'schema.generated.ts'), 'utf8'),
		)
	})

	test('migrate applies a declared trigger, and the start check refuses one no migration declares', async () => {
		const { root, source, schema } = application()
		const trigger = (name: string): string =>
			`CREATE TRIGGER ${name} BEFORE UPDATE ON deals FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()`
		writeMigration(root, '20261008120000_init.sql', `CREATE TABLE deals (id TEXT PRIMARY KEY);\n${trigger('noop')}`)
		await run(root, 'migrate', [], { source })
		await run(root, 'codegen', [], { source })
		expect(await run(root, 'codegen', ['--verify'], { source })).toBe('src/db/schema.generated.ts is current\n')
		const runtime = new SQL({ url, adapter: 'postgres', max: 1 })
		try {
			await runtime.unsafe(`SET search_path TO ${schema}; ${trigger('later')}`)
		} finally {
			await runtime.close()
		}
		expect(await failure(run(root, 'codegen', ['--verify'], { source }))).toBe(
			`schema ${schema} holds database code that escapes it or that no migration declares: trigger deals.later (no migration declares it); declare it in a migration or drop it in a new one`,
		)
	})

	test('migrate refuses COPY … PROGRAM and another schema before any SQL runs', async () => {
		const { root, source } = application()
		writeMigration(root, '20261008120000_init.sql', "CREATE TABLE deals (id TEXT PRIMARY KEY);\nCOPY deals FROM PROGRAM 'true'")
		expect(await failure(run(root, 'migrate', [], { source }))).toContain('Application migration 20261008120000_init.sql line 2: COPY is not allowed')
		writeMigration(root, '20261008120000_init.sql', 'CREATE TABLE deals (id TEXT PRIMARY KEY);\nINSERT INTO app_other.t VALUES (1)')
		expect(await failure(run(root, 'migrate', [], { source }))).toContain(
			'Application migration 20261008120000_init.sql line 2: INSERT reaching the schema app_other is not allowed',
		)
	})

	test("a migrated schema holds exactly the database code its manifest declares, the framework's functions included", async () => {
		const { root, source, schema, appId } = application()
		writeMigration(root, '20261008120000_init.sql', 'CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL)')
		// The runner's pre-commit check ran this query after every file, the framework's 0008_files.sql included.
		await run(root, 'migrate', [], { source })
		const code = async (declared: Parameters<typeof databaseCodeQuery>[1]) => {
			const sql = new SQL({ url, adapter: 'postgres', max: 1 })
			try {
				return z.array(z.object({ violation: z.string() })).parse(await sql.unsafe(databaseCodeQuery(schema, declared)))
			} finally {
				await sql.close()
			}
		}
		expect(await code(manifestOf(root, appId))).toEqual([])
		expect(await code([])).toEqual([
			{ violation: 'function fabrika_files_copy_legacy (no migration declares it)' },
			{ violation: 'function fabrika_files_release (no migration declares it)' },
		])
	})

	test('codegen writes the schema module and --verify fails once it is stale', async () => {
		const { root, source, schema, appId } = application()
		writeMigration(root, '20261008120000_init.sql', 'CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL)')
		expect(await failure(run(root, 'codegen', [], { source }))).toBe(`schema ${schema} does not exist; run fabrika db migrate first`)
		await run(root, 'migrate', [], { source })

		expect(await failure(run(root, 'codegen', ['--verify'], { source }))).toBe(
			'src/db/schema.generated.ts is stale; run fabrika db codegen and commit the result',
		)
		expect(await run(root, 'codegen', [], { source })).toBe('src/db/schema.generated.ts\n')
		const generated = readFileSync(join(root, 'src', 'db', 'schema.generated.ts'), 'utf8')
		expect(generated).toBe((await generateSchema(url, schema, manifestOf(root, appId))).source)
		expect(generated).toContain('export interface NotesTable {\n\tid: string\n\ttitle: string\n}\n')
		expect(await run(root, 'codegen', ['--verify'], { source })).toBe('src/db/schema.generated.ts is current\n')

		writeMigration(root, '20261009120000_body.sql', 'ALTER TABLE notes ADD COLUMN body TEXT')
		await run(root, 'migrate', [], { source })
		expect(await failure(run(root, 'codegen', ['--verify'], { source }))).toContain('is stale')
	})
})
