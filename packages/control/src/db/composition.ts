import type { SqlDatabase } from '@fabrika/platform'
import { GitHubConnectionStore } from '../github/connections/store'
import { BuilderConnectionRepository } from './builder-connections'
import { DataOperationRepository } from './data-operations'
import { DevEnvironmentRepository } from './dev-environments'
import { MailMessageRepository } from './mail-messages'
import { MailRuleRepository } from './mail-rules'
import { MembershipKeyRepository } from './membership-keys'
import { OperationsCatalogRepository } from './operations-catalog'
import { OperationsReleaseRepository } from './operations-releases'
import { PlatformTransportKeyRepository } from './platform-transport-keys'
import { RepoPollingRepository } from './polling'
import { ControlRegistryRepository } from './registry'
import { RunRepository } from './runs'
import { TokenKeyRepository } from './token-keys'
import { WorkloadCredentialRepository } from './workload-credentials'
import { WorkspaceRepository } from './workspaces'

/** Control-plane persistence capabilities selected together by a runtime composition root. */
export interface ControlRepositories {
	builderConnections: BuilderConnectionRepository
	registry: ControlRegistryRepository
	runs: RunRepository
	polling: RepoPollingRepository
	operationsCatalog: OperationsCatalogRepository
	operationsReleases: OperationsReleaseRepository
	githubConnections: GitHubConnectionStore
	workspaces: WorkspaceRepository
	devEnvironments: DevEnvironmentRepository
	workloadCredentials: WorkloadCredentialRepository
	membershipKeys: MembershipKeyRepository
	tokenKeys: TokenKeyRepository
	platformTransportKeys: PlatformTransportKeyRepository
	mailMessages: MailMessageRepository
	mailRules: MailRuleRepository
	dataOperations: DataOperationRepository
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
		workspaces: new WorkspaceRepository(db, now),
		devEnvironments: new DevEnvironmentRepository(db, now),
		workloadCredentials: new WorkloadCredentialRepository(db),
		membershipKeys: new MembershipKeyRepository(db),
		tokenKeys: new TokenKeyRepository(db),
		platformTransportKeys: new PlatformTransportKeyRepository(db),
		mailMessages: new MailMessageRepository(db),
		mailRules: new MailRuleRepository(db),
		dataOperations: new DataOperationRepository(db, now),
	}
}
