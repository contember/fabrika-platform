import type { IssueStatus } from '@fabrika/operations-contract/operator'
import type {
	OperationsAlertKind,
	OperationsAlertSettingsResponseDto,
	OperationsAssigneeListResponseDto,
	OperationsBulkIssueStatusResponseDto,
	OperationsEventDetailResponseDto,
	OperationsHealthCheckUpsertRequestDto,
	OperationsHealthResponseDto,
	OperationsIssueDetailResponseDto,
	OperationsIssueListResponseDto,
	OperationsIssueMutationRequestDto,
	OperationsIssueOccurrenceListResponseDto,
	OperationsNotificationChannelRequestDto,
	OperationsReleaseDetailResponseDto,
	OperationsReleaseListResponseDto,
	OperationsSourceDetailResponseDto,
	OperationsSourceHealthDto,
	OperationsSourceListResponseDto,
	OperationsSpikeAlertRequestDto,
} from '@fabrika/operations-contract/operator-api'
import type { OperationsIssueQuery, OperationsReleaseQuery } from '@fabrika/operations-contract/rpc'
import { alertSettings, createAlertChannel, deleteAlertChannel, updateAlertChannel, updateAlertRule, updateSpikeAlert } from './alerts.js'
import type { OperationsOperatorOptions } from './context.js'
import { createHealthCheck, deleteHealthCheck, healthOverview, sourceHealth, updateHealthCheck } from './health.js'
import { bulkIssueStatus, issueDetail, issueEvent, issueLatestEvent, issueOccurrences, listIssues, mutateIssue } from './issues.js'
import { listReleases, releaseDetail } from './releases.js'
import { listAssignees, listSources, sourceDetail } from './sources.js'

/** Typed operator use cases behind the RPC boundary. */
export class OperationsOperatorUseCases {
	constructor(
		private readonly request: Request,
		private readonly options: OperationsOperatorOptions,
	) {}

	sources(): Promise<OperationsSourceListResponseDto> {
		return listSources(this.options)
	}

	source(sourceId: string): Promise<OperationsSourceDetailResponseDto> {
		return sourceDetail(sourceId, this.options)
	}

	issues(query: OperationsIssueQuery): Promise<OperationsIssueListResponseDto> {
		return listIssues(query, this.options)
	}

	issue(issueId: string): Promise<OperationsIssueDetailResponseDto> {
		return issueDetail(issueId, this.options)
	}

	issueOccurrences(issueId: string, cursorValue?: string, limit?: number): Promise<OperationsIssueOccurrenceListResponseDto> {
		return issueOccurrences(issueId, cursorValue, limit, this.options)
	}

	latestEvent(issueId: string): Promise<OperationsEventDetailResponseDto> {
		return issueLatestEvent(issueId, this.options)
	}

	event(issueId: string, occurrenceId: string): Promise<OperationsEventDetailResponseDto> {
		return issueEvent(issueId, occurrenceId, this.options)
	}

	mutateIssue(issueId: string, mutation: OperationsIssueMutationRequestDto): Promise<OperationsIssueDetailResponseDto> {
		return mutateIssue(this.request, issueId, mutation, this.options)
	}

	bulkIssueStatus(input: { issueIds: string[]; status: IssueStatus }): Promise<OperationsBulkIssueStatusResponseDto> {
		return bulkIssueStatus(input, this.options)
	}

	assignees(sourceId: string): Promise<OperationsAssigneeListResponseDto> {
		return listAssignees(this.request, sourceId, this.options)
	}

	releases(query: OperationsReleaseQuery): Promise<OperationsReleaseListResponseDto> {
		return listReleases(query, this.options)
	}

	release(releaseId: string): Promise<OperationsReleaseDetailResponseDto> {
		return releaseDetail(releaseId, this.options)
	}

	health(): Promise<OperationsHealthResponseDto> {
		return healthOverview(this.options)
	}

	sourceHealth(sourceId: string): Promise<OperationsSourceHealthDto> {
		return sourceHealth(sourceId, this.options)
	}

	createHealthCheck(sourceId: string, input: OperationsHealthCheckUpsertRequestDto): Promise<{ id: string }> {
		return createHealthCheck(sourceId, input, this.options)
	}

	updateHealthCheck(sourceId: string, checkId: string, input: OperationsHealthCheckUpsertRequestDto): Promise<{ id: string }> {
		return updateHealthCheck(sourceId, checkId, input, this.options)
	}

	deleteHealthCheck(sourceId: string, checkId: string): Promise<null> {
		return deleteHealthCheck(sourceId, checkId, this.options)
	}

	alerts(sourceId: string): Promise<OperationsAlertSettingsResponseDto> {
		return alertSettings(sourceId, this.options)
	}

	updateSpikeAlert(sourceId: string, input: OperationsSpikeAlertRequestDto): Promise<{ threshold: number; enabled: boolean }> {
		return updateSpikeAlert(sourceId, input, this.options)
	}

	updateAlertRule(sourceId: string, kind: OperationsAlertKind, input: { enabled: boolean }): Promise<{ kind: OperationsAlertKind; enabled: boolean }> {
		return updateAlertRule(sourceId, kind, input, this.options)
	}

	createAlertChannel(sourceId: string, input: OperationsNotificationChannelRequestDto): Promise<{ id: string }> {
		return createAlertChannel(sourceId, input, this.options)
	}

	updateAlertChannel(sourceId: string, channelId: string, input: OperationsNotificationChannelRequestDto): Promise<{ id: string }> {
		return updateAlertChannel(sourceId, channelId, input, this.options)
	}

	deleteAlertChannel(sourceId: string, channelId: string): Promise<null> {
		return deleteAlertChannel(sourceId, channelId, this.options)
	}
}
