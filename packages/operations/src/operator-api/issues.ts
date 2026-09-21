import type { IssueMutation, IssueStatus } from '@fabrika/operations-contract/operator'
import type {
	OperationsBulkIssueStatusResponseDto,
	OperationsEventDetailResponseDto,
	OperationsIssueDetailDto,
	OperationsIssueDetailResponseDto,
	OperationsIssueListResponseDto,
	OperationsIssueMutationRequestDto,
	OperationsIssueOccurrenceDto,
	OperationsIssueOccurrenceListResponseDto,
	OperationsIssueSummaryDto,
} from '@fabrika/operations-contract/operator-api'
import type { OperationsIssueQuery } from '@fabrika/operations-contract/rpc'
import { auditIssueMutation, canAccessOperationsSource, normalizeIssueAssignment } from '../access.js'
import { parseEventDetail } from '../event-detail.js'
import type { IdentifiedOperatorIssueRow, OperatorOccurrenceRow } from '../repositories.js'
import { authorizedSources, sourceAccess, visibleIssue } from './access.js'
import type { OperationsOperatorOptions } from './context.js'
import { badRequest, notFoundError, OperatorRequestError } from './errors.js'
import { boundedLimit, encodeIssueCursor, encodeOccurrenceCursor, issueCursor, occurrenceCursor } from './pagination.js'
import { sourceDto } from './sources.js'
import { now, nullableNumeric, numeric } from './values.js'

export async function listIssues(queryInput: OperationsIssueQuery, options: OperationsOperatorOptions): Promise<OperationsIssueListResponseDto> {
	let sources = await authorizedSources(options, 'operations.read')
	if (queryInput.sourceId !== undefined) sources = sources.filter((source) => source.id === queryInput.sourceId)
	const status = queryInput.status
	const level = queryInput.level
	const query = queryInput.query?.trim()
	const sort = queryInput.sort ?? 'recent'
	const after = issueCursor(queryInput.cursor, sort)
	const since = issueWindowStart(queryInput.window, now(options))
	let assignee: { kind: 'principal'; id: string } | { kind: 'none' } | undefined
	if (queryInput.assignee === 'none') assignee = { kind: 'none' }
	if (queryInput.assignee === 'me') assignee = { kind: 'principal', id: options.auth.principal?.id ?? '' }
	const limit = boundedLimit(queryInput.limit)
	const sourceIds = sources.map((source) => source.id)
	await options.repositories.operator.ensureIssueIds(sourceIds)
	const [rows, counts] = await Promise.all([
		options.repositories.operator.listIssues({
			sourceIds,
			...(status === undefined ? {} : { status }),
			...(level === undefined ? {} : { level }),
			...(since === undefined ? {} : { since }),
			...(query ? { query } : {}),
			...(assignee === undefined ? {} : { assignee }),
			sort,
			...(after === undefined ? {} : { after }),
			limit: limit + 1,
		}),
		options.repositories.operator.issueStatusCounts({
			sourceIds,
			...(level === undefined ? {} : { level }),
			...(since === undefined ? {} : { since }),
			...(query ? { query } : {}),
			...(assignee === undefined ? {} : { assignee }),
		}),
	])
	const hasMore = rows.length > limit
	const page = hasMore ? rows.slice(0, limit) : rows
	const trendRows = await options.repositories.operator.issueTrends({
		issues: page,
		since: now(options) - 24 * 60 * 60 * 1_000,
		until: now(options),
		buckets: 12,
	})
	const trends = new Map<string, number[]>()
	for (const row of page) trends.set(row.id, Array.from({ length: 12 }, () => 0))
	for (const trend of trendRows) {
		const buckets = trends.get(trend.issue_id)
		if (buckets !== undefined) buckets[trend.bucket] = trend.count
	}
	const summary = { total: 0, open: 0, resolved: 0, ignored: 0 }
	for (const count of counts) {
		summary[count.status] = count.count
		summary.total += count.count
	}
	return {
		items: page.map((row) => issueSummary(row, trends.get(row.id))),
		nextCursor: hasMore && page.length > 0 ? encodeIssueCursor(page[page.length - 1], sort) : null,
		summary,
	}
}

export async function issueDetail(issueId: string, options: OperationsOperatorOptions): Promise<OperationsIssueDetailResponseDto> {
	const issue = await visibleIssue(issueId, 'operations.read', options)
	return { issue: await completeIssue(issue, options) }
}

export async function issueOccurrences(
	issueId: string,
	cursorValue: string | undefined,
	requestedLimit: number | undefined,
	options: OperationsOperatorOptions,
): Promise<OperationsIssueOccurrenceListResponseDto> {
	const issue = await visibleIssue(issueId, 'operations.read', options)
	const limit = requestedLimit ?? 50
	const after = occurrenceCursor(cursorValue)
	const rows = await options.repositories.operator.listOccurrences({
		issue,
		...(after === undefined ? {} : { after }),
		limit: limit + 1,
	})
	const hasMore = rows.length > limit
	const page = hasMore ? rows.slice(0, limit) : rows
	return {
		items: page.map(occurrenceSummary),
		nextCursor: hasMore && page.length > 0 ? encodeOccurrenceCursor(page[page.length - 1]) : null,
	}
}

export async function issueLatestEvent(issueId: string, options: OperationsOperatorOptions): Promise<OperationsEventDetailResponseDto> {
	const issue = await visibleIssue(issueId, 'operations.read', options)
	const occurrence = await options.repositories.operator.latestOccurrence(issue)
	if (occurrence === null) return notFoundError()
	return eventDetail(occurrence, options)
}

export async function issueEvent(
	issueId: string,
	occurrenceId: string,
	options: OperationsOperatorOptions,
): Promise<OperationsEventDetailResponseDto> {
	const issue = await visibleIssue(issueId, 'operations.read', options)
	const occurrence = await options.repositories.operator.getOccurrence(issue, occurrenceId)
	if (occurrence === null) return notFoundError()
	return eventDetail(occurrence, options)
}

async function eventDetail(occurrence: OperatorOccurrenceRow, options: OperationsOperatorOptions): Promise<OperationsEventDetailResponseDto> {
	const object = await options.payloads.get(occurrence.blob_key)
	if (object === null) return notFoundError()
	const detail = await parseEventDetail(await object.text(), occurrence.source_id, {
		get: (key) => options.payloads.get(key),
		getSourceMap: async (sourceId, releaseName, logicalPath) => {
			const key = await options.repositories.artifacts.sourceMapKey(sourceId, releaseName, logicalPath)
			return key === null ? null : options.payloads.get(key)
		},
	})
	return {
		occurrenceId: occurrence.id,
		receivedAt: numeric(occurrence.received_at),
		detail,
	}
}

export async function mutateIssue(
	request: Request,
	issueId: string,
	mutationInput: OperationsIssueMutationRequestDto,
	options: OperationsOperatorOptions,
): Promise<OperationsIssueDetailResponseDto> {
	const issue = await visibleIssue(issueId, 'operations.triage', options)
	const mutation = await internalMutation(request, mutationInput, issue, options)
	const principal = options.auth.principal
	const updated = await options.repositories.issues.mutate({
		sourceId: issue.source_id,
		fingerprint: issue.fingerprint,
		mutation,
		actorId: principal?.id ?? null,
		actorLabel: principal?.label ?? null,
	})
	if (updated === null) return notFoundError()
	await auditIssueMutation(options.auth, issueId, mutation)
	const identified = await options.repositories.operator.getIssueById(issueId)
	if (identified === null) return notFoundError()
	return { issue: await completeIssue(identified, options) }
}

export async function bulkIssueStatus(
	input: { issueIds: string[]; status: IssueStatus },
	options: OperationsOperatorOptions,
): Promise<OperationsBulkIssueStatusResponseDto> {
	const rawIds = input.issueIds
	if (rawIds.length === 0 || rawIds.length > 100) throw badRequest('issueIds must contain between 1 and 100 ids')
	const ids = [...new Set(rawIds)]
	if (ids.length !== rawIds.length) throw badRequest('issueIds must not contain duplicates')
	const status = input.status
	const issues = await options.repositories.operator.getIssuesByIds(ids)
	if (issues.length !== ids.length) return notFoundError()
	for (const issue of issues) {
		if (!canAccessOperationsSource(options.auth, 'operations.triage', sourceAccess(issue))) return notFoundError()
	}
	const principal = options.auth.principal
	const updated = await options.repositories.operator.bulkStatus({
		issues,
		status,
		actorId: principal?.id ?? null,
		actorLabel: principal?.label ?? null,
	})
	await Promise.all(ids.map((id) => auditIssueMutation(options.auth, id, { kind: 'status', status })))
	return { items: updated.map((row) => issueSummary(row)) }
}

async function completeIssue(issue: IdentifiedOperatorIssueRow, options: OperationsOperatorOptions): Promise<OperationsIssueDetailDto> {
	await options.repositories.operator.ensureIssueIds([issue.source_id])
	const [activity, occurrencePage, release, mergedInto, trendRows] = await Promise.all([
		options.repositories.issues.activity(issue.source_id, issue.fingerprint),
		options.repositories.operator.listOccurrences({ issue, limit: 51 }),
		issue.resolved_in_release === null
			? Promise.resolve(null)
			: options.repositories.operator.getReleaseByName(issue.source_id, issue.resolved_in_release),
		issue.merged_into === null
			? Promise.resolve(null)
			: options.repositories.operator.getIssueByCoordinate(issue.source_id, issue.merged_into),
		options.repositories.operator.issueTrends({
			issues: [issue],
			since: now(options) - 24 * 60 * 60 * 1_000,
			until: now(options),
			buckets: 12,
		}),
	])
	const hasMoreOccurrences = occurrencePage.length > 50
	const occurrences = hasMoreOccurrences ? occurrencePage.slice(0, 50) : occurrencePage
	const trend = Array.from({ length: 12 }, () => 0)
	for (const row of trendRows) trend[row.bucket] = row.count
	return {
		...issueSummary(issue, trend),
		snoozeUntil: nullableNumeric(issue.snooze_until),
		snoozeUntilCount: nullableNumeric(issue.snooze_until_count),
		resolvedInRelease: release === null ? null : { id: release.id, name: release.release_name },
		mergedIntoIssueId: mergedInto?.id ?? null,
		activity,
		latestOccurrence: occurrences[0] === undefined ? null : occurrenceSummary(occurrences[0]),
		occurrences: occurrences.map(occurrenceSummary),
		occurrencesNextCursor: hasMoreOccurrences && occurrences.length > 0
			? encodeOccurrenceCursor(occurrences[occurrences.length - 1])
			: null,
	}
}

async function internalMutation(
	request: Request,
	mutationInput: OperationsIssueMutationRequestDto,
	issue: IdentifiedOperatorIssueRow,
	options: OperationsOperatorOptions,
): Promise<IssueMutation> {
	const mutation = mutationInput
	if (mutation.kind === 'assign') {
		if (mutation.principalId === null) return { kind: 'assign', principalId: null, principalLabel: null }
		const principals = await options.principals.listPrincipals(request)
		if (!principals.ok) throw new OperatorRequestError(principals.status, principals.reason)
		return normalizeIssueAssignment(
			{ kind: 'assign', principalId: mutation.principalId, principalLabel: null },
			principals.principals,
		)
	}
	if (mutation.kind === 'merge') {
		const target = await options.repositories.operator.getIssueById(mutation.targetIssueId)
		if (
			target === null
			|| target.source_id !== issue.source_id
			|| !canAccessOperationsSource(options.auth, 'operations.triage', sourceAccess(target))
		) return notFoundError()
		return { kind: 'merge', target: target.fingerprint }
	}
	if (mutation.kind === 'resolve_in_release') {
		if (mutation.releaseId === null) return { kind: 'resolve_in_release', release: null }
		const release = await options.repositories.operator.getReleaseById(mutation.releaseId)
		if (release === null || release.source_id !== issue.source_id) return notFoundError()
		return { kind: 'resolve_in_release', release: release.release_name }
	}
	if (mutation.kind === 'snooze_count') return { ...mutation, currentCount: 0 }
	return mutation
}

export function issueSummary(row: IdentifiedOperatorIssueRow, trend: number[] = Array.from({ length: 12 }, () => 0)): OperationsIssueSummaryDto {
	return {
		id: row.id,
		source: sourceDto(row),
		title: row.title,
		culprit: row.culprit,
		level: row.level,
		status: row.status,
		assignedTo: row.assigned_to === null ? null : { id: row.assigned_to, label: row.assigned_to_label },
		regressedAt: nullableNumeric(row.regressed_at),
		firstSeen: numeric(row.first_seen),
		lastSeen: numeric(row.last_seen),
		count: numeric(row.occurrence_count),
		trend,
	}
}

function occurrenceSummary(occurrence: OperatorOccurrenceRow): OperationsIssueOccurrenceDto {
	return {
		id: occurrence.id,
		eventId: occurrence.event_id,
		receivedAt: numeric(occurrence.received_at),
		release: occurrence.release,
	}
}

function issueWindowStart(window: OperationsIssueQuery['window'], at: number): number | undefined {
	if (window === undefined || window === 'all') return undefined
	if (window === '24h') return at - 24 * 60 * 60 * 1_000
	if (window === '7d') return at - 7 * 24 * 60 * 60 * 1_000
	return at - 30 * 24 * 60 * 60 * 1_000
}
