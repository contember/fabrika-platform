import type { SqlDatabase } from '@fabrika/platform'
import { AlertsRepository, PostgresAlertsRepository, SqliteAlertsRepository } from './repositories/alerts.js'
import { ArtifactsRepository } from './repositories/artifacts.js'
import { CatalogRepository } from './repositories/catalog.js'
import { DeadEventsRepository } from './repositories/dead-events.js'
import { IngestRateLimitsRepository } from './repositories/ingest-rate-limits.js'
import { ErrorIngestRepository, PostgresErrorIngestRepository, SqliteErrorIngestRepository } from './repositories/ingest.js'
import { IssuesRepository } from './repositories/issues.js'
import { OperatorRepository } from './repositories/operator.js'
import { SourcesRepository } from './repositories/sources.js'

export interface OperationsRepositories {
	sources: SourcesRepository
	catalog: CatalogRepository
	ingest: ErrorIngestRepository
	issues: IssuesRepository
	operator: OperatorRepository
	alerts: AlertsRepository
	ingestRateLimits: IngestRateLimitsRepository
	deadEvents: DeadEventsRepository
	artifacts: ArtifactsRepository
}

export function createSqliteOperationsRepositories(
	db: SqlDatabase,
	options: { now?: () => number; replacements?: Partial<OperationsRepositories> } = {},
): OperationsRepositories {
	const now = options.now ?? Date.now
	const replacements = options.replacements ?? {}
	return {
		sources: replacements.sources ?? new SourcesRepository(db, now),
		catalog: replacements.catalog ?? new CatalogRepository(db, now),
		ingest: replacements.ingest ?? new SqliteErrorIngestRepository(db, now),
		issues: replacements.issues ?? new IssuesRepository(db, now),
		operator: replacements.operator ?? new OperatorRepository(db, now),
		alerts: replacements.alerts ?? new SqliteAlertsRepository(db, now),
		ingestRateLimits: replacements.ingestRateLimits ?? new IngestRateLimitsRepository(db, now),
		deadEvents: replacements.deadEvents ?? new DeadEventsRepository(db),
		artifacts: replacements.artifacts ?? new ArtifactsRepository(db, now),
	}
}

export function createPostgresOperationsRepositories(
	db: SqlDatabase,
	options: { now?: () => number; replacements?: Partial<OperationsRepositories> } = {},
): OperationsRepositories {
	const now = options.now ?? Date.now
	const replacements = options.replacements ?? {}
	return {
		sources: replacements.sources ?? new SourcesRepository(db, now),
		catalog: replacements.catalog ?? new CatalogRepository(db, now),
		ingest: replacements.ingest ?? new PostgresErrorIngestRepository(db, now),
		issues: replacements.issues ?? new IssuesRepository(db, now),
		operator: replacements.operator ?? new OperatorRepository(db, now),
		alerts: replacements.alerts ?? new PostgresAlertsRepository(db, now),
		ingestRateLimits: replacements.ingestRateLimits ?? new IngestRateLimitsRepository(db, now),
		deadEvents: replacements.deadEvents ?? new DeadEventsRepository(db),
		artifacts: replacements.artifacts ?? new ArtifactsRepository(db, now),
	}
}

export type { AlertConfigRow, AlertRuleRow, ClaimedNotification, NotificationChannelRow } from './repositories/alerts.js'
export { AlertsRepository, PostgresAlertsRepository, SqliteAlertsRepository } from './repositories/alerts.js'
export type { ArtifactUploadCredentialResolution, ReleaseRow } from './repositories/artifacts.js'
export { ArtifactProjectionConflictError, ArtifactsRepository } from './repositories/artifacts.js'
export type { CatalogCursorRow } from './repositories/catalog.js'
export { CatalogRepository, CatalogRevisionConflictError } from './repositories/catalog.js'
export { DeadEventsRepository } from './repositories/dead-events.js'
export { IngestRateLimitsRepository } from './repositories/ingest-rate-limits.js'
export type { CountBucket, CountResult, RecordOccurrenceInput, RecordOccurrenceResult } from './repositories/ingest.js'
export { ErrorIngestRepository, PostgresErrorIngestRepository, SqliteErrorIngestRepository } from './repositories/ingest.js'
export type { IssueRow } from './repositories/issue-row.js'
export { IssuesRepository } from './repositories/issues.js'
export type {
	IdentifiedOperatorIssueRow,
	OperatorIssueCursor,
	OperatorIssueRow,
	OperatorIssueSort,
	OperatorIssueTrendRow,
	OperatorNotificationAttemptRow,
	OperatorNotificationDeliveryRow,
	OperatorOccurrenceCursor,
	OperatorOccurrenceRow,
	OperatorReleaseRow,
} from './repositories/operator.js'
export { OperatorRepository } from './repositories/operator.js'
export type { IngestCredentialResolution, SourceRow } from './repositories/sources.js'
export { SourcesRepository } from './repositories/sources.js'
