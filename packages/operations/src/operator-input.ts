import type { IssueStatus } from '@fabrika/operations-contract/operator'
import type {
	OperationsAlertKind,
	OperationsHealthCheckUpsertRequestDto,
	OperationsIssueMutationRequestDto,
	OperationsNotificationChannelRequestDto,
	OperationsSpikeAlertRequestDto,
} from '@fabrika/operations-contract/operator-api'

export function string(value: unknown, field: string): string {
	if (typeof value !== 'string' || value === '') throw new Error(`${field} must be a non-empty string`)
	return value
}

function nullableString(value: unknown, field: string): string | null {
	return value === null ? null : string(value, field)
}

function boolean(value: unknown, field: string): boolean {
	if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`)
	return value
}

function positiveInteger(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${field} must be a positive integer`)
	}
	return value
}

export function issueStatus(value: unknown): IssueStatus {
	if (value === 'open' || value === 'resolved' || value === 'ignored') return value
	throw new Error('invalid issue status')
}

export function issueMutation(body: Record<string, unknown>): OperationsIssueMutationRequestDto {
	switch (body['kind']) {
		case 'status':
			return { kind: 'status', status: issueStatus(body['status']) }
		case 'comment':
			return { kind: 'comment', text: string(body['text'], 'text') }
		case 'assign':
			return { kind: 'assign', principalId: nullableString(body['principalId'], 'principalId') }
		case 'snooze_until':
			return { kind: 'snooze_until', until: positiveInteger(body['until'], 'until') }
		case 'snooze_count':
			return { kind: 'snooze_count', additional: positiveInteger(body['additional'], 'additional') }
		case 'resolve_in_release':
			return { kind: 'resolve_in_release', releaseId: nullableString(body['releaseId'], 'releaseId') }
		case 'merge':
			return { kind: 'merge', targetIssueId: string(body['targetIssueId'], 'targetIssueId') }
		default:
			throw new Error('invalid issue mutation')
	}
}

export function bulkIssueStatusInput(body: Record<string, unknown>): { issueIds: string[]; status: IssueStatus } {
	const ids = body['issueIds']
	if (!Array.isArray(ids)) throw new Error('issueIds must be an array')
	const issueIds: string[] = []
	for (const id of ids) issueIds.push(string(id, 'issueId'))
	return { issueIds, status: issueStatus(body['status']) }
}

export function healthCheckInput(body: Record<string, unknown>): OperationsHealthCheckUpsertRequestDto {
	return {
		path: string(body['path'], 'path'),
		enabled: boolean(body['enabled'], 'enabled'),
		intervalMs: positiveInteger(body['intervalMs'], 'intervalMs'),
		timeoutMs: positiveInteger(body['timeoutMs'], 'timeoutMs'),
		expectedStatus: positiveInteger(body['expectedStatus'], 'expectedStatus'),
		failureThreshold: positiveInteger(body['failureThreshold'], 'failureThreshold'),
		recoveryThreshold: positiveInteger(body['recoveryThreshold'], 'recoveryThreshold'),
		staleAfterMs: positiveInteger(body['staleAfterMs'], 'staleAfterMs'),
	}
}

export function spikeAlertInput(body: Record<string, unknown>): OperationsSpikeAlertRequestDto {
	return { threshold: positiveInteger(body['threshold'], 'threshold'), enabled: boolean(body['enabled'], 'enabled') }
}

export function alertRuleInput(body: Record<string, unknown>): { enabled: boolean } {
	return { enabled: boolean(body['enabled'], 'enabled') }
}

export function alertKind(value: unknown): OperationsAlertKind | null {
	switch (value) {
		case 'new_issue':
		case 'regression':
		case 'spike':
		case 'failed_check':
		case 'recovery':
		case 'unhealthy_telemetry':
			return value
		default:
			return null
	}
}

export function requiredAlertKind(value: unknown): OperationsAlertKind {
	const kind = alertKind(value)
	if (kind === null) throw new Error('invalid alert kind')
	return kind
}

export function channelInput(
	body: Record<string, unknown>,
	requireTarget: boolean,
): OperationsNotificationChannelRequestDto {
	if (body['type'] !== 'webhook') throw new Error('type must be webhook')
	const target = body['target']
	if (requireTarget && typeof target !== 'string') throw new Error('target is required')
	if (target !== undefined && typeof target !== 'string') throw new Error('target must be a string')
	return {
		scope: requiredAlertKind(body['scope']),
		type: 'webhook',
		...(typeof target === 'string' ? { target } : {}),
		enabled: boolean(body['enabled'], 'enabled'),
	}
}
