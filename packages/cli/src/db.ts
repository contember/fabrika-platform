import { applicationMigrations as sqliteApplicationMigrations } from '@fabrika/app/build'
import {
	type ApplicationDialect,
	CONFIG_FILE,
	type Finding,
	formatFinding,
	GENERATED_TEST_HEADER,
	type GeneratedTest,
	generatedTests,
	missingEndpointFixtures,
	readApplicationTree,
	scaffoldInputs,
} from '@fabrika/check'
import { CodegenError, generateSchema, SCHEMA_FILE } from '@fabrika/db/codegen'
import { generateSqliteSchema } from '@fabrika/db/codegen-sqlite'
import { FRAMEWORK_MIGRATION_BUNDLE, FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'
import { SQLITE_FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations-sqlite'
import {
	APPLICATION_MIGRATION_BUNDLE,
	CONNECTION_CAPACITY_MESSAGE,
	ConnectionCapacityError,
	createTestProvisioner,
	DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
	DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS,
	definePostgresApplicationMigrations,
	type PostgresApplicationMigrations,
	PostgresMigrationError,
	postgresMigrationResultMessage,
	type TestProvisioner,
	TOO_MANY_CONNECTIONS,
	withConnectionCapacity,
} from '@fabrika/platform-node'
import { SQL } from 'bun'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { settleTarget } from './config-database'
import { readJunitCases } from './junit'

/** The checker's `migration-name` contract (`@fabrika/check`, `db/migrations/`). */
const MIGRATIONS_DIR = 'db/migrations'
const SLUG = /^[a-z0-9]+(?:_[a-z0-9]+)*$/

export const DB_USAGE = `fabrika db — an application's database schema: Postgres, or SQLite on Cloudflare

Usage:
  fabrika db new <slug>           Write ${MIGRATIONS_DIR}/<UTC YYYYMMDDHHMMSS>_<slug>.sql; the slug is lowercase snake_case.
  fabrika db migrate              Apply the framework's tables, then ${MIGRATIONS_DIR}, to the application's schema app_<id>.
  fabrika db codegen [--verify]   Write ${SCHEMA_FILE} from the migrated schema; --verify only fails when it is stale.
  fabrika db test-scaffold        Write the generated tests: a policy isolation test per table a store reaches, the endpoint access test.
  fabrika db test-isolation [--verbose]  Run the generated tests on a throwaway schema; fail unless every case the scaffold wrote passed.

Run from the application root. \`migrate\` and \`codegen\` read FABRIKA_APP_ID and FABRIKA_APP_DATABASE_URL from
the environment only. FABRIKA_APP_DATABASE_URL is the provisioning credential: \`migrate\` uses it only to create
the application's roles (app_<id> owns the schema, run_<id> gets DML on its tables) and fails when it cannot create
roles. It applies the files as app_<id>, holds a lock derived from the application id, runs each file in one
transaction with lock_timeout ${DEFAULT_MIGRATION_LOCK_TIMEOUT_MS} ms and statement_timeout ${DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS} ms, and fails when a
file that already ran has changed: an applied migration is immutable, so a change is a new file.
\`test-scaffold\` reads fabrika.contract.ts and src/db/tables.ts as the checker does, rewrites every generated test and
deletes a generated one the scaffold no longer writes, printing each path, or that it wrote none; @fabrika/check refuses
one that is missing, edited or stale.
\`test-isolation\` is the platform's run of them: with FABRIKA_APP_DATABASE_URL it creates a throwaway provisioner
(CREATEROLE, CREATE on the database, nothing of any application) that the tests get instead, ignores the application's
bunfig.toml, and checks the JUnit report against the case names the scaffold wrote. It first drops the provisioners
that killed runs left behind: expired, and without a session of their own or of a role they created. A database at its
connection limit (SQLSTATE ${TOO_MANY_CONNECTIONS}) is waited for; one that never frees a slot fails the run saying so,
never as failed cases.

An application whose ${CONFIG_FILE} default-exports @fabrika/provider-cloudflare's defineApp runs on SQLite in its
Durable Object, which applies the migrations itself when it boots: \`migrate\` refuses, \`codegen\` applies them to an
in-memory database, and the generated tests run on @fabrika/db/testing-sqlite; none of them needs a database URL,
unless its config names \`database: { kind: 'postgres', … }\` in defineApp's argument, an object literal (directly or
through a const): then it takes the Postgres path above, and the deploy runs \`migrate\` with the provisioning secret
as FABRIKA_APP_DATABASE_URL.
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

/**
 * The dialect `fabrika.config.ts` names, read as the checker reads it and checked against the loaded config where the
 * read cannot follow it (`settleTarget`); Postgres without a config.
 */
const dialectAt = async (cwd: string): Promise<ApplicationDialect> => {
	const settled = await settleTarget(cwd, 'unsettled')
	if ('refusal' in settled) throw new Error(`db: ${settled.refusal}`)
	return settled.target.dialect
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
	if (error instanceof CodegenError || error instanceof ConnectionCapacityError) return error
	const server = serverError(error)
	if (server !== undefined) return new Error(server)
	return new Error('the database connection failed; check FABRIKA_APP_DATABASE_URL (the driver error is withheld: it may contain the URL)')
}

const serverError = (error: unknown): string | undefined =>
	error instanceof SQL.PostgresError && error.code === 'ERR_POSTGRES_SERVER_ERROR'
		? `${error.message} (SQLSTATE ${error.errno ?? 'unknown'})`
		: undefined

/** The framework's tables, then the application's `db/migrations`, as `migrate` applies them and `codegen` checks them. */
const applicationMigrations = (appId: string, cwd: string): PostgresApplicationMigrations =>
	definePostgresApplicationMigrations({
		appId,
		directory: join(cwd, MIGRATIONS_DIR),
		framework: { bundle: FRAMEWORK_MIGRATION_BUNDLE, migrations: FRAMEWORK_MIGRATIONS },
	})

const migrate = async (argv: readonly string[], deps: DbCommandDependencies): Promise<void> => {
	refuseArguments('migrate', argv)
	if ((await dialectAt(deps.cwd)) === 'sqlite') {
		throw new Error(
			'db migrate: an application on Cloudflare migrates its own SQLite database when its Durable Object boots (ADR-0065); there is nothing to run',
		)
	}
	const migrations = applicationMigrations(required(deps.source, 'FABRIKA_APP_ID'), deps.cwd)
	const url = required(deps.source, 'FABRIKA_APP_DATABASE_URL')
	const files = migrations.read()
	migrations.plan(files)
	try {
		deps.write(`${postgresMigrationResultMessage(await migrations.migrate(url, files))}\n`)
	} catch (error) {
		throw reportable(error)
	}
}

/** The schema module of the migrated application schema, read with the provisioning credential. */
const postgresSchema = async (deps: DbCommandDependencies): Promise<string> => {
	const migrations = applicationMigrations(required(deps.source, 'FABRIKA_APP_ID'), deps.cwd)
	const url = required(deps.source, 'FABRIKA_APP_DATABASE_URL')
	try {
		// The migrations' manifest: the start check refuses any database object no migration declares.
		return await generateSchema(url, migrations.schema, migrations.objects())
	} catch (error) {
		throw reportable(error)
	}
}

/** The schema module of the bundles the Durable Object applies, in its order, run in an in-memory database. */
const sqliteSchema = async (cwd: string): Promise<string> =>
	generateSqliteSchema([
		{ bundle: FRAMEWORK_MIGRATION_BUNDLE, migrations: SQLITE_FRAMEWORK_MIGRATIONS },
		{ bundle: APPLICATION_MIGRATION_BUNDLE, migrations: await sqliteApplicationMigrations(cwd) },
	])

const codegen = async (argv: readonly string[], deps: DbCommandDependencies): Promise<void> => {
	const verify = argv.includes('--verify')
	refuseArguments('codegen', argv.filter((arg) => arg !== '--verify'))
	const source = (await dialectAt(deps.cwd)) === 'sqlite' ? await sqliteSchema(deps.cwd) : await postgresSchema(deps)
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
): Promise<
	{ readonly files: ReadonlyMap<string, string>; readonly tests: ReadonlyMap<string, GeneratedTest>; readonly missing: readonly Finding[] }
> => {
	const { files } = await readApplicationTree(cwd)
	const inputs = scaffoldInputs(files)
	return {
		files,
		tests: await generatedTests(inputs.policies, inputs.artifact, inputs.fixtures, inputs.dialect),
		missing: missingEndpointFixtures(inputs),
	}
}

const testScaffold = async (argv: readonly string[], deps: DbCommandDependencies): Promise<void> => {
	refuseArguments('test-scaffold', argv)
	// The scaffold reads the dialect statically; a config whose loaded database that read misses is refused first.
	await dialectAt(deps.cwd)
	const { files, tests, missing } = await expectedTests(deps.cwd)
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
	if (missing.length > 0) {
		throw new Error(`db test-scaffold: the endpoint access tests are incomplete\n${missing.map(formatFinding).join('\n')}`)
	}
	if (tests.size === 0) {
		deps.write('no generated tests: they start with the first table a store reaches, and the application has none; write the first test yourself\n')
	}
}

/**
 * Only what Bun needs to run; on Postgres the URL arrives as the kit's own variable, and no framework variable is passed
 * on. It is a throwaway provisioner's, never FABRIKA_APP_DATABASE_URL: the generated tests load application code. The
 * SQLite kit opens an in-memory database and needs none.
 */
const testEnvironment = (source: DbCommandDependencies['source'], url: string | undefined): Record<string, string> => {
	const environment: Record<string, string> = url === undefined ? {} : { FABRIKA_TEST_POSTGRES_URL: url, FABRIKA_TEST_POSTGRES_REQUIRED: '1' }
	for (const name of ['PATH', 'HOME', 'TMPDIR']) {
		const value = source[name]
		if (value !== undefined) environment[name] = value
	}
	return environment
}

/**
 * The server's own words for a refused connection (SQLSTATE 53300) and the test kit's report of one it gave up on. A
 * run whose tests met one says so instead of counting cases: a case that could not connect proved nothing.
 */
const EXHAUSTED_CONNECTIONS = [
	CONNECTION_CAPACITY_MESSAGE,
	'remaining connection slots are reserved',
	'too many clients already',
	'too many connections for role',
	'too many connections for database',
]

/** Whether the tests' output reports a connection the database refused for lack of a free slot. */
export const reportsExhaustedConnections = (output: string): boolean => EXHAUSTED_CONNECTIONS.some((text) => output.includes(text))

/**
 * Runs exactly the generated tests, with an empty `bunfig.toml` so that no preload, root or ignore pattern of the
 * application applies, and the platform's preload, which captures Bun's test functions before the application loads.
 * Fails unless every case the scaffold wrote is reported as passed with an assertion. The child's output is never
 * printed, because a dependency may write a credential into it; `--verbose`, which the platform never passes, prints it.
 * On Postgres they run as a throwaway provisioner, dropped afterwards; on SQLite with no database URL at all.
 */
const testIsolation = async (argv: readonly string[], deps: DbCommandDependencies): Promise<void> => {
	const verbose = argv.includes('--verbose')
	refuseArguments('test-isolation', argv.filter((arg) => arg !== '--verbose'))
	const sqlite = (await dialectAt(deps.cwd)) === 'sqlite'
	const url = sqlite ? undefined : required(deps.source, 'FABRIKA_APP_DATABASE_URL')
	const { files, tests, missing } = await expectedTests(deps.cwd)
	if (missing.length > 0) throw new Error(`db test-isolation: the endpoint access tests are incomplete\n${missing.map(formatFinding).join('\n')}`)
	for (const [path, { text }] of tests) {
		if (files.get(path) !== text) throw new Error(`db test-isolation: ${path} is not the test fabrika db test-scaffold writes; run it`)
	}
	if (tests.size === 0) {
		deps.write('no generated tests\n')
		return
	}
	if (url === undefined) {
		await runGeneratedTests(tests, verbose, testEnvironment(deps.source, undefined), deps)
		return
	}
	let provisioner: TestProvisioner
	try {
		provisioner = await withConnectionCapacity(() => createTestProvisioner(url))
	} catch (error) {
		throw reportable(error)
	}
	if (provisioner.swept.length > 0) deps.write(`dropped the test provisioners earlier runs left behind: ${provisioner.swept.join(', ')}\n`)
	try {
		await runGeneratedTests(tests, verbose, testEnvironment(deps.source, provisioner.url), deps)
	} finally {
		await withConnectionCapacity(() => provisioner.drop()).catch((error: unknown) => {
			throw reportable(error)
		})
	}
}

const runGeneratedTests = async (
	tests: ReadonlyMap<string, GeneratedTest>,
	verbose: boolean,
	env: Record<string, string>,
	deps: DbCommandDependencies,
): Promise<void> => {
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
			{ cwd: deps.cwd, env, stdout: 'pipe', stderr: 'pipe' },
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
				const outcome = reportedCase === undefined
					? 'not run'
					: reportedCase.outcome === 'passed' && reportedCase.assertions === 0
					? 'no assertion'
					: reportedCase.outcome
				if (outcome !== 'passed') failed.push(`${path}: ${name} (${outcome})`)
			}
		}
		if ((code !== 0 || failed.length > 0) && reportsExhaustedConnections(`${stdout}${stderr}`)) {
			throw new Error(
				`db test-isolation: ${CONNECTION_CAPACITY_MESSAGE} for the generated tests (SQLSTATE ${TOO_MANY_CONNECTIONS}), so they reached no verdict; other processes hold the database's connections: free them or give the database more, then run it again`,
			)
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
