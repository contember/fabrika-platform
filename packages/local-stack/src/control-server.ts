// The local stack's Control process: the production entrypoint with the source transports pointed at the
// local fixtures and the Zerops emulator. The origins Control addresses stay the production ones (ADR-0029).
import { createRuntime } from '@fabrika/control/node/runtime'
import { startControlServer } from '@fabrika/control/node/server'
import { resolve } from 'node:path'
import {
	LOCAL_SOURCE_APPLICATION_ARCHIVE_FILE,
	LOCAL_SOURCE_APPLICATION_REPOSITORY,
	LOCAL_SOURCE_FIXTURE_DIRECTORY,
	LOCAL_SOURCE_PLATFORM_ARCHIVE_FILE,
	LOCAL_SOURCE_PLATFORM_REPOSITORY,
} from './local-source-contract'
import { loadLocalSourceFixtures } from './local-source-fixtures/fixture'
import { createFixtureTransports } from './local-source-transports'

async function main(): Promise<void> {
	const fixtureDirectory = resolve(import.meta.dir, '..', '.state', LOCAL_SOURCE_FIXTURE_DIRECTORY)
	const manifest = await loadLocalSourceFixtures(fixtureDirectory)
	const transports = createFixtureTransports([
		{
			repository: LOCAL_SOURCE_PLATFORM_REPOSITORY,
			fixture: manifest.platform,
			archive: Bun.file(resolve(fixtureDirectory, LOCAL_SOURCE_PLATFORM_ARCHIVE_FILE)),
		},
		{
			repository: LOCAL_SOURCE_APPLICATION_REPOSITORY,
			fixture: manifest.application,
			archive: Bun.file(resolve(fixtureDirectory, LOCAL_SOURCE_APPLICATION_ARCHIVE_FILE)),
		},
	])
	// No GitHub App is reachable locally; a private operation fails closed instead of calling out.
	const githubAppFetch = async (): Promise<Response> => new Response(null, { status: 404 })
	await startControlServer(createRuntime(process.env, { sourceSeams: { ...transports, githubAppFetch } }))
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error('local control failed to start:', error instanceof Error ? error.message : 'unknown error')
		process.exit(1)
	})
}
