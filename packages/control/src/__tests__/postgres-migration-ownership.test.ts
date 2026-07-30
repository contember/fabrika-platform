import type { PostgresMigration } from '@fabrika/platform-node'
import { PostgresDatabase } from '@fabrika/platform-node'
import { afterAll, describe, expect, test } from 'bun:test'
import { applyMigrations as applyIamMigrations, postgresMigrations as iamMigrations } from '../../../iam/src/node/migrate.js'
import { applyMigrations as applyControlMigrations, postgresMigrations as controlMigrations } from '../node/migrate.js'
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

async function createLegacyLedger(db: PostgresDatabase): Promise<void> {
	await db.prepare(`CREATE TABLE schema_migrations (
		name TEXT PRIMARY KEY,
		applied_at INTEGER NOT NULL
	)`).run()
}

async function applyLegacy(db: PostgresDatabase, migrations: readonly PostgresMigration[]): Promise<void> {
	await createLegacyLedger(db)
	for (const [index, migration] of migrations.entries()) {
		await db.batch([
			db.prepare(migration.sql),
			db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').bind(migration.name, index + 1),
		])
	}
}

async function recordLegacy(db: PostgresDatabase, migrations: readonly PostgresMigration[]): Promise<void> {
	for (const [index, migration] of migrations.entries()) {
		await db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').bind(migration.name, index + 1).run()
	}
}

function names(migrations: readonly PostgresMigration[]): string[] {
	return migrations.map((migration) => migration.name)
}

function requiredMigration(migrations: readonly PostgresMigration[], index: number): PostgresMigration {
	const migration = migrations[index]
	if (migration === undefined) throw new Error(`migration ${index} is missing`)
	return migration
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

	test('legacy IAM ledger cannot suppress new Control migrations', async () => {
		const fixture = await sharedFixture('migration_legacy_iam')
		await applyLegacy(fixture.db, iamMigrations())
		expect(await applyControlMigrations(fixture.db)).toEqual(names(controlMigrations()))
		expect(await applyIamMigrations(fixture.db)).toEqual([])
		expect(await fixture.db.prepare(`SELECT to_regclass('apps') AS relation`).first<{ relation: string | null }>()).toEqual({
			relation: 'apps',
		})
	})

	test('legacy Control ledger cannot suppress new IAM migrations', async () => {
		const fixture = await sharedFixture('migration_legacy_control')
		await applyLegacy(fixture.db, controlMigrations())
		expect(await applyIamMigrations(fixture.db)).toEqual(names(iamMigrations()))
		expect(await applyControlMigrations(fixture.db)).toEqual([])
		expect(await fixture.db.prepare(`SELECT to_regclass('principals') AS relation`).first<{ relation: string | null }>()).toEqual({
			relation: 'principals',
		})
	})

	test('IAM refuses to adopt a recorded provisioning migration without its seeded principal', async () => {
		const fixture = await sharedFixture('migration_iam_effect')
		const migrations = iamMigrations()
		await createLegacyLedger(fixture.db)
		await fixture.db.prepare(requiredMigration(migrations, 0).sql).run()
		await recordLegacy(fixture.db, migrations)
		await expect(applyIamMigrations(fixture.db)).rejects.toThrow(
			'Legacy migration effect 0002_provisioning_principal.sql is missing',
		)
	})

	test('Control refuses to adopt a recorded jobs migration without its complete table', async () => {
		const fixture = await sharedFixture('migration_control_effect')
		const migrations = controlMigrations()
		await createLegacyLedger(fixture.db)
		await fixture.db.prepare(requiredMigration(migrations, 0).sql).run()
		await recordLegacy(fixture.db, migrations.slice(0, 2))
		await expect(applyControlMigrations(fixture.db)).rejects.toThrow(
			'Legacy migration effect 0002_jobs.sql is missing',
		)
	})
})
