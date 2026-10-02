import { type SqlDatabase, SqlDeployLocks } from '@fabrika/platform'
import { expect, test } from 'bun:test'
import { createControlRepositories } from '../../db'
import type { RunMutationGuard } from '../../db/runs'

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
			await runs.createRun({ id, appId, env, ref: 'main', trigger: 'manual' })
		}
		const locks = (now: number) => new SqlDeployLocks(sql, { now: () => now })
		const guard: RunMutationGuard = { holder: 'first-delivery', nowMs: 100, expectedProviderStateJson: null }
		return { sql, runs, first, second, stage, locks, guard, key: `${appId}:prod` }
	}

	test('initial reservation after cancellation requires the exact live owner and checkpoint, never a stale same-id retry', async () => {
		const { runs, first, locks, guard, key } = await seed('cancel-reservation')
		await locks(100).acquire(key, guard.holder, 100)
		await runs.markRunStarted(first, 'log', guard)
		await runs.beginRunCancellation(first)
		expect(await runs.recordInitialRunExternalId(first, 'version', { phase: 'reserved' }, { ...guard, holder: 'stale' })).toBe(false)
		expect(await runs.recordInitialRunExternalId(first, 'version', { phase: 'reserved' }, { ...guard, expectedProviderStateJson: '{}' })).toBe(false)
		await locks(200).acquire(key, 'takeover', 100)
		expect(await runs.recordInitialRunExternalId(first, 'version', { phase: 'reserved' }, guard)).toBe(false)
		const takeover = { ...guard, holder: 'takeover', nowMs: 200 }
		expect(await runs.recordInitialRunExternalId(first, 'version', { phase: 'reserved' }, takeover)).toBe(true)
		const current = { ...takeover, expectedProviderStateJson: '{"phase":"reserved"}' }
		expect(await runs.recordInitialRunExternalId(first, 'version', { phase: 'later' }, current)).toBe(false)
		expect(await runs.recordInitialRunExternalId(first, 'version', { phase: 'later' }, guard)).toBe(false)
		expect(await runs.checkpointRunProviderState(first, { phase: 'submitted' }, current)).toBe(false)
		expect(await runs.setRunExternalId(first, 'version', { phase: 'submitted' }, current)).toBe(false)
		expect(await runs.markRunCancellationFinished(first, current)).toBe(true)
	})

	test('start requires a live exact owner, never creates or renews a lease, and refuses another running run after takeover', async () => {
		const { sql, runs, first, second, stage, locks, guard, key } = await seed('start-fence')
		expect(await runs.markRunStarted(first, 'log', guard)).toBe(false)
		expect(await locks(100).acquire(key, guard.holder, 100)).toBe(true)
		expect(await runs.markRunStarted(first, 'log', { ...guard, holder: 'wrong' })).toBe(false)
		expect(await runs.markRunStarted(first, 'log', { ...guard, nowMs: 200 })).toBe(false)
		expect(await runs.markRunStarted(first, 'log', guard)).toBe(true)
		expect((await runs.getRun(first))?.started_at).toBe(42)
		expect(await locks(200).acquire(key, 'next-delivery', 100)).toBe(true)
		expect(await runs.markRunStarted(second, 'log', { ...guard, holder: 'next-delivery', nowMs: 200 })).toBe(false)
		expect(await locks(200).acquire('start-fence:stage', 'stage-delivery', 100)).toBe(true)
		expect(await runs.markRunStarted(stage, 'log', { ...guard, holder: 'stage-delivery', nowMs: 200 })).toBe(true)
		expect((await runs.getRun(second))?.status).toBe('pending')
		expect(await sql.prepare('SELECT holder FROM deploy_locks WHERE lock_key = ?').bind(key).first<{ holder: string }>()).toEqual({
			holder: 'next-delivery',
		})
	})

	test('takeover denies every old-owner write including terminal, commit, external id and cancellation finalization', async () => {
		const { runs, first, locks, guard, key } = await seed('old-owner')
		await locks(100).acquire(key, guard.holder, 100)
		await runs.markRunStarted(first, 'log', guard)
		await runs.setRunExternalId(first, 'operation', undefined, guard)
		await locks(200).acquire(key, 'new-owner', 100)
		const before = await runs.getRun(first)
		expect(await runs.setRunExternalId(first, 'operation', { phase: 1 }, guard)).toBe(false)
		expect(await runs.checkpointRunProviderState(first, { phase: 1 }, guard)).toBe(false)
		expect(await runs.setRunCommit(first, 'abc', guard)).toBe(false)
		expect(await runs.markRunFinished(first, 'succeeded', 0, guard)).toBe(false)
		expect(await runs.getRun(first)).toEqual(before)
		await runs.beginRunCancellation(first)
		expect(await runs.markRunCancellationFinished(first, guard)).toBe(false)
		expect(await runs.markRunCancellationFinished(first, { ...guard, holder: 'new-owner', nowMs: 200 })).toBe(true)
	})

	test('checkpoint CAS rejects stale snapshots and preserves external id and commit immutability', async () => {
		const { runs, first, locks, guard, key } = await seed('checkpoint-cas')
		await locks(100).acquire(key, guard.holder, 100)
		await runs.markRunStarted(first, 'log', guard)
		expect(await runs.checkpointRunProviderState(first, { phase: 0 }, guard)).toBe(false)
		expect(await runs.setRunExternalId(first, 'operation', { phase: 0 }, guard)).toBe(true)
		const current = { ...guard, expectedProviderStateJson: '{"phase":0}' }
		expect(await runs.checkpointRunProviderState(first, { phase: 1 }, { ...current, expectedProviderStateJson: '{ "phase": 0 }' })).toBe(false)
		expect(await runs.setRunExternalId(first, 'other', undefined, current)).toBe(false)
		expect(await runs.setRunCommit(first, 'abc', current)).toBe(true)
		expect(await runs.setRunCommit(first, 'def', current)).toBe(false)
		expect(await runs.markRunFinished(first, 'succeeded', 0, guard)).toBe(false)
		expect(await runs.checkpointRunProviderState(first, { phase: 1 }, current)).toBe(true)
		expect(await runs.checkpointRunProviderState(first, { phase: 2 }, current)).toBe(false)
		expect(await runs.setRunExternalId(first, 'operation', { phase: 0 }, current)).toBe(false)
		expect(await runs.setRunCommit(first, 'abc', current)).toBe(false)
		const latest = { ...guard, expectedProviderStateJson: '{"phase":1}' }
		expect(await runs.checkpointRunProviderState(first, { phase: 2 }, { ...latest, nowMs: 200 })).toBe(false)
		expect((await runs.getRun(first))?.provider_state_json).toBe('{"phase":1}')
		expect(await runs.markRunFinished(first, 'succeeded', 0, latest)).toBe(true)
		expect(await runs.setRunCommit(first, 'abc', latest)).toBe(false)
		expect(await runs.setRunExternalId(first, 'operation', undefined, latest)).toBe(false)
	})

	test('cancellation blocks ordinary writes but only its fenced current snapshot may finalize', async () => {
		const { runs, first, second, locks, guard, key } = await seed('cancellation-fence')
		await locks(100).acquire(key, guard.holder, 100)
		await runs.markRunStarted(first, 'log', guard)
		await runs.setRunExternalId(first, 'operation', { phase: 0 }, guard)
		const current = { ...guard, expectedProviderStateJson: '{"phase":0}' }
		expect(await runs.markRunCancellationFinished(first, current)).toBe(false)
		await runs.beginRunCancellation(first)
		expect(await runs.setRunExternalId(first, 'operation', undefined, current)).toBe(false)
		expect(await runs.setRunCommit(first, 'abc', current)).toBe(false)
		expect(await runs.checkpointRunProviderState(first, { phase: 1 }, current)).toBe(false)
		expect(await runs.markRunFinished(first, 'succeeded', 0, current)).toBe(false)
		expect(await runs.markRunCancellationFinished(first, guard)).toBe(false)
		expect(await runs.markRunCancellationFinished(first, { ...current, nowMs: 200 })).toBe(false)
		expect(await runs.markRunCancellationFinished(first, current)).toBe(true)
		expect((await runs.getRun(first))?.status).toBe('failed')
		await runs.beginRunCancellation(second)
		expect(await runs.markRunStarted(second, 'log', guard)).toBe(false)
		expect(await runs.markRunCancellationFinished(second, guard)).toBe(true)
	})

	test('runner-success correction requires the current holder, expiry and exact checkpoint', async () => {
		const { runs, first, locks, guard, key } = await seed('runner-correction')
		await locks(100).acquire(key, guard.holder, 100)
		await runs.markRunStarted(first, 'log', guard)
		await runs.setRunExternalId(first, 'runner', { phase: 'accepted' }, guard)
		await runs.markRunFinished(first, 'succeeded', 0)
		const current = { ...guard, expectedProviderStateJson: '{"phase":"accepted"}' }
		expect(await runs.markRunFailedAfterRunner(first, guard)).toBe(false)
		expect(await runs.markRunFailedAfterRunner(first, { ...current, nowMs: 200 })).toBe(false)
		await locks(200).acquire(key, 'recovery', 100)
		expect(await runs.markRunFailedAfterRunner(first, current)).toBe(false)
		expect((await runs.getRun(first))?.status).toBe('succeeded')
		expect(await runs.markRunFailedAfterRunner(first, { ...current, holder: 'recovery', nowMs: 200 })).toBe(true)
		expect((await runs.getRun(first))?.finished_at).toBe(42)
	})
}
