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
				+ `pruned=${notifications.prunedClaims} notifications=${notifications.notifications}`,
		)
	} finally {
		await runtime.shutdown()
	}
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error('operations maintenance failed:', error instanceof Error ? error.message : 'unknown error')
		process.exit(1)
	})
}
