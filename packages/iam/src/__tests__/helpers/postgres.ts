// Shared setup for the tests that need a REAL Postgres — the same opt-in convention `@fabrika/platform-node`
// uses, so one `FABRIKA_TEST_POSTGRES_URL` turns on every Postgres-backed suite in the repo.
//
// They SKIP rather than fail when it is unset: `bun test` has to be green on a laptop with no
// database. What is lost by skipping is stated plainly in the skip message, because a silently empty
// suite is worse than no suite.
//
//   docker run --rm -d -p 55433:5432 -e POSTGRES_PASSWORD=postgres postgres:17
//   FABRIKA_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55433/postgres bun test packages/iam
//
// Each fixture gets its OWN Postgres schema, selected through the `search_path` startup parameter so
// every pooled connection sees it. That gives real isolation without renaming a single table, and
// lets the SHIPPED migrations be applied verbatim, through the SHIPPED runner — the tests exercise
// what deploys, not a re-spelling of it. The URL is a credential and is never logged, not on failure.

import { PostgresDatabase } from '@fabrika/platform-node'
import { applyMigrations } from '../../node/migrate'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'

/** The configured connection URL, or null when these tests should skip. */
export const postgresUrl: string | null = process.env[URL_VAR] ?? null

/** True when a real Postgres is configured. Use as `describe.skipIf(!hasPostgres)`. */
export const hasPostgres = postgresUrl !== null

/** One-line reason the skipped suites print, so a green run is never silently empty. */
export const skipReason =
	`skipped: set ${URL_VAR} to run the Postgres-backed IAM tests (they apply migrations-postgres/ and run the db.ts query surface against it)`

export interface PostgresFixture {
	db: PostgresDatabase
	/** The isolated schema name, for assertions that need to name it. */
	schema: string
	/** Drop the schema and close the pool. */
	close(): Promise<void>
}

/**
 * Stand up an isolated schema, apply the shipped Postgres migrations into it with the shipped runner,
 * and hand back a `PostgresDatabase` bound to it.
 *
 * `max: 1` mirrors how `node/migrate.ts` runs in production — the advisory lock it takes is
 * session-scoped, so the runner is only correct on a single-connection pool.
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

	const db = PostgresDatabase.connect(url, { connection: { search_path: schema }, max: 1 })
	await applyMigrations(db)

	return {
		db,
		schema,
		async close(): Promise<void> {
			await db.close()
			const cleanup = PostgresDatabase.connect(url)
			await cleanup.prepare(`DROP SCHEMA ${schema} CASCADE`).run()
			await cleanup.close()
		},
	}
}
