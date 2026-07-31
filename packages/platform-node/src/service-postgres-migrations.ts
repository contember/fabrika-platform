import type { SqlDatabase } from '@fabrika/platform'
import {
	applyPostgresMigrations,
	definePostgresMigrationPlan,
	type PostgresLegacyMigrationLedger,
	type PostgresMigration,
	type PostgresMigrationBundle,
	postgresMigrationFilenames,
	type PostgresMigrationPlan,
	readPostgresMigrationBundle,
} from './postgres-migrations'

export interface PostgresServiceMigrationsConfig {
	/** Stable service-owned bundle name. */
	readonly name: string
	/** Stable service-owned ledger table. */
	readonly ledgerTable: string
	/** Stable service advisory lock. */
	readonly lockKey: number
	readonly directory: string
	readonly legacy: PostgresLegacyMigrationLedger
	/** Runtime-owned bundles applied before the service schema. */
	readonly dependencies?: readonly PostgresMigrationBundle[]
}

export interface PostgresServiceMigrations {
	read(directory?: string): PostgresMigration[]
	plan(migrations?: readonly PostgresMigration[]): PostgresMigrationPlan
	apply(db: SqlDatabase, migrations?: readonly PostgresMigration[]): Promise<string[]>
	applyQualified(db: SqlDatabase, migrations?: readonly PostgresMigration[]): Promise<string[]>
}

/**
 * Define the repeated service migration wrapper while keeping service identity and lifecycle local.
 * Bundle names, ledgers, lock ids, dependency order, and legacy evidence remain explicit inputs.
 */
export function definePostgresServiceMigrations(config: PostgresServiceMigrationsConfig): PostgresServiceMigrations {
	const read = (directory: string = config.directory): PostgresMigration[] => [
		...readPostgresMigrationBundle({
			name: config.name,
			directory,
			adoptLegacy: true,
		}).migrations,
	]
	const plan = (migrations: readonly PostgresMigration[] = read()): PostgresMigrationPlan =>
		definePostgresMigrationPlan({
			ledgerTable: config.ledgerTable,
			lockKey: config.lockKey,
			bundles: [
				...(config.dependencies ?? []),
				{ name: config.name, migrations, adoptLegacy: true },
			],
			legacy: config.legacy,
		})
	const applyQualified = (
		db: SqlDatabase,
		migrations: readonly PostgresMigration[] = read(),
	): Promise<string[]> => applyPostgresMigrations(db, plan(migrations))
	const apply = async (
		db: SqlDatabase,
		migrations: readonly PostgresMigration[] = read(),
	): Promise<string[]> => postgresMigrationFilenames(await applyQualified(db, migrations), config.name)

	return { read, plan, apply, applyQualified }
}

export function postgresMigrationResultMessage(applied: readonly string[]): string {
	return applied.length === 0 ? 'migrations: already up to date' : `migrations applied: ${applied.join(', ')}`
}
