// The local stack's Control process: the production entrypoint with the source transports pointed at the
// local fixtures, the GitHub double and the Zerops emulator. The origins Control addresses stay the
// production ones, and the seams are a composition input, never an environment variable (ADR-0029).
// Its provider registry adds `directory`, so the composition's mail transport is one Control can hand a deploy.
import { createRuntime, type RuntimeOverrides } from '@fabrika/control/zerops/runtime'
import { startControlServer } from '@fabrika/control/zerops/server'
import type { EmailProviderRegistry } from '@fabrika/email'
import { directoryEmailProvider } from '@fabrika/email/directory'
import { builtinEmailProviders } from '@fabrika/email/providers'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createGitHubDouble, localGitHubDoubleApps } from './github-double'
import {
	LOCAL_SOURCE_AGENT_CHANGE_ARCHIVE_FILE,
	LOCAL_SOURCE_AGENT_CHANGE_DIRECTORY,
	LOCAL_SOURCE_APPLICATION_ARCHIVE_FILE,
	LOCAL_SOURCE_APPLICATION_REPOSITORY,
	LOCAL_SOURCE_BRANCH_HEAD_FILE,
	LOCAL_SOURCE_FIXTURE_DIRECTORY,
	LOCAL_SOURCE_PLATFORM_ARCHIVE_FILE,
	LOCAL_SOURCE_PLATFORM_REPOSITORY,
	localSourceBranchHeadSchema,
} from './local-source-contract'
import { loadLocalSourceFixtures, readFixtureFiles } from './local-source-fixtures/fixture'
import { applicationFixtureSource } from './local-source-fixtures/generate'
import { createFixtureTransports } from './local-source-transports'
import { readLocalGitHubApps } from './source-connection-fixture'

/** The providers Control accepts here: the built-in ones and the composition's capture. */
export const LOCAL_CONTROL_EMAIL_PROVIDERS = { ...builtinEmailProviders, directory: directoryEmailProvider } satisfies EmailProviderRegistry

/**
 * The platform fixture is public, as a namespace proxy source must be. The application fixture is a
 * private repository of the first keyed connection's installation owner, so a deploy of it has to mint
 * an installation token through that connection's own App key.
 */
export async function localSourceSeams(stateDirectory: string): Promise<NonNullable<RuntimeOverrides['sourceSeams']>> {
	const fixtureDirectory = resolve(stateDirectory, LOCAL_SOURCE_FIXTURE_DIRECTORY)
	const manifest = await loadLocalSourceFixtures(fixtureDirectory)
	const github = await createGitHubDouble({
		apps: localGitHubDoubleApps(await readLocalGitHubApps(stateDirectory)),
		privateRepositories: [LOCAL_SOURCE_APPLICATION_REPOSITORY],
	})
	const transports = createFixtureTransports([
		{
			repository: LOCAL_SOURCE_PLATFORM_REPOSITORY,
			fixture: manifest.platform,
			archive: Bun.file(resolve(fixtureDirectory, LOCAL_SOURCE_PLATFORM_ARCHIVE_FILE)),
			visibility: 'public',
		},
		{
			repository: LOCAL_SOURCE_APPLICATION_REPOSITORY,
			fixture: manifest.application,
			archive: Bun.file(resolve(fixtureDirectory, LOCAL_SOURCE_APPLICATION_ARCHIVE_FILE)),
			visibility: 'private',
			// Control reads the contract and the migrations file by file, at the commit (ADR-0050).
			files: readFixtureFiles(manifest.application, await applicationFixtureSource()),
		},
		// The agent's commit on top of it, which the `notes-agent-change` browser seed pushes.
		{
			repository: LOCAL_SOURCE_APPLICATION_REPOSITORY,
			fixture: manifest.agentChange,
			archive: Bun.file(resolve(fixtureDirectory, LOCAL_SOURCE_AGENT_CHANGE_ARCHIVE_FILE)),
			visibility: 'private',
			files: readFixtureFiles(manifest.agentChange, await applicationFixtureSource(resolve(fixtureDirectory, LOCAL_SOURCE_AGENT_CHANGE_DIRECTORY))),
		},
	], {
		access: github,
		// Read at every lookup: a push moves the branch while Control runs.
		branchHead: (repository) => {
			const path = resolve(stateDirectory, LOCAL_SOURCE_BRANCH_HEAD_FILE)
			if (repository !== LOCAL_SOURCE_APPLICATION_REPOSITORY || !existsSync(path)) return undefined
			return localSourceBranchHeadSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).commitSha
		},
	})
	return { ...transports, githubAppFetch: github.appFetch }
}

async function main(): Promise<void> {
	const sourceSeams = await localSourceSeams(resolve(import.meta.dir, '..', '.state'))
	await startControlServer(createRuntime(process.env, { sourceSeams, emailProviders: LOCAL_CONTROL_EMAIL_PROVIDERS }))
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error('local control failed to start:', error instanceof Error ? error.message : 'unknown error')
		process.exit(1)
	})
}
