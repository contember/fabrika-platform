// The cron command — the process-side equivalent of the Worker's `scheduled` handler.
//
// On Cloudflare `triggers.crons` wakes the Worker and calls `scheduled()`. There is no such trigger for
// a plain container, so the platform cron (on Zerops `zerops.yaml` → `run.crontab`) runs this, which calls
// the same `runMaintenance` the Worker's handler calls. Nothing about the poll or the sweep lives here.
//
// It is a one-shot process, not a timer inside the server: a timer fires once per container (so it
// multiplies with horizontal scale) and its schedule silently resets on every redeploy. `allContainers:
// false` in the crontab entry keeps a horizontally-scaled service polling once.
//
// An installation's composition root runs it with its provider: `bun src/zerops/cron.ts`.

import { runMaintenance } from '../cron'
import { stopIdleDevServices } from '../dev/service'
import { reconcileProviderRuns } from '../provider-reconcile'
import { iamSchemaDeps, locks, operationsReleaseDeps, platformTransportDeps, repositories } from '../services'
import type { Runtime } from './runtime'

async function main(createRuntime: () => Runtime): Promise<void> {
	const runtime = createRuntime()
	try {
		await runMaintenance(runtime.env, {
			reconcile: () =>
				reconcileProviderRuns({
					repositories: repositories(runtime.env),
					provider: runtime.provider,
					runLogs: runtime.env.RUN_LOGS,
					lock: locks(runtime.env),
					operations: operationsReleaseDeps(runtime.env),
					...platformTransportDeps(runtime.env),
					...iamSchemaDeps(runtime.env),
				}),
			devIdle: () => stopIdleDevServices({ repositories: repositories(runtime.env), provider: runtime.provider }, Math.floor(Date.now() / 1000)),
		})
	} finally {
		await runtime.shutdown()
	}
}

/** The process entry of a composition root: one maintenance pass, or exit 1. */
export function runMaintenanceProcess(createRuntime: () => Runtime): void {
	// Never log the error object: it can carry a feed URL or a connection string.
	main(createRuntime).catch((err: unknown) => {
		console.error('maintenance failed:', err instanceof Error ? err.message : 'unknown error')
		process.exit(1)
	})
}
