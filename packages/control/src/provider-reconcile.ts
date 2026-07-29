import type { ControlProvider } from '@fabrika/provider-contract'
import type { Db } from './db'
import { providerEnvironment } from './run-lifecycle'

export interface ProviderReconcileSummary {
	checked: number
	succeeded: number
	failed: number
	inProgress: number
	waiting: number
}

export interface ProviderReconcileDeps {
	database: Pick<Db, 'getAppEnv' | 'getDeploymentNamespace' | 'listInFlightRuns' | 'markRunFinished'>
	provider: ControlProvider
	releaseLock: (key: string, holder: string) => Promise<void>
}

/** Reconcile provider-owned deploys after the process that started them has gone away. */
export async function reconcileProviderRuns(deps: ProviderReconcileDeps): Promise<ProviderReconcileSummary> {
	const runs = await deps.database.listInFlightRuns(deps.provider.id)
	const summary: ProviderReconcileSummary = {
		checked: 0,
		succeeded: 0,
		failed: 0,
		inProgress: 0,
		waiting: 0,
	}

	for (const run of runs) {
		if (run.external_run_id === null) {
			summary.waiting++
			continue
		}

		const reconcile = deps.provider.reconcile
		if (reconcile === undefined) {
			summary.inProgress++
			continue
		}

		const appEnv = await deps.database.getAppEnv(run.app_id, run.env)
		if (appEnv === null) {
			throw new Error(`provider environment ${run.app_id}/${run.env} disappeared during reconciliation`)
		}
		const outcome = await reconcile({
			runId: run.id,
			externalId: run.external_run_id,
			environment: await providerEnvironment(deps.database, appEnv),
		})
		summary.checked++

		if (outcome.state === 'running') {
			summary.inProgress++
			continue
		}

		await deps.database.markRunFinished(run.id, outcome.state, outcome.exitCode ?? null)
		await deps.releaseLock(`${run.app_id}:${run.env}`, run.id)
		summary[outcome.state]++
	}

	return summary
}
