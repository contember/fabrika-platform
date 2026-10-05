import { resolve } from 'node:path'
import { LOCAL_SOURCE_FIXTURE_DIRECTORY } from '../local-source-contract'
import { createLocalSourceRuntime } from './runtime'

async function main(): Promise<void> {
	const runtime = await createLocalSourceRuntime({
		fixtureDirectory: resolve(import.meta.dir, '../../.state', LOCAL_SOURCE_FIXTURE_DIRECTORY),
		env: process.env,
	})
	const server = Bun.serve({
		port: runtime.port,
		idleTimeout: 255,
		fetch: request => runtime.service.fetch(request),
		error: () => new Response('internal error', { status: 500 }),
	})
	console.info(`fabrika local source listening on :${server.port}`)
	let stopping = false
	const stop = (): void => {
		if (stopping) return
		stopping = true
		void server.stop(false).then(() => process.exit(0)).catch(() => {
			console.error('local source shutdown failed')
			process.exit(1)
		})
	}
	process.on('SIGTERM', stop)
	process.on('SIGINT', stop)
}

if (import.meta.main) {
	main().catch(() => {
		console.error('fabrika local source failed to start')
		process.exit(1)
	})
}
