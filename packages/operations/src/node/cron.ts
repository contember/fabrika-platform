import type { SecurityAlertProductionResult } from '../security-alerts.js'
import { createOperationsRuntime } from './runtime.js'

async function main(): Promise<void> {
	const runtime = createOperationsRuntime()
	try {
		const health = await runtime.health.run()
		const notifications = await runtime.maintenance.run()
		console.info(
			`operations maintenance: checks=${health.recordedChecks}/${health.claimedChecks} `
				+ `unavailable=${health.unavailableChecks} cancelled=${health.cancelledChecks} `
				+ `telemetry=${health.recordedTelemetry} transitions=${health.transitions} `
				+ `alerts=${health.enqueuedAlerts} errors=${health.errors} `
				+ `spikes=${notifications.spikes.enqueued}/${notifications.spikes.evaluated} `
				+ `security=${securitySummary(notifications.security)} `
				+ `pruned=${notifications.prunedClaims} notifications=${notifications.notifications}`,
		)
	} finally {
		await runtime.shutdown()
	}
}

function securitySummary(result: SecurityAlertProductionResult): string {
	if (result.status === 'evaluated') return String(result.enqueued)
	return result.status === 'skipped' ? `skipped:${result.reason}` : result.status
}

if (import.meta.main) {
	main().catch(() => {
		console.error('operations maintenance failed')
		process.exit(1)
	})
}
