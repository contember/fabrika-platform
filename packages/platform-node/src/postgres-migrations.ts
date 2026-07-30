import type { SqlDatabase, SqlStatement } from '@fabrika/platform'
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
	/** Only service-owned bundles may adopt matching entries from the old unqualified ledger. */
	adoptLegacy?: boolean
}

export interface PostgresLegacyMigrationLedger {
	/** Old filename-only ledger. */
	table: string
	/** Tables created atomically by this service's first migration. Every sentinel must exist. */
	sentinelTables: readonly string[]
	/** Extra effect probes for migrations whose filename could have collided in a shared old ledger. */
	effects?: readonly PostgresLegacyMigrationEffect[]
}

export interface PostgresLegacyMigrationEffect {
	migration: string
	/** A parameterless SELECT returning one boolean column named `proven`. */
	probeSql: string
}

export interface PostgresMigrationPlan {
	/** Service-scoped ledger table, such as `iam_schema_migrations`. */
	ledgerTable: string
	/** Service-specific session advisory lock. Keep this stable across runner upgrades. */
	lockKey: number
	bundles: readonly PostgresMigrationBundle[]
	legacy?: PostgresLegacyMigrationLedger
}

export interface ReadPostgresMigrationBundleOptions {
	name: string
	directory: string
	files?: readonly string[]
	adoptLegacy?: boolean
}

interface LedgerRow {
	bundle: string
	name: string
}

interface LegacyLedgerRow {
	name: string
	applied_at: number | string
}

interface PresenceRow {
	present: boolean
}

interface ProvenRow {
	proven: boolean
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
		...(options.adoptLegacy === true ? { adoptLegacy: true } : {}),
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
	if (plan.legacy !== undefined) {
		validateIdentifier(plan.legacy.table, 'legacy migration ledger table')
		if (plan.legacy.sentinelTables.length === 0) {
			throw new Error('Legacy migration adoption requires at least one service sentinel')
		}
		for (const sentinel of plan.legacy.sentinelTables) {
			validateIdentifier(sentinel, 'legacy migration sentinel table')
		}
		const adoptingBundles = plan.bundles.filter((bundle) => bundle.adoptLegacy === true)
		if (adoptingBundles.length !== 1) {
			throw new Error('Legacy migration adoption requires exactly one adopting bundle')
		}
		const adoptable = new Set(
			adoptingBundles.flatMap((bundle) => bundle.migrations.map((migration) => migration.name)),
		)
		const effectNames = new Set<string>()
		for (const effect of plan.legacy.effects ?? []) {
			validateMigrationName(effect.migration)
			if (!adoptable.has(effect.migration)) {
				throw new Error(`Legacy migration effect references non-adoptable migration ${effect.migration}`)
			}
			if (effectNames.has(effect.migration)) {
				throw new Error(`Duplicate legacy migration effect ${effect.migration}`)
			}
			if (effect.probeSql.trim() === '') {
				throw new Error(`Legacy migration effect ${effect.migration} is empty`)
			}
			effectNames.add(effect.migration)
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
		const beforeAdoption = await appliedIdentities(db, plan.ledgerTable)
		if (beforeAdoption.size === 0) await adoptLegacyMigrations(db, plan)
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

async function adoptLegacyMigrations(db: SqlDatabase, plan: PostgresMigrationPlan): Promise<void> {
	const legacy = plan.legacy
	if (legacy === undefined) return
	const sentinelStates = await Promise.all(legacy.sentinelTables.map((sentinel) => relationExists(db, sentinel)))
	const presentSentinels = sentinelStates.filter(Boolean).length
	if (presentSentinels === 0) return
	if (presentSentinels !== sentinelStates.length) {
		throw new Error('Legacy migration service sentinels are inconsistent')
	}
	if (!(await relationExists(db, legacy.table))) {
		throw new Error('Legacy migration ledger is missing for an existing service schema')
	}
	for (const sentinel of legacy.sentinelTables) {
		if (!(await relationExists(db, sentinel))) {
			throw new Error('Legacy migration service sentinels changed during adoption')
		}
	}
	const { results } = await db.prepare(`SELECT name, applied_at FROM ${legacy.table}`).all<LegacyLedgerRow>()
	const legacyApplied = new Map(results.map((row) => [row.name, appliedAt(row.applied_at)]))
	const adoptingBundle = plan.bundles.find((bundle) => bundle.adoptLegacy === true)
	if (adoptingBundle === undefined) throw new Error('Legacy migration adopting bundle is missing')
	const firstMigration = adoptingBundle.migrations[0]
	if (firstMigration === undefined || !legacyApplied.has(firstMigration.name)) {
		throw new Error(`Legacy migration ledger does not prove ${adoptingBundle.name}'s first migration`)
	}
	for (const effect of legacy.effects ?? []) {
		if (!legacyApplied.has(effect.migration)) continue
		const row = await db.prepare(effect.probeSql).first<ProvenRow>()
		if (row === null || typeof row.proven !== 'boolean') {
			throw new Error(`Legacy migration effect ${effect.migration} did not return a boolean proven column`)
		}
		if (!row.proven) {
			throw new Error(`Legacy migration effect ${effect.migration} is missing`)
		}
	}
	const statements: SqlStatement[] = []
	for (const bundle of plan.bundles) {
		if (bundle.adoptLegacy !== true) continue
		for (const migration of bundle.migrations) {
			const timestamp = legacyApplied.get(migration.name)
			if (timestamp === undefined) continue
			statements.push(
				db
					.prepare(`INSERT INTO ${plan.ledgerTable} (bundle, name, applied_at)
						VALUES (?, ?, ?)
						ON CONFLICT (bundle, name) DO NOTHING`)
					.bind(
						bundle.name,
						migration.name,
						timestamp,
					),
			)
		}
	}
	if (statements.length > 0) await db.batch(statements)
}

async function relationExists(db: SqlDatabase, name: string): Promise<boolean> {
	const row = await db
		.prepare(`SELECT EXISTS (
			SELECT 1
			FROM pg_catalog.pg_class relation
			JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
			WHERE namespace.nspname = current_schema()
				AND relation.relname = ?
				AND relation.relkind IN ('r', 'p')
		) AS present`)
		.bind(name)
		.first<PresenceRow>()
	return row?.present === true
}

function appliedAt(value: number | string): number {
	const parsed = typeof value === 'number' ? value : Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Legacy migration ledger contains an invalid timestamp')
	return parsed
}

function unixNow(): number {
	return Math.floor(Date.now() / 1_000)
}
