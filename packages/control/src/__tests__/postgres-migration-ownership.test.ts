import { PostgresDatabase, type PostgresMigration } from '@fabrika/platform-node'
import { afterAll, describe, expect, test } from 'bun:test'
import { applyMigrations as applyIamMigrations, postgresMigrations as iamMigrations } from '../../../iam/src/node/migrate.js'
import { applyMigrations as applyControlMigrations, postgresMigrations as controlMigrations } from '../zerops/migrate.js'
import { hasPostgres, postgresUrl, skipReason } from './helpers/postgres.js'

if (!hasPostgres) console.warn(`postgres-migration-ownership.test.ts ${skipReason}`)

interface SharedFixture {
	db: PostgresDatabase
	schema: string
	open(): PostgresDatabase
	close(): Promise<void>
}

const fixtures: SharedFixture[] = []

afterAll(async () => {
	for (const fixture of fixtures) await fixture.close()
})

async function sharedFixture(prefix: string): Promise<SharedFixture> {
	if (postgresUrl === null) throw new Error('FABRIKA_TEST_POSTGRES_URL is not set')
	const url = postgresUrl
	const schema = `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
	const admin = PostgresDatabase.connect(url)
	await admin.prepare(`CREATE SCHEMA ${schema}`).run()
	await admin.close()
	const db = PostgresDatabase.connect(url, { connection: { search_path: schema }, max: 1 })
	const fixture = {
		db,
		schema,
		open: () => PostgresDatabase.connect(url, { connection: { search_path: schema }, max: 1 }),
		async close(): Promise<void> {
			await db.close()
			const cleanup = PostgresDatabase.connect(url)
			await cleanup.prepare(`DROP SCHEMA ${schema} CASCADE`).run()
			await cleanup.close()
		},
	}
	fixtures.push(fixture)
	return fixture
}

function names(migrations: readonly PostgresMigration[]): string[] {
	return migrations.map((migration) => migration.name)
}

describe.skipIf(!hasPostgres)('IAM and Control migration ownership on one real Postgres schema', () => {
	test('fresh IAM and Control runners can bootstrap concurrently without filename collisions', async () => {
		const fixture = await sharedFixture('migration_fresh_shared')
		const second = fixture.open()
		try {
			const [iamApplied, controlApplied] = await Promise.all([
				applyIamMigrations(fixture.db),
				applyControlMigrations(second),
			])
			expect(iamApplied).toEqual(names(iamMigrations()))
			expect(controlApplied).toEqual(names(controlMigrations()))
			expect(await applyIamMigrations(fixture.db)).toEqual([])
			expect(await applyControlMigrations(second)).toEqual([])
		} finally {
			await second.close()
		}
	})
})
