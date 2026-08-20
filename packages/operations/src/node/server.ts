import { createBunHandler } from '@fabrika/app/bun'
import { operationsApp } from '../app.js'
import { createOperationsRuntime } from './runtime.js'

async function main(): Promise<void> {
	const runtime = createOperationsRuntime()
	const appHandler = createBunHandler(operationsApp, runtime.env, {
		onBackgroundError() {
			console.error('operations background task failed')
		},
	})
	const server = Bun.serve({
		port: runtime.port,
		// Bun closes an idle socket after 10s by default, and a handler that is still working counts as
		// idle — a slow upstream answered as an unattributable 502 instead of its own error.
		idleTimeout: 255,
		fetch: appHandler.fetch,
		error(): Response {
			console.error('operations server error')
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
			.then(() => appHandler.drain())
			.then(() => runtime.consumer.stop())
			.then(() => runtime.shutdown())
			.then(() => process.exit(0))
			.catch(() => {
				console.error('operations shutdown failed')
				process.exit(1)
			})
	}
	process.on('SIGTERM', () => stop('SIGTERM'))
	process.on('SIGINT', () => stop('SIGINT'))
}

if (import.meta.main) {
	main().catch(() => {
		console.error('operations failed to start')
		process.exit(1)
	})
}
