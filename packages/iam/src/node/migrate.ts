import {
	definePostgresServiceMigrations,
	PostgresDatabase,
	type PostgresMigration,
	type PostgresMigrationPlan,
	postgresMigrationResultMessage,
} from '@fabrika/platform-node'
import { join } from 'node:path'

const MIGRATION_LOCK_KEY = 7214839201
const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'migrations-postgres')
const serviceMigrations = definePostgresServiceMigrations({
	name: 'iam',
	directory: MIGRATIONS_DIR,
	ledgerTable: 'iam_schema_migrations',
	lockKey: MIGRATION_LOCK_KEY,
	legacy: {
		table: 'schema_migrations',
		sentinelTables: ['principals', 'auth_log'],
		effects: [{
			migration: '0002_provisioning_principal.sql',
			probeSql: `SELECT EXISTS (
				SELECT 1 FROM principals WHERE id = 'provisioning-admin'
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
	const url = process.env['PROPUSTKA_DATABASE_URL']
	if (url === undefined || url.trim() === '') throw new Error('PROPUSTKA_DATABASE_URL is required')
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
