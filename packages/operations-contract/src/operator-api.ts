import type { ActivityItem, EventDetail, IssueStatus } from './operator.js'
import type { OperationsArtifactState } from './releases.js'

export type OperationsAlertKind =
	| 'new_issue'
	| 'regression'
	| 'spike'
	| 'failed_check'
	| 'recovery'
	| 'unhealthy_telemetry'

export type OperationsHealthState = 'healthy' | 'degraded' | 'failed' | 'stale' | 'unavailable'

export interface OperationsSourceSummaryDto {
	id: string
	appId: string
	environment: string
	serviceKey: string
	displayName: string
	publicOrigin: string | null
	enabled: boolean
}

export interface OperationsSourceListResponseDto {
	items: OperationsSourceSummaryDto[]
}

export interface OperationsSourceDetailResponseDto {
	source: OperationsSourceSummaryDto
}

export interface OperationsIssueSummaryDto {
	id: string
	source: OperationsSourceSummaryDto
	title: string
	culprit: string | null
	level: string
	status: IssueStatus
	assignedTo: { id: string; label: string | null } | null
	regressedAt: number | null
	firstSeen: number
	lastSeen: number
	count: number
	trend: number[]
}

export interface OperationsIssueListResponseDto {
	items: OperationsIssueSummaryDto[]
	nextCursor: string | null
	summary: {
		total: number
		open: number
		resolved: number
		ignored: number
	}
}

export interface OperationsIssueDetailDto extends OperationsIssueSummaryDto {
	snoozeUntil: number | null
	snoozeUntilCount: number | null
	resolvedInRelease: { id: string; name: string } | null
	mergedIntoIssueId: string | null
	activity: ActivityItem[]
	latestOccurrence: {
		id: string
		eventId: string
		receivedAt: number
		release: string | null
	} | null
}

export interface OperationsIssueDetailResponseDto {
	issue: OperationsIssueDetailDto
}

export interface OperationsEventDetailResponseDto {
	occurrenceId: string
	receivedAt: number
	detail: EventDetail
}

export type OperationsIssueMutationRequestDto =
	| { kind: 'status'; status: IssueStatus }
	| { kind: 'comment'; text: string }
	| { kind: 'assign'; principalId: string | null }
	| { kind: 'snooze_until'; until: number }
	| { kind: 'snooze_count'; additional: number }
	| { kind: 'resolve_in_release'; releaseId: string | null }
	| { kind: 'merge'; targetIssueId: string }

export interface OperationsBulkIssueStatusRequestDto {
	issueIds: string[]
	status: IssueStatus
}

export interface OperationsBulkIssueStatusResponseDto {
	items: OperationsIssueSummaryDto[]
}

export interface OperationsAssigneeListResponseDto {
	items: {
		id: string
		label: string
	}[]
}

export interface OperationsReleaseSummaryDto {
	id: string
	source: OperationsSourceSummaryDto
	runId: string
	commitSha: string
	state: string
	artifactState: OperationsArtifactState
	releaseName: string
	createdAt: number
	finishedAt: number | null
	newIssueCount: number
	regressionCount: number
}

export interface OperationsReleaseListResponseDto {
	items: OperationsReleaseSummaryDto[]
	nextCursor: string | null
}

export interface OperationsReleaseDetailResponseDto {
	release: OperationsReleaseSummaryDto
	issues: OperationsIssueSummaryDto[]
}

export interface OperationsCurrentHttpHealthDto {
	state: Exclude<OperationsHealthState, 'unavailable'>
	observedAt: number
	latencyMs: number | null
	detailCode: string
	consecutiveFailures: number
	consecutiveSuccesses: number
}

export interface OperationsHealthObservationDto {
	id: string
	state: OperationsHealthState
	observedAt: number
	latencyMs: number | null
	detailCode: string | null
	successful: boolean
	statusCode: number | null
}

export interface OperationsHealthCheckDto {
	id: string
	sourceId: string
	path: string
	enabled: boolean
	intervalMs: number
	timeoutMs: number
	expectedStatus: number
	failureThreshold: number
	recoveryThreshold: number
	staleAfterMs: number
	current: OperationsCurrentHttpHealthDto | null
	history: OperationsHealthObservationDto[]
}

export interface OperationsSourceHealthDto {
	source: OperationsSourceSummaryDto
	httpChecks: OperationsHealthCheckDto[]
	telemetryState: OperationsHealthState
}

export interface OperationsHealthResponseDto {
	sources: OperationsSourceHealthDto[]
}

export interface OperationsHealthCheckUpsertRequestDto {
	path: string
	enabled: boolean
	intervalMs: number
	timeoutMs: number
	expectedStatus: number
	failureThreshold: number
	recoveryThreshold: number
	staleAfterMs: number
}

export interface OperationsAlertRuleDto {
	kind: OperationsAlertKind
	enabled: boolean
}

export interface OperationsNotificationChannelDto {
	id: string
	scope: OperationsAlertKind
	type: 'webhook'
	targetDisplay: string
	hasTarget: boolean
	enabled: boolean
}

export interface OperationsAlertSettingsResponseDto {
	spike: { threshold: number; enabled: boolean } | null
	rules: OperationsAlertRuleDto[]
	channels: OperationsNotificationChannelDto[]
}

export interface OperationsSpikeAlertRequestDto {
	threshold: number
	enabled: boolean
}

export interface OperationsAlertRuleRequestDto {
	enabled: boolean
}

export interface OperationsNotificationChannelRequestDto {
	scope: OperationsAlertKind
	type: 'webhook'
	target?: string
	enabled: boolean
}
