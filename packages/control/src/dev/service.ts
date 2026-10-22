// The service of a `dev` environment outside a run: maintenance stops it once no commit reached it for a while, and the
// next commit, bind or reset starts it again. Neither is a deploy, so neither takes the namespace lease.

import type { ControlProvider } from '@fabrika/provider-contract'
import type { ControlRepositories, DevEnvironmentRow } from '../db'
import { providerEnvironment } from '../run-lifecycle'

/** How long a `dev` environment runs with no sync before maintenance stops it. */
export const DEV_IDLE_STOP_SECONDS = 30 * 60

export interface DevServiceDeps {
	readonly repositories: Pick<ControlRepositories, 'registry' | 'runs' | 'devEnvironments'>
	readonly provider: Pick<ControlProvider, 'devEnvironments'>
}

export interface DevIdleSummary {
	readonly stopped: number
	readonly failed: number
}

/** Start the service when maintenance recorded it stopped. A provider without dev environments has nothing to start. */
export async function startDevService(deps: DevServiceDeps, row: DevEnvironmentRow, signal: AbortSignal): Promise<void> {
	const capability = deps.provider.devEnvironments
	if (row.stopped_at === null || capability === undefined) return
	const appEnv = await deps.repositories.registry.getAppEnv(row.app_id, row.env)
	if (appEnv === null) return
	await capability.start({ environment: await providerEnvironment(deps.repositories, appEnv), signal })
	await deps.repositories.devEnvironments.markStarted(row.app_id, row.env)
}

/** Stop every bound `dev` environment that saw no activity for `idleSeconds`. One failure does not stop the others. */
export async function stopIdleDevServices(deps: DevServiceDeps, now: number, idleSeconds = DEV_IDLE_STOP_SECONDS): Promise<DevIdleSummary> {
	const capability = deps.provider.devEnvironments
	if (capability === undefined) return { stopped: 0, failed: 0 }
	const before = now - idleSeconds
	let stopped = 0
	let failed = 0
	for (const row of await deps.repositories.devEnvironments.listIdle(before)) {
		try {
			const appEnv = await deps.repositories.registry.getAppEnv(row.app_id, row.env)
			if (appEnv === null) continue
			// Recorded first: a commit that arrives meanwhile sees the service as stopped and starts it again.
			if (!await deps.repositories.devEnvironments.markStopped(row.app_id, row.env, before)) continue
			await capability.stop({ environment: await providerEnvironment(deps.repositories, appEnv), signal: AbortSignal.timeout(60_000) })
			stopped += 1
		} catch {
			// Never the error object: a provider failure may carry a request detail.
			console.error(`dev environments: stopping ${row.app_id}/${row.env} failed; the next maintenance pass retries`)
			await deps.repositories.devEnvironments.clearStopped(row.app_id, row.env).catch(() => {})
			failed += 1
		}
	}
	return { stopped, failed }
}
