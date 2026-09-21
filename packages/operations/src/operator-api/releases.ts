import type {
	OperationsReleaseDetailResponseDto,
	OperationsReleaseListResponseDto,
	OperationsReleaseSummaryDto,
} from '@fabrika/operations-contract/operator-api'
import type { OperationsReleaseQuery } from '@fabrika/operations-contract/rpc'
import { canAccessOperationsSource } from '../access.js'
import type { OperatorReleaseRow } from '../repositories.js'
import { authorizedSources, sourceAccess } from './access.js'
import type { OperationsOperatorOptions } from './context.js'
import { notFoundError } from './errors.js'
import { issueSummary } from './issues.js'
import { boundedLimit, offsetCursor } from './pagination.js'
import { sourceDto } from './sources.js'
import { nullableNumeric, numeric } from './values.js'

export async function listReleases(
	queryInput: OperationsReleaseQuery,
	options: OperationsOperatorOptions,
): Promise<OperationsReleaseListResponseDto> {
	let sources = await authorizedSources(options, 'operations.read')
	if (queryInput.sourceId !== undefined) sources = sources.filter((source) => source.id === queryInput.sourceId)
	const offset = offsetCursor(queryInput.cursor ?? null)
	const limit = boundedLimit(queryInput.limit === undefined ? null : String(queryInput.limit))
	const rows = await options.repositories.operator.listReleases({ sourceIds: sources.map((source) => source.id), offset, limit })
	return {
		items: rows.map(releaseSummary),
		nextCursor: rows.length === limit ? String(offset + rows.length) : null,
	}
}

export async function releaseDetail(releaseId: string, options: OperationsOperatorOptions): Promise<OperationsReleaseDetailResponseDto> {
	const release = await options.repositories.operator.getReleaseById(releaseId)
	if (release === null || !canAccessOperationsSource(options.auth, 'operations.read', sourceAccess(release))) return notFoundError()
	const issues = await options.repositories.operator.listReleaseIssues(release)
	return {
		release: releaseSummary(release),
		issues: issues.map((row) => issueSummary(row)),
	}
}

function releaseSummary(row: OperatorReleaseRow): OperationsReleaseSummaryDto {
	return {
		id: row.id,
		source: sourceDto(row),
		runId: row.run_id,
		commitSha: row.commit_sha,
		state: row.state,
		artifactState: row.artifact_state,
		releaseName: row.release_name,
		createdAt: numeric(row.created_at),
		finishedAt: nullableNumeric(row.finished_at),
		newIssueCount: numeric(row.new_issue_count),
		regressionCount: numeric(row.regression_count),
	}
}
