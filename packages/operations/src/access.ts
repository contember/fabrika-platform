import type { AuthContext } from '@fabrika/auth'
import type { PrincipalListItem, Scope } from '@fabrika/auth-core'
import { OPERATIONS_ACTIONS, type OperationsAction } from '@fabrika/operations-contract/access'
import type { IssueMutation } from '@fabrika/operations-contract/operator'

export interface OperationsSourceAccess {
	id: string
	appId: string
	environment: string
	serviceKey: string
}

const appScope = (appId: string): Scope => ({ type: 'app', value: appId })
const environmentScope = (environment: string): Scope => ({ type: 'environment', value: environment })

/** App and environment scope dimensions are independent grants, therefore source access is their union. */
export function canAccessOperationsSource(
	auth: Pick<AuthContext, 'can'>,
	action: OperationsAction,
	source: Pick<OperationsSourceAccess, 'appId' | 'environment'>,
): boolean {
	return auth.can(action, appScope(source.appId)) || auth.can(action, environmentScope(source.environment))
}

export function filterOperationsSources<T extends Pick<OperationsSourceAccess, 'appId' | 'environment'>>(
	auth: Pick<AuthContext, 'scopedTo'>,
	action: OperationsAction,
	sources: readonly T[],
): T[] {
	const apps = auth.scopedTo(action, 'app')
	const environments = auth.scopedTo(action, 'environment')
	if (apps === null || environments === null) return [...sources]
	const appSet = new Set(apps)
	const environmentSet = new Set(environments)
	return sources.filter((source) => appSet.has(source.appId) || environmentSet.has(source.environment))
}

/** Replace caller-provided assignment labels with IAM's durable id + current display snapshot. */
export function normalizeIssueAssignment(
	mutation: IssueMutation,
	principals: readonly PrincipalListItem[],
): IssueMutation {
	if (mutation.kind !== 'assign' || mutation.principalId === null) return mutation
	const principal = principals.find((candidate) =>
		candidate.id === mutation.principalId
		&& candidate.type === 'user'
		&& !candidate.disabled
	)
	if (!principal) throw new RangeError('assignee is not an active IAM user')
	return { kind: 'assign', principalId: principal.id, principalLabel: principal.label }
}

export async function auditIssueMutation(
	auth: Pick<AuthContext, 'audit'>,
	issueId: string,
	mutation: IssueMutation,
): Promise<void> {
	await auth.audit({
		action: issueMutationAuditAction(mutation),
		resourceType: 'operations_issue',
		resourceId: issueId,
	})
}

export function issueMutationAuditAction(mutation: IssueMutation): string {
	switch (mutation.kind) {
		case 'status':
		case 'resolve_in_release':
			return 'operations.issue.status'
		case 'comment':
			return 'operations.issue.comment'
		case 'assign':
			return 'operations.issue.assign'
		case 'snooze_until':
		case 'snooze_count':
			return 'operations.issue.snooze'
		case 'merge':
			return 'operations.issue.merge'
	}
}

export { OPERATIONS_ACTIONS }
