import { createSourceRuntime } from './config'

async function main(): Promise<void> {
	const runtime = await createSourceRuntime()
	const server = Bun.serve({
		port: runtime.port,
		// Bun closes an idle socket after 10s by default, and a handler that is still working counts as
		// idle — a slow upstream answered as an unattributable 502 instead of its own error.
		idleTimeout: 255,
		fetch: (request) => runtime.service.fetch(request),
		error(): Response {
			console.error('source server request failed')
			return new Response('internal error', {
				status: 500,
				headers: { 'content-type': 'text/plain; charset=utf-8' },
			})
		},
	})
	console.info(
		`fabrika source listening on :${server.port} (github-app=${runtime.githubEnabled ? 'enabled' : 'disabled'})`,
	)

	let stopping = false
	const stop = (signal: string): void => {
		if (stopping) return
		stopping = true
		console.info(`fabrika source shutting down (${signal})`)
		void server
			.stop(false)
			.then(() => process.exit(0))
			.catch(() => {
				console.error('source shutdown failed')
				process.exit(1)
			})
	}
	process.on('SIGTERM', () => stop('SIGTERM'))
	process.on('SIGINT', () => stop('SIGINT'))
}

if (import.meta.main) {
	main().catch(() => {
		console.error('fabrika source failed to start')
		process.exit(1)
	})
}
