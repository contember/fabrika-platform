import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	applyPostgresMigrations,
	definePostgresMigrationPlan,
	platformNodePostgresMigrationBundle,
	type PostgresMigration,
	postgresMigrationIdentity,
	type PostgresMigrationPlan,
	readPostgresMigrationBundle,
} from '../postgres-migrations.js'
import { definePostgresServiceMigrations } from '../service-postgres-migrations.js'
import { PostgresDatabase } from '../sql-postgres.js'
import { hasPostgres, postgresUrl, skipReason } from './helpers/postgres.js'

const migration = (name: string, sql = 'SELECT 1'): PostgresMigration => ({ name, sql })

describe('Postgres migration plans', () => {
	test('the service wrapper preserves dependency order and ownership inputs', () => {
		const service = definePostgresServiceMigrations({
			name: 'operations',
			directory: '/unused',
			ledgerTable: 'operations_schema_migrations',
			lockKey: 6384217905,
			dependencies: [{ name: 'platform-node', migrations: [migration('0001_jobs.sql')] }],
			legacy: { table: 'schema_migrations', sentinelTables: ['sources', 'issues'] },
		})

		const plan = service.plan([migration('0001_init.sql')])

		expect(plan.ledgerTable).toBe('operations_schema_migrations')
		expect(plan.lockKey).toBe(6384217905)
		expect(plan.bundles.map((bundle) => bundle.name)).toEqual(['platform-node', 'operations'])
		expect(plan.bundles[1]?.adoptLegacy).toBe(true)
	})

	test('qualifies identities and reads an explicit bundle in filename order', () => {
		const directory = mkdtempSync(join(tmpdir(), 'fabrika-migrations-'))
		try {
			writeFileSync(join(directory, '0002_second.sql'), 'SELECT 2')
			writeFileSync(join(directory, '0001_first.sql'), 'SELECT 1')
			writeFileSync(join(directory, 'README.md'), 'ignored')
			const bundle = readPostgresMigrationBundle({
				name: 'service-a',
				directory,
				files: ['0002_second.sql', '0001_first.sql'],
				adoptLegacy: true,
			})
			expect(bundle).toEqual({
				name: 'service-a',
				adoptLegacy: true,
				migrations: [
					{ name: '0001_first.sql', sql: 'SELECT 1' },
					{ name: '0002_second.sql', sql: 'SELECT 2' },
				],
			})
			expect(postgresMigrationIdentity(bundle.name, bundle.migrations[0]?.name ?? '')).toBe('service-a/0001_first.sql')
			expect(() =>
				readPostgresMigrationBundle({
					name: 'service-a',
					directory,
					files: ['0003_missing.sql'],
				})
			).toThrow('Postgres migration service-a/0003_missing.sql is missing')
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	})

	test('exposes the generic jobs migration as an explicit platform bundle', () => {
		const bundle = platformNodePostgresMigrationBundle(['0001_jobs.sql'])
		expect(bundle.name).toBe('platform-node')
		expect(bundle.adoptLegacy).toBeUndefined()
		expect(bundle.migrations.map((item) => item.name)).toEqual(['0001_jobs.sql'])
		expect(bundle.migrations[0]?.sql).toContain('CREATE TABLE IF NOT EXISTS jobs')
	})

	test('rejects ambiguous, unordered, unsafe, and unprovable plans before SQL', () => {
		const valid: PostgresMigrationPlan = {
			ledgerTable: 'service_schema_migrations',
			lockKey: 42,
			bundles: [{ name: 'service', migrations: [migration('0001_init.sql')], adoptLegacy: true }],
			legacy: { table: 'schema_migrations', sentinelTables: ['service_table'] },
		}
		expect(definePostgresMigrationPlan(valid)).toBe(valid)
		expect(() => definePostgresMigrationPlan({ ...valid, ledgerTable: 'unsafe;drop' })).toThrow('Invalid migration ledger table')
		expect(() => definePostgresMigrationPlan({ ...valid, lockKey: 0 })).toThrow('positive safe integer')
		expect(() => definePostgresMigrationPlan({ ...valid, bundles: [] })).toThrow('at least one bundle')
		expect(() =>
			definePostgresMigrationPlan({
				...valid,
				bundles: [
					{ name: 'service', migrations: [migration('0001_init.sql')] },
					{ name: 'service', migrations: [migration('0002_next.sql')] },
				],
			})
		).toThrow('Duplicate Postgres migration bundle service')
		expect(() =>
			definePostgresMigrationPlan({
				...valid,
				bundles: [{
					name: 'service',
					migrations: [migration('0002_next.sql'), migration('0001_init.sql')],
					adoptLegacy: true,
				}],
			})
		).toThrow('not ordered by filename')
		expect(() =>
			definePostgresMigrationPlan({
				...valid,
				legacy: { table: 'schema_migrations', sentinelTables: [] },
			})
		).toThrow('at least one service sentinel')
		expect(() =>
			definePostgresMigrationPlan({
				...valid,
				bundles: [
					{ name: 'service', migrations: [migration('0001_init.sql')], adoptLegacy: true },
					{ name: 'other', migrations: [migration('0001_init.sql')], adoptLegacy: true },
				],
			})
		).toThrow('exactly one adopting bundle')
		expect(() =>
			definePostgresMigrationPlan({
				...valid,
				legacy: {
					table: 'schema_migrations',
					sentinelTables: ['service_table'],
					effects: [{ migration: '0002_unknown.sql', probeSql: 'SELECT true AS proven' }],
				},
			})
		).toThrow('non-adoptable migration')
	})
})

if (!hasPostgres) console.warn(`postgres-migrations.test.ts ${skipReason}`)

interface RealFixture {
	db: PostgresDatabase
	schema: string
	close(): Promise<void>
}

const fixtures: RealFixture[] = []

afterAll(async () => {
	for (const fixture of fixtures) await fixture.close()
})

async function realFixture(prefix: string): Promise<RealFixture> {
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

function plan(input: {
	ledger: string
	lockKey: number
	bundles: PostgresMigrationPlan['bundles']
	sentinels?: readonly string[]
	effects?: NonNullable<PostgresMigrationPlan['legacy']>['effects']
}): PostgresMigrationPlan {
	return definePostgresMigrationPlan({
		ledgerTable: input.ledger,
		lockKey: input.lockKey,
		bundles: input.bundles,
		...(input.sentinels === undefined
			? {}
			: {
				legacy: {
					table: 'schema_migrations',
					sentinelTables: input.sentinels,
					...(input.effects === undefined ? {} : { effects: input.effects }),
				},
			}),
	})
}

describe.skipIf(!hasPostgres)('Postgres migration runner on real Postgres', () => {
	test('applies ordered bundles atomically and records bundle-qualified identities', async () => {
		const fixture = await realFixture('migration_apply')
		const migrationPlan = plan({
			ledger: 'service_schema_migrations',
			lockKey: 8_301_001,
			bundles: [
				{ name: 'platform-node', migrations: [migration('0001_jobs.sql', 'CREATE TABLE jobs (id TEXT PRIMARY KEY)')] },
				{ name: 'service', migrations: [migration('0001_init.sql', 'CREATE TABLE service_data (id TEXT PRIMARY KEY)')] },
			],
		})
		expect(await applyPostgresMigrations(fixture.db, migrationPlan, { now: () => 123 })).toEqual([
			'platform-node/0001_jobs.sql',
			'service/0001_init.sql',
		])
		expect(await applyPostgresMigrations(fixture.db, migrationPlan)).toEqual([])
		const { results } = await fixture.db
			.prepare('SELECT bundle, name, applied_at FROM service_schema_migrations ORDER BY bundle, name')
			.all<{ bundle: string; name: string; applied_at: number }>()
		expect(results).toEqual([
			{ bundle: 'platform-node', name: '0001_jobs.sql', applied_at: 123 },
			{ bundle: 'service', name: '0001_init.sql', applied_at: 123 },
		])
	})

	test('adopts only a proven service bundle from an old unqualified ledger', async () => {
		const fixture = await realFixture('migration_adopt')
		await fixture.db.prepare('CREATE TABLE service_root (id TEXT PRIMARY KEY)').run()
		await fixture.db.prepare('CREATE TABLE service_tail (id TEXT PRIMARY KEY)').run()
		await fixture.db.prepare('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)').run()
		await fixture.db
			.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?), (?, ?)')
			.bind('0001_init.sql', 10, '0001_jobs.sql', 11)
			.run()
		const migrationPlan = plan({
			ledger: 'service_schema_migrations',
			lockKey: 8_301_002,
			bundles: [
				{ name: 'platform-node', migrations: [migration('0001_jobs.sql', 'CREATE TABLE jobs (id TEXT PRIMARY KEY)')] },
				{
					name: 'service',
					migrations: [migration('0001_init.sql', 'CREATE TABLE service_root (id TEXT PRIMARY KEY)')],
					adoptLegacy: true,
				},
			],
			sentinels: ['service_root', 'service_tail'],
		})
		expect(await applyPostgresMigrations(fixture.db, migrationPlan, { now: () => 20 })).toEqual(['platform-node/0001_jobs.sql'])
		const { results } = await fixture.db
			.prepare('SELECT bundle, name, applied_at FROM service_schema_migrations ORDER BY bundle')
			.all<{ bundle: string; name: string; applied_at: number }>()
		expect(results).toEqual([
			{ bundle: 'platform-node', name: '0001_jobs.sql', applied_at: 20 },
			{ bundle: 'service', name: '0001_init.sql', applied_at: 10 },
		])
	})

	test('refuses partial sentinels and disproven legacy effects', async () => {
		const partial = await realFixture('migration_partial')
		await partial.db.prepare('CREATE TABLE service_root (id TEXT PRIMARY KEY)').run()
		await partial.db.prepare('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)').run()
		const partialPlan = plan({
			ledger: 'service_schema_migrations',
			lockKey: 8_301_003,
			bundles: [{
				name: 'service',
				migrations: [migration('0001_init.sql', 'CREATE TABLE service_root (id TEXT PRIMARY KEY)')],
				adoptLegacy: true,
			}],
			sentinels: ['service_root', 'service_tail'],
		})
		await expect(applyPostgresMigrations(partial.db, partialPlan)).rejects.toThrow('sentinels are inconsistent')

		const effect = await realFixture('migration_effect')
		await effect.db.prepare('CREATE TABLE service_root (id TEXT PRIMARY KEY)').run()
		await effect.db.prepare('CREATE TABLE service_tail (id TEXT PRIMARY KEY)').run()
		await effect.db.prepare('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)').run()
		await effect.db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').bind('0001_init.sql', 10).run()
		const effectPlan = plan({
			ledger: 'service_schema_migrations',
			lockKey: 8_301_004,
			bundles: [{
				name: 'service',
				migrations: [migration('0001_init.sql', 'CREATE TABLE service_root (id TEXT PRIMARY KEY)')],
				adoptLegacy: true,
			}],
			sentinels: ['service_root', 'service_tail'],
			effects: [{ migration: '0001_init.sql', probeSql: 'SELECT false AS proven' }],
		})
		await expect(applyPostgresMigrations(effect.db, effectPlan)).rejects.toThrow('effect 0001_init.sql is missing')
	})

	test('serializes concurrent runners on one stable session lock', async () => {
		if (postgresUrl === null) throw new Error('FABRIKA_TEST_POSTGRES_URL is not set')
		const fixture = await realFixture('migration_lock')
		const second = PostgresDatabase.connect(postgresUrl, { connection: { search_path: fixture.schema }, max: 1 })
		try {
			const migrationPlan = plan({
				ledger: 'service_schema_migrations',
				lockKey: 8_301_005,
				bundles: [{
					name: 'service',
					migrations: [migration('0001_init.sql', 'SELECT pg_sleep(0.1); CREATE TABLE service_data (id TEXT PRIMARY KEY)')],
				}],
			})
			const outcomes = await Promise.all([
				applyPostgresMigrations(fixture.db, migrationPlan),
				applyPostgresMigrations(second, migrationPlan),
			])
			expect(outcomes.filter((outcome) => outcome.length === 1)).toHaveLength(1)
			expect(outcomes.filter((outcome) => outcome.length === 0)).toHaveLength(1)
		} finally {
			await second.close()
		}
	})

	test('rolls back both migration effects and the ledger row on failure', async () => {
		const fixture = await realFixture('migration_atomic')
		const brokenPlan = plan({
			ledger: 'service_schema_migrations',
			lockKey: 8_301_006,
			bundles: [{
				name: 'service',
				migrations: [
					migration(
						'0001_init.sql',
						'CREATE TABLE atomic_data (id TEXT PRIMARY KEY); INSERT INTO missing_atomic_table (id) VALUES (1)',
					),
				],
			}],
		})
		await expect(applyPostgresMigrations(fixture.db, brokenPlan)).rejects.toThrow()
		expect(await fixture.db.prepare(`SELECT to_regclass('atomic_data') AS relation`).first<{ relation: string | null }>()).toEqual({
			relation: null,
		})
		const { results } = await fixture.db.prepare('SELECT bundle, name FROM service_schema_migrations').all()
		expect(results).toEqual([])

		const repairedPlan = plan({
			ledger: 'service_schema_migrations',
			lockKey: 8_301_006,
			bundles: [{
				name: 'service',
				migrations: [migration('0001_init.sql', 'CREATE TABLE atomic_data (id TEXT PRIMARY KEY)')],
			}],
		})
		expect(await applyPostgresMigrations(fixture.db, repairedPlan)).toEqual(['service/0001_init.sql'])
	})

	test('reports an unlock failure only when the migration body succeeded', async () => {
		const fixture = await realFixture('migration_unlock')
		const lockKey = 8_301_007
		const migrationPlan = plan({
			ledger: 'service_schema_migrations',
			lockKey,
			bundles: [{
				name: 'service',
				migrations: [migration('0001_init.sql', `SELECT pg_advisory_unlock(${lockKey})`)],
			}],
		})
		await expect(applyPostgresMigrations(fixture.db, migrationPlan)).rejects.toThrow(
			'Postgres migration advisory unlock failed',
		)
	})

	test('preserves the migration error when unlocking also fails', async () => {
		const fixture = await realFixture('migration_unlock_after_failure')
		const lockKey = 8_301_008
		const migrationPlan = plan({
			ledger: 'service_schema_migrations',
			lockKey,
			bundles: [{
				name: 'service',
				migrations: [
					migration(
						'0001_init.sql',
						`SELECT pg_advisory_unlock(${lockKey}); INSERT INTO missing_unlock_table (id) VALUES (1)`,
					),
				],
			}],
		})
		let failure = ''
		try {
			await applyPostgresMigrations(fixture.db, migrationPlan)
		} catch (error) {
			failure = error instanceof Error ? error.message : 'unknown migration error'
		}
		expect(failure).not.toBe('')
		expect(failure).not.toContain('Postgres migration advisory unlock failed')
	})
})
