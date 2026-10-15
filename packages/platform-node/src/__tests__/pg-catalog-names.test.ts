import { describe, expect, test } from 'bun:test'
import { PG_CATALOG_ABSENT, PG_CATALOG_FUNCTIONS, PG_CATALOG_MAJORS, SQL_KEYWORDS } from '../pg-catalog-names.js'
import { PostgresDatabase } from '../sql-postgres.js'
import { hasPostgres, postgresUrl, skipReason } from './helpers/postgres.js'

if (!hasPostgres) console.warn(`pg-catalog-names.test.ts ${skipReason}`)

describe('the generated pg_catalog names', () => {
	test('a name one supported major lacks belongs to another', () => {
		for (const [major, absent] of PG_CATALOG_ABSENT) {
			const others = PG_CATALOG_MAJORS.filter((other) => other !== major)
			for (const name of absent.functions) {
				expect(others.some((other) => !PG_CATALOG_ABSENT.get(other)?.functions.has(name))).toBe(true)
			}
			for (const name of absent.keywords) {
				expect(others.some((other) => !PG_CATALOG_ABSENT.get(other)?.keywords.has(name))).toBe(true)
			}
		}
	})

	test.skipIf(!hasPostgres)(
		'are the test server catalog plus only the names its major lacks; regenerate with helpers/generate-pg-catalog-names.ts',
		async () => {
			const db = PostgresDatabase.connect(postgresUrl ?? '', { max: 1 })
			try {
				const version = await db.prepare("SELECT current_setting('server_version_num')::int / 10000 AS major").first<{ major: number }>()
				const { results: functions } = await db
					.prepare("SELECT DISTINCT proname::text AS name FROM pg_catalog.pg_proc WHERE pronamespace = 'pg_catalog'::regnamespace")
					.all<{ name: string }>()
				const { results: keywords } = await db.prepare('SELECT word AS name FROM pg_catalog.pg_get_keywords()').all<{ name: string }>()

				const absent = PG_CATALOG_ABSENT.get(version?.major ?? 0)
				if (absent === undefined) {
					throw new Error(`Postgres ${version?.major} is not one of the generated majors ${PG_CATALOG_MAJORS.join(', ')}; regenerate with it`)
				}
				const serverFunctions = new Set(functions.map((row) => row.name))
				const serverKeywords = new Set(keywords.map((row) => row.name))
				expect([...serverFunctions].filter((name) => !PG_CATALOG_FUNCTIONS.has(name))).toEqual([])
				expect([...serverKeywords].filter((name) => !SQL_KEYWORDS.has(name))).toEqual([])
				expect([...PG_CATALOG_FUNCTIONS].filter((name) => !serverFunctions.has(name))).toEqual([...absent.functions])
				expect([...SQL_KEYWORDS].filter((name) => !serverKeywords.has(name))).toEqual([...absent.keywords])
			} finally {
				await db.close()
			}
		},
	)
})
