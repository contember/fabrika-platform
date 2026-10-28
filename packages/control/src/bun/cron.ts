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

import { runBackupSchedule } from '../backups'
import { runMaintenance } from '../cron'
import { devSandboxDepsOf, maintainDevSandboxes, stopIdleDevServices } from '../dev/service'
import { reconcileProviderRuns } from '../provider-reconcile'
import { operationDeploys } from '../run-lifecycle'
import { buildRunDeps, iamSchemaDeps, locks, operationsReleaseDeps, opsTransportDeps, platformTransportDeps, repositories } from '../services'
import type { Runtime } from './runtime'

async function main(createRuntime: () => Runtime): Promise<void> {
	const runtime = createRuntime()
	const { opsTransport } = opsTransportDeps(runtime.env)
	const sandboxes = devSandboxDepsOf(runtime.env, runtime.provider)
	try {
		await runMaintenance(runtime.env, {
			// The same pass as the Worker's, for a provider that serves the data operations and a Control that holds ops keys.
			...(opsTransport === undefined || runtime.provider.dataOperations === undefined ? {} : {
				backups: async () =>
					await runBackupSchedule({
						repositories: repositories(runtime.env),
						lock: locks(runtime.env),
						ops: opsTransport,
						provider: runtime.provider,
						deploys: operationDeploys(await buildRunDeps(runtime.env, runtime.provider)),
					}),
			}),
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
			// A provider with workspace sandboxes parks and removes them; the one-service-per-environment path stops services.
			devIdle: async () => {
				const now = Math.floor(Date.now() / 1000)
				if (sandboxes !== undefined) return maintainDevSandboxes(sandboxes, now)
				const stopped = await stopIdleDevServices({ repositories: repositories(runtime.env), provider: runtime.provider }, now)
				return { ...stopped, parked: 0, removed: 0 }
			},
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
