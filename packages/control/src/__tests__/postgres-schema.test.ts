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

import { type BlobStore, SqlDeployLocks } from '@fabrika/platform'
import { type PostgresDatabase, PostgresJobQueue } from '@fabrika/platform-node'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { runDeployJob } from '../consumer'
import { runMaintenance } from '../cron'
import { Db, uuidv7 } from '../db'
import type { Env } from '../env'
import { applyMigrations } from '../node/migrate'
import { createFetchHandler } from '../node/server'
import type { DeployJobMessage } from '../run-lifecycle'
import { startRun } from '../services'
import { Vault } from '../vault'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

if (!hasPostgres) {
	console.warn(`postgres-schema.test.ts ${skipReason}`)
}

let fixture: PostgresFixture | null = null
let raw: PostgresDatabase
let db: Db

beforeAll(async () => {
	if (!hasPostgres) {
		return
	}
	fixture = await createPostgres('vozka')
	raw = fixture.db
	db = new Db(raw)
})

afterAll(async () => {
	await fixture?.close()
})

/** Remove everything a test may have written. `apps` cascades to envs/secrets/vars/runs/poll state. */
async function reset(): Promise<void> {
	for (const table of ['jobs', 'deploy_locks', 'runs', 'repo_poll_state', 'app_vars', 'app_secrets', 'app_envs', 'apps', 'vault']) {
		await raw.prepare(`DELETE FROM ${table}`).run()
	}
}

function now(): number {
	return Math.floor(Date.now() / 1000)
}

const providerEnvironment = (
	appId: string,
	env: string,
	options: { domain?: string | null; triggerRef?: string | null } = {},
) => ({
	appId,
	env,
	...options,
	provider: 'harbor',
	providerTargetJson: JSON.stringify({ provider: 'harbor', version: 1, payload: { region: 'eu' } }),
	providerArtifactJson: JSON.stringify({ provider: 'harbor', version: 1, payload: { image: 'app:v1' } }),
})

/** A 32-byte base64 KEK, generated per call — never a fixed key, not even in a test. */
function kek(): string {
	return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
}

describe.skipIf(!hasPostgres)('migrations-postgres — the runner', () => {
	test('applies every shipped file and is a no-op on the second run', async () => {
		// The fixture already applied them once. `run.initCommands` re-runs this on EVERY container start,
		// so "already current" must be the normal, silent outcome and not an error.
		expect(await applyMigrations(raw)).toEqual([])
		const { results } = await raw.prepare('SELECT name FROM schema_migrations ORDER BY name').all<{ name: string }>()
		expect(results.map((r) => r.name)).toEqual([
			'0001_init.sql',
			'0002_jobs.sql',
			'0003_zerops_targets.sql',
			'0004_provider_envelopes.sql',
		])
	})

	test('creates exactly the tables the service reads/writes, and none of the retired ones', async () => {
		const { results } = await raw
			.prepare(`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ?`)
			.bind(fixture?.schema ?? '')
			.all<{ name: string }>()
		const names = results.map((r) => r.name)
		for (const table of ['apps', 'app_envs', 'app_secrets', 'app_vars', 'runs', 'repo_poll_state', 'vault', 'deploy_locks', 'jobs']) {
			expect(names).toContain(table)
		}
		// Retired by migrations/0003 — this set never creates it in the first place.
		expect(names).not.toContain('accounts')
	})
})

describe.skipIf(!hasPostgres)('the Postgres schema — column types the row shapes depend on', () => {
	test('every seconds-valued and count column is int4, so it decodes as a JS number', async () => {
		// The rule from the migration header: a column a row shape types `number` must be INTEGER, because
		// Bun decodes int8/numeric as a STRING by column OID. This asserts the schema side.
		const { results } = await raw
			.prepare(`SELECT table_name, column_name, data_type FROM information_schema.columns
				WHERE table_schema = ?
				  AND column_name IN ('created_at','started_at','finished_at','last_polled_at','rotated_at','exit_code','github_installation_id')
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
		const app = await db.createApp({ id: 'stamped', repoUrl: 'https://github.com/acme/app.git' })
		expect(typeof app.created_at).toBe('number')
		expect(app.created_at).toBeGreaterThanOrEqual(before)
		expect(app.created_at).toBeLessThanOrEqual(now() + 1)

		const run = await db.createRun({ id: uuidv7(), appId: app.id, env: 'prod', ref: 'refs/heads/main', trigger: 'manual' })
		expect(typeof run.created_at).toBe('number')
		expect(run.started_at).toBeNull()
	})
})

describe.skipIf(!hasPostgres)('src/db.ts — the whole query surface, unmodified, on Postgres', () => {
	test('apps: create, read, list, lookup by repo, partial update, delete', async () => {
		await reset()
		const created = await db.createApp({
			id: 'acme',
			repoUrl: 'github.com/acme/app',
			defaultBranch: 'trunk',
			workerDir: 'apps/web',
			githubInstallationId: 4242,
		})
		expect(created.default_branch).toBe('trunk')
		// int4, so it comes back as a number rather than a string.
		expect(created.github_installation_id).toBe(4242)
		expect(created.build_cmd).toBeNull()

		expect((await db.getApp('acme'))?.worker_dir).toBe('apps/web')
		expect(await db.getApp('nope')).toBeNull()
		expect((await db.getAppsByRepoUrl('github.com/acme/app')).map((a) => a.id)).toEqual(['acme'])
		expect(await db.getAppsByRepoUrl('github.com/other/app')).toHaveLength(0)

		await db.createApp({ id: 'beta', repoUrl: 'github.com/acme/beta' })
		expect((await db.listApps()).map((a) => a.id)).toEqual(['acme', 'beta'])

		// The COALESCE partial update: a bound NULL leaves the column alone. Postgres type-checks bind
		// parameters, so this is the statement most likely to break on the port — it does not.
		const updated = await db.updateApp('acme', { buildCmd: 'bun run build' })
		expect(updated?.build_cmd).toBe('bun run build')
		expect(updated?.default_branch).toBe('trunk')
		expect(updated?.worker_dir).toBe('apps/web')
		expect(await db.updateApp('missing', { buildCmd: 'x' })).toBeNull()

		expect(await db.deleteApp('beta')).toBe(true)
		expect(await db.deleteApp('beta')).toBe(false)
	})

	test('app_envs: upsert, exact + glob trigger lookup, cascade on app delete', async () => {
		await reset()
		await db.createApp({ id: 'acme', repoUrl: 'github.com/acme/app' })

		const prod = await db.upsertAppEnv(providerEnvironment('acme', 'prod', { domain: 'acme.example', triggerRef: 'refs/heads/main' }))
		expect(prod.domain).toBe('acme.example')
		expect(prod.provider).toBe('harbor')
		expect(JSON.parse(prod.provider_target_json)).toEqual({ provider: 'harbor', version: 1, payload: { region: 'eu' } })
		// ON CONFLICT (app_id, env) DO UPDATE — the upsert path and its RETURNING row.
		const again = await db.upsertAppEnv(providerEnvironment('acme', 'prod', { domain: 'acme2.example', triggerRef: 'refs/tags/v*' }))
		expect(again.domain).toBe('acme2.example')
		expect(again.trigger_ref).toBe('refs/tags/v*')

		await db.upsertAppEnv(providerEnvironment('acme', 'stage'))
		expect((await db.listAppEnvs('acme')).map((e) => e.env)).toEqual(['prod', 'stage'])
		expect((await db.getAppEnv('acme', 'prod'))?.env).toBe('prod')
		expect((await db.getAppEnvByTriggerRef('acme', 'refs/tags/v*'))?.env).toBe('prod')
		// Manual-only envs (NULL trigger_ref) are excluded — the partial index's whole point.
		expect((await db.listTriggerEnvs('acme')).map((e) => e.env)).toEqual(['prod'])

		expect(await db.deleteAppEnv('acme', 'stage')).toBe(true)
		expect(await db.deleteAppEnv('acme', 'stage')).toBe(false)

		await db.deleteApp('acme')
		expect(await db.listAppEnvs('acme')).toHaveLength(0)
	})

	test('a trigger ref is unique within an app, and NULLs do not contend', async () => {
		await reset()
		await db.createApp({ id: 'acme', repoUrl: 'github.com/acme/app' })
		await db.upsertAppEnv(providerEnvironment('acme', 'prod', { triggerRef: 'refs/heads/main' }))
		await expect(db.upsertAppEnv(providerEnvironment('acme', 'stage', { triggerRef: 'refs/heads/main' }))).rejects.toThrow()
		// Two manual-only envs coexist: the index is partial, so NULLs are skipped entirely.
		await db.upsertAppEnv(providerEnvironment('acme', 'a'))
		await db.upsertAppEnv(providerEnvironment('acme', 'b'))
	})

	test('app_secrets: the two LAYERS, their partial-index upserts, and the precedence ORDER BY', async () => {
		await reset()
		await db.createApp({ id: 'acme', repoUrl: 'github.com/acme/app' })

		await db.upsertAppSecret({ appId: 'acme', env: null, name: 'API_KEY', valueRef: 'vault:all' })
		await db.upsertAppSecret({ appId: 'acme', env: 'prod', name: 'API_KEY', valueRef: 'vault:prod' })
		await db.upsertAppSecret({ appId: 'acme', env: null, name: 'SHARED', valueRef: 'vault:shared' })

		// Each layer upserts against its OWN partial index — a re-put replaces rather than duplicating.
		const replaced = await db.upsertAppSecret({ appId: 'acme', env: null, name: 'API_KEY', valueRef: 'vault:all2' })
		expect(replaced.value_ref).toBe('vault:all2')
		expect(await db.listAppSecrets('acme')).toHaveLength(3)

		// THE ORDER IS THE FEATURE: the caller layers by last-write-wins, so the ALL-ENV row of a name must
		// come out BEFORE the env-specific one. Bare `ORDER BY name` left that to SQLite's rowid fallback,
		// and `ORDER BY name, env` inverts it on Postgres (NULLS LAST) — deploying the wrong secret value.
		const forProd = await db.getAppSecretsForEnv('acme', 'prod')
		expect(forProd.map((s) => `${s.name}:${s.value_ref}`)).toEqual(['API_KEY:vault:all2', 'API_KEY:vault:prod', 'SHARED:vault:shared'])
		const resolved: Record<string, string> = {}
		for (const row of forProd) {
			resolved[row.name] = row.value_ref
		}
		expect(resolved['API_KEY']).toBe('vault:prod')

		// A different env sees only its own layer plus the all-env one.
		expect((await db.getAppSecretsForEnv('acme', 'stage')).map((s) => s.value_ref)).toEqual(['vault:all2', 'vault:shared'])

		// Delete needs `IS NULL` for the all-env layer — a bound NULL never `= NULL`, on either engine.
		expect(await db.deleteAppSecret('acme', 'prod', 'API_KEY')).toBe(true)
		expect(await db.deleteAppSecret('acme', 'prod', 'API_KEY')).toBe(false)
		expect(await db.deleteAppSecret('acme', null, 'API_KEY')).toBe(true)
		expect(await db.deleteAppSecret('acme', null, 'API_KEY')).toBe(false)
		expect(await db.listAppSecrets('acme')).toHaveLength(1)
	})

	test('app_vars: the same layering, in plaintext', async () => {
		await reset()
		await db.createApp({ id: 'acme', repoUrl: 'github.com/acme/app' })
		await db.upsertAppVar({ appId: 'acme', env: null, name: 'TEAM', value: 'acme' })
		await db.upsertAppVar({ appId: 'acme', env: 'prod', name: 'TEAM', value: 'acme-prod' })
		await db.upsertAppVar({ appId: 'acme', env: null, name: 'REGION', value: 'eu' })

		expect((await db.getAppVarsForEnv('acme', 'prod')).map((v) => v.value)).toEqual(['eu', 'acme', 'acme-prod'])
		expect(await db.listAppVars('acme')).toHaveLength(3)
		expect((await db.upsertAppVar({ appId: 'acme', env: 'prod', name: 'TEAM', value: 'acme-prod-2' })).value).toBe('acme-prod-2')
		expect(await db.deleteAppVar('acme', 'prod', 'TEAM')).toBe(true)
		expect(await db.deleteAppVar('acme', null, 'REGION')).toBe(true)
		expect(await db.listAppVars('acme')).toHaveLength(1)
	})

	test('runs: create, the status-guarded transitions, keyset paging, and the stale sweep', async () => {
		await reset()
		await db.createApp({ id: 'acme', repoUrl: 'github.com/acme/app' })
		await db.upsertAppEnv(providerEnvironment('acme', 'prod'))

		const first = await db.createRun({ id: uuidv7(), appId: 'acme', env: 'prod', ref: 'refs/heads/main', trigger: 'webhook' })
		expect(first.status).toBe('pending')
		const second = await db.createRun({ id: uuidv7(), appId: 'acme', env: 'stage', ref: 'refs/heads/dev', commitSha: 'abc', trigger: 'poll' })

		expect((await db.getRun(first.id))?.trigger).toBe('webhook')
		// UUIDv7 ids are monotonic (RFC 9562 §6.2 counter), so `ORDER BY id DESC` is chronological on a
		// TEXT comparison even for two runs minted inside the same millisecond — as these two are.
		expect((await db.listRuns({ limit: 10 })).map((r) => r.id)).toEqual([second.id, first.id])
		expect((await db.listRuns({ limit: 10, appId: 'acme', env: 'prod' })).map((r) => r.id)).toEqual([first.id])
		expect((await db.listRuns({ limit: 10, before: second.id })).map((r) => r.id)).toEqual([first.id])
		expect(await db.listRuns({ limit: 1 })).toHaveLength(1)

		// pending → running only once: a redelivered queue message must be a no-op.
		expect(await db.markRunStarted(first.id, `runs/${first.id}/logs.ndjson`)).toBe(true)
		expect(await db.markRunStarted(first.id, `runs/${first.id}/logs.ndjson`)).toBe(false)
		const running = await db.getRun(first.id)
		expect(running?.status).toBe('running')
		expect(typeof running?.started_at).toBe('number')

		await db.setRunCommit(first.id, 'deadbeef')
		expect((await db.getRun(first.id))?.commit_sha).toBe('deadbeef')
		expect(await db.setRunExternalId(first.id, 'harbor-operation-1')).toBe(true)
		expect((await db.listInFlightRuns('harbor')).map((run) => run.id)).toEqual([first.id])
		expect((await db.getRun(first.id))?.external_run_id).toBe('harbor-operation-1')

		// The terminal write is guarded too — it is co-written by vozka-runner's `finishRun`.
		expect(await db.markRunFinished(first.id, 'succeeded', 0)).toBe(true)
		expect(await db.markRunFinished(first.id, 'failed', 1)).toBe(false)
		const done = await db.getRun(first.id)
		expect(done?.status).toBe('succeeded')
		expect(done?.exit_code).toBe(0)

		// The sweep only reaps genuinely aged pending/running rows — `second` is still pending and young.
		expect(await db.sweepStaleRuns(3600)).toBe(0)
		expect(await db.sweepStaleRuns(-1)).toBe(1)
		expect((await db.getRun(second.id))?.status).toBe('failed')
	})

	test('repo poll state: the join that selects pollable envs, and the upsert', async () => {
		await reset()
		// PUBLIC (no installation id) + a trigger ref → pollable. The other three combinations are not.
		await db.createApp({ id: 'public-app', repoUrl: 'github.com/acme/public' })
		await db.upsertAppEnv(providerEnvironment('public-app', 'prod', { triggerRef: 'refs/heads/main' }))
		await db.upsertAppEnv(providerEnvironment('public-app', 'manual'))
		await db.createApp({ id: 'private-app', repoUrl: 'github.com/acme/private', githubInstallationId: 99 })
		await db.upsertAppEnv(providerEnvironment('private-app', 'prod', { triggerRef: 'refs/heads/main' }))

		const eligible = await db.getPollEligibleEnvs()
		expect(eligible.map((e) => `${e.app.id}:${e.appEnv.env}`)).toEqual(['public-app:prod'])
		// The prefixed join columns are unpacked into two real row shapes, types intact.
		expect(eligible[0]?.app.github_installation_id).toBeNull()
		expect(typeof eligible[0]?.appEnv.created_at).toBe('number')

		expect(await db.getRepoPollState('public-app', 'prod')).toBeNull()
		const stamped = now()
		await db.upsertRepoPollState({ appId: 'public-app', env: 'prod', etag: 'W/"1"', lastSeenSha: 'aaa', lastPolledAt: stamped })
		const updated = await db.upsertRepoPollState({
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
		expect((await db.getRepoPollState('public-app', 'prod'))?.last_seen_sha).toBe('bbb')
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

	test('the scope CHECK admits only the two app scopes the vault still holds', async () => {
		await reset()
		const vault = await Vault.create(raw, kek())
		await vault.putSecret('app', 'app:acme/API_KEY', 'v')
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

describe.skipIf(!hasPostgres)('the deploy queue, as a table', () => {
	test('a message survives send → claim → handler → ack, and the payload round-trips', async () => {
		await reset()
		await db.createApp({ id: 'acme', repoUrl: 'github.com/acme/app' })
		await db.upsertAppEnv(providerEnvironment('acme', 'prod'))
		const run = await db.createRun({ id: uuidv7(), appId: 'acme', env: 'prod', ref: 'refs/heads/main', trigger: 'manual' })

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

	test('a run whose deploy has nowhere to go is recorded FAILED, not left pending', async () => {
		await reset()
		await db.createApp({ id: 'acme', repoUrl: 'github.com/acme/app' })
		await db.upsertAppEnv(providerEnvironment('acme', 'prod'))
		const run = await db.createRun({ id: uuidv7(), appId: 'acme', env: 'prod', ref: 'refs/heads/main', trigger: 'manual' })

		// No RUNNER (ADR-0003) and no Cloudflare credentials: `assembleJob` refuses before anything else,
		// `executeDeploy` records the failure, and `runDeployJob` returns normally so the message is acked.
		const result = await runDeployJob(env(), { runId: run.id })
		expect(result.status).toBe('failed')
		const after = await db.getRun(run.id)
		expect(after?.status).toBe('failed')
		expect(after?.exit_code).toBeNull()
		// The lock was taken and released, so the next trigger for this target is not wedged.
		expect(await new SqlDeployLocks(raw).acquire('acme:prod', 'next-run', 60_000)).toBe(true)
	})

	test('a CONTENDED run is deferred and re-enqueued, never double-run', async () => {
		await reset()
		await db.createApp({ id: 'acme', repoUrl: 'github.com/acme/app' })
		await db.upsertAppEnv(providerEnvironment('acme', 'prod'))
		const run = await db.createRun({ id: uuidv7(), appId: 'acme', env: 'prod', ref: 'refs/heads/main', trigger: 'manual' })
		// Somebody else holds the app-env lease.
		await new SqlDeployLocks(raw).acquire('acme:prod', 'other-run', 60_000)

		const assembled = env()
		expect((await runDeployJob(assembled, { runId: run.id })).status).toBe('deferred')

		// Left pending, and a FRESH message is waiting (delayed) rather than a retry being consumed.
		expect((await db.getRun(run.id))?.status).toBe('pending')
		const { results } = await raw.prepare('SELECT attempts FROM jobs').all<{ attempts: number }>()
		expect(results).toHaveLength(1)
		expect(results[0]?.attempts).toBe(0)
	})

	test('startRun fails LOUDLY when no runner exists, naming both reasons it can be missing', async () => {
		const job = {
			runId: 'r',
			repoUrl: 'https://github.com/acme/app.git',
			ref: 'refs/heads/main',
			env: 'prod',
			credentials: { CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't' },
		}
		await expect(startRun(env(), job)).rejects.toThrow(/no deploy runner is available/)
		// …and the same failure reaches the M2 compatibility route as an opaque 500, never a half-run.
		const response = await createFetchHandler(env())(
			new Request('http://localhost:18291/api/runs', { method: 'POST', body: JSON.stringify(job), headers: { 'content-type': 'application/json' } }),
		)
		expect(response.status).toBe(500)
		expect(await response.text()).toBe('internal error')
	})
})

describe.skipIf(!hasPostgres)('the Bun entrypoint, end to end on Postgres', () => {
	test('serves liveness, the API and the SPA fallback from one handler', async () => {
		await reset()
		await db.createApp({ id: 'acme', repoUrl: 'github.com/acme/app' })
		const handler = createFetchHandler(env())

		// The process-level liveness route, claimed before `handleFetch` could hand it to the SPA.
		expect((await handler(new Request('http://localhost:18291/healthz'))).status).toBe(200)
		// …and the Worker's own health route, unchanged, so one monitor works on both platforms.
		expect((await handler(new Request('http://localhost:18291/api/health'))).status).toBe(200)

		// The real ACL-gated control surface, against the real database. DEV='true' resolves the dev
		// admin persona, which is what makes this exercise the routing rather than the auth.
		const apps: unknown = await (await handler(new Request('http://localhost:18291/api/apps'))).json()
		expect(JSON.stringify(apps)).toContain('acme')

		// Anything unrouted is the SPA — the `ASSETS` binding's replacement.
		expect(await (await handler(new Request('http://localhost:18291/apps/acme'))).text()).toContain('spa')
	})

	test('an unhandled throw answers an opaque 500, not Bun default error page', async () => {
		// Bun's default error page embeds the exception message AND the surrounding source lines in the
		// response body. The Workers runtime does not, so this is the one place the two entrypoints would
		// have differed in what they show an attacker. Reproduced with an ASSETS port that throws.
		const handler = createFetchHandler({
			...env(),
			ASSETS: {
				fetch: () => {
					throw new Error('assets exploded with CLOUDFLARE_API_TOKEN=looks-like-a-secret')
				},
			},
		})
		const response = await handler(new Request('http://localhost:18291/anything'))
		expect(response.status).toBe(500)
		const text = await response.text()
		expect(text).toBe('internal error')
		expect(text).not.toContain('looks-like-a-secret')
	})

	test('the maintenance pass polls, enqueues and sweeps against the real schema', async () => {
		await reset()
		await db.createApp({ id: 'acme', repoUrl: 'github.com/acme/app' })
		await db.upsertAppEnv(providerEnvironment('acme', 'prod', { triggerRef: 'refs/heads/main' }))
		const stale = await db.createRun({ id: uuidv7(), appId: 'acme', env: 'prod', ref: 'refs/heads/main', trigger: 'manual' })
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
		expect((await db.getRun(stale.id))?.status).toBe('failed')
		expect((await db.listRuns({ limit: 10, appId: 'acme' })).filter((r) => r.trigger === 'poll')).toHaveLength(1)
		expect((await raw.prepare('SELECT count(*)::int AS n FROM jobs').first<{ n: number }>())?.n).toBe(1)
		expect((await db.getRepoPollState('acme', 'prod'))?.last_seen_sha).toBe('a'.repeat(40))
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
 * The `Env` `node/runtime.ts` would assemble from `process.env`, built by hand so it binds the
 * SCHEMA-SCOPED pool this fixture owns instead of opening a second one. Everything else — the routing,
 * the consumer, the maintenance pass — is exactly what runs in production.
 *
 * DEV='true' selects the dev-persona authenticator, and RUNNER is absent, which is the Zerops shape.
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
		ASSETS: { fetch: () => Promise.resolve(new Response('<!doctype html>spa', { headers: { 'content-type': 'text/html' } })) },
		RUN_LOGS: logs,
		DEPLOY_QUEUE: new PostgresJobQueue<DeployJobMessage>(raw, { queue: 'vozka-deploy' }),
		ENVIRONMENT: 'local',
		DEV: 'true',
		// No feed fetch happens in these tests (the poller needs a resolvable feed), so the maintenance
		// pass exercises the QUERIES; the poll logic itself is covered by repo-poll.test.ts.
	}
}
