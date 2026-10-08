import type { SqlDatabase, SqlStatement } from '@fabrika/platform'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const IDENTIFIER = /^[a-z][a-z0-9_]*$/
const BUNDLE_NAME = /^[a-z][a-z0-9-]*$/
const MIGRATION_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.sql$/
const CHECKSUM = /^[0-9a-f]{64}$/
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
}

/** A refusal or failure of the runner itself. Its message names no credential; a driver error is its `cause`. */
export class PostgresMigrationError extends Error {
	override readonly name = 'PostgresMigrationError'
}

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
	await db.prepare(`SELECT pg_advisory_lock(${plan.lockKey})`).run()
	let migrationFailed = false
	let migrationError: unknown
	const fresh: string[] = []
	try {
		await ensureLedger(db, plan)
		const applied = await appliedChecksums(db, plan)
		if (plan.application !== undefined) verifyChecksums(plan.bundles, applied)
		for (const bundle of plan.bundles) {
			for (const migration of bundle.migrations) {
				const identity = postgresMigrationIdentity(bundle.name, migration.name)
				if (applied.has(identity)) continue
				try {
					await db.batch([
						...applicationSettings(db, plan.application),
						db.prepare(migration.sql),
						ledgerInsert(db, plan, bundle.name, migration, (options.now ?? unixNow)()),
					])
				} catch (error) {
					throw new PostgresMigrationError(`Postgres migration ${identity} failed`, { cause: error })
				}
				applied.set(identity, undefined)
				fresh.push(identity)
			}
		}
	} catch (error) {
		migrationFailed = true
		migrationError = error
	}
	let unlockFailed = false
	try {
		const unlocked = await db
			.prepare(`SELECT pg_advisory_unlock(${plan.lockKey}) AS unlocked`)
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
	if (bundle.migrations.length === 0) throw new Error(`Postgres migration bundle ${bundle.name} is empty`)
	const names = new Set<string>()
	let previous = ''
	for (const migration of bundle.migrations) {
		validateMigrationName(migration.name)
		if (migration.sql.trim() === '') throw new Error(`Postgres migration ${bundle.name}/${migration.name} is empty`)
		if (names.has(migration.name)) throw new Error(`Duplicate Postgres migration ${bundle.name}/${migration.name}`)
		if (previous !== '' && migration.name.localeCompare(previous) < 0) {
			throw new Error(`Postgres migration bundle ${bundle.name} is not ordered by filename`)
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
	validateTimeout(application.lockTimeoutMs, 'lock timeout')
	validateTimeout(application.statementTimeoutMs, 'statement timeout')
}

function validateTimeout(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Postgres migration ${label} must be a positive number of milliseconds`)
}

function validateBundleName(value: string): void {
	if (!BUNDLE_NAME.test(value)) throw new Error(`Invalid Postgres migration bundle name: ${value}`)
}

function validateMigrationName(value: string): void {
	if (!MIGRATION_NAME.test(value)) throw new Error(`Invalid Postgres migration filename: ${value}`)
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
	await db.prepare(`CREATE SCHEMA IF NOT EXISTS ${plan.application.schema}`).run()
	await db.prepare(`CREATE TABLE IF NOT EXISTS ${plan.ledgerTable} (
		bundle TEXT NOT NULL,
		name TEXT NOT NULL,
		checksum TEXT NOT NULL,
		applied_at INTEGER NOT NULL,
		PRIMARY KEY (bundle, name)
	)`).run()
}

/** Applied identities, each with its recorded checksum; `undefined` for a service ledger, which records none. */
async function appliedChecksums(db: SqlDatabase, plan: PostgresMigrationPlan): Promise<Map<string, string | undefined>> {
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

/** SHA-256 of the file's text, hex. */
export function migrationChecksum(sql: string): string {
	return createHash('sha256').update(sql, 'utf8').digest('hex')
}

function applicationSettings(db: SqlDatabase, application: PostgresApplicationMigrationSettings | undefined): SqlStatement[] {
	if (application === undefined) return []
	return [
		db.prepare(`SET LOCAL search_path TO ${application.schema}`),
		db.prepare(`SET LOCAL lock_timeout = ${application.lockTimeoutMs}`),
		db.prepare(`SET LOCAL statement_timeout = ${application.statementTimeoutMs}`),
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
