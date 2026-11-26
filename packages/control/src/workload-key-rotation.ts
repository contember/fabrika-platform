// The maintenance pass that keeps an environment's workload keys valid without a deploy. A key with no more than
// `WORKLOAD_KEY_ROTATE_BELOW_SECONDS` left is re-issued and recorded as pending, IAM keeping the replaced one valid until
// its own expiry; the provider then writes every pending key to the version the environment runs. Only a write that
// landed, or a succeeded run that handed the key, clears the pending mark, so a failed write is retried by the next pass
// while the replaced key still works. Logs coordinates and counts only, never a key.

import type { DeployLocks } from '@fabrika/platform'
import type { ControlProvider, ProviderManagedCredentials } from '@fabrika/provider-contract'
import { approvedProviderAccess } from './approval/snapshot'
import type { ControlRepositories } from './db'
import { acquireLease, runLeaseKey } from './lease'
import { providerEnvironment } from './run-lifecycle'
import { type PendingWorkloadKey, WORKLOAD_KEY_ROTATE_BELOW_SECONDS, type WorkloadCredentialsPort } from './workload-credentials'

/** What one pass did, by environment and key counts. */
export interface WorkloadKeyRotationSummary {
	/** Keys written to the running version. */
	written: number
	/** Pending keys a succeeded run had handed already. */
	confirmed: number
	/** Environments left to the next pass: a run or another holder had the environment. */
	busy: number
	/** Environments whose renewal or write failed; their keys stay pending and the next pass tries again. */
	failed: number
}

export interface WorkloadKeyRotationDeps {
	readonly repositories: Pick<ControlRepositories, 'registry' | 'runs' | 'workloadCredentials'>
	readonly credentials: WorkloadCredentialsPort
	readonly provider: ControlProvider & { readonly managedCredentials: ProviderManagedCredentials }
	readonly locks: DeployLocks
	/** Unix seconds. */
	readonly now: () => number
}

export const NO_WORKLOAD_KEY_ROTATION: WorkloadKeyRotationSummary = { written: 0, confirmed: 0, busy: 0, failed: 0 }

/** The provider, when it writes managed credentials without a deploy. */
export function rotatingProvider(provider: ControlProvider | undefined): WorkloadKeyRotationDeps['provider'] | null {
	const managedCredentials = provider?.managedCredentials
	return provider === undefined || managedCredentials === undefined ? null : { ...provider, managedCredentials }
}

/**
 * Renew and hand the workload keys of every environment that has one near expiry or one its running version may not
 * hold. Each environment is worked under its `<app>:<env>` deploy lease, so no deploy reconciles its keys meanwhile.
 */
export async function rotateWorkloadKeys(deps: WorkloadKeyRotationDeps): Promise<WorkloadKeyRotationSummary> {
	const summary = { ...NO_WORKLOAD_KEY_ROTATION }
	const due = await deps.repositories.workloadCredentials.listDue(deps.now() + WORKLOAD_KEY_ROTATE_BELOW_SECONDS)
	for (const { app_id: appId, env } of due) {
		const lease = await acquireLease(deps.locks, runLeaseKey(appId, env))
		if (lease === null) {
			summary.busy++
			continue
		}
		try {
			const outcome = await rotateEnvironment(deps, appId, env, lease.signal, () => lease.assertHeld())
			if (outcome === 'busy') summary.busy++
			else {
				summary.written += outcome.written
				summary.confirmed += outcome.confirmed
			}
		} catch (error) {
			summary.failed++
			// The message only: an error object may carry a request, and so a key.
			console.error(
				`workload keys: ${appId}/${env} could not be renewed or handed to the running version, retried next pass: `
					+ (error instanceof Error ? error.message : 'unknown error'),
			)
		} finally {
			await lease.release()
		}
	}
	return summary
}

async function rotateEnvironment(
	deps: WorkloadKeyRotationDeps,
	appId: string,
	env: string,
	signal: AbortSignal,
	assertHeld: () => void,
): Promise<'busy' | { readonly written: number; readonly confirmed: number }> {
	const row = await deps.repositories.registry.getAppEnv(appId, env)
	if (row === null || row.kind === 'dev' || row.provider !== deps.provider.id) return { written: 0, confirmed: 0 }
	// A run still running after its holder's lease went (a Control restart) may be writing the Worker itself.
	if ((await deps.repositories.runs.listRuns({ appId, env, statuses: ['running'], limit: 1 })).length > 0) return 'busy'
	const contract = approvedProviderAccess(row).access?.contract ?? null
	const pending = await deps.credentials.renew(appId, env, contract, assertHeld)
	const handed: PendingWorkloadKey[] = []
	const unhanded: PendingWorkloadKey[] = []
	for (const key of pending) {
		const run = key.handedBy === null ? null : await deps.repositories.runs.getRun(key.handedBy)
		if (run?.status === 'succeeded') handed.push(key)
		else if (run === null || run.status === 'failed') unhanded.push(key)
		// Otherwise the run that handed it has not settled: its outcome decides, at a later pass.
	}
	await deps.credentials.confirm(appId, env, handed)
	if (unhanded.length === 0) return { written: 0, confirmed: handed.length }
	const values: Record<string, string> = {}
	for (const key of unhanded) {
		for (const variable of key.variables) values[variable] = key.key
	}
	assertHeld()
	await deps.provider.managedCredentials.write({ environment: await providerEnvironment(deps.repositories, row), values, signal })
	assertHeld()
	await deps.credentials.confirm(appId, env, unhanded)
	console.info(`workload keys: wrote ${unhanded.length} key(s) to the running version of ${appId}/${env}`)
	return { written: unhanded.length, confirmed: handed.length }
}
