import { createSourceRuntime, type SourceEnvironment, type SourceRuntime, type SourceUploadFetch } from '@fabrika/source-zerops'
import { resolve } from 'node:path'
import {
	LOCAL_SOURCE_APPLICATION_ARCHIVE_FILE,
	LOCAL_SOURCE_APPLICATION_REPOSITORY,
	LOCAL_SOURCE_PLATFORM_ARCHIVE_FILE,
	LOCAL_SOURCE_PLATFORM_REPOSITORY,
} from '../local-source-contract'
import { loadLocalSourceFixtures } from '../local-source-fixtures/fixture'
import { createFixtureTransports } from './transports'

export async function createLocalSourceRuntime(input: {
	fixtureDirectory: string
	env: SourceEnvironment
	uploadFetch?: SourceUploadFetch
}): Promise<SourceRuntime> {
	const manifest = await loadLocalSourceFixtures(input.fixtureDirectory)
	const transports = createFixtureTransports([
		{
			repository: LOCAL_SOURCE_PLATFORM_REPOSITORY,
			fixture: manifest.platform,
			archive: Bun.file(resolve(input.fixtureDirectory, LOCAL_SOURCE_PLATFORM_ARCHIVE_FILE)),
		},
		{
			repository: LOCAL_SOURCE_APPLICATION_REPOSITORY,
			fixture: manifest.application,
			archive: Bun.file(resolve(input.fixtureDirectory, LOCAL_SOURCE_APPLICATION_ARCHIVE_FILE)),
		},
	], input.uploadFetch)
	return await createSourceRuntime({
		env: input.env,
		...transports,
		githubFetch: async () => new Response(null, { status: 404 }),
	})
}
