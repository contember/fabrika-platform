import type { SqlDatabase } from '@fabrika/platform'
import { GitHubConnectionStore } from '../github-connection-store'
import { BuilderConnectionRepository } from './builder-connections'
import { OperationsCatalogRepository } from './operations-catalog'
import { OperationsReleaseRepository } from './operations-releases'
import { RepoPollingRepository } from './polling'
import { ControlRegistryRepository } from './registry'
import { RunRepository } from './runs'

/** Control-plane persistence capabilities selected together by a runtime composition root. */
export interface ControlRepositories {
	builderConnections: BuilderConnectionRepository
	registry: ControlRegistryRepository
	runs: RunRepository
	polling: RepoPollingRepository
	operationsCatalog: OperationsCatalogRepository
	operationsReleases: OperationsReleaseRepository
	githubConnections: GitHubConnectionStore
}

/** The portable repository bundle. */
export function createControlRepositories(db: SqlDatabase, options: { now?: () => number } = {}): ControlRepositories {
	const now = options.now ?? (() => Math.floor(Date.now() / 1000))
	return {
		builderConnections: new BuilderConnectionRepository(db, now),
		registry: new ControlRegistryRepository(db, now),
		runs: new RunRepository(db, now),
		polling: new RepoPollingRepository(db),
		operationsCatalog: new OperationsCatalogRepository(db, now),
		operationsReleases: new OperationsReleaseRepository(db, now),
		githubConnections: new GitHubConnectionStore(db, now),
	}
}
