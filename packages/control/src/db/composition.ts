import type { BlobStore, SqlDatabase } from '@fabrika/platform'
import { GitHubConnectionStore } from '../github/connections/store'
import { BackupRepository } from './backups'
import { BuilderConnectionRepository } from './builder-connections'
import { DataOperationRepository } from './data-operations'
import { DevEnvironmentRepository } from './dev-environments'
import { MailMessageRepository } from './mail-messages'
import { MailRuleRepository } from './mail-rules'
import { MembershipKeyRepository } from './membership-keys'
import { OperationsCatalogRepository } from './operations-catalog'
import { OperationsReleaseRepository } from './operations-releases'
import { OpsKeyRepository } from './ops-keys'
import { PlatformTransportKeyRepository } from './platform-transport-keys'
import { RepoPollingRepository } from './polling'
import { ControlRegistryRepository } from './registry'
import { ApplicationObjectsRepository, RestoreRepository } from './restores'
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
	opsKeys: OpsKeyRepository
	platformTransportKeys: PlatformTransportKeyRepository
	mailMessages: MailMessageRepository
	mailRules: MailRuleRepository
	dataOperations: DataOperationRepository
	backups: BackupRepository
	applicationObjects: ApplicationObjectsRepository
	restores: RestoreRepository
}

export interface ControlRepositoryOptions {
	now?: () => number
	/** Where the relay keeps message content its rows cannot hold (D1); without it, the rows hold it (Postgres). */
	mailContent?: BlobStore
}

/** The portable repository bundle. */
export function createControlRepositories(db: SqlDatabase, options: ControlRepositoryOptions = {}): ControlRepositories {
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
		opsKeys: new OpsKeyRepository(db),
		platformTransportKeys: new PlatformTransportKeyRepository(db),
		mailMessages: new MailMessageRepository(db, options.mailContent ?? null),
		mailRules: new MailRuleRepository(db),
		dataOperations: new DataOperationRepository(db, now),
		backups: new BackupRepository(db, now),
		applicationObjects: new ApplicationObjectsRepository(db, now),
		restores: new RestoreRepository(db, now),
	}
}
