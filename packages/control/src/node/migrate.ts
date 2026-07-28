// The Postgres migration runner — what `wrangler d1 migrations apply` is on the Cloudflare side, and
// what `run.initCommands` invokes at container start on Zerops.
//
// Applies `migrations-postgres/*.sql` in filename order, once each, recording what it applied in a
// `schema_migrations` ledger. Two properties make it safe to run on EVERY container start, which is
// exactly what `initCommands` does:
//
//   * ATOMIC PER FILE. A file and its ledger row go in ONE transaction (`batch()`), so there is no
//     window where a migration is half-applied or applied-but-unrecorded. A crash mid-run leaves the
//     next run with a clean pending list rather than a schema that no file describes.
//   * SERIALIZED ACROSS CONTAINERS. A Zerops service scales horizontally, so two containers can boot
//     at once and both see the same pending list. A session-level advisory lock makes the second one
//     wait and then find nothing to do. The pool is opened with `max: 1` precisely so that lock lives
//     on the same connection for the whole run — an advisory lock is per SESSION, and a pooled unlock
//     landing on a different connection would silently do nothing.
//
// The lock key differs from `@fabrika/iam`'s: the two services own different schemas and may share one
// Postgres server, and a shared key would serialize their boots against each other for no reason.
//
// Run it directly: `bun src/node/migrate.ts` (reads VOZKA_DATABASE_URL).

import { PostgresDatabase } from '@fabrika/platform-node'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Fixed key for the advisory lock. Any constant works; it only has to be the same in every container. */
const MIGRATION_LOCK_KEY = 4471902583

const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'migrations-postgres')

/** One migration file, as shipped. Executed whole — Postgres' simple-query path runs every statement in it. */
interface Migration {
	name: string
	sql: string
}

/** The shipped Postgres migrations, in filename order. */
export function postgresMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
	return readdirSync(dir)
		.filter((file) => file.endsWith('.sql'))
		.sort()
		.map((file) => ({ name: file, sql: readFileSync(join(dir, file), 'utf8') }))
}

/**
 * Apply every not-yet-applied migration. Returns the names applied by THIS call (empty when the schema
 * was already current). The database handle is the caller's — it must be backed by a single-connection
 * pool, or the advisory lock below does not serialize anything.
 */
export async function applyMigrations(db: PostgresDatabase, migrations: Migration[] = postgresMigrations()): Promise<string[]> {
	await db.prepare(`CREATE TABLE IF NOT EXISTS schema_migrations (
		name       TEXT PRIMARY KEY,
		applied_at INTEGER NOT NULL
	)`).run()

	// Blocks until any concurrently-booting container finishes its run.
	await db.prepare(`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`).run()
	try {
		const { results } = await db.prepare('SELECT name FROM schema_migrations').all<{ name: string }>()
		const applied = new Set(results.map((row) => row.name))
		const now = Math.floor(Date.now() / 1000)
		const fresh: string[] = []
		for (const migration of migrations) {
			if (applied.has(migration.name)) {
				continue
			}
			await db.batch([
				db.prepare(migration.sql),
				db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').bind(migration.name, now),
			])
			fresh.push(migration.name)
		}
		return fresh
	} finally {
		await db.prepare(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`).run()
	}
}

/** CLI: apply the shipped migrations against `VOZKA_DATABASE_URL`, then exit. */
async function main(): Promise<void> {
	const url = process.env['VOZKA_DATABASE_URL']
	if (url === undefined || url.trim() === '') {
		throw new Error('VOZKA_DATABASE_URL is required')
	}
	// `max: 1` is load-bearing — see the advisory-lock note in the header.
	const db = PostgresDatabase.connect(url, { max: 1 })
	try {
		const applied = await applyMigrations(db)
		console.info(applied.length === 0 ? 'migrations: already up to date' : `migrations applied: ${applied.join(', ')}`)
	} finally {
		await db.close()
	}
}

if (import.meta.main) {
	// The URL is a credential and may appear inside a driver error, so only a short message is logged.
	main().catch((err: unknown) => {
		console.error('migration failed:', err instanceof Error ? err.message : 'unknown error')
		process.exit(1)
	})
}
