import {
	applyPostgresMigrations,
	definePostgresMigrationPlan,
	PostgresDatabase,
	type PostgresMigration,
	postgresMigrationFilenames,
	type PostgresMigrationPlan,
	readPostgresMigrationBundle,
} from '@fabrika/platform-node'
import { join } from 'node:path'

const MIGRATION_LOCK_KEY = 4471902583
const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'migrations-postgres')

export function postgresMigrations(dir: string = MIGRATIONS_DIR): PostgresMigration[] {
	return [...serviceBundle(dir).migrations]
}

export function postgresMigrationPlan(migrations: readonly PostgresMigration[] = postgresMigrations()): PostgresMigrationPlan {
	return definePostgresMigrationPlan({
		ledgerTable: 'control_schema_migrations',
		lockKey: MIGRATION_LOCK_KEY,
		bundles: [{ name: 'control', migrations, adoptLegacy: true }],
		legacy: {
			table: 'schema_migrations',
			// Both tables are created in Control's atomic 0001 migration.
			sentinelTables: ['apps', 'runs'],
			// IAM and Control shared one old ledger on Zerops. Do not trust a colliding row alone.
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
}

export async function applyMigrations(
	db: PostgresDatabase,
	migrations: readonly PostgresMigration[] = postgresMigrations(),
): Promise<string[]> {
	return postgresMigrationFilenames(await applyPostgresMigrations(db, postgresMigrationPlan(migrations)), 'control')
}

function serviceBundle(directory: string) {
	return readPostgresMigrationBundle({
		name: 'control',
		directory,
		adoptLegacy: true,
	})
}

async function main(): Promise<void> {
	const url = process.env['VOZKA_DATABASE_URL']
	if (url === undefined || url.trim() === '') throw new Error('VOZKA_DATABASE_URL is required')
	const db = PostgresDatabase.connect(url, { max: 1 })
	try {
		const applied = await applyMigrations(db)
		console.info(applied.length === 0 ? 'migrations: already up to date' : `migrations applied: ${applied.join(', ')}`)
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
