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
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** The checker's `migration-name` contract (`@fabrika/check`, `db/migrations/`). */
const MIGRATIONS_DIR = 'db/migrations'
const SLUG = /^[a-z0-9]+(?:_[a-z0-9]+)*$/

export const DB_USAGE = `fabrika db — an application's Postgres schema

Usage:
  fabrika db new <slug>           Write ${MIGRATIONS_DIR}/<UTC YYYYMMDDHHMMSS>_<slug>.sql; the slug is lowercase snake_case.
  fabrika db migrate              Apply the framework's tables, then ${MIGRATIONS_DIR}, to the application's schema app_<id>.
  fabrika db codegen [--verify]   Write ${SCHEMA_FILE} from the migrated schema; --verify only fails when it is stale.

Run from the application root. \`migrate\` and \`codegen\` read FABRIKA_APP_ID and FABRIKA_APP_DATABASE_URL from
the environment only. \`migrate\` holds a lock derived from the application id, runs each file in one transaction
with lock_timeout ${DEFAULT_MIGRATION_LOCK_TIMEOUT_MS} ms and statement_timeout ${DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS} ms, and fails when a
file that already ran has changed: an applied migration is immutable, so a change is a new file.
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

export const runDbCommand = async (command: string | undefined, argv: readonly string[], deps: DbCommandDependencies): Promise<void> => {
	if (command === 'new') return newMigration(argv, deps)
	if (command === 'migrate') return migrate(argv, deps)
	if (command === 'codegen') return codegen(argv, deps)
	throw new Error(`Unknown db command: ${command ?? '(missing)'}\n\n${DB_USAGE}`)
}

export const runDbCli = (command: string | undefined, argv: readonly string[]): Promise<void> =>
	runDbCommand(command, argv, {
		cwd: process.cwd(),
		source: process.env,
		now: () => new Date(),
		write: (line) => process.stdout.write(line),
	})
