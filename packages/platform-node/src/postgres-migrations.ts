import type { SqlDatabase } from '@fabrika/platform'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const IDENTIFIER = /^[a-z][a-z0-9_]*$/
const BUNDLE_NAME = /^[a-z][a-z0-9-]*$/
const MIGRATION_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.sql$/
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
	/** Service-scoped ledger table, such as `iam_schema_migrations`. */
	ledgerTable: string
	/** Service-specific session advisory lock. Keep this stable across runner upgrades. */
	lockKey: number
	bundles: readonly PostgresMigrationBundle[]
}

export interface ReadPostgresMigrationBundleOptions {
	name: string
	directory: string
	files?: readonly string[]
}

interface LedgerRow {
	bundle: string
	name: string
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
	validateIdentifier(plan.ledgerTable, 'migration ledger table')
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
		await ensureLedger(db, plan.ledgerTable)
		const applied = await appliedIdentities(db, plan.ledgerTable)
		for (const bundle of plan.bundles) {
			for (const migration of bundle.migrations) {
				const identity = postgresMigrationIdentity(bundle.name, migration.name)
				if (applied.has(identity)) continue
				await db.batch([
					db.prepare(migration.sql),
					db
						.prepare(`INSERT INTO ${plan.ledgerTable} (bundle, name, applied_at) VALUES (?, ?, ?)`)
						.bind(bundle.name, migration.name, (options.now ?? unixNow)()),
				])
				applied.add(identity)
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

function validateBundleName(value: string): void {
	if (!BUNDLE_NAME.test(value)) throw new Error(`Invalid Postgres migration bundle name: ${value}`)
}

function validateMigrationName(value: string): void {
	if (!MIGRATION_NAME.test(value)) throw new Error(`Invalid Postgres migration filename: ${value}`)
}

async function ensureLedger(db: SqlDatabase, ledgerTable: string): Promise<void> {
	await db.prepare(`CREATE TABLE IF NOT EXISTS ${ledgerTable} (
		bundle TEXT NOT NULL,
		name TEXT NOT NULL,
		applied_at INTEGER NOT NULL,
		PRIMARY KEY (bundle, name)
	)`).run()
}

async function appliedIdentities(db: SqlDatabase, ledgerTable: string): Promise<Set<string>> {
	const { results } = await db.prepare(`SELECT bundle, name FROM ${ledgerTable}`).all<LedgerRow>()
	return new Set(results.map((row) => postgresMigrationIdentity(row.bundle, row.name)))
}

function unixNow(): number {
	return Math.floor(Date.now() / 1_000)
}
