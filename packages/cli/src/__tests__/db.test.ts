// `fabrika db`. The migrate and codegen halves run against a REAL Postgres and skip cleanly without
// FABRIKA_TEST_POSTGRES_URL. The URL is a credential: no assertion prints it.

import { checkApplication, formatFinding, generatedTestHeader } from '@fabrika/check'
import { generateSchema } from '@fabrika/db/codegen'
import { FRAMEWORK_MIGRATION_BUNDLE, FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'
import {
	applicationDatabaseSchema,
	createTestProvisioner,
	databaseCodeQuery,
	definePostgresApplicationMigrations,
	dropApplicationDatabase,
	PostgresDatabase,
} from '@fabrika/platform-node'
import { SQL } from 'bun'
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { runCli } from '..'
import { type DbCommandDependencies, runDbCommand } from '../db'
import { readJunitCases } from '../junit'

// The scaffold cases run the whole checker over a copied fixture, and a test-isolation run makes a throwaway schema and
// runs every generated case: under a loaded host either outlasts the 5 s default.
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

/** The fixture application whose generated tests are committed and run with this suite. */
const ISOLATION_APP = join(import.meta.dir, 'fixtures', 'isolation-app')
const POLICY = 'src/db/__tests__'
const ENDPOINTS = 'src/__tests__/endpoint-access.test.ts'
const POLICY_TESTS = ['note_comments', 'notes', 'notices', 'organizations', 'workspace_events', 'workspaces'].map((table) =>
	`${POLICY}/${table}.policy-isolation.test.ts`
)
const SCAFFOLDED = [...POLICY_TESTS, ENDPOINTS]

/** A copy of the fixture application outside the repository, for the scaffold to write into. */
const isolationApp = (): string => {
	const root = appRoot()
	cpSync(ISOLATION_APP, root, { recursive: true })
	return root
}

/** A copy that `bun test` can run: its imports resolve through this package's dependencies. */
const runnableIsolationApp = (): string => {
	const root = isolationApp()
	symlinkSync(join(import.meta.dir, '..', '..', 'node_modules'), join(root, 'node_modules'))
	return root
}

const findingsOf = async (root: string): Promise<string[]> => (await checkApplication({ root })).map(formatFinding)
const withoutAllowed = (lines: readonly string[]): string[] => lines.map((line) => line.slice(0, line.indexOf(' ('))).sort()

describe('fabrika db test-scaffold', () => {
	test('writes a policy isolation test per table a store reaches and the endpoint access test, as committed in the fixture', async () => {
		const root = isolationApp()
		rmSync(join(root, POLICY), { recursive: true })
		rmSync(join(root, ENDPOINTS))
		expect((await run(root, 'test-scaffold')).split('\n').filter((line) => line !== '')).toEqual(SCAFFOLDED)
		for (const path of SCAFFOLDED) {
			expect(readFileSync(join(root, path), 'utf8')).toBe(readFileSync(join(ISOLATION_APP, path), 'utf8'))
		}
		expect(await findingsOf(root)).toEqual([])
	})

	test('a weakened generated test fails the check: its hash no longer matches', async () => {
		const root = isolationApp()
		const path = join(root, POLICY, 'notes.policy-isolation.test.ts')
		const text = readFileSync(path, 'utf8')
		const weakened = text.replace("expect((await kit.get('other')).status).toBe(404)", "expect((await kit.get('other')).status).toBeGreaterThan(0)")
		expect(weakened).not.toBe(text)
		writeFileSync(path, weakened)
		expect(await findingsOf(root)).toEqual([
			`${POLICY}/notes.policy-isolation.test.ts:1:1 generated-test-hash this generated test differs from what fabrika db test-scaffold wrote (allowed form: the file as generated; rerun fabrika db test-scaffold after a table change)`,
		])
		expect(await run(root, 'test-scaffold')).toContain(`${POLICY}/notes.policy-isolation.test.ts`)
		expect(await findingsOf(root)).toEqual([])
	})

	test('a test rewritten under a new hash, one without its header, a deleted one and a stale one fail the check too', async () => {
		const root = isolationApp()
		const notes = join(root, POLICY, 'notes.policy-isolation.test.ts')
		const body = readFileSync(notes, 'utf8').split('\n').slice(1).join('\n').replace('toBe(403)', 'toBe(200)')
		writeFileSync(notes, `${await generatedTestHeader(body)}\n${body}`)
		const endpoints = join(root, ENDPOINTS)
		writeFileSync(endpoints, readFileSync(endpoints, 'utf8').split('\n').slice(1).join('\n'))
		rmSync(join(root, POLICY, 'workspaces.policy-isolation.test.ts'))
		const tables = join(root, 'src', 'db', 'tables.ts')
		writeFileSync(tables, readFileSync(tables, 'utf8').replace("delete: 'notes.write' },", '},'))
		expect(withoutAllowed(await findingsOf(root))).toEqual([
			`${POLICY}/note_comments.policy-isolation.test.ts:1:1 generated-test-hash this file is not the generated test the scaffold writes here`,
			`${POLICY}/notes.policy-isolation.test.ts:1:1 generated-test-hash this file is not the generated test the scaffold writes here`,
			`${POLICY}/workspaces.policy-isolation.test.ts:1:1 generated-test-hash this generated test is missing`,
			`${ENDPOINTS}:1:1 generated-test-hash this file is not the generated test the scaffold writes here`,
		].sort())
	})

	test('an endpoint change makes the endpoint access test stale', async () => {
		const root = isolationApp()
		const endpoints = join(root, 'src', 'notes', 'endpoints.ts')
		const source = readFileSync(endpoints, 'utf8')
		const changed = source.replace(
			"output: Note, access: { action: 'notes.read', on: 'note', from: 'id' } })",
			"output: Note, access: { action: 'notes.write', on: 'note', from: 'id' } })",
		)
		expect(changed).not.toBe(source)
		writeFileSync(endpoints, changed)
		expect(withoutAllowed(await findingsOf(root))).toEqual([
			`${ENDPOINTS}:1:1 generated-test-hash this file is not the generated test the scaffold writes here`,
		])
	})

	test('removes a generated test the scaffold no longer writes, and keeps hand-written tests', async () => {
		const root = isolationApp()
		const gone = join(root, POLICY, 'gone.policy-isolation.test.ts')
		writeFileSync(gone, readFileSync(join(root, POLICY, 'notes.policy-isolation.test.ts'), 'utf8'))
		writeFileSync(join(root, POLICY, 'own.test.ts'), "import { expect, test } from 'bun:test'\n\ntest('mine', () => {\n\texpect(1).toBe(1)\n})\n")
		expect(withoutAllowed(await findingsOf(root))).toEqual([
			`${POLICY}/gone.policy-isolation.test.ts:1:1 generated-test-hash a generated test the scaffold no longer writes`,
		])
		expect(await run(root, 'test-scaffold')).toContain(`removed ${POLICY}/gone.policy-isolation.test.ts`)
		expect(existsSync(gone)).toBe(false)
		expect(existsSync(join(root, POLICY, 'own.test.ts'))).toBe(true)
	})

	test('an input the scaffold cannot sample needs a fixture; with one, the fixture is the case input', async () => {
		const root = isolationApp()
		const schemas = join(root, 'src', 'schemas.ts')
		writeFileSync(
			schemas,
			readFileSync(schemas, 'utf8').replace('title: z.string().min(1), expectVersion', 'title: z.string().regex(/^T-[0-9]+$/), expectVersion'),
		)
		expect(await failure(run(root, 'test-scaffold'))).toContain(
			'src/__tests__/endpoint-access.fixtures.ts:1:1 endpoint-fixture api.notes.rename: the scaffold cannot write an input its schema admits',
		)
		expect(withoutAllowed(await findingsOf(root))).toContain(
			'src/__tests__/endpoint-access.fixtures.ts:1:1 endpoint-fixture api.notes.rename: the scaffold cannot write an input its schema admits, so its endpoint access cases need one here',
		)
		writeFileSync(
			join(root, 'src', '__tests__', 'endpoint-access.fixtures.ts'),
			"export const fixtures = { 'api.notes.rename': { expectVersion: 1, id: '', title: 'T-1' } }\n",
		)
		await run(root, 'test-scaffold')
		expect(readFileSync(join(root, ENDPOINTS), 'utf8')).toContain("kit.denied('api.notes.rename', { expectVersion: 1, id: '', title: 'T-1' })")
		expect(await findingsOf(root)).toEqual([])
	})

	test('says so when it writes nothing: an application before its first table', async () => {
		const root = appRoot()
		mkdirSync(join(root, 'src'))
		writeFileSync(
			join(root, 'src', 'vocabulary.ts'),
			"import { defineVocabulary } from '@fabrika/app/contract'\n\nexport const vocabulary = defineVocabulary({ app: 'plain', dimensions: {}, actions: {}, roles: {} })\n",
		)
		writeFileSync(
			join(root, 'src', 'app-kit.ts'),
			"import { defineApp } from '@fabrika/app/contract'\nimport { vocabulary } from './vocabulary'\n\nexport const app = defineApp(vocabulary)\n",
		)
		writeFileSync(
			join(root, 'fabrika.contract.ts'),
			"import { app } from './src/app-kit'\n\nexport const contract = app.contract((c) => ({ health: c.health('/healthz') }))\n",
		)
		expect(await run(root, 'test-scaffold')).toBe(
			'no generated tests: they start with the first table a store reaches, and the application has none; write the first test yourself\n',
		)
	})

	test('refuses policies the reader refuses, and takes no argument', async () => {
		const root = isolationApp()
		const tables = join(root, 'src', 'db', 'tables.ts')
		writeFileSync(tables, readFileSync(tables, 'utf8').replace("insert: ['name'],", "insert: ['name', 'missing'],"))
		expect(await failure(run(root, 'test-scaffold'))).toContain('the contract cannot be read from source')
		expect(await failure(run(root, 'test-scaffold', ['--all']))).toContain('db test-scaffold takes no argument --all')
	})
})

describe('fabrika db test-isolation', () => {
	test('needs the database URL, and refuses a generated test that is not what the scaffold writes', async () => {
		expect(await failure(run(isolationApp(), 'test-isolation'))).toBe('FABRIKA_APP_DATABASE_URL is required')
		const root = isolationApp()
		const path = join(root, POLICY, 'notes.policy-isolation.test.ts')
		writeFileSync(path, readFileSync(path, 'utf8').replace('toBe(404)', 'toBe(200)'))
		expect(await failure(run(root, 'test-isolation', [], { source: { FABRIKA_APP_DATABASE_URL: 'postgres://unused' } }))).toBe(
			`db test-isolation: ${POLICY}/notes.policy-isolation.test.ts is not the test fabrika db test-scaffold writes; run it`,
		)
	})

	test('reads every case of a JUnit report: passed, failed, skipped', () => {
		const xml = [
			'<testsuites><testsuite name="a.test.ts" file="a.test.ts">',
			'<testcase name="passes &amp; counts" file="a.test.ts" line="1" assertions="2" />',
			'<testcase name="asserts nothing" file="a.test.ts" line="1" assertions="0" />',
			'<testcase name="fails" file="a.test.ts" line="2"><failure type="AssertionError" /></testcase>',
			'<testcase name="skips" file="./a.test.ts" line="3">',
			'<skipped />',
			'</testcase>',
			'</testsuite></testsuites>',
		].join('\n')
		expect(readJunitCases(xml)).toEqual([
			{ file: 'a.test.ts', name: 'passes & counts', outcome: 'passed', assertions: 2 },
			{ file: 'a.test.ts', name: 'asserts nothing', outcome: 'passed', assertions: 0 },
			{ file: 'a.test.ts', name: 'fails', outcome: 'failed', assertions: null },
			{ file: 'a.test.ts', name: 'skips', outcome: 'skipped', assertions: null },
		])
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
			'migrations applied: fabrika/0001_webhooks.sql, fabrika/0002_job_leases.sql, fabrika/0003_form_admissions.sql, fabrika/0004_job_kicks.sql, fabrika/0005_form_files.sql, fabrika/0006_form_bytes.sql, fabrika/0007_webhook_delivery_claims.sql, fabrika/0008_files.sql, fabrika/0009_job_wakes.sql, fabrika/0010_job_wakes_owned.sql, app/20261008120000_init.sql\n',
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

	const testIsolation = (root: string, argv: readonly string[] = []) =>
		run(root, 'test-isolation', argv, { source: { FABRIKA_APP_DATABASE_URL: url, PATH: process.env['PATH'] } })

	/** The output without the line about provisioners an earlier run left behind, which a concurrent suite may have caused. */
	const withoutSweep = (output: string): string => output.replace(/^dropped the test provisioners earlier runs left behind: [^\n]*\n/, '')

	test('test-isolation runs every generated case of the fixture, whatever its bunfig.toml says', async () => {
		const root = runnableIsolationApp()
		writeFileSync(join(root, 'skip-everything.ts'), "import { mock, test } from 'bun:test'\n\nmock.module('bun:test', () => ({ test: test.skip }))\n")
		writeFileSync(join(root, 'bunfig.toml'), '[test]\npreload = ["./skip-everything.ts"]\nroot = "nowhere"\n')
		expect(withoutSweep(await testIsolation(root))).toBe('104 generated cases passed\n')
	})

	test('test-isolation first drops the provisioner a killed run left behind, with the roles and schemas it created', async () => {
		const leftover = await createTestProvisioner(url)
		const name = new URL(leftover.url).username
		const family = definePostgresApplicationMigrations({ appId: `test-${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`, directory: '/unused' })
		await family.migrate(leftover.url, [{ name: '20261015120000_init.sql', sql: 'CREATE TABLE notes (id TEXT PRIMARY KEY)' }])
		const sql = new SQL({ url, adapter: 'postgres', max: 1 })
		try {
			await sql.unsafe(`ALTER ROLE ${name} VALID UNTIL '2000-01-01'`)
			const output = await testIsolation(runnableIsolationApp())
			expect(output).toMatch(new RegExp(`^dropped the test provisioners earlier runs left behind: [^\\n]*\\b${name}\\b`))
			expect(output).toEndWith('\n104 generated cases passed\n')
			const left = await sql.unsafe(
				'SELECT rolname FROM pg_roles WHERE rolname IN ($1, $2) UNION ALL SELECT nspname FROM pg_namespace WHERE nspname = $3',
				[
					name,
					family.roles.runtime,
					family.schema,
				],
			)
			expect([...left]).toEqual([])
		} finally {
			await sql.close()
		}
	})

	/**
	 * A runnable copy of the fixture with its `src/app.ts` replaced by `edit` of it, and, when `leaky`, its note handler
	 * serving the first caller's note to everyone after it (the cache the endpoint tests must catch). The cache is a
	 * module only the handler imports, since the shell module holds literals only.
	 */
	const editedApplication = (edit: (source: string) => string, leaky = true): string => {
		const root = runnableIsolationApp()
		const app = join(root, 'src', 'app.ts')
		writeFileSync(app, edit(readFileSync(app, 'utf8')))
		if (leaky) {
			const endpoints = join(root, 'src', 'notes', 'endpoints.ts')
			writeFileSync(
				join(root, 'src', 'notes', 'memo.ts'),
				'let cached: { id: string; title: string } | undefined\n\nexport const remembered = (note: { id: string; title: string }) => (cached ??= note)\n',
			)
			writeFileSync(
				endpoints,
				`import { remembered } from './memo'\n${
					readFileSync(endpoints, 'utf8').replace('const note = await ctx.db.target.get()', 'const note = remembered(await ctx.db.target.get())')
				}`,
			)
		}
		return root
	}

	test('a mock of bun:test in application code neither silences the generated cases nor passes the checker', async () => {
		const mocked = (source: string): string =>
			`import { mock } from 'bun:test'\n\nmock.module('bun:test', () => ({ test: () => {}, describe: (_: string, body: () => void) => body(), expect: () => ({}), afterAll: () => {} }))\n${source}`
		const root = editedApplication(mocked)
		expect((await checkApplication({ root })).map((finding) => `${finding.file} ${finding.rule}`)).toContain('src/app.ts mock-module')
		const failed = await failure(testIsolation(root))
		expect(failed).toContain('db test-isolation: 103 of 104 generated cases passed')
		expect(failed).toContain(`${ENDPOINTS}: api.notes.get: the answer to one scope holds nothing of the scope answered before it (failed)`)
	})

	test('the startup run prints no output of the tests, so a credential a dependency writes stays out of the log', async () => {
		const password = decodeURIComponent(new URL(url).password)
		const diagnostic = (source: string): string =>
			`${source}\nconsole.error(\`DIAGNOSTIC connect failed for \${decodeURIComponent(new URL(process.env['FABRIKA_TEST_POSTGRES_URL'] ?? '').password)}\`)\n`
		const root = editedApplication(diagnostic)
		const failed = await failure(testIsolation(root))
		expect(failed).not.toContain('DIAGNOSTIC')
		if (password.length > 3) expect(failed).not.toContain(password)
		expect(failed).toContain('rerun with --verbose locally to see the test output')
		const verbose = await failure(testIsolation(root, ['--verbose']))
		expect(verbose).toContain('db test-isolation:')
	})

	test('the generated tests load application code, so they get a throwaway provisioner, never the provisioning credential', async () => {
		const seen = join(appRoot(), 'environment.json')
		const recording = (source: string): string =>
			`import { readFileSync as readEnvironment, writeFileSync as writeEnvironment } from 'node:fs'\n${source}\nwriteEnvironment(${
				JSON.stringify(seen)
			}, JSON.stringify({ environ: readEnvironment('/proc/self/environ', 'latin1'), url: process.env['FABRIKA_TEST_POSTGRES_URL'] ?? '' }))\n`
		expect(withoutSweep(await testIsolation(editedApplication(recording, false)))).toBe('104 generated cases passed\n')
		const recorded = z.object({ environ: z.string(), url: z.string() }).parse(JSON.parse(readFileSync(seen, 'utf8')))
		const password = decodeURIComponent(new URL(url).password)
		expect(recorded.environ).not.toContain(url)
		expect(recorded.environ).not.toContain(`:${password}@`)
		expect(new URL(recorded.url).username).toMatch(/^fabrika_tests_[0-9a-f]{16}$/)
		const sql = new SQL({ url, adapter: 'postgres', max: 1 })
		try {
			expect([...await sql.unsafe('SELECT rolname FROM pg_roles WHERE rolname = $1', [new URL(recorded.url).username])]).toEqual([])
		} finally {
			await sql.close()
		}
	})

	test('a fixture the endpoint schema refuses fails its cases', async () => {
		const root = runnableIsolationApp()
		const schemas = join(root, 'src', 'schemas.ts')
		writeFileSync(
			schemas,
			readFileSync(schemas, 'utf8').replace('title: z.string().min(1), expectVersion', 'title: z.string().regex(/^T-[0-9]+$/), expectVersion'),
		)
		const fixtures = join(root, 'src', '__tests__', 'endpoint-access.fixtures.ts')
		const original = existsSync(fixtures) ? readFileSync(fixtures, 'utf8') : ''
		writeFileSync(fixtures, `${original}export const fixtures = { 'api.notes.rename': { expectVersion: 1, id: '', title: 'not a T number' } }\n`)
		await run(root, 'test-scaffold')
		const failed = await failure(testIsolation(root))
		expect(failed).toContain('db test-isolation: 101 of 104 generated cases passed')
		expect(failed).toContain(`${ENDPOINTS}: api.notes.rename: the note of another scope is 404 (failed)`)
	})

	test('without its application rows, an endpoint and a link procedure that read one fail their leak and own cases', async () => {
		const root = runnableIsolationApp()
		const fixtures = join(root, 'src', '__tests__', 'endpoint-access.fixtures.ts')
		writeFileSync(fixtures, readFileSync(fixtures, 'utf8').replace(/^export const appRows = \{\n[\s\S]*?^\}\n/m, ''))
		expect(readFileSync(fixtures, 'utf8')).not.toContain('appRows')
		await run(root, 'test-scaffold')
		const failed = await failure(testIsolation(root))
		expect(failed).toContain('db test-isolation: 101 of 104 generated cases passed')
		expect(failed).toContain(`${ENDPOINTS}: api.notes.notice: the answer to one scope holds nothing of the scope answered before it (failed)`)
		expect(failed).toContain(`${ENDPOINTS}: shared.notice: the holder of a link to a note reaches it (failed)`)
	})

	test('an endpoint without its own application rows fails, though an earlier case seeded the same row', async () => {
		const root = runnableIsolationApp()
		const fixtures = join(root, 'src', '__tests__', 'endpoint-access.fixtures.ts')
		const without = readFileSync(fixtures, 'utf8').replace(/^\t'shared\.notice': .*\n/m, '')
		expect(without).toContain("'api.notes.notice'")
		expect(without).not.toContain("'shared.notice'")
		writeFileSync(fixtures, without)
		await run(root, 'test-scaffold')
		// api.notes.notice's cases run first and seed the published notice; each removes it once it is over.
		const failed = await failure(testIsolation(root))
		expect(failed).toContain('db test-isolation: 103 of 104 generated cases passed')
		expect(failed).toContain(`${ENDPOINTS}: shared.notice: the holder of a link to a note reaches it (failed)`)
	})

	test('--verbose prints the test output locally', async () => {
		const verbose = await testIsolation(runnableIsolationApp(), ['--verbose'])
		expect(verbose).toContain('104 generated cases passed')
		expect(verbose).toContain('104 pass')
	})

	test('the isolation fixture’s schema module is what codegen writes for its migrations', async () => {
		const appId = `cli-${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`
		appIds.push(appId)
		const migrations = definePostgresApplicationMigrations({ appId, directory: join(ISOLATION_APP, 'db', 'migrations') })
		const db = PostgresDatabase.connect(url, { max: 1 })
		try {
			await migrations.apply(db)
		} finally {
			await db.close()
		}
		expect(await generateSchema(url, migrations.schema, migrations.objects())).toBe(
			readFileSync(join(ISOLATION_APP, 'src', 'db', 'schema.generated.ts'), 'utf8'),
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
		expect(generated).toBe(await generateSchema(url, schema, manifestOf(root, appId)))
		expect(generated).toContain('export interface NotesTable {\n\tid: string\n\ttitle: string\n}\n')
		expect(await run(root, 'codegen', ['--verify'], { source })).toBe('src/db/schema.generated.ts is current\n')

		writeMigration(root, '20261009120000_body.sql', 'ALTER TABLE notes ADD COLUMN body TEXT')
		await run(root, 'migrate', [], { source })
		expect(await failure(run(root, 'codegen', ['--verify'], { source }))).toContain('is stale')
	})
})
