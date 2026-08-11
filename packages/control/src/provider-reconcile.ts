import type { ControlProvider } from '@fabrika/provider-contract'
import { type ControlRepositories, parseProviderJson } from './db'
import type { OperationsReleaseProjectionDeps } from './operations-releases'
import { projectedReturnOrigins } from './return-origins'
import { projectTerminalRun, providerEnvironment } from './run-lifecycle'

export interface ProviderReconcileSummary {
	checked: number
	succeeded: number
	failed: number
	inProgress: number
	waiting: number
}

export interface ProviderReconcileDeps {
	repositories: ControlRepositories
	provider: ControlProvider
	releaseLock: (key: string, holder: string) => Promise<void>
	operations?: OperationsReleaseProjectionDeps
}

/** Reconcile provider-owned deploys after the process that started them has gone away. */
export async function reconcileProviderRuns(deps: ProviderReconcileDeps): Promise<ProviderReconcileSummary> {
	const runs = await deps.repositories.runs.listInFlightRuns(deps.provider.id)
	const summary: ProviderReconcileSummary = {
		checked: 0,
		succeeded: 0,
		failed: 0,
		inProgress: 0,
		waiting: 0,
	}

	for (const run of runs) {
		if (run.cancel_requested_at !== null) {
			if (run.external_run_id !== null && deps.provider.cancel !== undefined) {
				const appEnv = await deps.repositories.registry.getAppEnv(run.app_id, run.env)
				if (appEnv === null) {
					throw new Error(`provider environment ${run.app_id}/${run.env} disappeared during cancellation`)
				}
				await deps.provider.cancel({
					runId: run.id,
					externalId: run.external_run_id,
					environment: await providerEnvironment(deps.repositories.registry, appEnv),
					...(run.provider_state_json === null
						? {}
						: { providerState: parseProviderJson(run.provider_state_json, `provider state for run ${run.id}`) }),
				})
			}
			summary.checked++
			if (await deps.repositories.runs.markRunCancellationFinished(run.id)) {
				await projectTerminalRun(deps, run.id, false, 'failed')
				await deps.releaseLock(`${run.app_id}:${run.env}`, run.id)
				summary.failed++
			} else {
				summary.inProgress++
			}
			continue
		}

		if (run.external_run_id === null) {
			summary.waiting++
			continue
		}

		const reconcile = deps.provider.reconcile
		if (reconcile === undefined) {
			summary.inProgress++
			continue
		}

		const appEnv = await deps.repositories.registry.getAppEnv(run.app_id, run.env)
		if (appEnv === null) {
			throw new Error(`provider environment ${run.app_id}/${run.env} disappeared during reconciliation`)
		}
		// A provider that finishes a resumed deploy runs the same IAM touchpoint the deploy would have,
		// so it needs the same projected set — assembled here, where the registry is reachable.
		const returnOrigins = await projectedReturnOrigins(deps.repositories.registry, run.app_id)
		const outcome = await reconcile({
			runId: run.id,
			externalId: run.external_run_id,
			environment: await providerEnvironment(deps.repositories.registry, appEnv),
			...(run.provider_state_json === null
				? {}
				: { providerState: parseProviderJson(run.provider_state_json, `provider state for run ${run.id}`) }),
			...(returnOrigins === undefined ? {} : { returnOrigins }),
		})
		summary.checked++

		if (outcome.state === 'running') {
			summary.inProgress++
			continue
		}

		if (!(await deps.repositories.runs.markRunFinished(run.id, outcome.state, outcome.exitCode ?? null))) {
			summary.inProgress++
			continue
		}
		await projectTerminalRun(deps, run.id, false, outcome.state)
		await deps.releaseLock(`${run.app_id}:${run.env}`, run.id)
		summary[outcome.state]++
	}

	return summary
}
