import { SqlDeployLocks } from '@fabrika/platform'
import { PostgresDatabase } from '@fabrika/platform-node'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createControlRepositories } from '../db'
import { reconcileProviderRuns } from '../provider-reconcile'
import { executeDeploy, type RunDeps } from '../run-lifecycle'
import { EnvSecretResolver } from '../secret-resolver'
import { createPostgres, hasPostgres, type PostgresFixture, postgresUrl, skipReason } from './helpers/postgres'
import { runFencingContract } from './helpers/run-fencing'

if (!hasPostgres) console.warn(`run-fencing-postgres.test.ts ${skipReason}`)

let fixture: PostgresFixture
beforeAll(async () => {
	if (hasPostgres) fixture = await createPostgres('run_fencing')
})
afterAll(async () => {
	if (hasPostgres) await fixture.close()
})

describe.skipIf(!hasPostgres)('run fencing on Postgres', () => {
	runFencingContract(() => fixture.db)

	test('runtime deploy and recovery share SQL ownership and retain exclusion across unresolved invocations', async () => {
		const repositories = createControlRepositories(fixture.db)
		const locks = new SqlDeployLocks(fixture.db)
		const appId = 'runtime-ownership'
		await repositories.registry.createApp({ id: appId, repoUrl: 'https://github.com/example/app' })
		const envelope = JSON.stringify({ provider: 'runtime-test', version: 1, payload: {} })
		await repositories.registry.upsertAppEnv({
			appId,
			env: 'prod',
			namespaceId: null,
			provider: 'runtime-test',
			providerTargetJson: envelope,
			providerArtifactJson: envelope,
		})
		for (const id of ['runtime-first', 'runtime-next']) {
			await repositories.runs.createRun({ id, appId, env: 'prod', ref: 'main', trigger: 'manual' })
		}
		const deps: RunDeps = {
			repositories,
			lock: {
				acquire: (key, holder) => locks.acquire(key, holder, 1800000),
				renew: (key, holder) => locks.renew(key, holder, 1800000),
				release: (key, holder) => locks.release(key, holder),
			},
			secrets: new EnvSecretResolver({}),
			logs: { put: async () => {} },
			provider: {
				id: 'runtime-test',
				normalizeRegistration: (input) => input,
				deploy: async (input) => {
					await input.events.externalId('external', { phase: 1 })
					await input.events.checkpoint({ phase: 2 })
					return { state: 'running' }
				},
				reconcile: async (input) => {
					expect(input.providerState).toEqual({ phase: 2 })
					await input.checkpoint({ phase: 3 })
					return { state: 'succeeded' }
				},
			},
		}
		expect(await executeDeploy(deps, { runId: 'runtime-first' })).toEqual({ runId: 'runtime-first', status: 'running' })
		expect(await executeDeploy(deps, { runId: 'runtime-next' })).toEqual({ runId: 'runtime-next', status: 'deferred' })
		expect(await reconcileProviderRuns(deps)).toMatchObject({ succeeded: 1, waiting: 1 })
		expect(await executeDeploy(deps, { runId: 'runtime-next' })).toEqual({ runId: 'runtime-next', status: 'running' })
	})

	test('concurrent checkpoint CAS attempts have exactly one winner', async () => {
		if (postgresUrl === null) throw new Error('Postgres not configured')
		const pool = PostgresDatabase.connect(postgresUrl, { connection: { search_path: fixture.schema }, max: 2 })
		try {
			const { registry, runs } = createControlRepositories(pool)
			await registry.createApp({ id: 'concurrent-cas', repoUrl: 'github.com/acme/app' })
			await registry.upsertAppEnv({
				appId: 'concurrent-cas',
				env: 'prod',
				namespaceId: null,
				provider: 'test',
				providerTargetJson: '{}',
				providerArtifactJson: '{}',
			})
			await runs.createRun({ id: 'concurrent-cas', appId: 'concurrent-cas', env: 'prod', ref: 'main', trigger: 'manual' })
			await new SqlDeployLocks(pool, { now: () => 100 }).acquire('concurrent-cas:prod', 'owner', 100)
			const guard = { holder: 'owner', nowMs: 100, expectedProviderStateJson: null }
			await runs.markRunStarted('concurrent-cas', 'log', guard)
			await runs.setRunExternalId('concurrent-cas', 'operation', undefined, guard)
			const results = await Promise.all([
				runs.checkpointRunProviderState('concurrent-cas', { phase: 1 }, guard),
				runs.checkpointRunProviderState('concurrent-cas', { phase: 2 }, guard),
			])
			expect(results.filter(Boolean)).toHaveLength(1)
			expect((await runs.getRun('concurrent-cas'))?.provider_state_json).toBe(results[0] ? '{"phase":1}' : '{"phase":2}')
		} finally {
			await pool.close()
		}
	})

	test('lease takeover waits behind the real mutation batch until its run write commits', async () => {
		if (postgresUrl === null) throw new Error('Postgres not configured')
		const mutationName = `${fixture.schema}_mutation`
		const takeoverName = `${fixture.schema}_takeover`
		const mutationPool = PostgresDatabase.connect(postgresUrl, {
			connection: { search_path: fixture.schema, application_name: mutationName },
			max: 1,
		})
		const takeoverPool = PostgresDatabase.connect(postgresUrl, {
			connection: { search_path: fixture.schema, application_name: takeoverName },
			max: 1,
		})
		const gate = new Bun.SQL({ url: postgresUrl, adapter: 'postgres', max: 1 })
		const locked = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		let holding: Promise<unknown> | undefined
		let mutation: Promise<boolean> | undefined
		let takeover: Promise<boolean> | undefined
		try {
			const { registry, runs } = createControlRepositories(mutationPool)
			await registry.createApp({ id: 'takeover-race', repoUrl: 'github.com/acme/app' })
			await registry.upsertAppEnv({
				appId: 'takeover-race',
				env: 'prod',
				namespaceId: null,
				provider: 'test',
				providerTargetJson: '{}',
				providerArtifactJson: '{}',
			})
			await runs.createRun({ id: 'takeover-race', appId: 'takeover-race', env: 'prod', ref: 'main', trigger: 'manual' })
			await runs.createRun({ id: 'takeover-next', appId: 'takeover-race', env: 'prod', ref: 'main', trigger: 'manual' })
			await new SqlDeployLocks(mutationPool, { now: () => 100 }).acquire('takeover-race:prod', 'owner', 100)
			// Pause the second batch statement inside Postgres, after the production code locked the lease row.
			await fixture.db.prepare(`CREATE FUNCTION pause_fenced_run() RETURNS trigger LANGUAGE plpgsql AS $$
				BEGIN
					IF NEW.id = 'takeover-race' THEN PERFORM pg_advisory_xact_lock(hashtext(TG_TABLE_SCHEMA)); END IF;
					RETURN NEW;
				END $$`).run()
			await fixture.db.prepare('CREATE TRIGGER pause_fenced_run BEFORE UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION pause_fenced_run()').run()
			holding = gate.begin(async (tx) => {
				await tx.unsafe('SELECT pg_advisory_xact_lock(hashtext($1))', [fixture.schema])
				locked.resolve()
				await release.promise
			})
			await Promise.race([locked.promise, holding])
			mutation = runs.markRunStarted('takeover-race', 'log', { holder: 'owner', nowMs: 100, expectedProviderStateJson: null })
			await waitForLock(mutationName)
			takeover = new SqlDeployLocks(takeoverPool, { now: () => 200 }).acquire('takeover-race:prod', 'next-owner', 100)
			await waitForLock(takeoverName)
			expect((await fixture.db.prepare('SELECT status FROM runs WHERE id = ?').bind('takeover-race').first<{ status: string }>())?.status).toBe(
				'pending',
			)
			release.resolve()
			expect(await mutation).toBe(true)
			expect(await takeover).toBe(true)
			expect(await runs.markRunStarted('takeover-next', 'log', { holder: 'next-owner', nowMs: 200, expectedProviderStateJson: null })).toBe(false)
			expect((await runs.getRun('takeover-race'))?.status).toBe('running')
			expect((await runs.getRun('takeover-next'))?.status).toBe('pending')
			expect(await runs.markRunFinished('takeover-race', 'succeeded', 0, { holder: 'owner', nowMs: 100, expectedProviderStateJson: null })).toBe(false)
		} finally {
			release.resolve()
			await Promise.allSettled([holding, mutation, takeover])
			await fixture.db.prepare('DROP TRIGGER IF EXISTS pause_fenced_run ON runs').run()
			await fixture.db.prepare('DROP FUNCTION IF EXISTS pause_fenced_run()').run()
			await Promise.all([gate.close(), mutationPool.close(), takeoverPool.close()])
		}
	}, 15000)
})

async function waitForLock(applicationName: string): Promise<void> {
	const deadline = Date.now() + 5000
	while (Date.now() < deadline) {
		const waiting = await fixture.db.prepare(`SELECT 1 FROM pg_stat_activity
			WHERE application_name = ? AND wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0`)
			.bind(applicationName).first()
		if (waiting !== null) return
	}
	throw new Error('expected database lock barrier was not reached')
}
