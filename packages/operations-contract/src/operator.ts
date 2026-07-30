import type { StackFrame } from './ingest.js'

export type IssueStatus = 'open' | 'resolved' | 'ignored'
export type ActivityKind = 'comment' | 'status' | 'assigned' | 'regressed' | 'snoozed' | 'unsnoozed' | 'merged'
export type IssueAlertType = 'new_issue' | 'regression'

export interface IssueListItem {
	fingerprint: string
	projectId: string
	title: string
	culprit: string | null
	level: string
	status: IssueStatus
	assignedTo: string | null
	regressedAt: number | null
	firstSeen: number
	lastSeen: number
	count: number
	trend: number[]
}

export interface ActivityItem {
	id: string
	kind: ActivityKind
	actorLabel: string | null
	data: Record<string, unknown> | null
	at: number
}

export interface SourceContext {
	lines: string[]
	errorIndex: number
	startLine: number
}

export interface DisplayFrame {
	file: string
	function: string | null
	line: number | null
	column: number | null
	inApp: boolean
	resolved: boolean
	source?: SourceContext
}

export interface EventException {
	type: string | null
	value: string | null
	handled: boolean | null
	frames: DisplayFrame[]
}

export interface EventBreadcrumb {
	timestamp?: number | string
	type?: string
	category?: string
	level?: string
	message?: string
}

export interface EventDetail {
	eventId: string | null
	platform: string | null
	release: string | null
	environment: string | null
	tags: { key: string; value: string }[]
	request: { url: string | null; method: string | null } | null
	user: { id: string | null; email: string | null; username: string | null } | null
	breadcrumbs: EventBreadcrumb[]
	runtime: string | null
	os: string | null
	serverName: string | null
	traceId: string | null
	exceptions: EventException[]
	rawEvent: string
}

export interface Occurrence {
	release?: string
	receivedAt: number
}

export interface PriorIssueState {
	status: IssueStatus
	resolvedInRelease: string | null
	snoozeUntil: number | null
	snoozeUntilCount: number | null
}

export interface OccurrenceTransition {
	reopen: boolean
	regression: boolean
	at: number | null
	release: string | null
	activity: ActivityKind | null
}

export type IssueMutation =
	| { kind: 'status'; status: IssueStatus }
	| { kind: 'comment'; text: string }
	| { kind: 'assign'; principalId: string | null; principalLabel: string | null }
	| { kind: 'snooze_until'; until: number }
	| { kind: 'snooze_count'; additional: number; currentCount: number }
	| { kind: 'resolve_in_release'; release: string | null }
	| { kind: 'merge'; target: string }

export interface ActivityDraft {
	kind: ActivityKind
	data: Record<string, unknown>
}

export interface IssueMutationDecision {
	status: IssueStatus
	assignedTo?: string | null
	assignedToLabel?: string | null
	snoozeUntil?: number | null
	snoozeUntilCount?: number | null
	resolvedInRelease?: string | null
	mergedInto?: string
	activity: ActivityDraft | null
}

export type RawEventFrame = StackFrame
