import { PostgresDatabase } from '@fabrika/platform-node'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATION_LOCK_KEY = 6384217905
const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'migrations-postgres')

export interface Migration {
	name: string
	sql: string
}

export function postgresMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
	return readdirSync(dir)
		.filter((file) => file.endsWith('.sql'))
		.sort()
		.map((file) => ({ name: file, sql: readFileSync(join(dir, file), 'utf8') }))
}

export async function applyMigrations(
	db: PostgresDatabase,
	migrations: Migration[] = postgresMigrations(),
): Promise<string[]> {
	await db.prepare(`CREATE TABLE IF NOT EXISTS schema_migrations (
		name TEXT PRIMARY KEY,
		applied_at INTEGER NOT NULL
	)`).run()
	await db.prepare(`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`).run()
	try {
		const { results } = await db.prepare('SELECT name FROM schema_migrations').all<{ name: string }>()
		const applied = new Set(results.map((row) => row.name))
		const fresh: string[] = []
		for (const migration of migrations) {
			if (applied.has(migration.name)) continue
			await db.batch([
				db.prepare(migration.sql),
				db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
					.bind(migration.name, Math.floor(Date.now() / 1000)),
			])
			fresh.push(migration.name)
		}
		return fresh
	} finally {
		await db.prepare(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`).run()
	}
}

async function main(): Promise<void> {
	const url = process.env['FABRIKA_OPERATIONS_DATABASE_URL']
	if (!url) throw new Error('FABRIKA_OPERATIONS_DATABASE_URL is required')
	const db = PostgresDatabase.connect(url, { max: 1 })
	try {
		const applied = await applyMigrations(db)
		console.info(applied.length === 0 ? 'migrations: already up to date' : `migrations applied: ${applied.join(', ')}`)
	} finally {
		await db.close()
	}
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error('migration failed:', error instanceof Error ? error.message : 'unknown error')
		process.exit(1)
	})
}
