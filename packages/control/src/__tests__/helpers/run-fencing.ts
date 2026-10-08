import { type SqlDatabase, SqlDeployLocks } from '@fabrika/platform'
import { expect, test } from 'bun:test'
import { createControlRepositories } from '../../db'
import type { LeaseFence } from '../../lease'

export function runFencingContract(database: () => SqlDatabase): void {
	async function seed(appId: string) {
		const sql = database()
		const repositories = createControlRepositories(sql, { now: () => 42 })
		await repositories.registry.createApp({ id: appId, repoUrl: 'github.com/acme/app' })
		for (const env of ['prod', 'stage']) {
			await repositories.registry.upsertAppEnv({ appId, env, namespaceId: null, provider: 'test', providerTargetJson: '{}', providerArtifactJson: '{}' })
		}
		const runs = repositories.runs
		const first = `${appId}-first`
		const second = `${appId}-second`
		const stage = `${appId}-stage`
		for (const { id, env } of [{ id: first, env: 'prod' }, { id: second, env: 'prod' }, { id: stage, env: 'stage' }]) {
			await runs.createRun({ id, appId, env, ref: 'main', trigger: 'manual', actor: 'user:test' })
		}
		const locks = (now: number) => new SqlDeployLocks(sql, { now: () => now })
		const key = `${appId}:prod`
		const fence: LeaseFence = { holder: 'first-delivery', nowMs: 100 }
		return { sql, runs, first, second, stage, locks, fence, key }
	}

	test('initial reservation after cancellation requires the exact live owner, never a stale holder', async () => {
		const { runs, first, locks, fence, key } = await seed('cancel-reservation')
		await locks(100).acquire(key, fence.holder, 100)
		await runs.markRunStarted(first, 'log', fence)
		await runs.requestRunCancellation(first)
		expect(await runs.recordInitialRunExternalId(first, 'version', { triggered: false }, { ...fence, holder: 'stale' })).toBe(false)
		await locks(200).acquire(key, 'takeover', 100)
		expect(await runs.recordInitialRunExternalId(first, 'version', { triggered: false }, fence)).toBe(false)
		const takeover = { ...fence, holder: 'takeover', nowMs: 200 }
		expect(await runs.recordInitialRunExternalId(first, 'version', { triggered: false }, takeover)).toBe(true)
		expect(await runs.recordInitialRunExternalId(first, 'version', { triggered: true }, takeover)).toBe(false)
		expect(await runs.checkpointRunProviderState(first, { triggered: true }, takeover)).toBe(false)
		expect(await runs.markRunCancellationFinished(first, 'failed', takeover)).toBe(true)
	})

	test('start requires a live exact owner, never creates or renews a lease, and refuses another running run after takeover', async () => {
		const { sql, runs, first, second, stage, locks, fence, key } = await seed('start-fence')
		expect(await runs.markRunStarted(first, 'log', fence)).toBe(false)
		expect(await locks(100).acquire(key, fence.holder, 100)).toBe(true)
		expect(await runs.markRunStarted(first, 'log', { ...fence, holder: 'wrong' })).toBe(false)
		expect(await runs.markRunStarted(first, 'log', { ...fence, nowMs: 200 })).toBe(false)
		expect(await runs.markRunStarted(first, 'log', fence)).toBe(true)
		expect((await runs.getRun(first))?.started_at).toBe(42)
		expect(await locks(200).acquire(key, 'next-delivery', 100)).toBe(true)
		expect(await runs.markRunStarted(second, 'log', { ...fence, holder: 'next-delivery', nowMs: 200 })).toBe(false)
		expect(await locks(200).acquire('start-fence:stage', 'stage-delivery', 100)).toBe(true)
		expect(await runs.markRunStarted(stage, 'log', { holder: 'stage-delivery', nowMs: 200 })).toBe(true)
		expect((await runs.getRun(second))?.status).toBe('pending')
		expect(await sql.prepare('SELECT holder FROM deploy_locks WHERE lock_key = ?').bind(key).first<{ holder: string }>()).toEqual({
			holder: 'next-delivery',
		})
	})

	test('no write path skips the holder check: a foreign fence changes nothing', async () => {
		const { runs, first, locks, fence, key } = await seed('foreign-fence')
		await locks(100).acquire(key, fence.holder, 100)
		await runs.markRunStarted(first, 'log', fence)
		const foreign = { ...fence, holder: 'foreign' }
		const before = await runs.getRun(first)
		expect(await runs.markRunStarted(first, 'log', foreign)).toBe(false)
		expect(await runs.setRunCommit(first, 'a'.repeat(40), foreign)).toBe(false)
		expect(await runs.recordInitialRunExternalId(first, 'operation', { triggered: false }, foreign)).toBe(false)
		expect(await runs.markRunFinished(first, 'succeeded', 0, foreign)).toBe(false)
		expect(await runs.getRun(first)).toEqual(before)
		await runs.recordInitialRunExternalId(first, 'operation', { triggered: false }, fence)
		const accepted = await runs.getRun(first)
		expect(await runs.checkpointRunProviderState(first, { triggered: true }, foreign)).toBe(false)
		expect(await runs.getRun(first)).toEqual(accepted)
		const cancelling = await runs.requestRunCancellation(first)
		expect(await runs.markRunCancellationFinished(first, 'failed', foreign)).toBe(false)
		expect(await runs.getRun(first)).toEqual(cancelling)
	})

	test('takeover denies every old-owner write including terminal, commit, external id and cancellation finalization', async () => {
		const { runs, first, locks, fence, key } = await seed('old-owner')
		await locks(100).acquire(key, fence.holder, 100)
		await runs.markRunStarted(first, 'log', fence)
		await locks(200).acquire(key, 'new-owner', 100)
		const before = await runs.getRun(first)
		expect(await runs.recordInitialRunExternalId(first, 'operation', { triggered: false }, fence)).toBe(false)
		expect(await runs.checkpointRunProviderState(first, { triggered: true }, fence)).toBe(false)
		expect(await runs.setRunCommit(first, 'abc', fence)).toBe(false)
		expect(await runs.markRunFinished(first, 'succeeded', 0, fence)).toBe(false)
		expect(await runs.getRun(first)).toEqual(before)
		await runs.requestRunCancellation(first)
		expect(await runs.markRunCancellationFinished(first, 'failed', fence)).toBe(false)
		expect(await runs.markRunCancellationFinished(first, 'failed', { ...fence, holder: 'new-owner', nowMs: 200 })).toBe(true)
	})

	test('external id and commit are recorded once, and a terminal row accepts no further write', async () => {
		const { runs, first, locks, fence, key } = await seed('immutable')
		await locks(100).acquire(key, fence.holder, 100)
		await runs.markRunStarted(first, 'log', fence)
		expect(await runs.checkpointRunProviderState(first, { triggered: false }, fence)).toBe(false)
		expect(await runs.recordInitialRunExternalId(first, 'operation', { triggered: false }, fence)).toBe(true)
		expect(await runs.recordInitialRunExternalId(first, 'other', undefined, fence)).toBe(false)
		expect(await runs.setRunCommit(first, 'abc', fence)).toBe(true)
		expect(await runs.setRunCommit(first, 'def', fence)).toBe(false)
		expect(await runs.checkpointRunProviderState(first, { triggered: true }, fence)).toBe(true)
		expect((await runs.getRun(first))?.provider_state_json).toBe('{"triggered":true}')
		expect(await runs.markRunFinished(first, 'succeeded', 0, fence)).toBe(true)
		expect(await runs.setRunCommit(first, 'abc', fence)).toBe(false)
		expect(await runs.checkpointRunProviderState(first, { triggered: true }, fence)).toBe(false)
		expect(await runs.markRunFinished(first, 'failed', 1, fence)).toBe(false)
	})

	test('a cancellation request blocks ordinary writes and only the live holder may finalize', async () => {
		const { runs, first, second, locks, fence, key } = await seed('cancellation-fence')
		await locks(100).acquire(key, fence.holder, 100)
		await runs.markRunStarted(first, 'log', fence)
		await runs.recordInitialRunExternalId(first, 'operation', { triggered: false }, fence)
		expect(await runs.markRunCancellationFinished(first, 'failed', fence)).toBe(false)
		await runs.requestRunCancellation(first)
		expect(await runs.setRunCommit(first, 'abc', fence)).toBe(false)
		expect(await runs.checkpointRunProviderState(first, { triggered: true }, fence)).toBe(false)
		expect(await runs.markRunFinished(first, 'succeeded', 0, fence)).toBe(false)
		expect(await runs.markRunCancellationFinished(first, 'failed', { ...fence, nowMs: 200 })).toBe(false)
		expect(await runs.markRunCancellationFinished(first, 'failed', fence)).toBe(true)
		expect((await runs.getRun(first))?.status).toBe('failed')
		await runs.requestRunCancellation(second)
		expect(await runs.markRunStarted(second, 'log', fence)).toBe(false)
		expect(await runs.markRunCancellationFinished(second, 'failed', fence)).toBe(true)
	})
}
