import { GENERATED_TEST_HEADER, type GeneratedTest, generatedTests, readApplicationTree, scaffoldInputs } from '@fabrika/check'
import { CodegenError, generateSchema, SCHEMA_FILE } from '@fabrika/db/codegen'
import { FRAMEWORK_MIGRATION_BUNDLE, FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'
import {
	applicationDatabaseSchema,
	DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
	DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS,
	definePostgresApplicationMigrations,
	PostgresDatabase,
	PostgresMigrationError,
	postgresMigrationResultMessage,
} from '@fabrika/platform-node'
import { SQL } from 'bun'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJunitCases } from './junit'

/** The checker's `migration-name` contract (`@fabrika/check`, `db/migrations/`). */
const MIGRATIONS_DIR = 'db/migrations'
const SLUG = /^[a-z0-9]+(?:_[a-z0-9]+)*$/

export const DB_USAGE = `fabrika db — an application's Postgres schema

Usage:
  fabrika db new <slug>           Write ${MIGRATIONS_DIR}/<UTC YYYYMMDDHHMMSS>_<slug>.sql; the slug is lowercase snake_case.
  fabrika db migrate              Apply the framework's tables, then ${MIGRATIONS_DIR}, to the application's schema app_<id>.
  fabrika db codegen [--verify]   Write ${SCHEMA_FILE} from the migrated schema; --verify only fails when it is stale.
  fabrika db test-scaffold        Write the generated tests: a policy isolation test per table a store reaches, the endpoint access test.
  fabrika db test-isolation [--verbose]  Run the generated tests on a throwaway schema; fail unless every case the scaffold wrote passed.

Run from the application root. \`migrate\` and \`codegen\` read FABRIKA_APP_ID and FABRIKA_APP_DATABASE_URL from
the environment only. \`migrate\` holds a lock derived from the application id, runs each file in one transaction
with lock_timeout ${DEFAULT_MIGRATION_LOCK_TIMEOUT_MS} ms and statement_timeout ${DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS} ms, and fails when a
file that already ran has changed: an applied migration is immutable, so a change is a new file.
\`test-scaffold\` reads fabrika.contract.ts and src/db/tables.ts as the checker does, rewrites every generated test and
deletes a generated one the scaffold no longer writes; @fabrika/check refuses one that is missing, edited or stale.
\`test-isolation\` is the platform's run of them: it reads FABRIKA_APP_DATABASE_URL, ignores the application's
bunfig.toml, and checks the JUnit report against the case names the scaffold wrote.
`

export interface DbCommandDependencies {
	/** The application root. */
	readonly cwd: string
	readonly source: Readonly<Record<string, string | undefined>>
	readonly now: () => Date
	readonly write: (line: string) => void
}

const required = (source: DbCommandDependencies['source'], name: string): string => {
	const value = source[name]
	if (value === undefined || value.trim() === '') throw new Error(`${name} is required`)
	return value.trim()
}

const refuseArguments = (command: string, argv: readonly string[]): void => {
	if (argv.length > 0) throw new Error(`db ${command} takes no argument ${argv[0]}\n\n${DB_USAGE}`)
}

const timestamp = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, '').replaceAll(/[-:T]/g, '')

const newMigration = async (argv: readonly string[], deps: DbCommandDependencies): Promise<void> => {
	const [slug, ...extra] = argv
	if (slug === undefined || slug.startsWith('-')) throw new Error(`db new needs a slug\n\n${DB_USAGE}`)
	refuseArguments('new', extra)
	if (!SLUG.test(slug)) throw new Error(`db new: '${slug}' is not a lowercase snake_case slug (allowed: add_note_tags)`)
	const path = `${MIGRATIONS_DIR}/${timestamp(deps.now())}_${slug}.sql`
	await mkdir(join(deps.cwd, MIGRATIONS_DIR), { recursive: true })
	try {
		await writeFile(join(deps.cwd, path), `-- ${slug}\n`, { flag: 'wx' })
	} catch {
		throw new Error(`db new: ${path} could not be created; if it exists, run fabrika db new again in a second`)
	}
	deps.write(`${path}\n`)
}

/**
 * The runner's own messages name no credential, and neither does a server-reported error. Anything else from the
 * driver (a refused connection, a TLS failure) may quote the URL, so it is replaced.
 */
const reportable = (error: unknown): Error => {
	if (error instanceof PostgresMigrationError) {
		const server = serverError(error.cause)
		return new Error(server === undefined ? error.message : `${error.message}: ${server}`)
	}
	if (error instanceof CodegenError) return error
	const server = serverError(error)
	if (server !== undefined) return new Error(server)
	return new Error('the database connection failed; check FABRIKA_APP_DATABASE_URL (the driver error is withheld: it may contain the URL)')
}

const serverError = (error: unknown): string | undefined =>
	error instanceof SQL.PostgresError && error.code === 'ERR_POSTGRES_SERVER_ERROR'
		? `${error.message} (SQLSTATE ${error.errno ?? 'unknown'})`
		: undefined

const migrate = async (argv: readonly string[], deps: DbCommandDependencies): Promise<void> => {
	refuseArguments('migrate', argv)
	const appId = required(deps.source, 'FABRIKA_APP_ID')
	const url = required(deps.source, 'FABRIKA_APP_DATABASE_URL')
	const migrations = definePostgresApplicationMigrations({
		appId,
		directory: join(deps.cwd, MIGRATIONS_DIR),
		framework: { bundle: FRAMEWORK_MIGRATION_BUNDLE, migrations: FRAMEWORK_MIGRATIONS },
	})
	const files = migrations.read()
	migrations.plan(files)
	// One connection: the advisory lock is session state.
	const db = PostgresDatabase.connect(url, { max: 1 })
	try {
		deps.write(`${postgresMigrationResultMessage(await migrations.apply(db, files))}\n`)
	} catch (error) {
		throw reportable(error)
	} finally {
		await db.close()
	}
}

const codegen = async (argv: readonly string[], deps: DbCommandDependencies): Promise<void> => {
	const verify = argv.includes('--verify')
	refuseArguments('codegen', argv.filter((arg) => arg !== '--verify'))
	const schema = applicationDatabaseSchema(required(deps.source, 'FABRIKA_APP_ID'))
	const url = required(deps.source, 'FABRIKA_APP_DATABASE_URL')
	let source: string
	try {
		source = await generateSchema(url, schema)
	} catch (error) {
		throw reportable(error)
	}
	const path = join(deps.cwd, SCHEMA_FILE)
	if (verify) {
		const committed = await readFile(path, 'utf8').catch(() => undefined)
		if (committed !== source) throw new Error(`${SCHEMA_FILE} is stale; run fabrika db codegen and commit the result`)
		deps.write(`${SCHEMA_FILE} is current\n`)
		return
	}
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, source)
	deps.write(`${SCHEMA_FILE}\n`)
}

const expectedTests = async (
	cwd: string,
): Promise<{ readonly files: ReadonlyMap<string, string>; readonly tests: ReadonlyMap<string, GeneratedTest> }> => {
	const { files } = await readApplicationTree(cwd)
	const { policies, artifact } = scaffoldInputs(files)
	return { files, tests: await generatedTests(policies, artifact) }
}

const testScaffold = async (argv: readonly string[], deps: DbCommandDependencies): Promise<void> => {
	refuseArguments('test-scaffold', argv)
	const { files, tests } = await expectedTests(deps.cwd)
	for (const [path, text] of files) {
		if (text.startsWith(GENERATED_TEST_HEADER) && !tests.has(path)) {
			await rm(join(deps.cwd, path))
			deps.write(`removed ${path}\n`)
		}
	}
	for (const [path, { text }] of tests) {
		await mkdir(dirname(join(deps.cwd, path)), { recursive: true })
		await writeFile(join(deps.cwd, path), text)
		deps.write(`${path}\n`)
	}
}

/** Only what Bun needs to run; the URL arrives as the kit's own variable, and no framework variable is passed on. */
const testEnvironment = (source: DbCommandDependencies['source'], url: string): Record<string, string> => {
	const environment: Record<string, string> = { FABRIKA_TEST_POSTGRES_URL: url, FABRIKA_TEST_POSTGRES_REQUIRED: '1' }
	for (const name of ['PATH', 'HOME', 'TMPDIR']) {
		const value = source[name]
		if (value !== undefined) environment[name] = value
	}
	return environment
}

/**
 * Runs exactly the generated tests, with an empty `bunfig.toml` so that no preload, root or ignore pattern of the
 * application applies, and fails unless every case the scaffold wrote is reported as passed.
 */
/**
 * Runs exactly the generated tests, with an empty `bunfig.toml` so that no preload, root or ignore pattern of the
 * application applies, and the platform's preload, which captures Bun's test functions before the application loads.
 * Fails unless every case the scaffold wrote is reported as passed with an assertion. The child's output is never
 * printed, because a dependency may write a credential into it; `--verbose`, which the platform never passes, prints it.
 */
const testIsolation = async (argv: readonly string[], deps: DbCommandDependencies): Promise<void> => {
	const verbose = argv.includes('--verbose')
	refuseArguments('test-isolation', argv.filter((arg) => arg !== '--verbose'))
	const url = required(deps.source, 'FABRIKA_APP_DATABASE_URL')
	const { files, tests } = await expectedTests(deps.cwd)
	for (const [path, { text }] of tests) {
		if (files.get(path) !== text) throw new Error(`db test-isolation: ${path} is not the test fabrika db test-scaffold writes; run it`)
	}
	if (tests.size === 0) {
		deps.write('no generated tests\n')
		return
	}
	const scratch = await mkdtemp(join(tmpdir(), 'fabrika-test-isolation-'))
	try {
		await writeFile(join(scratch, 'bunfig.toml'), '')
		const report = join(scratch, 'junit.xml')
		const child = Bun.spawn(
			[
				process.execPath,
				`--config=${join(scratch, 'bunfig.toml')}`,
				'test',
				`--preload=${fileURLToPath(import.meta.resolve('@fabrika/app/testing/preload'))}`,
				...[...tests.keys()].map((path) => `./${path}`),
				'--reporter=junit',
				`--reporter-outfile=${report}`,
			],
			{ cwd: deps.cwd, env: testEnvironment(deps.source, url), stdout: 'pipe', stderr: 'pipe' },
		)
		const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
		if (verbose) deps.write(`${stdout}${stderr}\n`)
		const reported = readJunitCases(await readFile(report, 'utf8').catch(() => ''))
		const failed: string[] = []
		let total = 0
		for (const [path, { cases }] of tests) {
			for (const name of cases) {
				total++
				const reportedCase = reported.find((item) => item.file === path && item.name === name)
				const outcome = reportedCase === undefined ? 'not run' : reportedCase.assertions === 0 ? 'no assertion' : reportedCase.outcome
				if (outcome !== 'passed') failed.push(`${path}: ${name} (${outcome})`)
			}
		}
		if (code !== 0 || failed.length > 0) {
			const rerun = verbose ? '' : '; rerun with --verbose locally to see the test output'
			throw new Error(
				`db test-isolation: ${total - failed.length} of ${total} generated cases passed (exit ${code})${rerun}${
					failed.map((line) => `\n- ${line}`).join('')
				}`,
			)
		}
		deps.write(`${total} generated cases passed\n`)
	} finally {
		await rm(scratch, { recursive: true, force: true })
	}
}

export const runDbCommand = async (command: string | undefined, argv: readonly string[], deps: DbCommandDependencies): Promise<void> => {
	if (command === 'new') return newMigration(argv, deps)
	if (command === 'migrate') return migrate(argv, deps)
	if (command === 'codegen') return codegen(argv, deps)
	if (command === 'test-scaffold') return testScaffold(argv, deps)
	if (command === 'test-isolation') return testIsolation(argv, deps)
	throw new Error(`Unknown db command: ${command ?? '(missing)'}\n\n${DB_USAGE}`)
}

export const runDbCli = (command: string | undefined, argv: readonly string[]): Promise<void> =>
	runDbCommand(command, argv, {
		cwd: process.cwd(),
		source: process.env,
		now: () => new Date(),
		write: (line) => process.stdout.write(line),
	})
