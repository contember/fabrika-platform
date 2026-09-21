import type { SqlDatabase } from '@fabrika/platform'
import { GitHubConnectionStore } from '../github-connection-store'
import { OperationsCatalogRepository } from './operations-catalog'
import { OperationsReleaseRepository } from './operations-releases'
import { RepoPollingRepository } from './polling'
import { ControlRegistryRepository } from './registry'
import { RunRepository } from './runs'

/** Control-plane persistence capabilities selected together by a runtime composition root. */
export interface ControlRepositories {
	registry: ControlRegistryRepository
	runs: RunRepository
	polling: RepoPollingRepository
	operationsCatalog: OperationsCatalogRepository
	operationsReleases: OperationsReleaseRepository
	githubConnections: GitHubConnectionStore
}

/** The portable repository bundle. A composition root may replace one complete capability. */
export function createControlRepositories(
	db: SqlDatabase,
	options: {
		now?: () => number
		replacements?: Partial<ControlRepositories>
	} = {},
): ControlRepositories {
	const now = options.now ?? (() => Math.floor(Date.now() / 1000))
	const replacements = options.replacements ?? {}
	return {
		registry: replacements.registry ?? new ControlRegistryRepository(db, now),
		runs: replacements.runs ?? new RunRepository(db, now),
		polling: replacements.polling ?? new RepoPollingRepository(db),
		operationsCatalog: replacements.operationsCatalog ?? new OperationsCatalogRepository(db, now),
		operationsReleases: replacements.operationsReleases ?? new OperationsReleaseRepository(db, now),
		githubConnections: replacements.githubConnections ?? new GitHubConnectionStore(db, now),
	}
}
