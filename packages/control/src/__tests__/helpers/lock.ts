import { type DeployLocks, SqlDeployLocks } from '@fabrika/platform'
import type { JsonValue } from '@fabrika/provider-contract'
import type { AppliedOperationsIngestConfig, ControlRepositories, DeploymentNamespaceState, RunRepository } from '../../db'
import { CATALOG_LEASE_KEY, LEASE_TTL_MS, type LeaseFence, namespaceLeaseKey, runLeaseKey } from '../../lease'
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
		park: (id: string, classificationJson: string) => owned(id, (fence) => runs.parkRunForApproval(id, classificationJson, fence)),
		snapshot: (id: string, snapshotJson: string, hasContract = false) =>
			owned(id, (fence) => runs.recordRunSnapshot(id, snapshotJson, hasContract, fence)),
		publish: (id: string, expected: Parameters<RunRepository['publishRunSnapshot']>[1]) =>
			owned(id, (fence) => runs.publishRunSnapshot(id, expected, fence)),
		approve: (id: string, classificationJson: string, approvalJson: string) =>
			owned(id, (fence) => runs.approveParkedRun(id, classificationJson, approvalJson, fence)),
		reject: (id: string, classificationJson: string) => owned(id, (fence) => runs.rejectParkedRun(id, classificationJson, fence)),
	}
}

/** Write a namespace row the way its lease holder does: take the lease as a fixture holder, one fenced write, release. */
export async function fixtureNamespaceWrite(
	repositories: ControlRepositories,
	id: string,
	state: DeploymentNamespaceState,
	options: { providerTargetJson?: string; lastError?: string } = {},
): Promise<void> {
	const row = await repositories.registry.getDeploymentNamespace(id)
	if (row === null) throw new Error(`fixture namespace ${id} is missing`)
	const locks = makeFakeLock(repositories)
	const key = namespaceLeaseKey(id)
	const holder = `fixture-${id}`
	if (!(await locks.acquire(key, holder, LEASE_TTL_MS))) throw new Error(`fixture lease ${key} is held`)
	try {
		const written = await repositories.registry.writeDeploymentNamespace({
			id,
			createdAt: row.created_at,
			fence: { holder, nowMs: Date.now() },
			providerTargetJson: options.providerTargetJson ?? row.provider_target_json,
			state,
			lastError: options.lastError ?? null,
			claim: true,
		})
		if (!written) throw new Error(`fixture namespace ${id} write was refused`)
	} finally {
		await locks.release(key, holder)
	}
}

/** Record a catalog reconcile the way its lease holder does: take the catalog lease as a fixture holder, one fenced write, release. */
export async function fixtureCatalogApplied(
	repositories: ControlRepositories,
	revision: number,
	snapshotHash: string,
	configs: readonly AppliedOperationsIngestConfig[],
): Promise<void> {
	const locks = makeFakeLock(repositories)
	const holder = 'fixture-catalog'
	if (!(await locks.acquire(CATALOG_LEASE_KEY, holder, LEASE_TTL_MS))) throw new Error('fixture catalog lease is held')
	try {
		const written = await repositories.operationsCatalog.markApplied(revision, snapshotHash, configs, { holder, nowMs: Date.now() })
		if (!written) throw new Error('fixture catalog write was refused')
	} finally {
		await locks.release(CATALOG_LEASE_KEY, holder)
	}
}
