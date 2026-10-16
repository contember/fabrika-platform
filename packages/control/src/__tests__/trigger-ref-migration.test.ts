// `0009_canonical_trigger_refs.sql` on both dialects: the rows an installation stored before registration canonicalized a
// trigger ref, migrated by the shipped file. The Postgres half skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset.

import { PostgresDatabase } from '@fabrika/platform-node'
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { warnBareTriggerRefs } from '../cron'
import { applyMigrations, postgresMigrations } from '../zerops/migrate'
import { createHarness } from './helpers/harness'
import { hasPostgres, postgresUrl, skipReason } from './helpers/postgres'

if (!hasPostgres) {
	console.warn(`trigger-ref-migration.test.ts ${skipReason}`)
}

const MIGRATION = '0009_canonical_trigger_refs.sql'

/** One app's environments as an older release stored them: bare names, full refs, a glob, a manual-only one. */
const SEEDED: [string, string, string | null][] = [
	['notes', 'prod', 'deploy/prod'],
	['notes', 'stage', 'refs/heads/stage'],
	['notes', 'release', 'refs/tags/v*'],
	['notes', 'manual', null],
	// A bare name whose full ref another environment of the app holds stays bare, so the unique index holds.
	['shop', 'prod', 'main'],
	['shop', 'next', 'refs/heads/main'],
	// The same bare name in another app is no collision.
	['blog', 'prod', 'main'],
]

const MIGRATED: Record<string, string | null> = {
	'blog/prod': 'refs/heads/main',
	'notes/manual': null,
	'notes/prod': 'refs/heads/deploy/prod',
	'notes/release': 'refs/tags/v*',
	'notes/stage': 'refs/heads/stage',
	'shop/next': 'refs/heads/main',
	'shop/prod': 'main',
}

const SEED_APP = 'INSERT INTO apps (id, repo_url) VALUES (?, ?)'
const SEED_ENV = `INSERT INTO app_envs (app_id, env, trigger_ref, provider, provider_target_json, provider_artifact_json)
	VALUES (?, ?, ?, 'harbor', '{}', '{}')`
const READ_ENVS = 'SELECT app_id, env, trigger_ref FROM app_envs ORDER BY app_id, env'

const appIds = (): string[] => [...new Set(SEEDED.map(([appId]) => appId))]

const byCoordinate = (rows: { app_id: string; env: string; trigger_ref: string | null }[]): Record<string, string | null> =>
	Object.fromEntries(rows.map((row) => [`${row.app_id}/${row.env}`, row.trigger_ref]))

describe(`${MIGRATION} on SQLite`, () => {
	const directory = join(import.meta.dir, '..', '..', 'migrations')
	const files = readdirSync(directory).filter((file) => file.endsWith('.sql')).sort()
	const sql = (file: string): string => readFileSync(join(directory, file), 'utf8')

	test('rewrites every bare trigger ref to refs/heads/<name> except one whose full ref another environment holds', () => {
		const sqlite = new Database(':memory:')
		sqlite.exec('PRAGMA foreign_keys = ON')
		for (const file of files.filter((name) => name < MIGRATION)) sqlite.exec(sql(file))
		for (const appId of appIds()) sqlite.query(SEED_APP).run(appId, `github.com/acme/${appId}`)
		for (const [appId, env, triggerRef] of SEEDED) sqlite.query(SEED_ENV).run(appId, env, triggerRef)

		sqlite.exec(sql(MIGRATION))

		const rows = sqlite.query<{ app_id: string; env: string; trigger_ref: string | null }, []>(READ_ENVS).all()
		expect(byCoordinate(rows)).toEqual(MIGRATED)
	})
})

describe('maintenance names an environment the migration left bare', () => {
	let warn: ReturnType<typeof spyOn<Console, 'warn'>>
	beforeEach(() => {
		warn = spyOn(console, 'warn').mockImplementation(() => {})
	})
	afterEach(() => {
		warn.mockRestore()
	})

	test('one warning per bare trigger ref, with its coordinates, and none for a full ref', async () => {
		const { sqlite, db } = createHarness()
		sqlite.query(SEED_APP).run('shop', 'github.com/acme/shop')
		sqlite.query(SEED_ENV).run('shop', 'prod', 'main')
		sqlite.query(SEED_ENV).run('shop', 'next', 'refs/heads/main')

		expect(await warnBareTriggerRefs(db.registry)).toEqual(['shop/prod'])

		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn.mock.calls[0]?.[0]).toBe(
			'trigger ref "main" of shop/prod is not a full git ref, so no push deploys it; '
				+ 'put shop/prod again with a refs/heads/<branch> or refs/tags/<tag> trigger ref no other environment holds',
		)
	})
})

describe.skipIf(!hasPostgres)(`${MIGRATION} on Postgres`, () => {
	test('rewrites every bare trigger ref to refs/heads/<name> except one whose full ref another environment holds', async () => {
		if (postgresUrl === null) throw new Error('FABRIKA_TEST_POSTGRES_URL is not set')
		const schema = `vozka_trigger_migration_${Math.random().toString(36).slice(2, 10)}`
		const admin = PostgresDatabase.connect(postgresUrl)
		await admin.prepare(`CREATE SCHEMA ${schema}`).run()
		const db = PostgresDatabase.connect(postgresUrl, { connection: { search_path: schema }, max: 1 })
		try {
			const migrations = postgresMigrations()
			await applyMigrations(db, migrations.filter((migration) => migration.name < MIGRATION))
			for (const appId of appIds()) await db.prepare(SEED_APP).bind(appId, `github.com/acme/${appId}`).run()
			for (const [appId, env, triggerRef] of SEEDED) await db.prepare(SEED_ENV).bind(appId, env, triggerRef).run()

			expect(await applyMigrations(db, migrations)).toEqual([MIGRATION])

			const { results } = await db.prepare(READ_ENVS).all<{ app_id: string; env: string; trigger_ref: string | null }>()
			expect(byCoordinate(results)).toEqual(MIGRATED)
		} finally {
			await db.close()
			await admin.prepare(`DROP SCHEMA ${schema} CASCADE`).run()
			await admin.close()
		}
	})
})
