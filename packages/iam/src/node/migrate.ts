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

const MIGRATION_LOCK_KEY = 7214839201
const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'migrations-postgres')

export function postgresMigrations(dir: string = MIGRATIONS_DIR): PostgresMigration[] {
	return [...serviceBundle(dir).migrations]
}

export function postgresMigrationPlan(migrations: readonly PostgresMigration[] = postgresMigrations()): PostgresMigrationPlan {
	return definePostgresMigrationPlan({
		ledgerTable: 'iam_schema_migrations',
		lockKey: MIGRATION_LOCK_KEY,
		bundles: [{ name: 'iam', migrations, adoptLegacy: true }],
		legacy: {
			table: 'schema_migrations',
			// Both tables are created in IAM's atomic 0001 migration.
			sentinelTables: ['principals', 'auth_log'],
			effects: [{
				migration: '0002_provisioning_principal.sql',
				probeSql: `SELECT EXISTS (
					SELECT 1 FROM principals WHERE id = 'provisioning-admin'
				) AS proven`,
			}],
		},
	})
}

export async function applyMigrations(
	db: PostgresDatabase,
	migrations: readonly PostgresMigration[] = postgresMigrations(),
): Promise<string[]> {
	return postgresMigrationFilenames(await applyPostgresMigrations(db, postgresMigrationPlan(migrations)), 'iam')
}

function serviceBundle(directory: string) {
	return readPostgresMigrationBundle({
		name: 'iam',
		directory,
		adoptLegacy: true,
	})
}

async function main(): Promise<void> {
	const url = process.env['PROPUSTKA_DATABASE_URL']
	if (url === undefined || url.trim() === '') throw new Error('PROPUSTKA_DATABASE_URL is required')
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
