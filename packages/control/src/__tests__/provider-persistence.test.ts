import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHarness, queryRows } from './helpers/harness'

const targetJson = JSON.stringify({ provider: 'harbor', version: 2, payload: { region: 'eu-west' } })
const artifactJson = JSON.stringify({ provider: 'harbor', version: 4, payload: { image: 'registry.example/app:v4' } })

const appEnvironment = (appId: string, env: string) => ({
	appId,
	env,
	provider: 'harbor',
	providerTargetJson: targetJson,
	providerArtifactJson: artifactJson,
})

const rowValue = (row: Record<string, unknown> | undefined, key: string): unknown => row?.[key]

describe('generic provider persistence', () => {
	test('round-trips a third provider without changing the schema or query surface', async () => {
		const { db } = createHarness()
		await db.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		const stored = await db.upsertAppEnv(appEnvironment('app', 'prod'))

		expect(stored.provider).toBe('harbor')
		expect(stored.provider_target_json).toBe(targetJson)
		expect(stored.provider_artifact_json).toBe(artifactJson)
		expect((await db.listAppEnvsByProvider('harbor')).map((row) => row.env)).toEqual(['prod'])
		expect(await db.listAppEnvsByProvider('other')).toHaveLength(0)
	})

	test('persists and lists provider-owned external runs generically', async () => {
		const now = 2_000_000
		const { db, sqlite } = createHarness(() => now)
		await db.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		await db.upsertAppEnv(appEnvironment('app', 'prod'))
		const run = await db.createRun({ id: 'run-1', appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })
		await db.markRunStarted(run.id, 'runs/run-1/logs.ndjson')

		expect(await db.setRunExternalId(run.id, 'harbor-operation-7')).toBe(true)
		expect((await db.getRun(run.id))?.external_run_id).toBe('harbor-operation-7')
		expect((await db.listInFlightRuns('harbor')).map((row) => row.id)).toEqual(['run-1'])
		expect(await db.listInFlightRuns('other')).toHaveLength(0)

		sqlite.query('UPDATE runs SET created_at = ?, started_at = ? WHERE id = ?').run(now - 7200, now - 7200, run.id)
		expect(await db.sweepStaleRuns(3600)).toBe(0)
		expect((await db.getRun(run.id))?.status).toBe('running')
	})

	test('migrates existing Cloudflare and Zerops rows into envelopes before dropping named columns', () => {
		const sqlite = new Database(':memory:')
		sqlite.exec('PRAGMA foreign_keys = ON')
		const sqliteMigrations = join(import.meta.dir, '..', '..', 'migrations')
		for (let version = 1; version <= 7; version++) {
			const name = String(version).padStart(4, '0')
			const filename = version === 1
				? `${name}_init.sql`
				: version === 2
				? `${name}_vault.sql`
				: version === 3
				? `${name}_single_account.sql`
				: version === 4
				? `${name}_repo_poll.sql`
				: version === 5
				? `${name}_app_vars.sql`
				: version === 6
				? `${name}_deploy_locks.sql`
				: `${name}_zerops_targets.sql`
			sqlite.exec(readFileSync(join(sqliteMigrations, filename), 'utf8'))
		}

		sqlite.query(`INSERT INTO apps (id, repo_url, config_path) VALUES (?, ?, ?)`).run('cf', 'github.com/acme/cf', 'deploy/config.ts')
		sqlite.query(`INSERT INTO apps (id, repo_url) VALUES (?, ?)`).run('zp', 'github.com/acme/zp')
		sqlite.query(`INSERT INTO app_envs (app_id, env, platform) VALUES (?, ?, ?)`).run('cf', 'prod', 'cloudflare')
		sqlite.query(
			`INSERT INTO app_envs (app_id, env, platform, zerops_project_id, zerops_service_id, manifest_json)
				VALUES (?, ?, ?, ?, ?, ?)`,
		).run('zp', 'prod', 'zerops', 'project-1', 'service-1', JSON.stringify({ version: 1 }))
		sqlite.query(`INSERT INTO runs (id, app_id, env, ref, trigger, status, platform_run_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
			.run('run-zp', 'zp', 'prod', 'main', 'manual', 'running', 'version-1')

		sqlite.exec(readFileSync(join(sqliteMigrations, '0008_provider_envelopes.sql'), 'utf8'))

		const environments = queryRows(
			sqlite,
			`SELECT app_id, provider, provider_target_json, provider_artifact_json FROM app_envs ORDER BY app_id`,
		)
		expect(environments).toHaveLength(2)
		expect(rowValue(environments[0], 'provider')).toBe('cloudflare')
		expect(rowValue(environments[0], 'provider_artifact_json')).toBe(
			JSON.stringify({ provider: 'cloudflare', version: 1, payload: { configPath: 'deploy/config.ts' } }),
		)
		expect(rowValue(environments[1], 'provider_target_json')).toBe(
			JSON.stringify({ provider: 'zerops', version: 1, payload: { projectId: 'project-1', serviceId: 'service-1' } }),
		)
		expect(rowValue(queryRows(sqlite, 'SELECT external_run_id FROM runs')[0], 'external_run_id')).toBe('version-1')
	})
})
