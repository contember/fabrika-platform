import type {
	OperationsAssigneeListResponseDto,
	OperationsSourceDetailResponseDto,
	OperationsSourceListResponseDto,
	OperationsSourceSummaryDto,
} from '@fabrika/operations-contract/operator-api'
import type { IdentifiedOperatorIssueRow, OperatorReleaseRow, SourceRow } from '../repositories.js'
import { authorizedSources, visibleSource } from './access.js'
import type { OperationsOperatorOptions } from './context.js'
import { OperatorRequestError } from './errors.js'

export async function listSources(options: OperationsOperatorOptions): Promise<OperationsSourceListResponseDto> {
	const sources = await authorizedSources(options, 'operations.read')
	return { items: sources.map(sourceDto) }
}

export async function sourceDetail(sourceId: string, options: OperationsOperatorOptions): Promise<OperationsSourceDetailResponseDto> {
	const source = await visibleSource(sourceId, 'operations.read', options)
	return { source: sourceDto(source) }
}

export async function listAssignees(
	request: Request,
	sourceId: string,
	options: OperationsOperatorOptions,
): Promise<OperationsAssigneeListResponseDto> {
	await visibleSource(sourceId, 'operations.triage', options)
	const result = await options.principals.listPrincipals(request)
	if (!result.ok) throw new OperatorRequestError(result.status, result.reason)
	return {
		items: result.principals
			.filter((principal) => principal.type === 'user' && !principal.disabled)
			.map((principal) => ({ id: principal.id, label: principal.label })),
	}
}

export function sourceDto(source: SourceRow | IdentifiedOperatorIssueRow | OperatorReleaseRow): OperationsSourceSummaryDto {
	if ('app_id' in source) {
		return {
			id: source.id,
			appId: source.app_id,
			environment: source.environment,
			serviceKey: source.service_key,
			displayName: source.display_name,
			publicOrigin: source.public_origin,
			enabled: source.enabled === 1,
		}
	}
	return {
		id: source.source_id,
		appId: source.source_app_id,
		environment: source.source_environment,
		serviceKey: source.source_service_key,
		displayName: source.source_display_name,
		publicOrigin: source.source_public_origin,
		enabled: source.source_enabled === 1,
	}
}
