import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The cumulative schema: every `migrations/*.sql` concatenated in filename order.
 * Tests stand up an in-memory sqlite from this so they run against the SAME schema
 * a deployed worker reaches after `wrangler d1 migrations apply`.
 */
export function allMigrations(): string {
	return migrationsWhere(() => true)
}

/** The schema an installation had before the migration `file` (and every later one) was shipped. */
export function migrationsBefore(file: string): string {
	return migrationsWhere((name) => name < file)
}

/** One shipped migration, as an upgrade applies it to an installation that has every earlier one. */
export function migrationFile(file: string): string {
	return readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
}

const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', '..', 'migrations')

function migrationsWhere(included: (file: string) => boolean): string {
	return readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith('.sql') && included(f))
		.sort()
		.map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
		.join('\n')
}
