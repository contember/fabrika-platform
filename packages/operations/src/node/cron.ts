import { createOperationsRuntime } from './runtime.js'

async function main(): Promise<void> {
	const runtime = createOperationsRuntime()
	try {
		const result = await runtime.maintenance.run()
		console.info(`operations maintenance: pruned=${result.prunedClaims} notifications=${result.notifications}`)
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
