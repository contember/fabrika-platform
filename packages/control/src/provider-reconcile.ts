import { logSettlement, type RunDeps, RunInvocation, type RunSettleDeps, settleUnfinishedRun } from './run-lifecycle'

export interface ProviderReconcileSummary {
	checked: number
	succeeded: number
	failed: number
	inProgress: number
	waiting: number
}

export type ProviderReconcileDeps = RunSettleDeps & Pick<RunDeps, 'lock' | 'leaseClock'>

export async function reconcileProviderRuns(deps: ProviderReconcileDeps): Promise<ProviderReconcileSummary> {
	const summary: ProviderReconcileSummary = { checked: 0, succeeded: 0, failed: 0, inProgress: 0, waiting: 0 }
	for (const candidate of await deps.repositories.runs.listInFlightRuns(deps.provider.id)) {
		const invocation = await RunInvocation.acquire(deps, candidate)
		if (invocation === null) {
			summary.inProgress++
			continue
		}
		try {
			const settled = await settleUnfinishedRun(deps, invocation)
			if (settled === 'waiting') summary.waiting++
			else if (settled === 'untracked') summary.inProgress++
			else if (settled !== null) {
				summary.checked++
				if (settled === 'running') summary.inProgress++
				else summary[settled]++
			}
		} catch {
			console.error(`provider reconcile failed for run ${candidate.id}`)
			summary.checked++
			summary.inProgress++
		} finally {
			await invocation.release().catch(() => console.error(`provider reconcile lock release failed for run ${candidate.id}`))
		}
	}
	return summary
}

export async function sweepStaleRuns(
	deps: Pick<RunDeps, 'repositories' | 'lock' | 'leaseClock' | 'runLogs'>,
	maxAgeSeconds: number,
	now: () => number = () => Math.floor(Date.now() / 1000),
): Promise<number> {
	let swept = 0
	for (const candidate of await deps.repositories.runs.listStaleRuns(maxAgeSeconds)) {
		const invocation = await RunInvocation.acquire(deps, candidate)
		if (invocation === null) continue
		try {
			const run = await invocation.read()
			if (
				run === null || (run.status !== 'pending' && run.status !== 'running') || run.external_run_id !== null || run.cancel_requested_at !== null
				|| (run.started_at ?? run.created_at) >= now() - maxAgeSeconds
			) continue
			await logSettlement(
				deps,
				run,
				`deploy failed: no provider accepted the run within ${Math.round(maxAgeSeconds / 60)} minutes of its start; run the deploy again`,
			)
			await invocation.write((fence) => deps.repositories.runs.markRunFinished(run.id, 'failed', null, fence))
			swept++
		} finally {
			await invocation.release()
		}
	}
	return swept
}
