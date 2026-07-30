import { createOperationsFetchHandler } from '../http.js'
import { createOperationsRuntime } from './runtime.js'

async function main(): Promise<void> {
	const runtime = createOperationsRuntime()
	const server = Bun.serve({
		port: runtime.port,
		fetch: createOperationsFetchHandler(runtime.env),
		error(error: unknown): Response {
			console.error('operations server error:', error instanceof Error ? error.message : 'unknown error')
			return Response.json({ error: 'internal error' }, { status: 500 })
		},
	})
	runtime.consumer.start()
	console.info(`operations listening on :${server.port}`)

	let stopping = false
	const stop = (signal: string): void => {
		if (stopping) return
		stopping = true
		console.info(`operations shutting down (${signal})`)
		void server.stop(false)
			.then(() => runtime.consumer.stop())
			.then(() => runtime.shutdown())
			.then(() => process.exit(0))
			.catch((error: unknown) => {
				console.error('operations shutdown failed:', error instanceof Error ? error.message : 'unknown error')
				process.exit(1)
			})
	}
	process.on('SIGTERM', () => stop('SIGTERM'))
	process.on('SIGINT', () => stop('SIGINT'))
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error('operations failed to start:', error instanceof Error ? error.message : 'unknown error')
		process.exit(1)
	})
}
