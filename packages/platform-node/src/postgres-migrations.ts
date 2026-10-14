import type { SqlDatabase, SqlStatement } from '@fabrika/platform'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { acquireMigrationLock, grantRuntimeRole, normalizeDefaultPrivileges } from './application-postgres-grants'
import { DATABASE_CODE_FAILURE, databaseCodeCheck } from './database-code'
import { classifyMigrations, type DatabaseObject, migrationManifest } from './migration-classify'
import { refusedStatement } from './migration-sql'
import { PostgresMigrationError } from './postgres-migration-error'

const IDENTIFIER = /^[a-z][a-z0-9_]*$/
const BUNDLE_NAME = /^[a-z][a-z0-9-]*$/
const MIGRATION_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.sql$/
const CHECKSUM = /^[0-9a-f]{64}$/
/** Raised in the migration's own transaction when the file ended it or changed a runner-owned setting. */
const GUARD_FAILURE = 'fabrika-migration-guard'
const PLATFORM_MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations')

export interface PostgresMigration {
	name: string
	sql: string
}

export interface PostgresMigrationBundle {
	name: string
	migrations: readonly PostgresMigration[]
}

export interface PostgresMigrationPlan {
	/** Service-scoped ledger table, such as `iam_schema_migrations`; an application's is qualified by its schema. */
	ledgerTable: string
	/** Service-specific session advisory lock. Keep this stable across runner upgrades. */
	lockKey: number
	bundles: readonly PostgresMigrationBundle[]
	/** Present only in an application's plan (ADR-0017): its schema, a checksum per migration, and timeouts. */
	application?: PostgresApplicationMigrationSettings
}

export interface PostgresApplicationMigrationSettings {
	/** Created when absent. Each migration runs with it as its only `search_path`. */
	schema: string
	/** `lock_timeout` of each migration, so a blocked `ALTER` fails the deploy instead of stalling the live version. */
	lockTimeoutMs: number
	statementTimeoutMs: number
	/** The framework's own bundle (`fabrika`), which alone may name the framework's `fabrika_*` tables. */
	frameworkBundle?: string
	/**
	 * The application's runtime role. Before the plan runs, the migration role's default privileges are cleared of
	 * PUBLIC; after it ran, the runtime role's and PUBLIC's privileges in the schema are reset to the runtime role's DML
	 * on every table but the ledger and verified, in one transaction under the migration lock; it never gets DDL.
	 */
	runtimeRole?: string
	/** How long the runner waits for the migration lock; any session may take an advisory lock, so the wait is bounded. */
	advisoryLockTimeoutMs?: number
}

export { PostgresMigrationError }

export interface ReadPostgresMigrationBundleOptions {
	name: string
	directory: string
	files?: readonly string[]
}

interface LedgerRow {
	bundle: string
	name: string
	checksum?: string | null
}

/** Read one ordered migration bundle from disk. An explicit file list fails closed when a file is absent. */
export function readPostgresMigrationBundle(options: ReadPostgresMigrationBundleOptions): PostgresMigrationBundle {
	validateBundleName(options.name)
	const available = readdirSync(options.directory)
		.filter((file) => file.endsWith('.sql'))
		.sort()
	const names = options.files === undefined ? available : [...options.files].sort()
	const availableNames = new Set(available)
	for (const name of names) {
		validateMigrationName(name)
		if (!availableNames.has(name)) {
			throw new Error(`Postgres migration ${options.name}/${name} is missing`)
		}
	}
	const bundle: PostgresMigrationBundle = {
		name: options.name,
		migrations: names.map((name) => ({
			name,
			sql: readFileSync(join(options.directory, name), 'utf8'),
		})),
	}
	validateBundle(bundle)
	return bundle
}

/** The generic migrations owned by the long-running Bun runtime. */
export function platformNodePostgresMigrationBundle(files?: readonly string[]): PostgresMigrationBundle {
	return readPostgresMigrationBundle({
		name: 'platform-node',
		directory: PLATFORM_MIGRATIONS_DIR,
		...(files === undefined ? {} : { files }),
	})
}

/** Validate a complete plan at composition time, before any SQL is executed. */
export function definePostgresMigrationPlan(plan: PostgresMigrationPlan): PostgresMigrationPlan {
	validateLedgerTable(plan)
	if (!Number.isSafeInteger(plan.lockKey) || plan.lockKey < 1) {
		throw new Error('Postgres migration lock key must be a positive safe integer')
	}
	if (plan.bundles.length === 0) throw new Error('Postgres migration plan must contain at least one bundle')
	const bundleNames = new Set<string>()
	const identities = new Set<string>()
	for (const bundle of plan.bundles) {
		validateBundle(bundle)
		if (bundleNames.has(bundle.name)) throw new Error(`Duplicate Postgres migration bundle ${bundle.name}`)
		bundleNames.add(bundle.name)
		for (const migration of bundle.migrations) {
			const identity = postgresMigrationIdentity(bundle.name, migration.name)
			if (identities.has(identity)) throw new Error(`Duplicate Postgres migration identity ${identity}`)
			identities.add(identity)
		}
	}
	return plan
}

export function postgresMigrationIdentity(bundle: string, name: string): string {
	validateBundleName(bundle)
	validateMigrationName(name)
	return `${bundle}/${name}`
}

/** Preserve a service wrapper's historical filename-only result while the core uses qualified ids. */
export function postgresMigrationFilenames(identities: readonly string[], bundle: string): string[] {
	validateBundleName(bundle)
	const prefix = `${bundle}/`
	const names: string[] = []
	for (const identity of identities) {
		if (!identity.startsWith(prefix)) continue
		const name = identity.slice(prefix.length)
		postgresMigrationIdentity(bundle, name)
		names.push(name)
	}
	return names
}

/**
 * Apply a plan over one Postgres session.
 *
 * The caller must supply a database backed by a single-connection pool. Advisory locks are session
 * state; allowing acquire and release to land on different pooled connections would make the runner
 * appear serialized while providing no serialization at all.
 */
export async function applyPostgresMigrations(
	db: SqlDatabase,
	input: PostgresMigrationPlan,
	options: { now?: () => number } = {},
): Promise<string[]> {
	const plan = definePostgresMigrationPlan(input)
	await acquireMigrationLock(db, plan.lockKey, plan.application?.advisoryLockTimeoutMs, plan.application?.schema ?? plan.ledgerTable)
	let migrationFailed = false
	let migrationError: unknown
	const fresh: string[] = []
	try {
		const applied = await appliedChecksums(db, plan)
		let manifests: ReadonlyMap<string, readonly DatabaseObject[]> = new Map()
		if (plan.application !== undefined) {
			verifyChecksums(plan.bundles, applied)
			manifests = classifyApplicationPlan(plan.bundles, applied, plan.application)
		}
		await ensureLedger(db, plan)
		if (plan.application?.runtimeRole !== undefined) await normalizeDefaultPrivileges(db, plan.application.schema)
		for (const bundle of plan.bundles) {
			for (const migration of bundle.migrations) {
				const identity = postgresMigrationIdentity(bundle.name, migration.name)
				if (applied.has(identity)) continue
				try {
					await db.batch([
						...applicationSettings(db, plan.application),
						db.prepare(GUARD_MARK),
						db.prepare(migration.sql),
						db.prepare(guardCheck(plan.application)),
						...databaseCodeStatements(db, plan.application, manifests.get(identity) ?? []),
						ledgerInsert(db, plan, bundle.name, migration, (options.now ?? unixNow)()),
					])
				} catch (error) {
					if (error instanceof Error && error.message === GUARD_FAILURE) {
						throw new PostgresMigrationError(
							`Postgres migration ${identity} ended the runner's transaction or changed its lock_timeout, statement_timeout or search_path`,
						)
					}
					if (error instanceof Error && error.message.startsWith(DATABASE_CODE_FAILURE)) {
						throw new PostgresMigrationError(
							`Postgres migration ${identity} was rolled back: the schema would hold database code that escapes it or that no migration declares: ${
								error.message.slice(DATABASE_CODE_FAILURE.length)
							}`,
						)
					}
					throw new PostgresMigrationError(`Postgres migration ${identity} failed`, { cause: error })
				}
				applied.set(identity, undefined)
				fresh.push(identity)
			}
		}
		if (plan.application?.runtimeRole !== undefined) {
			await grantRuntimeRole(db, plan.application.schema, plan.ledgerTable, plan.application.runtimeRole)
		}
	} catch (error) {
		migrationFailed = true
		migrationError = error
	}
	let unlockFailed = false
	try {
		const unlocked = await db
			.prepare(`SELECT pg_catalog.pg_advisory_unlock(${plan.lockKey}) AS unlocked`)
			.first<{ unlocked: boolean }>()
		unlockFailed = unlocked?.unlocked !== true
	} catch {
		unlockFailed = true
	}
	if (migrationFailed) throw migrationError
	if (unlockFailed) throw new Error('Postgres migration advisory unlock failed')
	return fresh
}

function validateBundle(bundle: PostgresMigrationBundle): void {
	validateBundleName(bundle.name)
	if (bundle.migrations.length === 0) throw new PostgresMigrationError(`Postgres migration bundle ${bundle.name} is empty`)
	const names = new Set<string>()
	let previous = ''
	for (const migration of bundle.migrations) {
		validateMigrationName(migration.name)
		if (migration.sql.trim() === '') throw new PostgresMigrationError(`Postgres migration ${bundle.name}/${migration.name} is empty`)
		if (names.has(migration.name)) throw new PostgresMigrationError(`Duplicate Postgres migration ${bundle.name}/${migration.name}`)
		const refused = refusedStatement(migration.sql)
		if (refused !== undefined) {
			throw new PostgresMigrationError(
				`Postgres migration ${bundle.name}/${migration.name} line ${refused.line}: ${refused.statement} is not allowed; the runner owns the transaction and its settings`,
			)
		}
		if (previous !== '' && migration.name.localeCompare(previous) < 0) {
			throw new PostgresMigrationError(`Postgres migration bundle ${bundle.name} is not ordered by filename`)
		}
		names.add(migration.name)
		previous = migration.name
	}
}

function validateIdentifier(value: string, label: string): void {
	if (!IDENTIFIER.test(value)) throw new Error(`Invalid ${label}: ${value}`)
}

/** Only an application's ledger is schema-qualified, and only by the application's own schema. */
function validateLedgerTable(plan: PostgresMigrationPlan): void {
	const { application } = plan
	if (application === undefined) {
		validateIdentifier(plan.ledgerTable, 'migration ledger table')
		return
	}
	validateIdentifier(application.schema, 'application schema')
	const prefix = `${application.schema}.`
	if (!plan.ledgerTable.startsWith(prefix)) throw new Error(`Invalid migration ledger table: ${plan.ledgerTable} is not in ${application.schema}`)
	validateIdentifier(plan.ledgerTable.slice(prefix.length), 'migration ledger table')
	if (application.runtimeRole !== undefined) validateIdentifier(application.runtimeRole, 'runtime role')
	if (application.advisoryLockTimeoutMs !== undefined) validateTimeout(application.advisoryLockTimeoutMs, 'advisory lock timeout')
	validateTimeout(application.lockTimeoutMs, 'lock timeout')
	validateTimeout(application.statementTimeoutMs, 'statement timeout')
	// Only the framework's bundle may name `fabrika_*`; it runs first, before an application's own.
	if (application.frameworkBundle !== undefined && (plan.bundles.length < 2 || plan.bundles[0]?.name !== application.frameworkBundle)) {
		throw new Error(`Invalid framework bundle: ${application.frameworkBundle} is not the first of several bundles`)
	}
}

function validateTimeout(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Postgres migration ${label} must be a positive number of milliseconds`)
}

function validateBundleName(value: string): void {
	if (!BUNDLE_NAME.test(value)) throw new PostgresMigrationError(`Invalid Postgres migration bundle name: ${value}`)
}

function validateMigrationName(value: string): void {
	if (!MIGRATION_NAME.test(value)) throw new PostgresMigrationError(`Invalid Postgres migration filename: ${value}`)
}

/** The service ledgers keep their original shape; an application's ledger also records each file's checksum. */
async function ensureLedger(db: SqlDatabase, plan: PostgresMigrationPlan): Promise<void> {
	if (plan.application === undefined) {
		await db.prepare(`CREATE TABLE IF NOT EXISTS ${plan.ledgerTable} (
		bundle TEXT NOT NULL,
		name TEXT NOT NULL,
		applied_at INTEGER NOT NULL,
		PRIMARY KEY (bundle, name)
	)`).run()
		return
	}
	// `CREATE SCHEMA IF NOT EXISTS` needs CREATE on the database even when the schema exists, which a migration role lacks.
	const schema = await db.prepare('SELECT pg_catalog.to_regnamespace(?) IS NOT NULL AS present').bind(plan.application.schema).first<
		{ present: boolean }
	>()
	if (schema?.present !== true) await db.prepare(`CREATE SCHEMA ${plan.application.schema}`).run()
	await db.prepare(`CREATE TABLE IF NOT EXISTS ${plan.ledgerTable} (
		bundle TEXT NOT NULL,
		name TEXT NOT NULL,
		checksum TEXT NOT NULL,
		applied_at INTEGER NOT NULL,
		PRIMARY KEY (bundle, name)
	)`).run()
}

/**
 * Applied identities, each with its recorded checksum; `undefined` for a service ledger, which records none. Empty
 * while the ledger does not exist yet, so a fresh schema is checked before the runner creates anything.
 */
async function appliedChecksums(db: SqlDatabase, plan: PostgresMigrationPlan): Promise<Map<string, string | undefined>> {
	const ledger = await db.prepare('SELECT pg_catalog.to_regclass(?) IS NOT NULL AS present').bind(plan.ledgerTable).first<{ present: boolean }>()
	if (ledger?.present !== true) return new Map()
	const columns = plan.application === undefined ? 'bundle, name' : 'bundle, name, checksum'
	const { results } = await db.prepare(`SELECT ${columns} FROM ${plan.ledgerTable}`).all<LedgerRow>()
	const applied = new Map<string, string | undefined>()
	for (const row of results) {
		const identity = postgresMigrationIdentity(row.bundle, row.name)
		if (plan.application === undefined) {
			applied.set(identity, undefined)
			continue
		}
		if (typeof row.checksum !== 'string' || !CHECKSUM.test(row.checksum)) {
			throw new PostgresMigrationError(`Postgres migration ledger row ${identity} has no valid checksum`)
		}
		applied.set(identity, row.checksum)
	}
	return applied
}

/**
 * Every applied file must be byte-for-byte the file that ran. Checked before anything is applied, so an edited
 * migration fails the run without a partial apply. A ledger row without a file is the database being ahead of the
 * code after a rollback, which is tolerated.
 */
function verifyChecksums(bundles: readonly PostgresMigrationBundle[], applied: ReadonlyMap<string, string | undefined>): void {
	for (const bundle of bundles) {
		for (const migration of bundle.migrations) {
			const identity = postgresMigrationIdentity(bundle.name, migration.name)
			const recorded = applied.get(identity)
			if (recorded !== undefined && recorded !== migrationChecksum(migration.sql)) {
				throw new PostgresMigrationError(
					`Postgres migration ${identity} changed after it was applied; an applied migration is immutable, so write the change as a new migration`,
				)
			}
		}
	}
}

/**
 * Classifies every file of an application plan and refuses one that is not applied yet and holds a refused statement,
 * before any SQL runs. An applied file is already checksum-locked, so a statement refused today cannot lock an
 * installation out of its next deploy. Returns, per migration identity, the manifest folded through that file: what
 * the catalog check admits right after it ran.
 */
function classifyApplicationPlan(
	bundles: readonly PostgresMigrationBundle[],
	applied: ReadonlyMap<string, string | undefined>,
	application: PostgresApplicationMigrationSettings,
): ReadonlyMap<string, readonly DatabaseObject[]> {
	const files = bundles.flatMap((bundle) =>
		bundle.migrations.map((migration) => ({
			name: migration.name,
			sql: migration.sql,
			framework: bundle.name === application.frameworkBundle,
			identity: postgresMigrationIdentity(bundle.name, migration.name),
		}))
	)
	const classified = classifyMigrations(files, application.schema)
	for (const [index, file] of files.entries()) {
		if (applied.has(file.identity)) continue
		const refused = classified.files[index]?.refused[0]
		if (refused === undefined) continue
		throw new PostgresMigrationError(
			`Application migration ${file.name} line ${refused.line}: ${refused.reason} is not allowed; an application migration may not leave its schema, its transaction or the platform (ADR-0017)`,
		)
	}
	return new Map(files.map((file, index) => [file.identity, migrationManifest(classified.files.slice(0, index + 1))]))
}

/** SHA-256 of the file's text, hex. */
export function migrationChecksum(sql: string): string {
	return createHash('sha256').update(sql, 'utf8').digest('hex')
}

/** Remembers the transaction in a transaction-local setting, which a COMMIT or ROLLBACK in the file discards. */
const GUARD_MARK = "SELECT pg_catalog.set_config('fabrika.migration_xact', pg_catalog.txid_current()::pg_catalog.text, true)"

/**
 * Fails the transaction when the file ended it or loosened a runner-owned setting. The lexical refusal runs first;
 * this also catches `set_config()` and anything the tokenizer cannot see. `pg_settings.setting` is in milliseconds.
 * Every function, operator and type is `pg_catalog`'s by name: the application's schema comes first on the path.
 */
function guardCheck(application: PostgresApplicationMigrationSettings | undefined): string {
	const differs = (left: string, right: string): string => `${left} OPERATOR(pg_catalog.<>) ${right}`
	const setting = (name: string): string => `(SELECT setting FROM pg_catalog.pg_settings WHERE name OPERATOR(pg_catalog.=) '${name}')`
	const settings = application === undefined ? [] : [
		differs(setting('lock_timeout'), `'${application.lockTimeoutMs}'`),
		differs(setting('statement_timeout'), `'${application.statementTimeoutMs}'`),
		differs("pg_catalog.current_setting('search_path')", `'${applicationSearchPath(application)}'`),
	]
	const conditions = [
		differs("COALESCE(pg_catalog.current_setting('fabrika.migration_xact', true), '')", 'pg_catalog.txid_current()::pg_catalog.text'),
		...settings,
	]
	return `DO $guard$ BEGIN IF ${conditions.join(' OR ')} THEN RAISE EXCEPTION '${GUARD_FAILURE}'; END IF; END $guard$`
}

/** The application's own schema first, so an unqualified name is its own; `pg_catalog` then, so a built-in resolves. */
function applicationSearchPath(application: PostgresApplicationMigrationSettings): string {
	return `${application.schema}, pg_catalog`
}

function applicationSettings(db: SqlDatabase, application: PostgresApplicationMigrationSettings | undefined): SqlStatement[] {
	if (application === undefined) return []
	return [
		db.prepare(`SET LOCAL search_path TO ${applicationSearchPath(application)}`),
		db.prepare(`SET LOCAL lock_timeout = ${application.lockTimeoutMs}`),
		db.prepare(`SET LOCAL statement_timeout = ${application.statementTimeoutMs}`),
		// The tokenizer reads '…' without backslash escapes, as Postgres does with this setting on.
		db.prepare('SET LOCAL standard_conforming_strings = on'),
	]
}

/**
 * The catalog check, after the file and before the commit, on settings it pins itself: the file may have changed
 * `standard_conforming_strings`, and nothing the application installed may resolve before `pg_catalog`.
 */
function databaseCodeStatements(
	db: SqlDatabase,
	application: PostgresApplicationMigrationSettings | undefined,
	manifest: readonly DatabaseObject[],
): SqlStatement[] {
	if (application === undefined) return []
	return [
		db.prepare('SET LOCAL search_path TO pg_catalog, pg_temp'),
		db.prepare('SET LOCAL standard_conforming_strings = on'),
		db.prepare(databaseCodeCheck(application.schema, manifest)),
	]
}

function ledgerInsert(db: SqlDatabase, plan: PostgresMigrationPlan, bundle: string, migration: PostgresMigration, appliedAt: number): SqlStatement {
	if (plan.application === undefined) {
		return db.prepare(`INSERT INTO ${plan.ledgerTable} (bundle, name, applied_at) VALUES (?, ?, ?)`).bind(bundle, migration.name, appliedAt)
	}
	return db
		.prepare(`INSERT INTO ${plan.ledgerTable} (bundle, name, checksum, applied_at) VALUES (?, ?, ?, ?)`)
		.bind(bundle, migration.name, migrationChecksum(migration.sql), appliedAt)
}

function unixNow(): number {
	return Math.floor(Date.now() / 1_000)
}
