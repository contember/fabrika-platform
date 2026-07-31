import {
	definePostgresServiceMigrations,
	platformNodePostgresMigrationBundle,
	PostgresDatabase,
	type PostgresMigration,
	type PostgresMigrationPlan,
	postgresMigrationResultMessage,
} from '@fabrika/platform-node'
import { join } from 'node:path'

const MIGRATION_LOCK_KEY = 6384217905
const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'migrations-postgres')
const serviceMigrations = definePostgresServiceMigrations({
	name: 'operations',
	directory: MIGRATIONS_DIR,
	ledgerTable: 'operations_schema_migrations',
	lockKey: MIGRATION_LOCK_KEY,
	dependencies: [platformNodePostgresMigrationBundle(['0001_jobs.sql'])],
	legacy: {
		table: 'schema_migrations',
		sentinelTables: ['sources', 'issues'],
	},
})

export type Migration = PostgresMigration

export function postgresMigrations(dir: string = MIGRATIONS_DIR): PostgresMigration[] {
	return serviceMigrations.read(dir)
}

export function postgresMigrationPlan(migrations: readonly PostgresMigration[] = postgresMigrations()): PostgresMigrationPlan {
	return serviceMigrations.plan(migrations)
}

export async function applyMigrations(
	db: PostgresDatabase,
	migrations: readonly PostgresMigration[] = postgresMigrations(),
): Promise<string[]> {
	return serviceMigrations.apply(db, migrations)
}

/** Apply the complete composed plan for process-side reporting, including platform-owned bundles. */
export function applyQualifiedMigrations(
	db: PostgresDatabase,
	migrations: readonly PostgresMigration[] = postgresMigrations(),
): Promise<string[]> {
	return serviceMigrations.applyQualified(db, migrations)
}

export function migrationResultMessage(applied: readonly string[]): string {
	return postgresMigrationResultMessage(applied)
}

async function main(): Promise<void> {
	const url = process.env['FABRIKA_OPERATIONS_DATABASE_URL']
	if (url === undefined || url.trim() === '') throw new Error('FABRIKA_OPERATIONS_DATABASE_URL is required')
	const db = PostgresDatabase.connect(url, { max: 1 })
	try {
		console.info(migrationResultMessage(await applyQualifiedMigrations(db)))
	} finally {
		await db.close()
	}
}

if (import.meta.main) {
	main().catch(() => {
		// Driver errors may contain the credential-bearing connection URL.
		console.error('migration failed')
		process.exit(1)
	})
}
