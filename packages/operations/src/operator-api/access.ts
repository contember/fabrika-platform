import type { OperationsSourceAccess } from '../access.js'
import { canAccessOperationsSource, filterOperationsSources } from '../access.js'
import type { IdentifiedOperatorIssueRow, OperatorReleaseRow, SourceRow } from '../repositories.js'
import type { OperationsOperatorOptions } from './context.js'
import { notFoundError } from './errors.js'

export function sourceAccess(source: SourceRow | IdentifiedOperatorIssueRow | OperatorReleaseRow): OperationsSourceAccess {
	if ('app_id' in source) return { id: source.id, appId: source.app_id, environment: source.environment, serviceKey: source.service_key }
	return {
		id: source.source_id,
		appId: source.source_app_id,
		environment: source.source_environment,
		serviceKey: source.source_service_key,
	}
}

export async function authorizedSources(
	options: OperationsOperatorOptions,
	action: 'operations.read' | 'operations.triage' | 'operations.manage',
): Promise<SourceRow[]> {
	const sources = await options.repositories.catalog.listControlSources()
	return filterOperationsSources(
		options.auth,
		action,
		sources.map((source) => ({
			...source,
			appId: source.app_id,
			environment: source.environment,
		})),
	)
}

export async function visibleSource(
	sourceId: string,
	action: 'operations.read' | 'operations.triage' | 'operations.manage',
	options: OperationsOperatorOptions,
): Promise<SourceRow> {
	const source = await options.repositories.sources.get(sourceId)
	if (source === null || !canAccessOperationsSource(options.auth, action, sourceAccess(source))) return notFoundError()
	return source
}

export async function visibleIssue(
	issueId: string,
	action: 'operations.read' | 'operations.triage',
	options: OperationsOperatorOptions,
): Promise<IdentifiedOperatorIssueRow> {
	const issue = await options.repositories.operator.getIssueById(issueId)
	if (issue === null || !canAccessOperationsSource(options.auth, action, sourceAccess(issue))) return notFoundError()
	return issue
}
