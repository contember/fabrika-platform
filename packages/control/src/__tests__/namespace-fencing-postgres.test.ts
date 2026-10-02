import { SqlDeployLocks } from '@fabrika/platform'
import { PostgresDatabase } from '@fabrika/platform-node'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createControlRepositories, type DeploymentNamespaceRow } from '../db'
import { createPostgres, hasPostgres, type PostgresFixture, postgresUrl, skipReason } from './helpers/postgres'

if (!hasPostgres) console.warn(`namespace-fencing-postgres.test.ts ${skipReason}`)
let fixture: PostgresFixture
beforeAll(async () => {
	if (hasPostgres) fixture = await createPostgres('namespace_fencing')
})
afterAll(async () => {
	if (hasPostgres) await fixture.close()
})

describe.skipIf(!hasPostgres)('namespace fencing on Postgres', () => {
	test('concurrent target CAS writes have one winner', async () => {
		if (postgresUrl === null) throw new Error('Postgres not configured')
		const pool = PostgresDatabase.connect(postgresUrl, { connection: { search_path: fixture.schema }, max: 2 })
		try {
			const { registry } = createControlRepositories(pool)
			const expected = await registry.createDeploymentNamespace({
				id: 'cas',
				env: 'prod',
				provider: 'test',
				exclusiveAppId: null,
				providerTargetJson: '{}',
				state: 'ready',
			})
			await new SqlDeployLocks(pool, { now: () => 100 }).acquire('namespace:cas', 'owner', 100)
			const input = { expected, holder: 'owner', nowMs: 100, state: 'provisioning', lastError: null, providerTargetJson: '{}' } satisfies Parameters<
				typeof registry.checkpointDeploymentNamespace
			>[0]
			const results = await Promise.all([
				registry.checkpointDeploymentNamespace({ ...input, providerTargetJson: '{"attempt":1}' }),
				registry.checkpointDeploymentNamespace({ ...input, providerTargetJson: '{"attempt":2}' }),
			])
			expect(results.filter(row => row !== null)).toHaveLength(1)
			expect((await registry.getDeploymentNamespace('cas'))?.provider_target_json).toBe(results[0] === null ? '{"attempt":2}' : '{"attempt":1}')
		} finally {
			await pool.close()
		}
	})

	test('lease takeover waits for the production namespace mutation transaction', async () => {
		if (postgresUrl === null) throw new Error('Postgres not configured')
		const mutationName = `${fixture.schema}_mutation`
		const takeoverName = `${fixture.schema}_takeover`
		const mutationPool = PostgresDatabase.connect(postgresUrl, { connection: { search_path: fixture.schema, application_name: mutationName }, max: 1 })
		const takeoverPool = PostgresDatabase.connect(postgresUrl, { connection: { search_path: fixture.schema, application_name: takeoverName }, max: 1 })
		const gate = new Bun.SQL({ url: postgresUrl, adapter: 'postgres', max: 1 })
		const locked = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		let holding: Promise<unknown> | undefined
		let mutation: Promise<DeploymentNamespaceRow | null> | undefined
		let takeover: Promise<boolean> | undefined
		try {
			const { registry } = createControlRepositories(mutationPool)
			const expected = await registry.createDeploymentNamespace({
				id: 'takeover',
				env: 'prod',
				provider: 'test',
				exclusiveAppId: null,
				providerTargetJson: '{}',
				state: 'ready',
			})
			await new SqlDeployLocks(mutationPool, { now: () => 100 }).acquire('namespace:takeover', 'owner', 100)
			await fixture.db.prepare(`CREATE FUNCTION pause_namespace() RETURNS trigger LANGUAGE plpgsql AS $$
				BEGIN
					IF NEW.id = 'takeover' THEN PERFORM pg_advisory_xact_lock(hashtext(TG_TABLE_SCHEMA)); END IF;
					RETURN NEW;
				END $$`).run()
			await fixture.db.prepare('CREATE TRIGGER pause_namespace BEFORE UPDATE ON deployment_namespaces FOR EACH ROW EXECUTE FUNCTION pause_namespace()')
				.run()
			holding = gate.begin(async tx => {
				await tx.unsafe('SELECT pg_advisory_xact_lock(hashtext($1))', [fixture.schema])
				locked.resolve()
				await release.promise
			})
			await Promise.race([locked.promise, holding])
			mutation = registry.checkpointDeploymentNamespace({
				expected,
				holder: 'owner',
				nowMs: 100,
				providerTargetJson: '{"reserved":"v1"}',
				state: 'provisioning',
				lastError: null,
			})
			await waitForLock(mutationName)
			takeover = new SqlDeployLocks(takeoverPool, { now: () => 200 }).acquire('namespace:takeover', 'next', 100)
			await waitForLock(takeoverName)
			release.resolve()
			expect(await mutation).not.toBeNull()
			expect(await takeover).toBe(true)
			const current = await registry.getDeploymentNamespace('takeover')
			if (current === null) throw new Error('missing namespace')
			expect(
				await registry.checkpointDeploymentNamespace({
					expected: current,
					holder: 'owner',
					nowMs: 200,
					providerTargetJson: '{"stale":true}',
					state: 'ready',
					lastError: null,
				}),
			).toBeNull()
			expect(current.provider_target_json).toBe('{"reserved":"v1"}')
		} finally {
			release.resolve()
			await Promise.allSettled([holding, mutation, takeover])
			await gate.close()
			await mutationPool.close()
			await takeoverPool.close()
		}
	})
})

async function waitForLock(applicationName: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const row = await fixture.db.prepare('SELECT wait_event_type FROM pg_stat_activity WHERE application_name = ?').bind(applicationName).first<
			{ wait_event_type: string | null }
		>()
		if (row?.wait_event_type === 'Lock') return
		await Bun.sleep(10)
	}
	throw new Error('Postgres session did not reach the expected lock barrier')
}
