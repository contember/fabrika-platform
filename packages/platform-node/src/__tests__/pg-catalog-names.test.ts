import { describe, expect, test } from 'bun:test'
import { PG_CATALOG_FUNCTIONS, SQL_KEYWORDS } from '../pg-catalog-names.js'
import { PostgresDatabase } from '../sql-postgres.js'
import { hasPostgres, postgresUrl, skipReason } from './helpers/postgres.js'

if (!hasPostgres) console.warn(`pg-catalog-names.test.ts ${skipReason}`)

describe.skipIf(!hasPostgres)('the generated pg_catalog names', () => {
	test('hold every function name and keyword of the test server; regenerate with helpers/generate-pg-catalog-names.ts', async () => {
		const db = PostgresDatabase.connect(postgresUrl ?? '', { max: 1 })
		try {
			const { results: functions } = await db
				.prepare("SELECT DISTINCT proname::text AS name FROM pg_catalog.pg_proc WHERE pronamespace = 'pg_catalog'::regnamespace")
				.all<{ name: string }>()
			const { results: keywords } = await db.prepare('SELECT word AS name FROM pg_catalog.pg_get_keywords()').all<{ name: string }>()
			expect(functions.map((row) => row.name).filter((name) => !PG_CATALOG_FUNCTIONS.has(name))).toEqual([])
			expect(keywords.map((row) => row.name).filter((name) => !SQL_KEYWORDS.has(name))).toEqual([])
		} finally {
			await db.close()
		}
	})
})
