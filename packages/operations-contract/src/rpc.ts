import type { RpcProcedureContract } from '@fabrika/app'
import type {
	OperationsAlertKind,
	OperationsAlertRuleRequestDto,
	OperationsAlertSettingsResponseDto,
	OperationsAssigneeListResponseDto,
	OperationsBulkIssueStatusRequestDto,
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
} from './operator-api.js'

export interface OperationsIssueQuery {
	sourceId?: string
	status?: 'open' | 'resolved' | 'ignored'
	level?: 'fatal' | 'error' | 'warning' | 'info'
	window?: 'all' | '24h' | '7d' | '30d'
	query?: string
	assignee?: 'all' | 'me' | 'none'
	sort?: 'recent' | 'new' | 'frequency'
	cursor?: string
	limit?: number
}

export interface OperationsReleaseQuery {
	sourceId?: string
	cursor?: string
	limit?: number
}

/** Portable operator API implemented by Operations and consumed by its console. */
export interface OperationsRpcContract {
	sources: RpcProcedureContract<void, OperationsSourceListResponseDto>
	source: RpcProcedureContract<{ sourceId: string }, OperationsSourceDetailResponseDto>
	issues: RpcProcedureContract<OperationsIssueQuery, OperationsIssueListResponseDto>
	issue: RpcProcedureContract<{ issueId: string }, OperationsIssueDetailResponseDto>
	issueOccurrences: RpcProcedureContract<{ issueId: string; cursor?: string; limit?: number }, OperationsIssueOccurrenceListResponseDto>
	latestEvent: RpcProcedureContract<{ issueId: string }, OperationsEventDetailResponseDto>
	event: RpcProcedureContract<{ issueId: string; occurrenceId: string }, OperationsEventDetailResponseDto>
	mutateIssue: RpcProcedureContract<{ issueId: string; mutation: OperationsIssueMutationRequestDto }, OperationsIssueDetailResponseDto>
	bulkIssueStatus: RpcProcedureContract<OperationsBulkIssueStatusRequestDto, OperationsBulkIssueStatusResponseDto>
	assignees: RpcProcedureContract<{ sourceId: string }, OperationsAssigneeListResponseDto>
	releases: RpcProcedureContract<OperationsReleaseQuery, OperationsReleaseListResponseDto>
	release: RpcProcedureContract<{ releaseId: string }, OperationsReleaseDetailResponseDto>
	health: RpcProcedureContract<void, OperationsHealthResponseDto>
	sourceHealth: RpcProcedureContract<{ sourceId: string }, OperationsSourceHealthDto>
	createHealthCheck: RpcProcedureContract<
		{ sourceId: string; input: OperationsHealthCheckUpsertRequestDto },
		{ id: string }
	>
	updateHealthCheck: RpcProcedureContract<
		{ sourceId: string; checkId: string; input: OperationsHealthCheckUpsertRequestDto },
		{ id: string }
	>
	deleteHealthCheck: RpcProcedureContract<{ sourceId: string; checkId: string }, null>
	alerts: RpcProcedureContract<{ sourceId: string }, OperationsAlertSettingsResponseDto>
	updateSpikeAlert: RpcProcedureContract<
		{ sourceId: string; input: OperationsSpikeAlertRequestDto },
		{ threshold: number; enabled: boolean }
	>
	updateAlertRule: RpcProcedureContract<
		{ sourceId: string; kind: OperationsAlertKind; input: OperationsAlertRuleRequestDto },
		{ kind: OperationsAlertKind; enabled: boolean }
	>
	createAlertChannel: RpcProcedureContract<
		{ sourceId: string; input: OperationsNotificationChannelRequestDto },
		{ id: string }
	>
	updateAlertChannel: RpcProcedureContract<
		{ sourceId: string; channelId: string; input: OperationsNotificationChannelRequestDto },
		{ id: string }
	>
	deleteAlertChannel: RpcProcedureContract<{ sourceId: string; channelId: string }, null>
}
