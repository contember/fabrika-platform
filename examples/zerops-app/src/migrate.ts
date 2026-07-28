// `run.initCommands` — migrations, at CONTAINER START.
//
// This is why the Zerops deploy plan has no `migrate` step: there is nothing for the deploy to do,
// because the platform runs this every time a runtime container starts or restarts.
//
// Two properties make that safe, and both are required rather than nice to have:
//
//   1. IDEMPOTENT. Every statement is `IF NOT EXISTS`, so the second start is a no-op.
//   2. SERIALIZED ACROSS CONTAINERS. A Zerops service scales horizontally, so several containers can
//      boot at once and would otherwise race. `pg_advisory_lock` is SESSION-level, which is exactly why
//      `NOTES_DATABASE_URL` must point at the DIRECT Postgres port (5432) and not at pgBouncer (6432):
//      transaction pooling does not preserve session state across statements, so the lock would be taken
//      and dropped on a connection nobody else is looking at.
//
// A real app would keep numbered migration files and a `schema_migrations` table. This one has a single
// statement so the example stays about the deploy path.

import { SQL } from 'bun'
import { readDatabaseUrl } from './env'

/** Any stable 64-bit constant. It only has to be the same in every container of this app. */
const LOCK_ID = 8_143_220_100_411_001n

const sql = new SQL(readDatabaseUrl())

try {
	await sql`SELECT pg_advisory_lock(${LOCK_ID})`
	await sql`
		CREATE TABLE IF NOT EXISTS notes (
			id TEXT PRIMARY KEY,
			workspace TEXT NOT NULL,
			title TEXT NOT NULL
		)
	`
	await sql`CREATE INDEX IF NOT EXISTS notes_workspace_idx ON notes (workspace)`
	await sql`SELECT pg_advisory_unlock(${LOCK_ID})`
	console.info('notes: migrations applied')
} finally {
	await sql.close()
}
