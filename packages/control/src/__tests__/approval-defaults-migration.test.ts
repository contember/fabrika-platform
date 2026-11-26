// Migration 0046: an environment that saved an approval choice under the earlier defaults keeps `role-external`,
// `public` and `csp` off, and one that saved none takes the new defaults. Rows are written in the stored forms the
// earlier release wrote, then the migration runs over them, on SQLite and (with FABRIKA_TEST_POSTGRES_URL) Postgres.

import { type ApprovalPolicy, PERMISSIVE_POLICY, STRICT_POLICY } from '@fabrika/control-contract'
import { PostgresDatabase } from '@fabrika/platform-node'
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { appEnvCategories, appEnvPolicy } from '../approval/categories'
import { applyMigrations, postgresMigrations } from '../bun/migrate'
import { hasPostgres, postgresUrl, skipReason } from './helpers/postgres'

const MIGRATION = '0046_approval_defaults_keep_saved_choices.sql'
const THREE_OFF = { 'role-external': 'off', public: 'off', csp: 'off' } satisfies Partial<ApprovalPolicy>

interface StoredRow {
	readonly env: string
	readonly approval_categories: string | null
	readonly approval_policy: string | null
}

/** What the earlier release stored, and the policy each row meant then. */
const ROWS: readonly { readonly row: StoredRow; readonly meant: ApprovalPolicy }[] = [
	{
		// The permissive preset: every mode that differed from the earlier defaults, and the list without the closer review.
		row: {
			env: 'permissive',
			approval_categories: JSON.stringify({
				added: [],
				removed: ['off-road', 'anyone-calls', 'get-mutation', 'people', 'adoption', 'terminal', 'deletes-data'],
			}),
			approval_policy: JSON.stringify({
				'off-road': 'off',
				'anyone-calls': 'off',
				'get-mutation': 'off',
				people: 'off',
				adoption: 'off',
				terminal: 'off',
				'deletes-data': 'off',
				'deploy-request': 'off',
				secrets: 'off',
				variables: 'off',
				data: 'off',
				registry: 'off',
				'agent-grants': 'off',
				credentials: 'off',
			}),
		},
		meant: PERMISSIVE_POLICY,
	},
	{
		// A choice of one action's mode: the list equalled the earlier defaults, so it stored none.
		row: { env: 'refuses-requests', approval_categories: null, approval_policy: JSON.stringify({ 'deploy-request': 'refuse' }) },
		meant: { ...STRICT_POLICY, ...THREE_OFF, 'deploy-request': 'refuse' },
	},
	{
		// A list stored before the policy column, by a Control that wrote only the list.
		row: { env: 'list-only', approval_categories: JSON.stringify({ added: ['role-added'], removed: [] }), approval_policy: null },
		meant: { ...STRICT_POLICY, ...THREE_OFF, 'role-added': 'person' },
	},
	{
		// One of the three chosen explicitly stays as chosen.
		row: {
			env: 'chose-public',
			approval_categories: JSON.stringify({ added: ['public'], removed: [] }),
			approval_policy: JSON.stringify({ public: 'plan' }),
		},
		meant: { ...STRICT_POLICY, ...THREE_OFF, public: 'plan' },
	},
]

/** An environment that saved no choice: it takes the new defaults. */
const UNCONFIGURED: StoredRow = { env: 'unconfigured', approval_categories: null, approval_policy: null }

const storedRowsSchema = z.array(z.object({ env: z.string(), approval_categories: z.string().nullable(), approval_policy: z.string().nullable() }))

function expectMigrated(rows: readonly StoredRow[]): void {
	const byEnv = new Map(rows.map((row) => [row.env, row]))
	for (const { row, meant } of ROWS) {
		const migrated = byEnv.get(row.env)
		if (migrated === undefined) throw new Error(`row ${row.env} is missing`)
		expect({ env: row.env, policy: appEnvPolicy(migrated) }).toEqual({ env: row.env, policy: meant })
	}
	const unconfigured = byEnv.get(UNCONFIGURED.env)
	expect(unconfigured).toEqual(UNCONFIGURED)
	if (unconfigured === undefined) return
	expect(appEnvPolicy(unconfigured)).toEqual(STRICT_POLICY)
	expect(appEnvCategories(unconfigured)).toEqual(expect.arrayContaining(['role-external', 'public', 'csp']))
}

const ALL_ROWS = [...ROWS.map(({ row }) => row), UNCONFIGURED]

describe('migration 0046 on SQLite', () => {
	const dir = join(import.meta.dir, '..', '..', 'migrations')
	const files = readdirSync(dir).filter((file) => file.endsWith('.sql')).sort()

	function migratedTo(last: string): Database {
		const sqlite = new Database(':memory:')
		for (const file of files.filter((name) => name <= last)) sqlite.exec(readFileSync(join(dir, file), 'utf8'))
		return sqlite
	}

	function seed(sqlite: Database): void {
		for (const row of ALL_ROWS) {
			sqlite.query(
				'INSERT INTO app_env_protection (app_id, env, protected, generation, protection_revision, approval_categories, approval_policy) VALUES (?, ?, 1, 1, 1, ?, ?)',
			).run('app', row.env, row.approval_categories, row.approval_policy)
		}
	}

	const read = (sqlite: Database): StoredRow[] =>
		storedRowsSchema.parse(sqlite.query('SELECT env, approval_categories, approval_policy FROM app_env_protection').all())

	test('a saved choice keeps the three off, and an environment with none takes the new defaults', () => {
		const before = files.filter((name) => name < MIGRATION).at(-1)
		if (before === undefined) throw new Error('no migration precedes 0046')
		const sqlite = migratedTo(before)
		seed(sqlite)
		sqlite.exec(readFileSync(join(dir, MIGRATION), 'utf8'))
		expectMigrated(read(sqlite))
	})

	test('running it again changes nothing', () => {
		const sqlite = migratedTo(MIGRATION)
		seed(sqlite)
		const migration = readFileSync(join(dir, MIGRATION), 'utf8')
		sqlite.exec(migration)
		const once = read(sqlite)
		sqlite.exec(migration)
		expect(read(sqlite)).toEqual(once)
	})
})

describe.skipIf(!hasPostgres)('migration 0046 on Postgres', () => {
	test('a saved choice keeps the three off, and an environment with none takes the new defaults', async () => {
		if (postgresUrl === null) throw new Error(skipReason)
		const schema = `approval_defaults_${Math.random().toString(36).slice(2, 10)}`
		const admin = PostgresDatabase.connect(postgresUrl)
		await admin.prepare(`CREATE SCHEMA ${schema}`).run()
		await admin.close()
		const db = PostgresDatabase.connect(postgresUrl, { connection: { search_path: schema }, max: 1 })
		try {
			const migrations = postgresMigrations()
			await applyMigrations(db, migrations.filter((migration) => migration.name < MIGRATION))
			for (const row of ALL_ROWS) {
				await db.prepare(
					'INSERT INTO app_env_protection (app_id, env, protected, generation, protection_revision, approval_categories, approval_policy) VALUES (?, ?, 1, 1, 1, ?, ?)',
				).bind('app', row.env, row.approval_categories, row.approval_policy).run()
			}
			expect(await applyMigrations(db, migrations)).toContain(MIGRATION)
			const rows = await db.prepare('SELECT env, approval_categories, approval_policy FROM app_env_protection').all()
			expectMigrated(storedRowsSchema.parse(rows.results))
		} finally {
			await db.close()
			const cleanup = PostgresDatabase.connect(postgresUrl)
			await cleanup.prepare(`DROP SCHEMA ${schema} CASCADE`).run()
			await cleanup.close()
		}
	})
})

if (!hasPostgres) console.info(`approval-defaults-migration: Postgres half ${skipReason}`)
