import { applicationMigrations as sqliteApplicationMigrations } from '@fabrika/app/build'
import { type ApplicationDialect, applicationDialect, CONFIG_FILE } from '@fabrika/check'
import { CodegenError, type GeneratedModule, generateSchema, leftOutText, SCHEMA_FILE } from '@fabrika/db/codegen'
import { generateSqliteSchema } from '@fabrika/db/codegen-sqlite'
import { FRAMEWORK_MIGRATION_BUNDLE, FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'
import { SQLITE_FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations-sqlite'
import {
	APPLICATION_MIGRATION_BUNDLE,
	ConnectionCapacityError,
	DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
	DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS,
	definePostgresApplicationMigrations,
	type PostgresApplicationMigrations,
	PostgresMigrationError,
	postgresMigrationResultMessage,
} from '@fabrika/platform-node'
import { SQL } from 'bun'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** The checker's `migration-name` contract (`@fabrika/check`, `db/migrations/`). */
const MIGRATIONS_DIR = 'db/migrations'
const SLUG = /^[a-z0-9]+(?:_[a-z0-9]+)*$/

export const DB_USAGE = `fabrika db — an application's database schema: Postgres, or SQLite on Cloudflare

Usage:
  fabrika db new <slug>           Write ${MIGRATIONS_DIR}/<UTC YYYYMMDDHHMMSS>_<slug>.sql; the slug is lowercase snake_case.
  fabrika db migrate              Apply the framework's tables, then ${MIGRATIONS_DIR}, to the application's schema app_<id>.
  fabrika db codegen [--verify] [--config=<path>]  Write ${SCHEMA_FILE} from the migrated schema; --verify only fails when it is stale.

Run from the application root. \`--config\` names the application's config, ${CONFIG_FILE} by default, as \`fabrika app
build\` takes it: its provider decides the dialect. \`migrate\` and \`codegen\` read FABRIKA_APP_ID and FABRIKA_APP_DATABASE_URL from
the environment only. FABRIKA_APP_DATABASE_URL is the provisioning credential: \`migrate\` uses it only to create
the application's roles (app_<id> owns the schema, run_<id> gets DML on its tables) and fails when it cannot create
roles. It applies the files as app_<id>, holds a lock derived from the application id, runs each file in one
transaction with lock_timeout ${DEFAULT_MIGRATION_LOCK_TIMEOUT_MS} ms and statement_timeout ${DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS} ms, and fails when a
file that already ran has changed: an applied migration is immutable, so a change is a new file.

An application whose ${CONFIG_FILE} default-exports @fabrika/provider-cloudflare's defineApp runs on SQLite in its
Durable Object, which applies the migrations itself when it boots: \`migrate\` refuses, \`codegen\` applies them to an
in-memory database; neither needs a database URL.
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

/** The dialect the config at `configPath` names, read as the checker reads `fabrika.config.ts`; Postgres without a config. */
const dialectAt = async (cwd: string, configPath: string = CONFIG_FILE): Promise<ApplicationDialect> => {
	const config = await readFile(join(cwd, configPath), 'utf8').catch(() => undefined)
	return applicationDialect(new Map(config === undefined ? [] : [[CONFIG_FILE, config]]))
}

const CONFIG_OPTION = '--config='

/** `--config=<path>`, relative to the application root, and the arguments besides it. */
const configOption = (argv: readonly string[]): { readonly config: string; readonly rest: readonly string[] } => {
	const named = argv.filter((arg) => arg.startsWith(CONFIG_OPTION))
	const config = named.at(-1)?.slice(CONFIG_OPTION.length)
	if (named.length > 1 || config === '') throw new Error(`db: --config names one config file\n\n${DB_USAGE}`)
	return { config: config ?? CONFIG_FILE, rest: argv.filter((arg) => !arg.startsWith(CONFIG_OPTION)) }
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
const postgresSchema = async (deps: DbCommandDependencies): Promise<GeneratedModule> => {
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
const sqliteSchema = async (cwd: string): Promise<GeneratedModule> =>
	generateSqliteSchema([
		{ bundle: FRAMEWORK_MIGRATION_BUNDLE, migrations: SQLITE_FRAMEWORK_MIGRATIONS },
		{ bundle: APPLICATION_MIGRATION_BUNDLE, migrations: await sqliteApplicationMigrations(cwd) },
	])

const codegen = async (argv: readonly string[], deps: DbCommandDependencies): Promise<void> => {
	const { config, rest } = configOption(argv)
	const verify = rest.includes('--verify')
	refuseArguments('codegen', rest.filter((arg) => arg !== '--verify'))
	const { source, leftOut } = (await dialectAt(deps.cwd, config)) === 'sqlite' ? await sqliteSchema(deps.cwd) : await postgresSchema(deps)
	const path = join(deps.cwd, SCHEMA_FILE)
	// Named on every run, --verify's too, so a column the module leaves out is never silent.
	for (const column of leftOut) deps.write(`${leftOutText(`${column.table}.${column.column}`, column.type, column.of)}\n`)
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

export const runDbCommand = async (command: string | undefined, argv: readonly string[], deps: DbCommandDependencies): Promise<void> => {
	if (command === 'new') return newMigration(argv, deps)
	if (command === 'migrate') return migrate(argv, deps)
	if (command === 'codegen') return codegen(argv, deps)
	// A platform release up to 0.9.0-dev.18 still runs this init command against the application's own CLI, and its
	// reader admits a newer prerelease of the same version (ADR-0062): the command stays, and runs nothing.
	if (command === 'test-isolation') {
		deps.write('db test-isolation: nothing to run; this release generates no tests\n')
		return
	}
	throw new Error(`Unknown db command: ${command ?? '(missing)'}\n\n${DB_USAGE}`)
}

export const runDbCli = (command: string | undefined, argv: readonly string[]): Promise<void> =>
	runDbCommand(command, argv, {
		cwd: process.cwd(),
		source: process.env,
		now: () => new Date(),
		write: (line) => process.stdout.write(line),
	})
