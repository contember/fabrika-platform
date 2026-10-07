import { SqlDeployLocks } from '@fabrika/platform'
import { PostgresDatabase } from '@fabrika/platform-node'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createControlRepositories } from '../db'
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
		let mutation: Promise<boolean> | undefined
		let takeover: Promise<boolean> | undefined
		try {
			const { registry } = createControlRepositories(mutationPool)
			const created = await registry.createDeploymentNamespace({
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
			mutation = registry.writeDeploymentNamespace({
				id: 'takeover',
				createdAt: created.created_at,
				fence: { holder: 'owner', nowMs: 100 },
				providerTargetJson: '{"reserved":"v1"}',
				state: 'provisioning',
				lastError: null,
				claim: true,
			})
			await waitForLock(mutationName)
			takeover = new SqlDeployLocks(takeoverPool, { now: () => 200 }).acquire('namespace:takeover', 'next', 100)
			await waitForLock(takeoverName)
			release.resolve()
			expect(await mutation).toBe(true)
			expect(await takeover).toBe(true)
			expect(
				await registry.writeDeploymentNamespace({
					id: 'takeover',
					createdAt: created.created_at,
					fence: { holder: 'owner', nowMs: 200 },
					providerTargetJson: '{"stale":true}',
					state: 'ready',
					lastError: null,
					claim: true,
				}),
			).toBe(false)
			expect((await registry.getDeploymentNamespace('takeover'))?.provider_target_json).toBe('{"reserved":"v1"}')
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
