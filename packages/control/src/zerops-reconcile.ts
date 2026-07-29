import { createZeropsApi, ZEROPS_ACTIVE, ZEROPS_TERMINAL, type ZeropsApi } from '@fabrika/engine'
import type { Db } from './db'
import type { Env } from './env'
import { db, locks } from './services'

type ReconcileApi = Pick<ZeropsApi, 'getAppVersion'>

export interface ZeropsReconcileSummary {
	checked: number
	succeeded: number
	failed: number
	inProgress: number
	waiting: number
}

export interface ZeropsReconcileDeps {
	database: Pick<Db, 'listInFlightZeropsRuns' | 'markRunFinished'>
	api?: ReconcileApi
	releaseLock: (key: string, holder: string) => Promise<void>
}

/**
 * Reconcile platform-owned deploys after the process that started them has gone away.
 *
 * A run without an app-version id is still owned by the queue consumer. Once the id is stored,
 * Zerops owns the work and this poller is the only writer of its terminal state.
 */
export async function reconcileZeropsRuns(deps: ZeropsReconcileDeps): Promise<ZeropsReconcileSummary> {
	const runs = await deps.database.listInFlightZeropsRuns()
	const summary: ZeropsReconcileSummary = {
		checked: 0,
		succeeded: 0,
		failed: 0,
		inProgress: 0,
		waiting: 0,
	}

	for (const run of runs) {
		if (run.platform_run_id === null) {
			summary.waiting++
			continue
		}
		if (deps.api === undefined) {
			throw new Error('ZEROPS_ACCESS_TOKEN is not configured')
		}

		const version = await deps.api.getAppVersion({
			appVersionId: run.platform_run_id,
			signal: new AbortController().signal,
		})
		summary.checked++

		if (version.status === ZEROPS_ACTIVE) {
			await deps.database.markRunFinished(run.id, 'succeeded', null)
			await deps.releaseLock(`${run.app_id}:${run.env}`, run.id)
			summary.succeeded++
			continue
		}
		if (version.status !== undefined && ZEROPS_TERMINAL.has(version.status)) {
			await deps.database.markRunFinished(run.id, 'failed', null)
			await deps.releaseLock(`${run.app_id}:${run.env}`, run.id)
			summary.failed++
			continue
		}
		summary.inProgress++
	}

	return summary
}

/** Assemble the production dependencies without requiring a token when there is nothing to poll. */
export function reconcileZeropsRunsFromEnv(env: Env): Promise<ZeropsReconcileSummary> {
	const accessToken = env.ZEROPS_ACCESS_TOKEN
	const api = accessToken === undefined || accessToken === ''
		? undefined
		: createZeropsApi({ token: accessToken, baseUrl: env.ZEROPS_API_BASE_URL })
	return reconcileZeropsRuns({
		database: db(env),
		...(api !== undefined ? { api } : {}),
		releaseLock: (key, holder) => locks(env).release(key, holder),
	})
}
