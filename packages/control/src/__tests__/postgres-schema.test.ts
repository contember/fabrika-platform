// The Postgres port, proved end to end against a REAL Postgres.
//
// This is the acceptance test for `migrations-postgres/`: it applies the shipped files with the
// shipped runner and then drives the SAME `src/db.ts`, `src/vault.ts` and `SqlDeployLocks` the Worker
// uses — every method, unmodified — against the result. If the two migration sets ever diverge in a way
// that matters, a call in here fails; a schema that merely LOOKS equivalent is not what is asserted.
//
// It also pins the things that behave differently from D1 and cannot be discovered any other way: the
// `DEFAULT (FLOOR(EXTRACT(EPOCH FROM now())))` creation stamps that replace SQLite's `unixepoch()`, the
// seconds-valued columns still decoding as `number`, and `deploy_locks.expires_at` being the one BIGINT
// — which is what makes a millisecond deadline storable at all.
//
// Skips cleanly (with a reason) when FABRIKA_TEST_POSTGRES_URL is unset — see helpers/postgres.ts.

import { PROXY_TOKEN_HEADER } from '@fabrika/auth'
import { type OperationsReleaseReconcileRequest, parseOperationsReleaseRequest } from '@fabrika/operations-contract/releases'
import { type BlobStore, type SqlDatabase, SqlDeployLocks, type SqlQueryResult, type SqlStatement, uuidv7 } from '@fabrika/platform'
import { PostgresDatabase, PostgresJobQueue } from '@fabrika/platform-node'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { applyMigrations } from '../bun/migrate'
import { createFetchHandler } from '../bun/server'
import { runDeployJob } from '../consumer'
import { runMaintenance } from '../cron'
import { AppEnvChangedError, type AppEnvInput, type ControlRepositories, createControlRepositories } from '../db'
import type { Env } from '../env'
import { type PublishGitHubConnectionInput } from '../github/connections/model'
import { githubAppCredentialSecretLabel, githubManifestStateSecretLabel, githubWebhookSecretLabel } from '../github/connections/secrets'
import { GitHubConnectionStore } from '../github/connections/store'
import { CATALOG_LEASE_KEY, LEASE_TTL_MS } from '../lease'
import type { DeployJobMessage } from '../run-lifecycle'
import { Vault } from '../vault'
import { fixtureProtect, fixtureRuns } from './helpers/lock'
import { createPostgres, hasPostgres, type PostgresFixture, postgresUrl, skipReason } from './helpers/postgres'
import { interleaving } from './helpers/postgres-interleave'
import { protectionRaceScenario } from './helpers/protection-race'
import { fakeControlProvider } from './helpers/provider'
import { proxiedRequest } from './helpers/proxy'
import { refusedClaimScenario } from './helpers/refused-claims'
import { unusedSourceConnection } from './helpers/source-connection'
import { adminToken, testIamEnv } from './helpers/tokens'

if (!hasPostgres) {
	console.warn(`postgres-schema.test.ts ${skipReason}`)
}

let fixture: PostgresFixture | null = null
let raw: PostgresDatabase
let db: ControlRepositories

beforeAll(async () => {
	if (!hasPostgres) {
		return
	}
	fixture = await createPostgres('vozka')
	raw = fixture.db
	db = createControlRepositories(raw)
})

afterAll(async () => {
	await fixture?.close()
})

/** Remove everything a test may have written. `apps` cascades to envs/secrets/vars/runs/poll state. */
async function reset(): Promise<void> {
	for (
		const table of [
			'github_source_connections_keyed',
			'github_source_setup_attempts',
			'namespace_resource_claims',
			'jobs',
			'deploy_locks',
			'runs',
			'repo_poll_state',
			'app_vars',
			'app_secrets',
			'app_envs',
			'app_env_protection',
			'deployment_namespaces',
			'apps',
			'vault',
		]
	) {
		await raw.prepare(`DELETE FROM ${table}`).run()
	}
}

function now(): number {
	return Math.floor(Date.now() / 1000)
}

const providerEnvironment = (
	appId: string,
	env: string,
	options: { domain?: string | null; publicOrigin?: string | null; crossOrigins?: readonly string[]; triggerRef?: string | null } = {},
) => ({
	appId,
	env,
	...options,
	namespaceId: null,
	provider: 'harbor',
	providerTargetJson: JSON.stringify({ provider: 'harbor', version: 1, payload: { region: 'eu' } }),
	providerArtifactJson: JSON.stringify({ provider: 'harbor', version: 1, payload: { image: 'app:v1' } }),
})

/** A 32-byte base64 KEK, generated per call — never a fixed key, not even in a test. */
function kek(): string {
	return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
}

class TwoConnectionBarrier {
	private arrivals = 0
	private readonly ready = Promise.withResolvers<void>()

	wait(): Promise<void> {
		this.arrivals += 1
		if (this.arrivals === 2) this.ready.resolve()
		return this.ready.promise
	}
}

class PostgresBarrierDatabase implements SqlDatabase {
	constructor(private readonly inner: SqlDatabase, private readonly barrier: TwoConnectionBarrier) {}

	prepare(sql: string): SqlStatement {
		return this.inner.prepare(sql)
	}

	async batch<T = Record<string, unknown>>(statements: SqlStatement[]): Promise<SqlQueryResult<T>[]> {
		await this.barrier.wait()
		return this.inner.batch<T>(statements)
	}
}

describe.skipIf(!hasPostgres)('migrations-postgres — the runner', () => {
	test('applies every shipped file and is a no-op on the second run', async () => {
		// The fixture already applied them once. `run.initCommands` re-runs this on EVERY container start,
		// so "already current" must be the normal, silent outcome and not an error.
		expect(await applyMigrations(raw)).toEqual([])
		const { results } = await raw
			.prepare('SELECT bundle, name FROM control_schema_migrations ORDER BY name')
			.all<{ bundle: string; name: string }>()
		expect(results).toEqual([
			{ bundle: 'control', name: '0001_init.sql' },
			{ bundle: 'control', name: '0002_authoring_workspaces.sql' },
			{ bundle: 'control', name: '0003_namespace_update.sql' },
			{ bundle: 'control', name: '0004_proxy_secrets.sql' },
			{ bundle: 'control', name: '0005_approved_access.sql' },
			{ bundle: 'control', name: '0006_workload_credentials.sql' },
			{ bundle: 'control', name: '0007_membership_keys.sql' },
			{ bundle: 'control', name: '0008_connector_credentials.sql' },
			{ bundle: 'control', name: '0009_canonical_trigger_refs.sql' },
			{ bundle: 'control', name: '0010_cross_origins.sql' },
			{ bundle: 'control', name: '0011_public_workload_credentials.sql' },
			{ bundle: 'control', name: '0012_token_keys.sql' },
			{ bundle: 'control', name: '0013_mail_relay.sql' },
			{ bundle: 'control', name: '0014_workspace_pull_requests.sql' },
			{ bundle: 'control', name: '0015_workspace_abandon.sql' },
			{ bundle: 'control', name: '0016_dev_environments.sql' },
			{ bundle: 'control', name: '0017_dev_launcher_contact.sql' },
			{ bundle: 'control', name: '0018_data_operations.sql' },
			{ bundle: 'control', name: '0019_ops_keys.sql' },
			{ bundle: 'control', name: '0020_run_superseded_by.sql' },
			{ bundle: 'control', name: '0021_backups.sql' },
		])
	})

	test('creates the tables the service reads/writes', async () => {
		const { results } = await raw
			.prepare(`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ?`)
			.bind(fixture?.schema ?? '')
			.all<{ name: string }>()
		const names = results.map((r) => r.name)
		for (
			const table of [
				'apps',
				'app_envs',
				'dev_environments',
				'deployment_namespaces',
				'namespace_resource_claims',
				'app_secrets',
				'app_vars',
				'app_env_proxy_secrets',
				'runs',
				'repo_poll_state',
				'vault',
				'deploy_locks',
				'jobs',
				'operations_catalog_sync',
				'operations_release_sync',
				'operations_ingest_configs',
				'github_source_setup_attempts',
				'github_source_connections_keyed',
				'builder_connection_receipts',
				'app_env_data_operations',
				'app_env_data_generations',
				'app_env_ops_keys',
				'app_env_backups',
				'app_env_backup_parts',
				'app_env_backup_schedules',
			]
		) {
			expect(names).toContain(table)
		}
	})
})

describe.skipIf(!hasPostgres)('the Postgres schema — column types the row shapes depend on', () => {
	test('every seconds-valued and count column is int4, so it decodes as a JS number', async () => {
		// The rule from the migration header: a column a row shape types `number` must be INTEGER, because
		// Bun decodes int8/numeric as a STRING by column OID. This asserts the schema side.
		const { results } = await raw
			.prepare(`SELECT table_name, column_name, data_type FROM information_schema.columns
				WHERE table_schema = ?
				  AND column_name IN (
					'created_at','started_at','finished_at','cancel_requested_at','last_polled_at','rotated_at','exit_code','github_installation_id'
				  )
				  AND table_name <> 'jobs'
				ORDER BY table_name, column_name`)
			.bind(fixture?.schema ?? '')
			.all<{ table_name: string; column_name: string; data_type: string }>()
		expect(results.length).toBeGreaterThan(0)
		for (const column of results) {
			expect(`${column.table_name}.${column.column_name}:${column.data_type}`).toBe(`${column.table_name}.${column.column_name}:integer`)
		}
	})

	test('the MILLISECOND columns are the only bigints, and no row shape reads one', async () => {
		const { results } = await raw
			.prepare(`SELECT table_name, column_name FROM information_schema.columns
				WHERE table_schema = ? AND data_type = 'bigint' ORDER BY table_name, column_name`)
			.bind(fixture?.schema ?? '')
			.all<{ table_name: string; column_name: string }>()
		// `deploy_locks.expires_at` is a `Date.now()` deadline; `jobs.visible_at`/`created_at` are the
		// queue's due/enqueued stamps. Every one of them is compared inside SQL and never selected into JS.
		expect(results.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
			'deploy_locks.expires_at',
			'jobs.created_at',
			'jobs.visible_at',
		])
	})

	test('a real millisecond deadline round-trips — which INTEGER could not hold at all', async () => {
		await reset()
		// The REAL clock, not an injected one: `Date.now()` is ~1.8e12 and int4 tops out at 2147483647, so
		// on an INTEGER column this insert fails outright with "integer out of range". That regression has
		// been shipped twice; this is the assertion that catches it the third time.
		const locks = new SqlDeployLocks(raw)
		expect(await locks.acquire('app:prod', 'run-1', 60_000)).toBe(true)
		expect(await locks.acquire('app:prod', 'run-2', 60_000)).toBe(false)

		const stored = await raw.prepare('SELECT expires_at FROM deploy_locks WHERE lock_key = ?').bind('app:prod').first<{ expires_at: unknown }>()
		// The consequence of BIGINT, pinned: Bun decodes it as a STRING. Nothing in the lock reads it —
		// `acquire` compares it inside the statement — which is exactly why no row shape has to model this.
		expect(typeof stored?.expires_at).toBe('string')
		expect(Number(stored?.expires_at)).toBeGreaterThan(2_147_483_647)

		await locks.release('app:prod', 'run-1')
		expect(await locks.acquire('app:prod', 'run-3', 60_000)).toBe(true)
	})

	test('the creation stamps come from the DDL default, in unix SECONDS', async () => {
		await reset()
		// `createApp` / `createRun` / `upsertAppEnv` / `upsertAppSecret` / `upsertAppVar` / `Vault.putSecret`
		// all OMIT created_at — SQLite fills it from `unixepoch()`, Postgres from this schema's own default.
		const before = now()
		const app = await db.registry.createApp({ id: 'stamped', repoUrl: 'https://github.com/acme/app.git' })
		expect(typeof app.created_at).toBe('number')
		expect(app.created_at).toBeGreaterThanOrEqual(before)
		expect(app.created_at).toBeLessThanOrEqual(now() + 1)

		const run = await db.runs.createRun({ id: uuidv7(), appId: app.id, env: 'prod', ref: 'refs/heads/main', trigger: 'manual', actor: 'user:test' })
		expect(typeof run.created_at).toBe('number')
		expect(run.started_at).toBeNull()
	})
})

describe.skipIf(!hasPostgres)('src/db.ts — the whole query surface, unmodified, on Postgres', () => {
	test('apps: create, read, list, lookup by repo, partial update, delete', async () => {
		await reset()
		const created = await db.registry.createApp({
			id: 'acme',
			repoUrl: 'github.com/acme/app',
			defaultBranch: 'trunk',
			workerDir: 'apps/web',
			githubInstallationId: 4242,
		})
		expect(created.default_branch).toBe('trunk')
		// int4, so it comes back as a number rather than a string.
		expect(created.github_installation_id).toBe(4242)
		expect(created.github_connection_id).toBeNull()
		expect(created.build_cmd).toBeNull()

		expect((await db.registry.getApp('acme'))?.worker_dir).toBe('apps/web')
		expect(await db.registry.getApp('nope')).toBeNull()

		await db.registry.createApp({ id: 'beta', repoUrl: 'github.com/acme/beta' })
		expect((await db.registry.listApps()).map((a) => a.id)).toEqual(['acme', 'beta'])

		// The COALESCE partial update: a bound NULL leaves the column alone. Postgres type-checks bind
		// parameters, so this is the statement most likely to break on the port — it does not.
		const updated = await db.registry.updateApp('acme', { buildCmd: 'bun run build' })
		expect(updated?.build_cmd).toBe('bun run build')
		expect(updated?.default_branch).toBe('trunk')
		expect(updated?.worker_dir).toBe('apps/web')
		expect(await db.registry.updateApp('missing', { buildCmd: 'x' })).toBeNull()

		expect(await db.registry.deleteApp('beta')).toBe(true)
		expect(await db.registry.deleteApp('beta')).toBe(false)
	})

	test('app_envs: upsert, exact + glob trigger lookup, cascade on app delete', async () => {
		await reset()
		await db.registry.createApp({ id: 'acme', repoUrl: 'github.com/acme/app' })

		const prod = await db.registry.upsertAppEnv(
			providerEnvironment('acme', 'prod', {
				domain: 'acme.example',
				publicOrigin: 'https://public.acme.example',
				crossOrigins: ['https://partner.acme.example'],
				triggerRef: 'refs/heads/main',
			}),
		)
		expect(prod.cross_origins_json).toBe('["https://partner.acme.example"]')
		expect(prod.domain).toBe('acme.example')
		expect(prod.public_origin).toBe('https://public.acme.example')
		expect(prod.provider).toBe('harbor')
		expect(JSON.parse(prod.provider_target_json)).toEqual({ provider: 'harbor', version: 1, payload: { region: 'eu' } })
		// ON CONFLICT (app_id, env) DO UPDATE — the upsert path and its RETURNING row.
		const again = await db.registry.upsertAppEnv(providerEnvironment('acme', 'prod', { domain: 'acme2.example', triggerRef: 'refs/tags/v*' }))
		expect(again.domain).toBe('acme2.example')
		expect(again.public_origin).toBeNull()
		// Omitted keeps the stored list; an empty one clears it.
		expect(again.cross_origins_json).toBe('["https://partner.acme.example"]')
		const cleared = await db.registry.upsertAppEnv(
			providerEnvironment('acme', 'prod', { domain: 'acme2.example', triggerRef: 'refs/tags/v*', crossOrigins: [] }),
		)
		expect(cleared.cross_origins_json).toBe('[]')
		expect(again.trigger_ref).toBe('refs/tags/v*')

		expect((await db.registry.upsertAppEnv(providerEnvironment('acme', 'stage'))).cross_origins_json).toBe('[]')
		expect((await db.registry.listAppEnvs('acme')).map((e) => e.env)).toEqual(['prod', 'stage'])
		expect((await db.registry.getAppEnv('acme', 'prod'))?.env).toBe('prod')
		expect((await db.registry.getAppEnvByTriggerRef('acme', 'refs/tags/v*'))?.env).toBe('prod')
		// Manual-only envs (NULL trigger_ref) are excluded — the partial index's whole point.
		expect((await db.registry.listTriggerEnvs('acme')).map((e) => e.env)).toEqual(['prod'])

		expect(await db.registry.deleteAppEnv('acme', 'stage')).toBe(true)
		expect(await db.registry.deleteAppEnv('acme', 'stage')).toBe(false)

		await db.registry.deleteApp('acme')
		expect(await db.registry.listAppEnvs('acme')).toHaveLength(0)
	})

	test('deployment namespaces and resource claims enforce the same ownership constraints', async () => {
		await reset()
		await db.registry.createApp({ id: 'alpha', repoUrl: 'github.com/acme/alpha' })
		await db.registry.createApp({ id: 'beta', repoUrl: 'github.com/acme/beta' })
		const target = JSON.stringify({ provider: 'harbor', version: 1, payload: { dock: 'eu' } })
		await db.registry.createDeploymentNamespace({
			id: 'apps-prod',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: target,
		})
		await db.registry.upsertAppEnv({ ...providerEnvironment('alpha', 'prod'), namespaceId: 'apps-prod' })
		await db.registry.upsertAppEnv({ ...providerEnvironment('beta', 'prod'), namespaceId: 'apps-prod' })
		await db.registry.createNamespaceResourceClaim({
			namespaceId: 'apps-prod',
			resourceKey: 'proxy',
			ownerAppId: null,
			ownerEnv: null,
		})
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

		expect((await db.registry.listDeploymentNamespaces()).map((namespace) => namespace.id)).toEqual(['apps-prod'])
		expect((await db.registry.listNamespaceResourceClaims('apps-prod')).map((claim) => claim.resource_key)).toEqual(['alpha-api', 'proxy'])
		await expect(db.registry.upsertAppEnv({ ...providerEnvironment('alpha', 'stage'), namespaceId: 'apps-prod' })).rejects.toThrow()
		await expect(db.registry.createNamespaceResourceClaim({
			namespaceId: 'apps-prod',
			resourceKey: 'alpha-api',
			ownerAppId: 'beta',
			ownerEnv: 'prod',
		})).rejects.toThrow('namespace resource claim owner is immutable')
		await expect(db.registry.deleteAppEnv('alpha', 'prod')).rejects.toThrow()
	})

	test('app environment and claim acquisition roll back together without releasing omitted claims', async () => {
		await reset()
		await db.registry.createApp({ id: 'alpha', repoUrl: 'github.com/acme/alpha' })
		await db.registry.createApp({ id: 'beta', repoUrl: 'github.com/acme/beta' })
		await db.registry.createDeploymentNamespace({
			id: 'apps-prod',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify({ provider: 'harbor', version: 1, payload: { dock: 'eu' } }),
		})
		await db.registry.createDeploymentNamespace({
			id: 'other-prod',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify({ provider: 'harbor', version: 1, payload: { dock: 'other' } }),
		})

		await db.registry.upsertAppEnvWithNamespaceResourceClaims(
			{ ...providerEnvironment('alpha', 'prod'), namespaceId: 'apps-prod' },
			['alpha-worker', 'z-shared'],
		)
		await db.registry.upsertAppEnvWithNamespaceResourceClaims(
			{ ...providerEnvironment('alpha', 'prod'), namespaceId: 'apps-prod', domain: 'alpha.example' },
			['z-shared'],
		)

		await expect(db.registry.upsertAppEnvWithNamespaceResourceClaims(
			{ ...providerEnvironment('beta', 'prod'), namespaceId: 'apps-prod' },
			['beta-worker', 'z-shared'],
		)).rejects.toThrow('namespace resource claim owner is immutable')
		expect(await db.registry.getAppEnv('beta', 'prod')).toBeNull()
		expect((await db.registry.listNamespaceResourceClaims('apps-prod')).map((claim) => claim.resource_key)).toEqual([
			'alpha-worker',
			'z-shared',
		])
		await db.registry.upsertAppEnvWithNamespaceResourceClaims(
			{ ...providerEnvironment('alpha', 'prod'), namespaceId: 'other-prod' },
			['alpha-worker'],
		)
		expect((await db.registry.getAppEnv('alpha', 'prod'))?.namespace_id).toBe('other-prod')
		expect((await db.registry.listNamespaceResourceClaims('apps-prod')).map((claim) => claim.resource_key)).toEqual([
			'alpha-worker',
			'z-shared',
		])
	})

	test('concurrent claim acquisitions have exactly one winner', async () => {
		await reset()
		await db.registry.createApp({ id: 'alpha', repoUrl: 'github.com/acme/alpha' })
		await db.registry.createApp({ id: 'beta', repoUrl: 'github.com/acme/beta' })
		await db.registry.createDeploymentNamespace({
			id: 'apps-prod',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify({ provider: 'harbor', version: 1, payload: { dock: 'eu' } }),
		})
		if (postgresUrl === null || fixture === null) {
			throw new Error('Postgres fixture is required')
		}
		const contenderRaw = PostgresDatabase.connect(postgresUrl, {
			connection: { search_path: fixture.schema },
			max: 1,
		})
		const contender = createControlRepositories(contenderRaw)
		try {
			const outcomes = await Promise.allSettled([
				db.registry.upsertAppEnvWithNamespaceResourceClaims(
					{ ...providerEnvironment('alpha', 'prod'), namespaceId: 'apps-prod' },
					['shared-service'],
				),
				contender.registry.upsertAppEnvWithNamespaceResourceClaims(
					{ ...providerEnvironment('beta', 'prod'), namespaceId: 'apps-prod' },
					['shared-service'],
				),
			])
			expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
			expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)

			const claims = await db.registry.listNamespaceResourceClaims('apps-prod')
			const environments = await db.registry.listAppEnvsByNamespace('apps-prod')
			expect(claims).toHaveLength(1)
			const ownerAppId = claims[0]?.owner_app_id
			if (ownerAppId === null || ownerAppId === undefined) {
				throw new Error('expected an app-owned resource claim')
			}
			expect(environments.map((environment) => environment.app_id)).toEqual([ownerAppId])
		} finally {
			await contenderRaw.close()
		}
	})

	test('a trigger ref is unique within an app, and NULLs do not contend', async () => {
		await reset()
		await db.registry.createApp({ id: 'acme', repoUrl: 'github.com/acme/app' })
		await db.registry.upsertAppEnv(providerEnvironment('acme', 'prod', { triggerRef: 'refs/heads/main' }))
		await expect(db.registry.upsertAppEnv(providerEnvironment('acme', 'stage', { triggerRef: 'refs/heads/main' }))).rejects.toThrow()
		// Two manual-only envs coexist: the index is partial, so NULLs are skipped entirely.
		await db.registry.upsertAppEnv(providerEnvironment('acme', 'a'))
		await db.registry.upsertAppEnv(providerEnvironment('acme', 'b'))
	})

	test('app_secrets: the two LAYERS, their partial-index upserts, and the precedence ORDER BY', async () => {
		await reset()
		await db.registry.createApp({ id: 'acme', repoUrl: 'github.com/acme/app' })

		await db.registry.upsertAppSecret({ appId: 'acme', env: null, name: 'API_KEY', valueRef: 'vault:all' })
		await db.registry.upsertAppSecret({ appId: 'acme', env: 'prod', name: 'API_KEY', valueRef: 'vault:prod' })
		await db.registry.upsertAppSecret({ appId: 'acme', env: null, name: 'SHARED', valueRef: 'vault:shared' })

		// Each layer upserts against its OWN partial index — a re-put replaces rather than duplicating.
		const replaced = await db.registry.upsertAppSecret({ appId: 'acme', env: null, name: 'API_KEY', valueRef: 'vault:all2' })
		expect(replaced.value_ref).toBe('vault:all2')
		expect(await db.registry.listAppSecrets('acme')).toHaveLength(3)

		// THE ORDER IS THE FEATURE: the caller layers by last-write-wins, so the ALL-ENV row of a name must
		// come out BEFORE the env-specific one. Bare `ORDER BY name` left that to SQLite's rowid fallback,
		// and `ORDER BY name, env` inverts it on Postgres (NULLS LAST) — deploying the wrong secret value.
		const forProd = await db.registry.getAppSecretsForEnv('acme', 'prod')
		expect(forProd.map((s) => `${s.name}:${s.value_ref}`)).toEqual(['API_KEY:vault:all2', 'API_KEY:vault:prod', 'SHARED:vault:shared'])
		const resolved: Record<string, string> = {}
		for (const row of forProd) {
			resolved[row.name] = row.value_ref
		}
		expect(resolved['API_KEY']).toBe('vault:prod')

		// A different env sees only its own layer plus the all-env one.
		expect((await db.registry.getAppSecretsForEnv('acme', 'stage')).map((s) => s.value_ref)).toEqual(['vault:all2', 'vault:shared'])

		// Delete needs `IS NULL` for the all-env layer — a bound NULL never `= NULL`, on either engine.
		expect(await db.registry.deleteAppSecret('acme', 'prod', 'API_KEY')).toBe(true)
		expect(await db.registry.deleteAppSecret('acme', 'prod', 'API_KEY')).toBe(false)
		expect(await db.registry.deleteAppSecret('acme', null, 'API_KEY')).toBe(true)
		expect(await db.registry.deleteAppSecret('acme', null, 'API_KEY')).toBe(false)
		expect(await db.registry.listAppSecrets('acme')).toHaveLength(1)
	})

	test('app_vars: the same layering, in plaintext', async () => {
		await reset()
		await db.registry.createApp({ id: 'acme', repoUrl: 'github.com/acme/app' })
		await db.registry.upsertAppVar({ appId: 'acme', env: null, name: 'TEAM', value: 'acme' })
		await db.registry.upsertAppVar({ appId: 'acme', env: 'prod', name: 'TEAM', value: 'acme-prod' })
		await db.registry.upsertAppVar({ appId: 'acme', env: null, name: 'REGION', value: 'eu' })

		expect((await db.registry.getAppVarsForEnv('acme', 'prod')).map((v) => v.value)).toEqual(['eu', 'acme', 'acme-prod'])
		expect(await db.registry.listAppVars('acme')).toHaveLength(3)
		expect((await db.registry.upsertAppVar({ appId: 'acme', env: 'prod', name: 'TEAM', value: 'acme-prod-2' })).value).toBe('acme-prod-2')
		expect(await db.registry.deleteAppVar('acme', 'prod', 'TEAM')).toBe(true)
		expect(await db.registry.deleteAppVar('acme', null, 'REGION')).toBe(true)
		expect(await db.registry.listAppVars('acme')).toHaveLength(1)
	})

	test('approved access: prod is protected by default, a publication is a compare-and-swap, a parked run moves once', async () => {
		await reset()
		await db.registry.createApp({ id: 'acme', repoUrl: 'github.com/acme/app' })
		await db.registry.upsertAppEnv(providerEnvironment('acme', 'prod'))
		await db.registry.upsertAppEnv(providerEnvironment('acme', 'stage'))
		expect((await db.registry.getAppEnv('acme', 'prod'))?.protected).toBe(1)
		expect((await db.registry.getAppEnv('acme', 'stage'))?.protected).toBe(0)
		expect(await fixtureProtect(db.registry, new SqlDeployLocks(raw), { appId: 'acme', env: 'stage' }, true)).toMatchObject({
			protected: 1,
			protection_revision: 1,
			generation: 1,
		})
		// A put advances the generation; the stored flag stays.
		expect(await db.registry.upsertAppEnv(providerEnvironment('acme', 'stage'))).toMatchObject({ protected: 1, generation: 2 })
		// The flag and the counters outlive the row: a recreated environment starts with them.
		expect(await db.registry.deleteAppEnv('acme', 'stage')).toBe(true)
		expect(await db.registry.upsertAppEnv(providerEnvironment('acme', 'stage'))).toMatchObject({ protected: 1, generation: 3, protection_revision: 1 })

		const owned = fixtureRuns(db.runs, new SqlDeployLocks(raw))
		const snapshot = JSON.stringify({ version: 1, contract: null, migrations: [], checker: '0.0.0', artifact: null })
		const first = await db.runs.createRun({ id: uuidv7(), appId: 'acme', env: 'prod', ref: 'main', trigger: 'manual', actor: 'user:ada' })
		const second = await db.runs.createRun({ id: uuidv7(), appId: 'acme', env: 'prod', ref: 'main', trigger: 'manual', actor: 'user:ada' })
		expect(first.actor).toBe('user:ada')
		await owned.start(first.id, 'logs')
		const unpublished = { generation: 0, protectionRevision: 0 }
		expect(await owned.publish(first.id, unpublished, snapshot)).toBe(false)
		await owned.snapshot(first.id, snapshot)
		expect(await owned.publish(first.id, { ...unpublished, protectionRevision: 1 }, snapshot)).toBe(false)
		expect(await owned.publish(first.id, unpublished, snapshot)).toBe(true)
		expect(await owned.publish(first.id, unpublished, snapshot)).toBe(false)
		expect(await db.registry.getAppEnv('acme', 'prod')).toMatchObject({ published_run_id: first.id, published_snapshot_json: snapshot, generation: 1 })
		await owned.finish(first.id, 'succeeded', 0)

		await owned.start(second.id, 'logs')
		expect(await owned.park(second.id, '{"a":1}')).toBe(true)
		expect((await db.runs.listRunsAwaitingApproval(10)).map((row) => row.id)).toEqual([second.id])
		expect(await owned.approve(second.id, '{"b":2}', '{}')).toBe(false)
		expect(await owned.approve(second.id, '{"a":1}', '{"by":"ada"}')).toBe(true)
		expect(await db.runs.getRun(second.id)).toMatchObject({ status: 'pending', approval_json: '{"by":"ada"}' })
		expect(await owned.reject(second.id, '{"a":1}')).toBe(false)

		// Parked again, the run keeps the approval it held, which a refusal drops.
		await owned.start(second.id, 'logs')
		expect(await owned.park(second.id, '{"a":2}')).toBe(true)
		expect(await db.runs.getRun(second.id)).toMatchObject({ status: 'awaiting_approval', approval_json: '{"by":"ada"}' })
		expect(await owned.reject(second.id, '{"a":2}')).toBe(true)
		expect(await db.runs.getRun(second.id)).toMatchObject({ status: 'failed', approval_json: null })

		// A cancellation drops it too, but only from a run that waits again: an approved run keeps the approval it ran with.
		const third = await db.runs.createRun({ id: uuidv7(), appId: 'acme', env: 'prod', ref: 'main', trigger: 'manual', actor: 'user:ada' })
		await owned.start(third.id, 'logs')
		await owned.park(third.id, '{"c":1}')
		await owned.approve(third.id, '{"c":1}', '{"by":"ada"}')
		await owned.start(third.id, 'logs')
		await owned.park(third.id, '{"c":2}')
		await db.runs.requestRunCancellation(third.id)
		expect(await owned.finishCancellation(third.id, 'failed')).toBe(true)
		expect(await db.runs.getRun(third.id)).toMatchObject({ status: 'failed', approval_json: null })
		const fourth = await db.runs.createRun({ id: uuidv7(), appId: 'acme', env: 'prod', ref: 'main', trigger: 'manual', actor: 'user:ada' })
		await owned.start(fourth.id, 'logs')
		await owned.park(fourth.id, '{"d":1}')
		await owned.approve(fourth.id, '{"d":1}', '{"by":"ada"}')
		await db.runs.requestRunCancellation(fourth.id)
		expect(await owned.finishCancellation(fourth.id, 'failed')).toBe(true)
		expect(await db.runs.getRun(fourth.id)).toMatchObject({ status: 'failed', approval_json: '{"by":"ada"}' })
	})

	test('approved access: stale registry writes and a stale publication lose to a protection change', async () => {
		await reset()
		await protectionRaceScenario(db, new SqlDeployLocks(raw))
	})

	test('approved access: a refused conditional put keeps none of its namespace claims', async () => {
		await reset()
		await refusedClaimScenario(db)
	})

	const stage: AppEnvInput = { ...providerEnvironment('acme', 'stage') }

	/** Run `contend` on its own connection while `hold` waits to commit on another, then let `hold` commit. */
	async function interleaved<T>(hold: (held: ControlRepositories) => Promise<unknown>, contend: (contender: ControlRepositories) => Promise<T>) {
		if (postgresUrl === null || fixture === null) throw new Error('Postgres fixture is unavailable')
		const lanes = await interleaving(postgresUrl, fixture.schema)
		try {
			const held = hold(createControlRepositories(lanes.held))
			await lanes.heldReady()
			const contended = contend(createControlRepositories(lanes.contender))
			await lanes.contenderBlocked()
			await lanes.commit()
			await held
			return await Promise.allSettled([contended]).then(([outcome]) => outcome)
		} finally {
			await lanes.close()
		}
	}

	test('approved access: an app deletion waits for a protection change on its environment, and then refuses', async () => {
		await reset()
		await db.registry.createApp({ id: 'acme', repoUrl: 'github.com/acme/app' })
		const read = await db.registry.upsertAppEnv(stage, { absent: true })
		const outcome = await interleaved(
			(human) => fixtureProtect(human.registry, new SqlDeployLocks(raw), { appId: 'acme', env: 'stage' }, true),
			(service) => service.registry.deleteApp('acme', [{ env: 'stage', generation: read.generation }]),
		)
		expect(outcome?.status === 'rejected' ? outcome.reason : null).toBeInstanceOf(AppEnvChangedError)
		expect(await db.registry.getAppEnv('acme', 'stage')).toMatchObject({ protected: 1, protection_revision: 1 })
	})

	test('approved access: an environment deletion waits for a protection change, and then refuses', async () => {
		await reset()
		await db.registry.createApp({ id: 'acme', repoUrl: 'github.com/acme/app' })
		const read = await db.registry.upsertAppEnv(stage, { absent: true })
		const outcome = await interleaved(
			(human) => fixtureProtect(human.registry, new SqlDeployLocks(raw), { appId: 'acme', env: 'stage' }, true),
			(service) => service.registry.deleteAppEnv('acme', 'stage', read.generation),
		)
		expect(outcome?.status === 'rejected' ? outcome.reason : null).toBeInstanceOf(AppEnvChangedError)
		expect(await db.registry.getAppEnv('acme', 'stage')).toMatchObject({ protected: 1, protection_revision: 1 })
	})

	test('approved access: a recreation that waits for a deletion starts from what that deletion left', async () => {
		await reset()
		await db.registry.createApp({ id: 'acme', repoUrl: 'github.com/acme/app' })
		const first = await db.registry.upsertAppEnv(stage, { absent: true })
		expect(await db.registry.deleteAppEnv('acme', 'stage', first.generation)).toBe(true)
		const recreated = await db.registry.upsertAppEnv(stage, { absent: true })
		expect(recreated).toMatchObject({ protected: 0, generation: 1, protection_revision: 0 })
		const run = await db.runs.createRun({ id: uuidv7(), appId: 'acme', env: 'stage', ref: 'main', trigger: 'manual', actor: 'user:ada' })
		const protectedRow = await fixtureProtect(db.registry, new SqlDeployLocks(raw), { appId: 'acme', env: 'stage' }, true)
		expect(protectedRow).toMatchObject({ protected: 1, generation: 2, protection_revision: 1 })
		const owned = fixtureRuns(db.runs, new SqlDeployLocks(raw))
		await owned.start(run.id, 'logs')
		const snapshot = JSON.stringify({ version: 1, contract: null, migrations: [], checker: '0.0.0', artifact: null })
		await owned.snapshot(run.id, snapshot)

		const outcome = await interleaved(
			(service) => service.registry.deleteAppEnv('acme', 'stage', 2),
			(service) => service.registry.upsertAppEnv(stage, { absent: true }),
		)
		expect(outcome?.status).toBe('fulfilled')
		expect(await db.registry.getAppEnv('acme', 'stage')).toMatchObject({ protected: 1, generation: 3, protection_revision: 1 })
		expect(await owned.publish(run.id, { generation: recreated.generation, protectionRevision: recreated.protection_revision }, snapshot)).toBe(false)
	})

	test('runs: create, status-guarded transitions, keyset paging, and stale candidates', async () => {
		await reset()
		await db.registry.createApp({ id: 'acme', repoUrl: 'github.com/acme/app' })
		await db.registry.upsertAppEnv(providerEnvironment('acme', 'prod'))

		const first = await db.runs.createRun({ id: uuidv7(), appId: 'acme', env: 'prod', ref: 'refs/heads/main', trigger: 'webhook', actor: 'user:test' })
		expect(first.status).toBe('pending')
		const second = await db.runs.createRun({
			id: uuidv7(),
			appId: 'acme',
			env: 'stage',
			ref: 'refs/heads/dev',
			commitSha: 'abc',
			trigger: 'poll',
			actor: 'user:test',
		})

		expect((await db.runs.getRun(first.id))?.trigger).toBe('webhook')
		// UUIDv7 ids are monotonic (RFC 9562 §6.2 counter), so `ORDER BY id DESC` is chronological on a
		// TEXT comparison even for two runs minted inside the same millisecond — as these two are.
		expect((await db.runs.listRuns({ limit: 10 })).map((r) => r.id)).toEqual([second.id, first.id])
		expect((await db.runs.listRuns({ limit: 10, appId: 'acme', env: 'prod' })).map((r) => r.id)).toEqual([first.id])
		expect((await db.runs.listRuns({ limit: 10, before: second.id })).map((r) => r.id)).toEqual([first.id])
		expect(await db.runs.listRuns({ limit: 1 })).toHaveLength(1)

		const owned = fixtureRuns(db.runs, new SqlDeployLocks(raw))
		// pending → running only once: a redelivered queue message must be a no-op.
		expect(await owned.start(first.id, `runs/${first.id}/logs.ndjson`)).toBe(true)
		expect((await db.runs.listRuns({ statuses: ['running'], limit: 10 })).map((run) => run.id)).toEqual([first.id])
		expect((await db.runs.listRuns({ statuses: ['pending'], limit: 10 })).map((run) => run.id)).toEqual([second.id])
		expect(await owned.start(first.id, `runs/${first.id}/logs.ndjson`)).toBe(false)
		const running = await db.runs.getRun(first.id)
		expect(running?.status).toBe('running')
		expect(typeof running?.started_at).toBe('number')

		expect(await owned.commit(first.id, 'deadbeef')).toBe(true)
		expect((await db.runs.getRun(first.id))?.commit_sha).toBe('deadbeef')
		expect(await owned.externalId(first.id, 'harbor-operation-1', { phase: 'accepted', attempt: 1 })).toBe(true)
		expect((await db.runs.listInFlightRuns('harbor')).map((run) => run.id)).toEqual([first.id])
		const accepted = await db.runs.getRun(first.id)
		expect(accepted?.external_run_id).toBe('harbor-operation-1')
		expect(JSON.parse(accepted?.provider_state_json ?? '')).toEqual({ phase: 'accepted', attempt: 1 })
		expect(await owned.checkpoint(first.id, { phase: 'building', attempt: 1 })).toBe(true)
		expect(JSON.parse((await db.runs.getRun(first.id))?.provider_state_json ?? '')).toEqual({ phase: 'building', attempt: 1 })

		// The terminal write is guarded too: a terminal row never moves again.
		expect(await owned.finish(first.id, 'succeeded', 0)).toBe(true)
		expect(await owned.finish(first.id, 'failed', 1)).toBe(false)
		const done = await db.runs.getRun(first.id)
		expect(done?.status).toBe('succeeded')
		expect(done?.exit_code).toBe(0)
		expect(await owned.checkpoint(first.id, { phase: 'late' })).toBe(false)

		const cancelled = await db.runs.createRun({ id: uuidv7(), appId: 'acme', env: 'prod', ref: 'main', trigger: 'manual', actor: 'user:test' })
		await owned.start(cancelled.id, `runs/${cancelled.id}/logs.ndjson`)
		await owned.externalId(cancelled.id, 'operation-2', { phase: 'uploaded' })
		const cancellation = await db.runs.requestRunCancellation(cancelled.id)
		expect(typeof cancellation?.cancel_requested_at).toBe('number')
		expect(cancellation?.external_run_id).toBe('operation-2')
		expect(await owned.finish(cancelled.id, 'succeeded', 0)).toBe(false)
		expect(await owned.finishCancellation(cancelled.id, 'failed')).toBe(true)
		expect((await db.runs.getRun(cancelled.id))?.status).toBe('failed')

		// Candidate discovery leaves settlement to the invocation that acquires the lease.
		expect(await db.runs.listStaleRuns(3600)).toHaveLength(0)
		expect((await db.runs.listStaleRuns(-1)).map((run) => run.id)).toEqual([second.id])
		expect((await db.runs.getRun(second.id))?.status).toBe('pending')
	})

	test('runs: only a newer succeeded run of the same environment supersedes a pending one', async () => {
		await reset()
		await db.registry.createApp({ id: 'acme', repoUrl: 'github.com/acme/app' })
		await db.registry.upsertAppEnv(providerEnvironment('acme', 'prod'))
		const owned = fixtureRuns(db.runs, new SqlDeployLocks(raw))
		const create = (env: string) => db.runs.createRun({ id: uuidv7(), appId: 'acme', env, ref: 'refs/heads/main', trigger: 'webhook', actor: 'poll' })
		const older = await create('prod')
		const otherEnv = await create('stage')
		await owned.finish(otherEnv.id, 'succeeded', 0)
		const failed = await create('prod')
		await owned.finish(failed.id, 'failed', 1)

		expect(await db.runs.getSupersedingRun(older.id)).toBeNull()
		// Neither a succeeded run of another environment nor a newer run that failed supersedes it.
		expect(await owned.supersede(older.id, otherEnv.id)).toBe(false)
		expect(await owned.supersede(older.id, failed.id)).toBe(false)
		const newer = await create('prod')
		await owned.start(newer.id)
		await owned.finish(newer.id, 'succeeded', 0)

		expect((await db.runs.getSupersedingRun(older.id))?.id).toBe(newer.id)
		expect(await db.runs.getSupersedingRun(newer.id)).toBeNull()
		expect(await owned.start(older.id)).toBe(false)
		expect(await owned.supersede(older.id, newer.id)).toBe(true)
		const superseded = await db.runs.getRun(older.id)
		expect(superseded?.status).toBe('failed')
		expect(superseded?.superseded_by).toBe(newer.id)
		expect(typeof superseded?.finished_at).toBe('number')
		expect(await owned.supersede(older.id, newer.id)).toBe(false)
	})

	test('repo poll state: the join that selects pollable envs, and the upsert', async () => {
		await reset()
		// PUBLIC (no installation id) + a trigger ref → pollable. The other three combinations are not.
		await db.registry.createApp({ id: 'public-app', repoUrl: 'github.com/acme/public' })
		await db.registry.upsertAppEnv(providerEnvironment('public-app', 'prod', { triggerRef: 'refs/heads/main' }))
		await db.registry.upsertAppEnv(providerEnvironment('public-app', 'manual'))
		await db.registry.createApp({ id: 'private-app', repoUrl: 'github.com/acme/private', githubInstallationId: 99 })
		await db.registry.upsertAppEnv(providerEnvironment('private-app', 'prod', { triggerRef: 'refs/heads/main' }))

		const eligible = await db.polling.getPollEligibleEnvs()
		expect(eligible.map((e) => `${e.app.id}:${e.appEnv.env}`)).toEqual(['public-app:prod'])
		// The prefixed join columns are unpacked into two real row shapes, types intact.
		expect(eligible[0]?.app.github_installation_id).toBeNull()
		expect(typeof eligible[0]?.appEnv.created_at).toBe('number')

		expect(await db.polling.getRepoPollState('public-app', 'prod')).toBeNull()
		const stamped = now()
		await db.polling.upsertRepoPollState({ appId: 'public-app', env: 'prod', etag: 'W/"1"', lastSeenSha: 'aaa', lastPolledAt: stamped })
		const updated = await db.polling.upsertRepoPollState({
			appId: 'public-app',
			env: 'prod',
			etag: 'W/"2"',
			lastSeenSha: 'bbb',
			lastPolledAt: stamped + 5,
			lastError: 'feed HTTP 500',
		})
		expect(updated.etag).toBe('W/"2"')
		expect(updated.last_seen_sha).toBe('bbb')
		expect(updated.last_polled_at).toBe(stamped + 5)
		expect(updated.last_error).toBe('feed HTTP 500')
		expect((await db.polling.getRepoPollState('public-app', 'prod'))?.last_seen_sha).toBe('bbb')
	})

	test('operations catalog: a reconcile is recorded only while its writer holds the catalog lease', async () => {
		await reset()
		await db.registry.createApp({ id: 'acme', repoUrl: 'github.com/acme/app' })
		await db.registry.upsertAppEnv(providerEnvironment('acme', 'prod'))
		await db.operationsCatalog.markDirty()
		const snapshot = await db.operationsCatalog.snapshot()
		const [source] = snapshot.sources
		if (source === undefined) throw new Error('expected one catalog source')
		const config = {
			appId: 'acme',
			environment: 'prod',
			serviceKey: source.service_key,
			credentialId: source.credential_id,
			ingestProjectId: '100000000000000001',
			dsn: `https://${source.public_key}@errors.example.test/100000000000000001`,
		}
		const locks = new SqlDeployLocks(raw)
		expect(await locks.acquire(CATALOG_LEASE_KEY, 'live-holder', LEASE_TTL_MS)).toBe(true)
		try {
			const stale = { holder: 'stale-holder', nowMs: Date.now() }
			expect(await db.operationsCatalog.markApplied(snapshot.revision, 'snapshot-hash', [config], stale)).toBe(false)
			expect(await db.operationsCatalog.getActiveIngestConfig('acme', 'prod')).toBeNull()

			const live = { holder: 'live-holder', nowMs: Date.now() }
			expect(await db.operationsCatalog.markApplied(snapshot.revision, 'snapshot-hash', [config], live)).toBe(true)
			expect((await db.operationsCatalog.getActiveIngestConfig('acme', 'prod'))?.dsn).toBe(config.dsn)
			expect((await db.operationsCatalog.getState()).appliedRevision).toBe(snapshot.revision)
		} finally {
			await locks.release(CATALOG_LEASE_KEY, 'live-holder')
		}
	})
})

describe.skipIf(!hasPostgres)('src/vault.ts — envelope encryption, unmodified, on Postgres', () => {
	test('put, read back, rotate, delete — and nothing plaintext is ever stored', async () => {
		await reset()
		const vault = await Vault.create(raw, kek())

		const ref = await vault.putSecret('app-env', 'app:acme/prod/API_KEY', 'super-secret-value')
		expect(ref.startsWith('vault:')).toBe(true)
		expect(await vault.getSecret(ref)).toBe('super-secret-value')

		const row = await raw.prepare('SELECT * FROM vault').first<Record<string, unknown>>()
		expect(JSON.stringify(row)).not.toContain('super-secret-value')
		expect(typeof row?.['created_at']).toBe('number')
		expect(row?.['rotated_at']).toBeNull()

		await vault.rotate(ref, 'rotated-value')
		expect(await vault.getSecret(ref)).toBe('rotated-value')
		expect(typeof (await raw.prepare('SELECT * FROM vault').first<Record<string, unknown>>())?.['rotated_at']).toBe('number')

		expect(await vault.delete(ref)).toBe(true)
		expect(await vault.delete(ref)).toBe(false)
		await expect(vault.getSecret(ref)).rejects.toThrow()
	})

	test('the scope CHECK admits app and platform scopes, but no retired global scope', async () => {
		await reset()
		const vault = await Vault.create(raw, kek())
		await vault.putSecret('app', 'app:acme/API_KEY', 'v')
		await vault.putSecret('platform', 'platform:github-source:a:webhook', 'hook')
		await expect(
			raw.prepare('INSERT INTO vault (id, scope, label, ciphertext, value_iv, wrapped_dek, dek_iv) VALUES (?, ?, ?, ?, ?, ?, ?)')
				.bind(uuidv7(), 'global', null, 'c', 'i', 'w', 'd')
				.run(),
		).rejects.toThrow()
	})

	test('a MASTER-KEY rotation re-wraps every DEK without touching a value', async () => {
		await reset()
		const oldKek = kek()
		const newKek = kek()
		const vault = await Vault.create(raw, oldKek)
		const a = await vault.putSecret('app', 'a', 'value-a')
		const b = await vault.putSecret('app-env', 'b', 'value-b')

		expect(await vault.reencryptAll(newKek)).toBe(2)
		// The OLD key can no longer open them; the new one can, and the values are unchanged.
		await expect(vault.getSecret(a)).rejects.toThrow()
		const rotated = await Vault.create(raw, newKek)
		expect(await rotated.getSecret(a)).toBe('value-a')
		expect(await rotated.getSecret(b)).toBe('value-b')
	})
})

describe.skipIf(!hasPostgres)('GitHub source connection persistence on Postgres', () => {
	test('uses the same callback CAS and atomic platform-secret checkpoint', async () => {
		await reset()
		const vault = await Vault.create(raw, kek())
		const attemptId = uuidv7()
		const manifestState = await vault.prepareSecret('platform', githubManifestStateSecretLabel(attemptId), 'opaque-state')
		const started = await db.githubConnections.beginAttemptWithManifestState({
			id: attemptId,
			stateHash: 'a'.repeat(64),
			initiatedBy: 'principal-1',
			expectedOrigin: 'https://control.example',
			desiredOwner: 'acme',
			desiredAppName: 'fabrika-source',
			desiredPublic: false,
			requestedRepositories: ['acme/app'],
			expiresAt: now() + 60,
		}, manifestState)
		const claimed = await db.githubConnections.claimCallback('a'.repeat(64), 'principal-1')
		if (claimed === null) throw new Error('callback claim failed')
		const credential = await vault.prepareSecret('platform', githubAppCredentialSecretLabel(started.id), 'app-credential')
		const stored = await db.githubConnections.storeSecretAndCheckpoint(
			started.id,
			claimed.version,
			'exchange_claimed',
			'credential_stored',
			'app-credential',
			credential,
		)
		expect(stored?.phase).toBe('credential_stored')
		expect(await vault.getSecretForPurpose(credential.ref, { scope: 'platform', label: githubAppCredentialSecretLabel(started.id) })).toBe(
			'app-credential',
		)
		expect(await db.githubConnections.claimCallback('a'.repeat(64), 'principal-1')).toBeNull()
	})

	test('two real connections have exactly one atomic secret-checkpoint CAS winner', async () => {
		await reset()
		if (postgresUrl === null || fixture === null) throw new Error('Postgres fixture is unavailable')
		const secondRaw = PostgresDatabase.connect(postgresUrl, { connection: { search_path: fixture.schema }, max: 1 })
		try {
			const masterKey = kek()
			const vault = await Vault.create(raw, masterKey)
			const attemptId = uuidv7()
			const manifestState = await vault.prepareSecret('platform', githubManifestStateSecretLabel(attemptId), 'opaque-state')
			const started = await db.githubConnections.beginAttemptWithManifestState({
				id: attemptId,
				stateHash: 'b'.repeat(64),
				initiatedBy: 'principal-1',
				expectedOrigin: 'https://control.example',
				desiredOwner: 'acme',
				desiredAppName: 'fabrika-source',
				desiredPublic: false,
				requestedRepositories: [],
				expiresAt: now() + 60,
			}, manifestState)
			const claimed = await db.githubConnections.claimCallback('b'.repeat(64), 'principal-1')
			if (claimed === null) throw new Error('callback claim failed')
			const first = await vault.prepareSecret('platform', githubAppCredentialSecretLabel(started.id), 'first')
			const second = await vault.prepareSecret('platform', githubAppCredentialSecretLabel(started.id), 'second')
			const barrier = new TwoConnectionBarrier()
			const left = new GitHubConnectionStore(new PostgresBarrierDatabase(raw, barrier))
			const right = new GitHubConnectionStore(new PostgresBarrierDatabase(secondRaw, barrier))
			const outcomes = await Promise.allSettled([
				left.storeSecretAndCheckpoint(started.id, claimed.version, 'exchange_claimed', 'credential_stored', 'app-credential', first),
				right.storeSecretAndCheckpoint(started.id, claimed.version, 'exchange_claimed', 'credential_stored', 'app-credential', second),
			])
			expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
			expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
			expect((await raw.prepare('SELECT COUNT(*)::int AS count FROM vault').first<{ count: number }>())?.count).toBe(1)
			expect((await db.githubConnections.getAttempt(started.id))?.phase).toBe('credential_stored')
		} finally {
			await secondRaw.close()
		}
	})

	test('two real connections have exactly one atomic connection-publish CAS winner', async () => {
		await reset()
		if (postgresUrl === null || fixture === null) throw new Error('Postgres fixture is unavailable')
		const secondRaw = PostgresDatabase.connect(postgresUrl, { connection: { search_path: fixture.schema }, max: 1 })
		try {
			const vault = await Vault.create(raw, kek())
			const store = db.githubConnections
			const attemptId = uuidv7()
			const manifestState = await vault.prepareSecret('platform', githubManifestStateSecretLabel(attemptId), 'opaque-state')
			const started = await store.beginAttemptWithManifestState({
				id: attemptId,
				stateHash: 'c'.repeat(64),
				initiatedBy: 'principal-1',
				expectedOrigin: 'https://control.example',
				desiredOwner: 'acme',
				desiredAppName: 'fabrika-source',
				desiredPublic: false,
				requestedRepositories: ['acme/app'],
				expiresAt: now() + 60,
			}, manifestState)
			const claimed = await store.claimCallback('c'.repeat(64), 'principal-1')
			if (claimed === null) throw new Error('callback claim failed')
			const credential = await vault.prepareSecret('platform', githubAppCredentialSecretLabel(started.id), 'app-credential')
			const stored = await store.storeSecretAndCheckpoint(
				started.id,
				claimed.version,
				'exchange_claimed',
				'credential_stored',
				'app-credential',
				credential,
			)
			if (stored === null) throw new Error('credential checkpoint failed')
			const verified = await store.checkpoint(started.id, stored.version, 'credential_stored', 'app_verified', {
				appId: '123',
				appSlug: 'fabrika-source',
				appHtmlUrl: 'https://github.com/apps/fabrika-source',
			})
			if (verified === null) throw new Error('App verification checkpoint failed')
			const webhook = await vault.prepareSecret('platform', githubWebhookSecretLabel(started.id), 'webhook')
			const webhookStored = await store.storeSecretAndCheckpoint(
				started.id,
				verified.version,
				'app_verified',
				'webhook_secret_stored',
				'webhook',
				webhook,
			)
			if (webhookStored === null) throw new Error('webhook checkpoint failed')
			const webhookConfigured = await store.checkpoint(started.id, webhookStored.version, 'webhook_secret_stored', 'webhook_configured')
			if (webhookConfigured === null) throw new Error('webhook config checkpoint failed')
			const ready = await store.checkpoint(started.id, webhookConfigured.version, 'webhook_configured', 'installation_required')
			if (ready === null) throw new Error('installation checkpoint failed')

			const barrier = new TwoConnectionBarrier()
			const left = new GitHubConnectionStore(new PostgresBarrierDatabase(raw, barrier))
			const right = new GitHubConnectionStore(new PostgresBarrierDatabase(secondRaw, barrier))
			const input: PublishGitHubConnectionInput = {
				attemptId: started.id,
				expectedVersion: ready.version,
				webhookUrl: `https://control.example/webhooks/github/${started.id}`,
				installationId: 45,
				installationAccountLogin: 'acme',
				installationSelection: 'selected',
				verifiedRepositories: ['acme/app'],
				verifiedAt: now(),
			}
			const outcomes = await Promise.allSettled([left.publishConnection(input), right.publishConnection(input)])
			expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
			expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
			expect(
				await raw.prepare('SELECT app_credential_ref FROM github_source_connections_keyed WHERE connection_id = ?')
					.bind(started.id)
					.first<{ app_credential_ref: string }>(),
			).toEqual({ app_credential_ref: credential.ref })
			expect((await store.getAttempt(started.id))?.status).toBe('completed')
		} finally {
			await secondRaw.close()
		}
	})
})

describe.skipIf(!hasPostgres)('the deploy queue, as a table', () => {
	test('a message survives send → claim → handler → ack, and the payload round-trips', async () => {
		await reset()
		await db.registry.createApp({ id: 'acme', repoUrl: 'github.com/acme/app' })
		await db.registry.upsertAppEnv(providerEnvironment('acme', 'prod'))
		const run = await db.runs.createRun({ id: uuidv7(), appId: 'acme', env: 'prod', ref: 'refs/heads/main', trigger: 'manual', actor: 'user:test' })

		const queue = new PostgresJobQueue<DeployJobMessage>(raw, { queue: 'vozka-deploy' })
		await queue.send({ runId: run.id })

		const claimed = await queue.claim({ limit: 5, visibilityTimeoutMs: 60_000, decode: (p) => decode(p) })
		expect(claimed).toHaveLength(1)
		expect(claimed[0]?.payload.runId).toBe(run.id)
		// int4, so the attempt counters decode as numbers rather than strings.
		expect(claimed[0]?.attempts).toBe(1)
		expect(claimed[0]?.maxAttempts).toBe(5)

		await queue.ack(claimed[0]?.id ?? '')
		expect(await queue.claim({ limit: 5, visibilityTimeoutMs: 60_000, decode: (p) => decode(p) })).toHaveLength(0)
	})

	test('a provider failure is recorded instead of leaving the run pending', async () => {
		await reset()
		await db.registry.createApp({ id: 'acme', repoUrl: 'github.com/acme/app' })
		await db.registry.upsertAppEnv(providerEnvironment('acme', 'prod'))
		const run = await db.runs.createRun({ id: uuidv7(), appId: 'acme', env: 'prod', ref: 'refs/heads/main', trigger: 'manual', actor: 'user:test' })

		const failingProvider = {
			...fakeControlProvider,
			deploy: () => Promise.reject(new Error('provider unavailable')),
		}
		const result = await runDeployJob(env(), failingProvider, { runId: run.id })
		expect(result.status).toBe('failed')
		const after = await db.runs.getRun(run.id)
		expect(after?.status).toBe('failed')
		expect(after?.exit_code).toBeNull()
		// The lock was taken and released, so the next trigger for this target is not wedged.
		expect(await new SqlDeployLocks(raw).acquire('acme:prod', 'next-run', 60_000)).toBe(true)
	})

	test('a CONTENDED run is deferred and re-enqueued, never double-run', async () => {
		await reset()
		await db.registry.createApp({ id: 'acme', repoUrl: 'github.com/acme/app' })
		await db.registry.upsertAppEnv(providerEnvironment('acme', 'prod'))
		const run = await db.runs.createRun({ id: uuidv7(), appId: 'acme', env: 'prod', ref: 'refs/heads/main', trigger: 'manual', actor: 'user:test' })
		// Somebody else holds the app-env lease.
		await new SqlDeployLocks(raw).acquire('acme:prod', 'other-run', 60_000)

		const assembled = env()
		expect((await runDeployJob(assembled, fakeControlProvider, { runId: run.id })).status).toBe('deferred')

		// Left pending, and a FRESH message is waiting (delayed) rather than a retry being consumed.
		expect((await db.runs.getRun(run.id))?.status).toBe('pending')
		const { results } = await raw.prepare('SELECT attempts FROM jobs').all<{ attempts: number }>()
		expect(results).toHaveLength(1)
		expect(results[0]?.attempts).toBe(0)
	})
})

describe.skipIf(!hasPostgres)('the Bun entrypoint, end to end on Postgres', () => {
	test('serves liveness, the API and the SPA fallback from one handler', async () => {
		await reset()
		await db.registry.createApp({ id: 'acme', repoUrl: 'github.com/acme/app' })
		const served = createFetchHandler(env(), fakeControlProvider, unusedSourceConnection('harbor'))
		const handler = (request: Request) => served(proxiedRequest(request))

		// The process-level liveness route is claimed before the SPA fallback.
		expect((await handler(new Request('http://localhost:18291/healthz'))).status).toBe(200)
		// …and the Worker's own health route, unchanged, so one monitor works on both platforms.
		expect((await handler(new Request('http://localhost:18291/api/health'))).status).toBe(200)

		// The real ACL-gated control surface, against the real database. The admin token stands in for
		// what the proxy injects, so this exercises the routing rather than the auth.
		const apps: unknown = await (await handler(
			new Request('http://localhost:18291/api/rpc', {
				method: 'POST',
				headers: { [PROXY_TOKEN_HEADER]: adminToken, authorization: 'Bearer px_test_reader', 'content-type': 'application/json' },
				body: JSON.stringify({ method: 'apps.list', input: null }),
			}),
		)).json()
		expect(JSON.stringify(apps)).toContain('acme')

		// Anything unrouted is the SPA — the `ASSETS` binding's replacement.
		expect(await (await handler(new Request('http://localhost:18291/apps/acme'))).text()).toContain('spa')
	})

	test('an unhandled throw answers an opaque 500, not Bun default error page', async () => {
		// Bun's default error page embeds the exception message AND the surrounding source lines in the
		// response body. The Workers runtime does not, so this is the one place the two entrypoints would
		// have differed in what they show an attacker. Reproduced with an ASSETS port that throws.
		const served = createFetchHandler(
			{
				...env(),
				ASSETS: {
					fetch: () => {
						throw new Error('assets exploded with CLOUDFLARE_API_TOKEN=looks-like-a-secret')
					},
				},
			},
			fakeControlProvider,
			unusedSourceConnection('harbor'),
		)
		const response = await served(proxiedRequest(new Request('http://localhost:18291/anything')))
		expect(response.status).toBe(500)
		const text = await response.text()
		expect(text).toBe('internal error')
		expect(text).not.toContain('looks-like-a-secret')
	})

	test('the maintenance pass polls, enqueues and sweeps against the real schema', async () => {
		await reset()
		await db.registry.createApp({ id: 'acme', repoUrl: 'github.com/acme/app' })
		await db.registry.upsertAppEnv(providerEnvironment('acme', 'prod', { triggerRef: 'refs/heads/main' }))
		const stale = await db.runs.createRun({ id: uuidv7(), appId: 'acme', env: 'prod', ref: 'refs/heads/main', trigger: 'manual', actor: 'user:test' })
		await raw.prepare('UPDATE runs SET created_at = ? WHERE id = ?').bind(now() - 86_400, stale.id).run()

		// A one-entry Atom feed with a new head sha, served locally — no test in this repo reaches github.com.
		const feed = `<feed><entry><id>tag:github.com,2008:Grit::Commit/${'a'.repeat(40)}</id></entry></feed>`
		const summary = await runMaintenance(env(), {
			now,
			fetch: () => Promise.resolve(new Response(feed, { status: 200, headers: { etag: 'W/"1"' } })),
		})

		expect(summary.poll).toEqual({ polled: 1, triggered: 1, unchanged: 0, errored: 0, skipped: 0 })
		expect(summary.swept).toBe(1)
		// The sweep reaped the aged run; the poll created a fresh one and enqueued it into `jobs`.
		expect((await db.runs.getRun(stale.id))?.status).toBe('failed')
		expect((await db.runs.listRuns({ limit: 10, appId: 'acme' })).filter((r) => r.trigger === 'poll')).toHaveLength(1)
		expect((await raw.prepare('SELECT count(*)::int AS n FROM jobs').first<{ n: number }>())?.n).toBe(1)
		expect((await db.polling.getRepoPollState('acme', 'prod'))?.last_seen_sha).toBe('a'.repeat(40))
	})

	test('maintenance repairs a clean swept release through the production dependency wiring', async () => {
		await reset()
		await db.registry.createApp({ id: 'acme', repoUrl: 'github.com/acme/app' })
		await db.registry.upsertAppEnv(providerEnvironment('acme', 'prod'))
		const stale = await db.runs.createRun({ id: uuidv7(), appId: 'acme', env: 'prod', ref: 'main', trigger: 'manual', actor: 'user:test' })
		await raw.prepare('UPDATE runs SET created_at = ? WHERE id = ?').bind(now() - 86_400, stale.id).run()
		await db.operationsReleases.project(
			stale.id,
			JSON.stringify({
				runId: stale.id,
				coordinate: { appId: 'acme', environment: 'prod' },
				phase: 'started',
				providerRunId: null,
				outcome: null,
				artifactState: 'not_applicable',
				release: { kind: 'unavailable', reason: 'missing_commit' },
				observedAt: (now() - 86_400) * 1000,
			}),
		)
		await db.operationsReleases.markApplied(stale.id, 1)
		const absent = await db.runs.createRun({ id: uuidv7(), appId: 'acme', env: 'prod', ref: 'main', trigger: 'manual', actor: 'user:test' })
		await fixtureRuns(db.runs, new SqlDeployLocks(raw)).finish(absent.id, 'succeeded', 0)
		const requests: OperationsReleaseReconcileRequest[] = []
		const summary = await runMaintenance({
			...env(),
			OPERATIONS_SYNC_KEY: 'maintenance-release-key-with-at-least-32-bytes',
			OPERATIONS: {
				async fetch(request) {
					const decoded: unknown = await request.json()
					const payload = parseOperationsReleaseRequest(decoded)
					requests.push(payload)
					return Response.json({ revision: payload.revision, outcome: 'applied' })
				},
			},
		}, { operations: async () => ({ outcome: 'disabled', revision: null }) })
		expect(summary.swept).toBe(1)
		expect(summary.releases).toEqual({ applied: 1, failed: 0, pending: 0 })
		expect(requests).toHaveLength(1)
		expect(requests[0]).toMatchObject({ runId: stale.id, phase: 'terminal', outcome: 'failed', revision: 2 })
		expect(await db.operationsReleases.get(absent.id)).toBeNull()
	})
})

/** Narrow a queue payload without a cast (the consumer's own decoder, restated for the claim call). */
function decode(payload: unknown): DeployJobMessage {
	const runId: unknown = payload === null || typeof payload !== 'object' ? undefined : Reflect.get(payload, 'runId')
	if (typeof runId !== 'string') {
		throw new Error('bad payload')
	}
	return { runId }
}

/**
 * The `Env` `bun/runtime.ts` would assemble from `process.env`, built by hand so it binds the
 * SCHEMA-SCOPED pool this fixture owns instead of opening a second one. Everything else — the routing,
 * the consumer, the maintenance pass — is exactly what runs in production.
 *
 * The IAM binding is the suite's JWKS stub. Provider selection is injected separately.
 */
function env(): Env {
	const blobs = new Map<string, string>()
	const logs: BlobStore = {
		put(key, value) {
			blobs.set(key, typeof value === 'string' ? value : '')
			return Promise.resolve()
		},
		get(key) {
			const found = blobs.get(key)
			return Promise.resolve(found === undefined ? null : { body: new Response(found).body ?? new ReadableStream(), text: () => Promise.resolve(found) })
		},
		delete(key) {
			blobs.delete(key)
			return Promise.resolve()
		},
	}
	return {
		DB: raw,
		REPOSITORIES: db,
		ASSETS: { fetch: () => Promise.resolve(new Response('<!doctype html>spa', { headers: { 'content-type': 'text/html' } })) },
		RUN_LOGS: logs,
		DEPLOY_QUEUE: new PostgresJobQueue<DeployJobMessage>(raw, { queue: 'vozka-deploy' }),
		WAIT_UNTIL: () => {},
		ENVIRONMENT: 'local',
		...testIamEnv,
		// No feed fetch happens in these tests (the poller needs a resolvable feed), so the maintenance
		// pass exercises the QUERIES; the poll logic itself is covered by repo-poll.test.ts.
	}
}
