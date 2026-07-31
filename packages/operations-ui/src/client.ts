import { createRpcClient, RpcError, type RpcFetch } from '@fabrika/app'
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
} from '@fabrika/operations-contract/operator-api'
import type { OperationsIssueQuery, OperationsReleaseQuery, OperationsRpcContract } from '@fabrika/operations-contract/rpc'

export { RpcError }
export type { OperationsIssueQuery, OperationsReleaseQuery }

const RPC_BASE = '/operations/api/rpc'
const LOGIN_BOUNCE_KEY = 'fabrika.operations.auth.login-bounce'
const LOGIN_BOUNCE_WINDOW_MS = 10_000

export interface OperationsClient {
	sources(): Promise<OperationsSourceListResponseDto>
	source(sourceId: string): Promise<OperationsSourceDetailResponseDto>
	issues(query?: OperationsIssueQuery): Promise<OperationsIssueListResponseDto>
	issue(issueId: string): Promise<OperationsIssueDetailResponseDto>
	issueOccurrences(issueId: string, cursor?: string): Promise<OperationsIssueOccurrenceListResponseDto>
	latestEvent(issueId: string): Promise<OperationsEventDetailResponseDto>
	event(issueId: string, occurrenceId: string): Promise<OperationsEventDetailResponseDto>
	mutateIssue(issueId: string, mutation: OperationsIssueMutationRequestDto): Promise<OperationsIssueDetailResponseDto>
	bulkIssueStatus(input: OperationsBulkIssueStatusRequestDto): Promise<OperationsBulkIssueStatusResponseDto>
	assignees(sourceId: string): Promise<OperationsAssigneeListResponseDto>
	releases(query?: OperationsReleaseQuery): Promise<OperationsReleaseListResponseDto>
	release(releaseId: string): Promise<OperationsReleaseDetailResponseDto>
	health(): Promise<OperationsHealthResponseDto>
	sourceHealth(sourceId: string): Promise<OperationsSourceHealthDto>
	createHealthCheck(sourceId: string, input: OperationsHealthCheckUpsertRequestDto): Promise<{ id: string }>
	updateHealthCheck(sourceId: string, checkId: string, input: OperationsHealthCheckUpsertRequestDto): Promise<{ id: string }>
	deleteHealthCheck(sourceId: string, checkId: string): Promise<null>
	alerts(sourceId: string): Promise<OperationsAlertSettingsResponseDto>
	updateSpikeAlert(sourceId: string, input: OperationsSpikeAlertRequestDto): Promise<{ threshold: number; enabled: boolean }>
	updateAlertRule(
		sourceId: string,
		kind: OperationsAlertKind,
		input: OperationsAlertRuleRequestDto,
	): Promise<{ kind: OperationsAlertKind; enabled: boolean }>
	createAlertChannel(sourceId: string, input: OperationsNotificationChannelRequestDto): Promise<{ id: string }>
	updateAlertChannel(sourceId: string, channelId: string, input: OperationsNotificationChannelRequestDto): Promise<{ id: string }>
	deleteAlertChannel(sourceId: string, channelId: string): Promise<null>
}

export type OperationsFetch = RpcFetch

/** Typed Operations console client. All domain calls use the portable RPC contract. */
export function createOperationsClient(fetcher: OperationsFetch = fetch): OperationsClient {
	const rpc = createRpcClient<OperationsRpcContract>({
		baseUrl: RPC_BASE,
		fetch: fetcher,
		bounceOnAuth: { sessionKey: LOGIN_BOUNCE_KEY, windowMs: LOGIN_BOUNCE_WINDOW_MS },
	})

	return {
		sources: () => rpc.sources(),
		source: (sourceId) => rpc.source({ sourceId }),
		issues: (query = {}) => rpc.issues(query),
		issue: (issueId) => rpc.issue({ issueId }),
		issueOccurrences: (issueId, cursor) => rpc.issueOccurrences({ issueId, ...(cursor === undefined ? {} : { cursor }), limit: 50 }),
		latestEvent: (issueId) => rpc.latestEvent({ issueId }),
		event: (issueId, occurrenceId) => rpc.event({ issueId, occurrenceId }),
		mutateIssue: (issueId, mutation) => rpc.mutateIssue({ issueId, mutation }),
		bulkIssueStatus: (input) => rpc.bulkIssueStatus(input),
		assignees: (sourceId) => rpc.assignees({ sourceId }),
		releases: (query = {}) => rpc.releases(query),
		release: (releaseId) => rpc.release({ releaseId }),
		health: () => rpc.health(),
		sourceHealth: (sourceId) => rpc.sourceHealth({ sourceId }),
		createHealthCheck: (sourceId, input) => rpc.createHealthCheck({ sourceId, input }),
		updateHealthCheck: (sourceId, checkId, input) => rpc.updateHealthCheck({ sourceId, checkId, input }),
		deleteHealthCheck: (sourceId, checkId) => rpc.deleteHealthCheck({ sourceId, checkId }),
		alerts: (sourceId) => rpc.alerts({ sourceId }),
		updateSpikeAlert: (sourceId, input) => rpc.updateSpikeAlert({ sourceId, input }),
		updateAlertRule: (sourceId, kind, input) => rpc.updateAlertRule({ sourceId, kind, input }),
		createAlertChannel: (sourceId, input) => rpc.createAlertChannel({ sourceId, input }),
		updateAlertChannel: (sourceId, channelId, input) => rpc.updateAlertChannel({ sourceId, channelId, input }),
		deleteAlertChannel: (sourceId, channelId) => rpc.deleteAlertChannel({ sourceId, channelId }),
	}
}

export const operationsClient = createOperationsClient()
