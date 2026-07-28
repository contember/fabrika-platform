// Shared setup for the tests that need a REAL Postgres.
//
// They are opt-in: set `FABRIKA_TEST_POSTGRES_URL` and they run, leave it unset and they skip with a
// message telling you exactly how to turn them on. Skipping (rather than failing) is deliberate —
// `bun test` has to be green on a laptop with no database, and the parts that carry the actual risk
// (the placeholder tokeniser, the SPA fallback, waitUntil) are proved with no services at all.
//
//   docker run --rm -d -p 55433:5432 -e POSTGRES_PASSWORD=postgres postgres:17
//   FABRIKA_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55433/postgres bun test
//
// Each file gets its OWN Postgres schema, applied via the `search_path` startup parameter so every
// pooled connection sees it. That gives real isolation without renaming tables, and lets the shipped
// migrations be applied verbatim. The URL is a credential: it is never logged, not even on failure.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PostgresDatabase } from '../../sql-postgres'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'

/** The configured connection URL, or null when these tests should skip. */
export const postgresUrl: string | null = process.env[URL_VAR] ?? null

/** True when a real Postgres is configured. Use as `describe.skipIf(!hasPostgres)`. */
export const hasPostgres = postgresUrl !== null

/** One-line reason printed by the skipped suites, so a green run is never silently empty. */
export const skipReason = `skipped: set ${URL_VAR} to run the Postgres-backed tests`

export interface PostgresFixture {
	db: PostgresDatabase
	/** Drop the schema and close the pool. */
	close(): Promise<void>
}

/**
 * Stand up an isolated schema, apply this package's migrations into it, and hand back a
 * `PostgresDatabase` bound to it.
 */
export async function createPostgres(namePrefix: string): Promise<PostgresFixture> {
	if (postgresUrl === null) {
		throw new Error(`${URL_VAR} is not set`)
	}
	const url = postgresUrl
	const schema = `${namePrefix}_${Math.random().toString(36).slice(2, 10)}`

	const admin = PostgresDatabase.connect(url)
	await admin.prepare(`CREATE SCHEMA ${schema}`).run()
	await admin.close()

	const db = PostgresDatabase.connect(url, { connection: { search_path: schema }, max: 4 })
	for (const migration of migrationFiles()) {
		await db.prepare(migration).run()
	}

	return {
		db,
		async close(): Promise<void> {
			await db.close()
			const cleanup = PostgresDatabase.connect(url)
			await cleanup.prepare(`DROP SCHEMA ${schema} CASCADE`).run()
			await cleanup.close()
		},
	}
}

/**
 * The shipped migrations, in filename order, one string per FILE. Each file is executed whole — the
 * driver hands a parameterless statement to Postgres' simple-query path, which runs every statement
 * in it and parses the comments itself. That is also the closest thing to how a real migration runner
 * would apply them, so the tests exercise the files as shipped rather than a re-split of them.
 */
export function migrationFiles(): string[] {
	const dir = join(import.meta.dir, '..', '..', '..', 'migrations')
	return readdirSync(dir)
		.filter((file) => file.endsWith('.sql'))
		.sort()
		.map((file) => readFileSync(join(dir, file), 'utf8'))
}
