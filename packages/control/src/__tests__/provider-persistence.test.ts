import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHarness, queryRows } from './helpers/harness'

const targetJson = JSON.stringify({ provider: 'harbor', version: 2, payload: { region: 'eu-west' } })
const artifactJson = JSON.stringify({ provider: 'harbor', version: 4, payload: { image: 'registry.example/app:v4' } })

const appEnvironment = (appId: string, env: string) => ({
	appId,
	env,
	namespaceId: null,
	provider: 'harbor',
	providerTargetJson: targetJson,
	providerArtifactJson: artifactJson,
})

const rowValue = (row: Record<string, unknown> | undefined, key: string): unknown => row?.[key]

const sqliteMigrations = join(import.meta.dir, '..', '..', 'migrations')

const applySqliteMigrationsThrough = (sqlite: Database, last: string): void => {
	for (const filename of readdirSync(sqliteMigrations).filter((name) => name.endsWith('.sql') && name <= last).sort()) {
		sqlite.exec(readFileSync(join(sqliteMigrations, filename), 'utf8'))
	}
}

const applySqliteMigrationStrictly = (sqlite: Database, filename: string): void => {
	const sql = readFileSync(join(sqliteMigrations, filename), 'utf8')
	for (const statement of sql.split(';').map((part) => part.trim()).filter((part) => part !== '')) {
		sqlite.run(statement)
	}
}

describe('generic provider persistence', () => {
	test('backfills only active legacy Zerops runs as already-triggered app versions', () => {
		const sqlite = new Database(':memory:')
		sqlite.exec('PRAGMA foreign_keys = ON')
		applySqliteMigrationsThrough(sqlite, '0017_provider_run_state.sql')
		sqlite.run("INSERT INTO apps (id, repo_url) VALUES ('app', 'github.com/acme/app')")
		for (const provider of ['zerops', 'cloudflare']) {
			sqlite.query(
				'INSERT INTO app_envs (app_id, env, provider, provider_target_json, provider_artifact_json) VALUES (?, ?, ?, ?, ?)',
			).run(
				'app',
				provider,
				provider,
				JSON.stringify({ provider, version: 1, payload: {} }),
				JSON.stringify({ provider, version: 1, payload: {} }),
			)
		}
		for (
			const [id, env, status] of [
				['active-zerops', 'zerops', 'running'],
				['pending-zerops', 'zerops', 'pending'],
				['terminal-zerops', 'zerops', 'succeeded'],
				['active-cloudflare', 'cloudflare', 'running'],
			]
		) {
			sqlite.query(
				'INSERT INTO runs (id, app_id, env, ref, trigger, status, external_run_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
			).run(
				id,
				'app',
				env,
				'main',
				'manual',
				status,
				id === 'active-zerops' ? 'version-"quoted"' : `${id}-operation`,
			)
		}

		applySqliteMigrationStrictly(sqlite, '0018_zerops_legacy_run_state.sql')

		const rows = queryRows(sqlite, 'SELECT id, provider_state_json FROM runs ORDER BY id')
		expect(rows).toEqual([
			{ id: 'active-cloudflare', provider_state_json: null },
			{
				id: 'active-zerops',
				provider_state_json: JSON.stringify({ appVersionId: 'version-"quoted"', phase: 'build_triggered' }),
			},
			{
				id: 'pending-zerops',
				provider_state_json: JSON.stringify({ appVersionId: 'pending-zerops-operation', phase: 'build_triggered' }),
			},
			{ id: 'terminal-zerops', provider_state_json: null },
		])
	})

	test('round-trips a third provider without changing the schema or query surface', async () => {
		const { db } = createHarness()
		await db.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		const stored = await db.registry.upsertAppEnv(appEnvironment('app', 'prod'))

		expect(stored.provider).toBe('harbor')
		expect(stored.provider_target_json).toBe(targetJson)
		expect(stored.provider_artifact_json).toBe(artifactJson)
		expect((await db.registry.listAppEnvsByProvider('harbor')).map((row) => row.env)).toEqual(['prod'])
		expect(await db.registry.listAppEnvsByProvider('other')).toHaveLength(0)
	})

	test('persists and lists provider-owned external runs generically', async () => {
		const now = 2_000_000
		const { db, sqlite } = createHarness(() => now)
		await db.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		await db.registry.upsertAppEnv(appEnvironment('app', 'prod'))
		const run = await db.runs.createRun({ id: 'run-1', appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })
		await db.runs.markRunStarted(run.id, 'runs/run-1/logs.ndjson')

		expect(await db.runs.setRunExternalId(run.id, 'harbor-operation-7')).toBe(true)
		expect((await db.runs.getRun(run.id))?.external_run_id).toBe('harbor-operation-7')
		expect((await db.runs.listInFlightRuns('harbor')).map((row) => row.id)).toEqual(['run-1'])
		expect(await db.runs.listInFlightRuns('other')).toHaveLength(0)

		sqlite.query('UPDATE runs SET created_at = ?, started_at = ? WHERE id = ?').run(now - 7200, now - 7200, run.id)
		expect(await db.runs.sweepStaleRuns(3600)).toBe(0)
		expect((await db.runs.getRun(run.id))?.status).toBe('running')
	})

	test('round-trips namespaces and namespace-owned or app-owned resource claims', async () => {
		const { db } = createHarness()
		await db.registry.createApp({ id: 'alpha', repoUrl: 'github.com/acme/alpha' })
		await db.registry.createApp({ id: 'beta', repoUrl: 'github.com/acme/beta' })
		const namespace = await db.registry.createDeploymentNamespace({
			id: 'apps-prod',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: targetJson,
		})
		await db.registry.upsertAppEnv({ ...appEnvironment('alpha', 'prod'), namespaceId: namespace.id })
		await db.registry.upsertAppEnv({ ...appEnvironment('beta', 'prod'), namespaceId: namespace.id })
		await db.registry.createNamespaceResourceClaim({
			namespaceId: namespace.id,
			resourceKey: 'proxy',
			ownerAppId: null,
			ownerEnv: null,
		})
		await db.registry.createNamespaceResourceClaim({
			namespaceId: namespace.id,
			resourceKey: 'alpha-api',
			ownerAppId: 'alpha',
			ownerEnv: 'prod',
		})
		const ready = await db.registry.updateDeploymentNamespace({
			id: namespace.id,
			providerTargetJson: JSON.stringify({ provider: 'harbor', version: 3, payload: { dock: '7' } }),
			state: 'ready',
			lastError: null,
		})

		expect((await db.registry.listDeploymentNamespaces()).map((row) => row.id)).toEqual(['apps-prod'])
		expect(ready?.state).toBe('ready')
		expect((await db.registry.getAppEnv('alpha', 'prod'))?.namespace_id).toBe('apps-prod')
		expect((await db.registry.listAppEnvsByNamespace('apps-prod')).map((row) => row.app_id)).toEqual(['alpha', 'beta'])
		expect((await db.registry.listNamespaceResourceClaims(namespace.id)).map((claim) => [
			claim.resource_key,
			claim.owner_app_id,
		])).toEqual([
			['alpha-api', 'alpha'],
			['proxy', null],
		])
	})

	test('acquires claims idempotently and atomically with an environment upsert', async () => {
		const { db } = createHarness()
		await db.registry.createApp({ id: 'alpha', repoUrl: 'github.com/acme/alpha' })
		await db.registry.createApp({ id: 'beta', repoUrl: 'github.com/acme/beta' })
		await db.registry.createDeploymentNamespace({
			id: 'apps-prod',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: targetJson,
		})

		const first = await db.registry.upsertAppEnvWithNamespaceResourceClaims(
			{ ...appEnvironment('alpha', 'prod'), namespaceId: 'apps-prod', domain: 'alpha.example' },
			['z-shared', 'alpha-worker', 'alpha-worker'],
		)
		expect(first.resourceClaims.map((claim) => claim.resource_key)).toEqual(['alpha-worker', 'z-shared'])

		const retried = await db.registry.upsertAppEnvWithNamespaceResourceClaims(
			{ ...appEnvironment('alpha', 'prod'), namespaceId: 'apps-prod', domain: 'new-alpha.example' },
			['z-shared'],
		)
		expect(retried.appEnv.domain).toBe('new-alpha.example')
		expect(retried.resourceClaims[0]?.created_at).toBe(first.resourceClaims[1]?.created_at)
		expect((await db.registry.listNamespaceResourceClaims('apps-prod')).map((claim) => claim.resource_key)).toEqual([
			'alpha-worker',
			'z-shared',
		])

		await expect(db.registry.upsertAppEnvWithNamespaceResourceClaims(
			{ ...appEnvironment('beta', 'prod'), namespaceId: 'apps-prod' },
			['beta-worker', 'z-shared'],
		)).rejects.toThrow('namespace resource claim owner is immutable')
		expect(await db.registry.getAppEnv('beta', 'prod')).toBeNull()
		expect((await db.registry.listNamespaceResourceClaims('apps-prod')).map((claim) => claim.resource_key)).toEqual([
			'alpha-worker',
			'z-shared',
		])
	})

	test('keeps historical claims when an undeployed environment moves namespaces', async () => {
		const { db } = createHarness()
		await db.registry.createApp({ id: 'alpha', repoUrl: 'github.com/acme/alpha' })
		for (const id of ['first', 'second']) {
			await db.registry.createDeploymentNamespace({
				id,
				env: 'prod',
				provider: 'harbor',
				exclusiveAppId: null,
				providerTargetJson: targetJson,
			})
		}
		await db.registry.upsertAppEnvWithNamespaceResourceClaims(
			{ ...appEnvironment('alpha', 'prod'), namespaceId: 'first' },
			['alpha-api'],
		)
		await db.registry.upsertAppEnvWithNamespaceResourceClaims(
			{ ...appEnvironment('alpha', 'prod'), namespaceId: 'second' },
			['alpha-api'],
		)

		expect((await db.registry.getAppEnv('alpha', 'prod'))?.namespace_id).toBe('second')
		expect((await db.registry.listNamespaceResourceClaims('first')).map((claim) => claim.resource_key)).toEqual(['alpha-api'])
		expect((await db.registry.listNamespaceResourceClaims('second')).map((claim) => claim.resource_key)).toEqual(['alpha-api'])
	})

	test('enforces namespace coordinates and resource ownership constraints', async () => {
		const { db } = createHarness()
		await db.registry.createApp({ id: 'alpha', repoUrl: 'github.com/acme/alpha' })
		await db.registry.createDeploymentNamespace({
			id: 'apps-prod',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: targetJson,
		})
		await db.registry.createDeploymentNamespace({
			id: 'other-prod',
			env: 'prod',
			provider: 'other',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify({ provider: 'other', version: 1, payload: {} }),
		})

		await expect(db.registry.upsertAppEnv({ ...appEnvironment('alpha', 'stage'), namespaceId: 'apps-prod' })).rejects.toThrow()
		await expect(db.registry.upsertAppEnv({ ...appEnvironment('alpha', 'prod'), namespaceId: 'other-prod' })).rejects.toThrow()
		await db.registry.upsertAppEnv({ ...appEnvironment('alpha', 'prod'), namespaceId: 'apps-prod' })
		await db.registry.createNamespaceResourceClaim({
			namespaceId: 'apps-prod',
			resourceKey: 'alpha-api',
			ownerAppId: 'alpha',
			ownerEnv: 'prod',
		})
		await expect(db.registry.createNamespaceResourceClaim({
			namespaceId: 'apps-prod',
			resourceKey: 'alpha-api',
			ownerAppId: 'alpha',
			ownerEnv: 'prod',
		})).resolves.toMatchObject({
			namespace_id: 'apps-prod',
			resource_key: 'alpha-api',
			owner_app_id: 'alpha',
			owner_env: 'prod',
		})
		await expect(db.registry.createNamespaceResourceClaim({
			namespaceId: 'apps-prod',
			resourceKey: 'alpha-api',
			ownerAppId: null,
			ownerEnv: null,
		})).rejects.toThrow()
		await expect(db.registry.createNamespaceResourceClaim({
			namespaceId: 'apps-prod',
			resourceKey: 'broken-owner',
			ownerAppId: 'alpha',
			ownerEnv: null,
		})).rejects.toThrow()
		await expect(db.registry.deleteAppEnv('alpha', 'prod')).rejects.toThrow()
	})

	test('migrates existing Cloudflare and Zerops rows into envelopes before dropping named columns', () => {
		const sqlite = new Database(':memory:')
		sqlite.exec('PRAGMA foreign_keys = ON')
		applySqliteMigrationsThrough(sqlite, '0007_zerops_targets.sql')

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

	test('groups existing Zerops targets into pending namespaces without changing app targets', () => {
		const sqlite = new Database(':memory:')
		sqlite.exec('PRAGMA foreign_keys = ON')
		applySqliteMigrationsThrough(sqlite, '0008_provider_envelopes.sql')
		for (const id of ['alpha', 'beta', 'cf', 'third']) {
			sqlite.query('INSERT INTO apps (id, repo_url) VALUES (?, ?)').run(id, `github.com/acme/${id}`)
		}
		const zeropsTarget = (serviceId: string): string =>
			JSON.stringify({ provider: 'zerops', version: 1, payload: { projectId: 'project-1', serviceId } })
		const artifact = (provider: string): string => JSON.stringify({ provider, version: 1, payload: { kind: 'artifact' } })
		for (const [appId, serviceId] of [['alpha', 'service-alpha'], ['beta', 'service-beta']]) {
			sqlite.query(`INSERT INTO app_envs (
					app_id, env, provider, provider_target_json, provider_artifact_json
				) VALUES (?, 'prod', 'zerops', ?, ?)`)
				.run(appId, zeropsTarget(serviceId), artifact('zerops'))
		}
		const cloudflareTarget = JSON.stringify({ provider: 'cloudflare', version: 1, payload: {} })
		const thirdTarget = JSON.stringify({ provider: 'harbor', version: 7, payload: { region: 'eu' } })
		sqlite.query(`INSERT INTO app_envs (
				app_id, env, provider, provider_target_json, provider_artifact_json
			) VALUES ('cf', 'prod', 'cloudflare', ?, ?)`)
			.run(cloudflareTarget, artifact('cloudflare'))
		sqlite.query(`INSERT INTO app_envs (
				app_id, env, provider, provider_target_json, provider_artifact_json
			) VALUES ('third', 'prod', 'harbor', ?, ?)`)
			.run(thirdTarget, artifact('harbor'))

		applySqliteMigrationStrictly(sqlite, '0009_deployment_namespaces.sql')

		const namespaces = queryRows(sqlite, 'SELECT * FROM deployment_namespaces')
		expect(namespaces).toHaveLength(1)
		expect(rowValue(namespaces[0], 'id')).toBe('zerops-project-project-1')
		expect(rowValue(namespaces[0], 'state')).toBe('pending')
		expect(rowValue(namespaces[0], 'exclusive_app_id')).toBeNull()
		expect(JSON.parse(`${rowValue(namespaces[0], 'provider_target_json')}`)).toEqual({
			provider: 'zerops',
			version: 1,
			payload: { projectId: 'project-1' },
		})
		const environments = queryRows(
			sqlite,
			'SELECT app_id, namespace_id, provider_target_json FROM app_envs ORDER BY app_id',
		)
		expect(environments.map((row) => [rowValue(row, 'app_id'), rowValue(row, 'namespace_id')])).toEqual([
			['alpha', 'zerops-project-project-1'],
			['beta', 'zerops-project-project-1'],
			['cf', null],
			['third', null],
		])
		expect(rowValue(environments[0], 'provider_target_json')).toBe(zeropsTarget('service-alpha'))
		expect(rowValue(environments[2], 'provider_target_json')).toBe(cloudflareTarget)
		expect(rowValue(environments[3], 'provider_target_json')).toBe(thirdTarget)
	})

	test('rejects inconsistent legacy Zerops groupings instead of guessing ownership', () => {
		const migrate = (rows: Array<{ appId: string; env: string; serviceId: string }>): void => {
			const sqlite = new Database(':memory:')
			sqlite.exec('PRAGMA foreign_keys = ON')
			applySqliteMigrationsThrough(sqlite, '0008_provider_envelopes.sql')
			for (const row of rows) {
				sqlite.query('INSERT INTO apps (id, repo_url) VALUES (?, ?)').run(row.appId, `github.com/acme/${row.appId}`)
				sqlite.query(`INSERT INTO app_envs (
						app_id, env, provider, provider_target_json, provider_artifact_json
					) VALUES (?, ?, 'zerops', ?, ?)`)
					.run(
						row.appId,
						row.env,
						JSON.stringify({
							provider: 'zerops',
							version: 1,
							payload: { projectId: 'project-1', serviceId: row.serviceId },
						}),
						JSON.stringify({ provider: 'zerops', version: 1, payload: null }),
					)
			}
			applySqliteMigrationStrictly(sqlite, '0009_deployment_namespaces.sql')
		}

		expect(() =>
			migrate([
				{ appId: 'prod-app', env: 'prod', serviceId: 'prod-service' },
				{ appId: 'stage-app', env: 'stage', serviceId: 'stage-service' },
			])
		).toThrow()
		expect(() =>
			migrate([
				{ appId: 'alpha', env: 'prod', serviceId: 'shared-service' },
				{ appId: 'beta', env: 'prod', serviceId: 'shared-service' },
			])
		).toThrow()
	})

	test('moves Zerops project coordinates from app target v1 to its namespace', () => {
		const migrate = (namespaceProjectId: string): Database => {
			const sqlite = new Database(':memory:')
			sqlite.exec('PRAGMA foreign_keys = ON')
			applySqliteMigrationsThrough(sqlite, '0011_namespace_resource_claim_owner_coordinates.sql')
			sqlite.query('INSERT INTO apps (id, repo_url) VALUES (?, ?)').run('alpha', 'github.com/acme/alpha')
			sqlite.query(`INSERT INTO deployment_namespaces (
					id, env, provider, exclusive_app_id, provider_target_json, state
				) VALUES (?, 'prod', 'zerops', NULL, ?, 'ready')`)
				.run(
					'apps-prod',
					JSON.stringify({
						provider: 'zerops',
						version: 1,
						payload: { projectId: namespaceProjectId, proxyServiceId: 'proxy-1', ready: true },
					}),
				)
			sqlite.query(`INSERT INTO app_envs (
					app_id, env, namespace_id, provider, provider_target_json, provider_artifact_json
				) VALUES ('alpha', 'prod', 'apps-prod', 'zerops', ?, ?)`)
				.run(
					JSON.stringify({
						provider: 'zerops',
						version: 1,
						payload: { projectId: 'project-1', serviceId: 'service-alpha' },
					}),
					JSON.stringify({ provider: 'zerops', version: 1, payload: { kind: 'artifact' } }),
				)
			applySqliteMigrationStrictly(sqlite, '0012_zerops_namespace_app_targets.sql')
			return sqlite
		}

		const sqlite = migrate('project-1')
		const environment = queryRows(sqlite, 'SELECT provider_target_json FROM app_envs')[0]
		expect(JSON.parse(`${rowValue(environment, 'provider_target_json')}`)).toEqual({
			provider: 'zerops',
			version: 2,
			payload: { serviceId: 'service-alpha' },
		})
		sqlite.close()
		expect(() => migrate('different-project')).toThrow()
	})
})
