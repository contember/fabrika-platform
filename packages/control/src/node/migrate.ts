import {
	definePostgresServiceMigrations,
	PostgresDatabase,
	type PostgresMigration,
	type PostgresMigrationPlan,
	postgresMigrationResultMessage,
} from '@fabrika/platform-node'
import { join } from 'node:path'

const MIGRATION_LOCK_KEY = 4471902583
const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'migrations-postgres')
const serviceMigrations = definePostgresServiceMigrations({
	name: 'control',
	directory: MIGRATIONS_DIR,
	ledgerTable: 'control_schema_migrations',
	lockKey: MIGRATION_LOCK_KEY,
	legacy: {
		table: 'schema_migrations',
		sentinelTables: ['apps', 'runs'],
		effects: [{
			migration: '0002_jobs.sql',
			probeSql: `SELECT
				EXISTS (
					SELECT 1
					FROM pg_catalog.pg_class AS relation
					INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
					WHERE namespace.nspname = current_schema()
						AND relation.relname = 'jobs'
						AND relation.relkind IN ('r', 'p')
				)
				AND (
					SELECT COUNT(*) = 7
					FROM information_schema.columns
					WHERE table_schema = current_schema()
						AND table_name = 'jobs'
						AND column_name IN ('id', 'queue', 'payload', 'visible_at', 'attempts', 'max_attempts', 'created_at')
				) AS proven`,
		}],
	},
})

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

async function main(): Promise<void> {
	const url = process.env['VOZKA_DATABASE_URL']
	if (url === undefined || url.trim() === '') throw new Error('VOZKA_DATABASE_URL is required')
	const db = PostgresDatabase.connect(url, { max: 1 })
	try {
		const applied = await applyMigrations(db)
		console.info(postgresMigrationResultMessage(applied))
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
