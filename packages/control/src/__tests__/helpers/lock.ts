import { type DeployLocks, SqlDeployLocks } from '@fabrika/platform'
import type { JsonValue } from '@fabrika/provider-contract'
import type { ControlRepositories, RunRepository } from '../../db'
import { LEASE_TTL_MS, type LeaseFence, runLeaseKey } from '../../lease'
import { harnessDatabase } from './harness'

/** The production lease store over a test harness's database. */
export function makeFakeLock(repositories: ControlRepositories): SqlDeployLocks {
	return new SqlDeployLocks(harnessDatabase(repositories))
}

/** Every lease row still held in a harness database. */
export async function heldLeases(repositories: ControlRepositories): Promise<{ lock_key: string; holder: string }[]> {
	const { results } = await harnessDatabase(repositories).prepare('SELECT lock_key, holder FROM deploy_locks ORDER BY lock_key')
		.all<{ lock_key: string; holder: string }>()
	return results
}

/**
 * Seed run lifecycle state the way a lease holder writes it: take the run's lease as a short-lived
 * fixture holder, apply one fenced write, release. Throws when a live holder owns the lease.
 */
export function fixtureRuns(runs: RunRepository, locks: DeployLocks, now: () => number = Date.now) {
	const owned = async (id: string, write: (fence: LeaseFence) => Promise<boolean>): Promise<boolean> => {
		const run = await runs.getRun(id)
		if (run === null) throw new Error(`fixture run ${id} is missing`)
		const key = runLeaseKey(run.app_id, run.env)
		const holder = `fixture-${id}`
		if (!(await locks.acquire(key, holder, LEASE_TTL_MS))) throw new Error(`fixture lease ${key} is held`)
		try {
			return await write({ holder, nowMs: now() })
		} finally {
			await locks.release(key, holder)
		}
	}
	return {
		start: (id: string, logKey = 'logs') => owned(id, (fence) => runs.markRunStarted(id, logKey, fence)),
		externalId: (id: string, externalId: string, state?: JsonValue) =>
			owned(id, (fence) => runs.recordInitialRunExternalId(id, externalId, state, fence)),
		checkpoint: (id: string, state: JsonValue) => owned(id, (fence) => runs.checkpointRunProviderState(id, state, fence)),
		commit: (id: string, commitSha: string) => owned(id, (fence) => runs.setRunCommit(id, commitSha, fence)),
		finish: (id: string, status: 'succeeded' | 'failed', exitCode: number | null = null) =>
			owned(id, (fence) => runs.markRunFinished(id, status, exitCode, fence)),
		finishCancellation: (id: string, status: 'succeeded' | 'failed') => owned(id, (fence) => runs.markRunCancellationFinished(id, status, fence)),
	}
}
