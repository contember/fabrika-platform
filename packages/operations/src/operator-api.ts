import type { AuthContext, ListPrincipalsFailure, PrincipalList } from '@fabrika/auth'
import type { IssueMutation, IssueStatus } from '@fabrika/operations-contract/operator'
import type {
	OperationsAlertKind,
	OperationsAlertSettingsResponseDto,
	OperationsAssigneeListResponseDto,
	OperationsBulkIssueStatusResponseDto,
	OperationsEventDetailResponseDto,
	OperationsHealthCheckDto,
	OperationsHealthCheckUpsertRequestDto,
	OperationsHealthResponseDto,
	OperationsIssueDetailDto,
	OperationsIssueDetailResponseDto,
	OperationsIssueListResponseDto,
	OperationsIssueMutationRequestDto,
	OperationsIssueSummaryDto,
	OperationsNotificationChannelRequestDto,
	OperationsReleaseDetailResponseDto,
	OperationsReleaseListResponseDto,
	OperationsReleaseSummaryDto,
	OperationsSourceDetailResponseDto,
	OperationsSourceHealthDto,
	OperationsSourceListResponseDto,
	OperationsSourceSummaryDto,
	OperationsSpikeAlertRequestDto,
} from '@fabrika/operations-contract/operator-api'
import type { OperationsIssueQuery, OperationsReleaseQuery } from '@fabrika/operations-contract/rpc'
import type { BlobStore } from '@fabrika/platform'
import {
	auditIssueMutation,
	canAccessOperationsSource,
	filterOperationsSources,
	normalizeIssueAssignment,
	type OperationsSourceAccess,
} from './access.js'
import { parseEventDetail } from './event-detail.js'
import type { HealthCheckRow, HealthRepository } from './health-repository.js'
import { visibleHealthState } from './health.js'
import type { IdentifiedOperatorIssueRow, OperationsRepositories, OperatorOccurrenceRow, OperatorReleaseRow, SourceRow } from './repositories.js'
import { uuidv7 } from './uuid.js'
import { isValidWebhookTarget } from './webhook-target.js'

const ISSUE_DETAIL = /^\/api\/issues\/([^/]+)$/
const ISSUE_LATEST_EVENT = /^\/api\/issues\/([^/]+)\/events\/latest$/
const SOURCE_DETAIL = /^\/api\/sources\/([^/]+)$/
const SOURCE_ASSIGNEES = /^\/api\/sources\/([^/]+)\/assignees$/
const SOURCE_HEALTH = /^\/api\/sources\/([^/]+)\/health$/
const SOURCE_HEALTH_CHECKS = /^\/api\/sources\/([^/]+)\/health-checks$/
const SOURCE_HEALTH_CHECK = /^\/api\/sources\/([^/]+)\/health-checks\/([^/]+)$/
const SOURCE_ALERTS = /^\/api\/sources\/([^/]+)\/alerts$/
const SOURCE_ALERT_SPIKE = /^\/api\/sources\/([^/]+)\/alerts\/spike$/
const SOURCE_ALERT_RULE = /^\/api\/sources\/([^/]+)\/alerts\/rules\/([^/]+)$/
const SOURCE_ALERT_CHANNELS = /^\/api\/sources\/([^/]+)\/alerts\/channels$/
const SOURCE_ALERT_CHANNEL = /^\/api\/sources\/([^/]+)\/alerts\/channels\/([^/]+)$/
const RELEASE_DETAIL = /^\/api\/releases\/([^/]+)$/

export interface OperationsPrincipalDirectory {
	listPrincipals(request: Request): Promise<PrincipalList | ListPrincipalsFailure>
}

export interface OperationsOperatorOptions {
	repositories: OperationsRepositories
	health: HealthRepository
	payloads: BlobStore
	auth: AuthContext
	principals: OperationsPrincipalDirectory
	now?: () => number
}

/** Typed operator use-cases shared by the REST compatibility adapter and RPC. */
export class OperationsOperatorUseCases {
	constructor(
		private readonly request: Request,
		private readonly options: OperationsOperatorOptions,
	) {}

	sources(): Promise<OperationsSourceListResponseDto> {
		return listSources(this.options)
	}

	source(sourceId: string): Promise<OperationsSourceDetailResponseDto> {
		return sourceDetail(sourceId, this.options)
	}

	issues(query: OperationsIssueQuery): Promise<OperationsIssueListResponseDto> {
		return listIssues(query, this.options)
	}

	issue(issueId: string): Promise<OperationsIssueDetailResponseDto> {
		return issueDetail(issueId, this.options)
	}

	latestEvent(issueId: string): Promise<OperationsEventDetailResponseDto> {
		return issueLatestEvent(issueId, this.options)
	}

	mutateIssue(issueId: string, mutation: OperationsIssueMutationRequestDto): Promise<OperationsIssueDetailResponseDto> {
		return mutateIssue(this.request, issueId, () => Promise.resolve(mutation), this.options)
	}

	mutateIssueAfterAuthorization(
		issueId: string,
		loadMutation: () => Promise<OperationsIssueMutationRequestDto>,
	): Promise<OperationsIssueDetailResponseDto> {
		return mutateIssue(this.request, issueId, loadMutation, this.options)
	}

	bulkIssueStatus(input: { issueIds: string[]; status: IssueStatus }): Promise<OperationsBulkIssueStatusResponseDto> {
		return bulkIssueStatus(input, this.options)
	}

	assignees(sourceId: string): Promise<OperationsAssigneeListResponseDto> {
		return listAssignees(this.request, sourceId, this.options)
	}

	releases(query: OperationsReleaseQuery): Promise<OperationsReleaseListResponseDto> {
		return listReleases(query, this.options)
	}

	release(releaseId: string): Promise<OperationsReleaseDetailResponseDto> {
		return releaseDetail(releaseId, this.options)
	}

	health(): Promise<OperationsHealthResponseDto> {
		return healthOverview(this.options)
	}

	sourceHealth(sourceId: string): Promise<OperationsSourceHealthDto> {
		return sourceHealth(sourceId, this.options)
	}

	createHealthCheck(sourceId: string, input: OperationsHealthCheckUpsertRequestDto): Promise<{ id: string }> {
		return createHealthCheck(sourceId, () => Promise.resolve(input), this.options)
	}

	createHealthCheckAfterAuthorization(
		sourceId: string,
		loadInput: () => Promise<OperationsHealthCheckUpsertRequestDto>,
	): Promise<{ id: string }> {
		return createHealthCheck(sourceId, loadInput, this.options)
	}

	updateHealthCheck(sourceId: string, checkId: string, input: OperationsHealthCheckUpsertRequestDto): Promise<{ id: string }> {
		return updateHealthCheck(sourceId, checkId, () => Promise.resolve(input), this.options)
	}

	updateHealthCheckAfterAuthorization(
		sourceId: string,
		checkId: string,
		loadInput: () => Promise<OperationsHealthCheckUpsertRequestDto>,
	): Promise<{ id: string }> {
		return updateHealthCheck(sourceId, checkId, loadInput, this.options)
	}

	deleteHealthCheck(sourceId: string, checkId: string): Promise<null> {
		return deleteHealthCheck(sourceId, checkId, this.options)
	}

	alerts(sourceId: string): Promise<OperationsAlertSettingsResponseDto> {
		return alertSettings(sourceId, this.options)
	}

	updateSpikeAlert(sourceId: string, input: OperationsSpikeAlertRequestDto): Promise<{ threshold: number; enabled: boolean }> {
		return updateSpikeAlert(sourceId, () => Promise.resolve(input), this.options)
	}

	updateSpikeAlertAfterAuthorization(
		sourceId: string,
		loadInput: () => Promise<OperationsSpikeAlertRequestDto>,
	): Promise<{ threshold: number; enabled: boolean }> {
		return updateSpikeAlert(sourceId, loadInput, this.options)
	}

	updateAlertRule(sourceId: string, kind: OperationsAlertKind, input: { enabled: boolean }): Promise<{ kind: OperationsAlertKind; enabled: boolean }> {
		return updateAlertRule(sourceId, () => Promise.resolve(kind), () => Promise.resolve(input), this.options)
	}

	updateAlertRuleAfterAuthorization(
		sourceId: string,
		loadKind: () => Promise<OperationsAlertKind>,
		loadInput: () => Promise<{ enabled: boolean }>,
	): Promise<{ kind: OperationsAlertKind; enabled: boolean }> {
		return updateAlertRule(sourceId, loadKind, loadInput, this.options)
	}

	createAlertChannel(sourceId: string, input: OperationsNotificationChannelRequestDto): Promise<{ id: string }> {
		return createAlertChannel(sourceId, () => Promise.resolve(input), this.options)
	}

	createAlertChannelAfterAuthorization(
		sourceId: string,
		loadInput: () => Promise<OperationsNotificationChannelRequestDto>,
	): Promise<{ id: string }> {
		return createAlertChannel(sourceId, loadInput, this.options)
	}

	updateAlertChannel(sourceId: string, channelId: string, input: OperationsNotificationChannelRequestDto): Promise<{ id: string }> {
		return updateAlertChannel(sourceId, channelId, () => Promise.resolve(input), this.options)
	}

	updateAlertChannelAfterAuthorization(
		sourceId: string,
		channelId: string,
		loadInput: () => Promise<OperationsNotificationChannelRequestDto>,
	): Promise<{ id: string }> {
		return updateAlertChannel(sourceId, channelId, loadInput, this.options)
	}

	deleteAlertChannel(sourceId: string, channelId: string): Promise<null> {
		return deleteAlertChannel(sourceId, channelId, this.options)
	}
}

export async function handleOperationsOperatorRequest(request: Request, options: OperationsOperatorOptions): Promise<Response> {
	try {
		const url = new URL(request.url)
		if (!url.pathname.startsWith('/api/')) return notFound()
		const useCases = new OperationsOperatorUseCases(request, options)

		if (url.pathname === '/api/sources' && request.method === 'GET') return Response.json(await useCases.sources())
		if (url.pathname === '/api/issues' && request.method === 'GET') return Response.json(await useCases.issues(issueQuery(url)))
		if (url.pathname === '/api/issues/bulk' && request.method === 'PUT') {
			return Response.json(await useCases.bulkIssueStatus(await bulkIssueStatusInput(request)))
		}
		if (url.pathname === '/api/releases' && request.method === 'GET') return Response.json(await useCases.releases(releaseQuery(url)))
		if (url.pathname === '/api/health' && request.method === 'GET') return Response.json(await useCases.health())

		const latestEvent = ISSUE_LATEST_EVENT.exec(url.pathname)
		if (latestEvent && request.method === 'GET') return Response.json(await useCases.latestEvent(decode(latestEvent[1])))
		const issue = ISSUE_DETAIL.exec(url.pathname)
		if (issue && request.method === 'GET') return Response.json(await useCases.issue(decode(issue[1])))
		if (issue && request.method === 'PUT') {
			return Response.json(
				await useCases.mutateIssueAfterAuthorization(decode(issue[1]), async () => issueMutation(await jsonObject(request))),
			)
		}

		const assignees = SOURCE_ASSIGNEES.exec(url.pathname)
		if (assignees && request.method === 'GET') return Response.json(await useCases.assignees(decode(assignees[1])))
		const health = SOURCE_HEALTH.exec(url.pathname)
		if (health && request.method === 'GET') return Response.json(await useCases.sourceHealth(decode(health[1])))
		const healthChecks = SOURCE_HEALTH_CHECKS.exec(url.pathname)
		if (healthChecks && request.method === 'POST') {
			return Response.json(
				await useCases.createHealthCheckAfterAuthorization(decode(healthChecks[1]), () => healthCheckInput(request)),
				{ status: 201 },
			)
		}
		const healthCheck = SOURCE_HEALTH_CHECK.exec(url.pathname)
		if (healthCheck && request.method === 'PUT') {
			return Response.json(
				await useCases.updateHealthCheckAfterAuthorization(
					decode(healthCheck[1]),
					decode(healthCheck[2]),
					() => healthCheckInput(request),
				),
			)
		}
		if (healthCheck && request.method === 'DELETE') {
			await useCases.deleteHealthCheck(decode(healthCheck[1]), decode(healthCheck[2]))
			return new Response(null, { status: 204 })
		}

		const alerts = SOURCE_ALERTS.exec(url.pathname)
		if (alerts && request.method === 'GET') return Response.json(await useCases.alerts(decode(alerts[1])))
		const spike = SOURCE_ALERT_SPIKE.exec(url.pathname)
		if (spike && request.method === 'PUT') {
			return Response.json(
				await useCases.updateSpikeAlertAfterAuthorization(decode(spike[1]), async () => spikeAlertInput(await jsonObject(request))),
			)
		}
		const rule = SOURCE_ALERT_RULE.exec(url.pathname)
		if (rule && request.method === 'PUT') {
			return Response.json(
				await useCases.updateAlertRuleAfterAuthorization(
					decode(rule[1]),
					() => Promise.resolve(requiredAlertKind(decode(rule[2]))),
					async () => alertRuleInput(await jsonObject(request)),
				),
			)
		}
		const channels = SOURCE_ALERT_CHANNELS.exec(url.pathname)
		if (channels && request.method === 'POST') {
			return Response.json(
				await useCases.createAlertChannelAfterAuthorization(
					decode(channels[1]),
					async () => channelInput(await jsonObject(request), true),
				),
				{ status: 201 },
			)
		}
		const channel = SOURCE_ALERT_CHANNEL.exec(url.pathname)
		if (channel && request.method === 'PUT') {
			return Response.json(
				await useCases.updateAlertChannelAfterAuthorization(
					decode(channel[1]),
					decode(channel[2]),
					async () => channelInput(await jsonObject(request), false),
				),
			)
		}
		if (channel && request.method === 'DELETE') {
			await useCases.deleteAlertChannel(decode(channel[1]), decode(channel[2]))
			return new Response(null, { status: 204 })
		}

		const source = SOURCE_DETAIL.exec(url.pathname)
		if (source && request.method === 'GET') return Response.json(await useCases.source(decode(source[1])))
		const release = RELEASE_DETAIL.exec(url.pathname)
		if (release && request.method === 'GET') return Response.json(await useCases.release(decode(release[1])))
		return notFound()
	} catch (error) {
		if (error instanceof OperatorRequestError) return Response.json({ error: error.message }, { status: error.httpStatus })
		if (error instanceof RangeError) return Response.json({ error: error.message }, { status: 400 })
		console.error('operations operator request failed')
		return Response.json({ error: 'internal error' }, { status: 500 })
	}
}

async function listSources(options: OperationsOperatorOptions): Promise<OperationsSourceListResponseDto> {
	const sources = await authorizedSources(options, 'operations.read')
	return { items: sources.map(sourceDto) }
}

async function sourceDetail(sourceId: string, options: OperationsOperatorOptions): Promise<OperationsSourceDetailResponseDto> {
	const source = await visibleSource(sourceId, 'operations.read', options)
	return { source: sourceDto(source) }
}

async function listIssues(queryInput: OperationsIssueQuery, options: OperationsOperatorOptions): Promise<OperationsIssueListResponseDto> {
	let sources = await authorizedSources(options, 'operations.read')
	if (queryInput.sourceId !== undefined) sources = sources.filter((source) => source.id === queryInput.sourceId)
	const status = queryInput.status
	const query = queryInput.query?.trim()
	const offset = cursor(queryInput.cursor ?? null)
	const limit = boundedLimit(queryInput.limit === undefined ? null : String(queryInput.limit))
	const sourceIds = sources.map((source) => source.id)
	await options.repositories.operator.ensureIssueIds(sourceIds)
	const [rows, counts] = await Promise.all([
		options.repositories.operator.listIssues({ sourceIds, ...(status === undefined ? {} : { status }), ...(query ? { query } : {}), offset, limit }),
		options.repositories.operator.issueStatusCounts(sourceIds),
	])
	const summary = { total: 0, open: 0, resolved: 0, ignored: 0 }
	for (const count of counts) {
		summary[count.status] = count.count
		summary.total += count.count
	}
	return {
		items: rows.map(issueSummary),
		nextCursor: rows.length === limit ? String(offset + rows.length) : null,
		summary,
	}
}

async function issueDetail(issueId: string, options: OperationsOperatorOptions): Promise<OperationsIssueDetailResponseDto> {
	const issue = await visibleIssue(issueId, 'operations.read', options)
	return { issue: await completeIssue(issue, options) }
}

async function issueLatestEvent(issueId: string, options: OperationsOperatorOptions): Promise<OperationsEventDetailResponseDto> {
	const issue = await visibleIssue(issueId, 'operations.read', options)
	const occurrence = await options.repositories.operator.latestOccurrence(issue.source_id, issue.fingerprint)
	if (occurrence === null) return notFoundError()
	const object = await options.payloads.get(occurrence.blob_key)
	if (object === null) return notFoundError()
	const detail = await parseEventDetail(await object.text(), {
		get: (key) => options.payloads.get(key),
		getSourceMap: async (releaseName, logicalPath) => {
			const key = await options.repositories.artifacts.sourceMapKey(releaseName, logicalPath)
			return key === null ? null : options.payloads.get(key)
		},
	})
	return {
		occurrenceId: occurrence.id,
		receivedAt: numeric(occurrence.received_at),
		detail,
	}
}

async function mutateIssue(
	request: Request,
	issueId: string,
	loadMutation: () => Promise<OperationsIssueMutationRequestDto>,
	options: OperationsOperatorOptions,
): Promise<OperationsIssueDetailResponseDto> {
	const issue = await visibleIssue(issueId, 'operations.triage', options)
	const mutationInput = await loadMutation()
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

async function bulkIssueStatus(
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
	return { items: updated.map(issueSummary) }
}

async function listAssignees(
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

async function listReleases(queryInput: OperationsReleaseQuery, options: OperationsOperatorOptions): Promise<OperationsReleaseListResponseDto> {
	let sources = await authorizedSources(options, 'operations.read')
	if (queryInput.sourceId !== undefined) sources = sources.filter((source) => source.id === queryInput.sourceId)
	const offset = cursor(queryInput.cursor ?? null)
	const limit = boundedLimit(queryInput.limit === undefined ? null : String(queryInput.limit))
	const rows = await options.repositories.operator.listReleases({ sourceIds: sources.map((source) => source.id), offset, limit })
	return {
		items: rows.map(releaseSummary),
		nextCursor: rows.length === limit ? String(offset + rows.length) : null,
	}
}

async function releaseDetail(releaseId: string, options: OperationsOperatorOptions): Promise<OperationsReleaseDetailResponseDto> {
	const release = await options.repositories.operator.getReleaseById(releaseId)
	if (release === null || !canAccessOperationsSource(options.auth, 'operations.read', sourceAccess(release))) return notFoundError()
	const issues = await options.repositories.operator.listReleaseIssues(release)
	return {
		release: releaseSummary(release),
		issues: issues.map(issueSummary),
	}
}

async function healthOverview(options: OperationsOperatorOptions): Promise<OperationsHealthResponseDto> {
	const sources = await authorizedSources(options, 'operations.read')
	return {
		sources: await Promise.all(sources.map((source) => healthForSource(source, options))),
	}
}

async function sourceHealth(sourceId: string, options: OperationsOperatorOptions): Promise<OperationsSourceHealthDto> {
	const source = await visibleSource(sourceId, 'operations.read', options)
	return healthForSource(source, options)
}

async function createHealthCheck(
	sourceId: string,
	loadInput: () => Promise<OperationsHealthCheckUpsertRequestDto>,
	options: OperationsOperatorOptions,
): Promise<{ id: string }> {
	await visibleSource(sourceId, 'operations.manage', options)
	const input = await loadInput()
	const checkId = uuidv7(now(options))
	await options.health.upsertCheck({ id: checkId, sourceId, ...input })
	await options.auth.audit({ action: 'operations.health_check.create', resourceType: 'operations_health_check', resourceId: checkId })
	return { id: checkId }
}

async function updateHealthCheck(
	sourceId: string,
	checkId: string,
	loadInput: () => Promise<OperationsHealthCheckUpsertRequestDto>,
	options: OperationsOperatorOptions,
): Promise<{ id: string }> {
	await visibleSource(sourceId, 'operations.manage', options)
	const existing = await options.health.getCheck(checkId)
	if (existing === null || existing.source_id !== sourceId) return notFoundError()
	const input = await loadInput()
	await options.health.upsertCheck({ id: checkId, sourceId, ...input })
	await options.auth.audit({ action: 'operations.health_check.update', resourceType: 'operations_health_check', resourceId: checkId })
	return { id: checkId }
}

async function deleteHealthCheck(sourceId: string, checkId: string, options: OperationsOperatorOptions): Promise<null> {
	await visibleSource(sourceId, 'operations.manage', options)
	const existing = await options.health.getCheck(checkId)
	if (existing === null || existing.source_id !== sourceId) return notFoundError()
	if (!await options.health.deleteCheck(sourceId, checkId)) return notFoundError()
	await options.auth.audit({ action: 'operations.health_check.delete', resourceType: 'operations_health_check', resourceId: checkId })
	return null
}

async function alertSettings(sourceId: string, options: OperationsOperatorOptions): Promise<OperationsAlertSettingsResponseDto> {
	await visibleSource(sourceId, 'operations.manage', options)
	const [config, rules, channels] = await Promise.all([
		options.repositories.alerts.getConfig(sourceId),
		options.repositories.alerts.listRules(sourceId),
		options.repositories.alerts.listChannels(sourceId),
	])
	return {
		spike: config === null ? null : { threshold: config.threshold, enabled: config.enabled === 1 },
		rules: rules.flatMap((rule) => {
			const kind = alertKind(rule.type)
			return kind === null ? [] : [{ kind, enabled: rule.enabled === 1 }]
		}),
		channels: channels.flatMap((channel) => {
			const scope = alertKind(channel.scope)
			return scope === null || channel.type !== 'webhook'
				? []
				: [{
					id: channel.id,
					scope,
					type: 'webhook',
					targetDisplay: redactTarget(channel.target),
					hasTarget: channel.target !== '',
					enabled: channel.enabled === 1,
				}]
		}),
	}
}

async function updateSpikeAlert(
	sourceId: string,
	loadInput: () => Promise<OperationsSpikeAlertRequestDto>,
	options: OperationsOperatorOptions,
): Promise<{ threshold: number; enabled: boolean }> {
	await visibleSource(sourceId, 'operations.manage', options)
	const input = await loadInput()
	const { threshold, enabled } = input
	await options.repositories.alerts.setConfig(sourceId, { threshold, enabled })
	await options.auth.audit({ action: 'operations.alert.spike', resourceType: 'operations_source', resourceId: sourceId })
	return { threshold, enabled }
}

async function updateAlertRule(
	sourceId: string,
	loadKind: () => Promise<OperationsAlertKind>,
	loadInput: () => Promise<{ enabled: boolean }>,
	options: OperationsOperatorOptions,
): Promise<{ kind: OperationsAlertKind; enabled: boolean }> {
	await visibleSource(sourceId, 'operations.manage', options)
	const kind = await loadKind()
	const input = await loadInput()
	const { enabled } = input
	await options.repositories.alerts.setRule(sourceId, kind, enabled)
	await options.auth.audit({ action: 'operations.alert.rule', resourceType: 'operations_source', resourceId: sourceId })
	return { kind, enabled }
}

async function createAlertChannel(
	sourceId: string,
	loadInput: () => Promise<OperationsNotificationChannelRequestDto>,
	options: OperationsOperatorOptions,
): Promise<{ id: string }> {
	await visibleSource(sourceId, 'operations.manage', options)
	const input = await loadInput()
	if (input.target === undefined) throw badRequest('target is required')
	if (!isValidWebhookTarget(input.target)) throw badRequest('target must be a public HTTPS URL without credentials or a fragment')
	const id = uuidv7(now(options))
	await options.repositories.alerts.upsertChannel({ id, sourceId, ...input, target: input.target })
	await options.auth.audit({ action: 'operations.alert_channel.create', resourceType: 'operations_alert_channel', resourceId: id })
	return { id }
}

async function updateAlertChannel(
	sourceId: string,
	channelId: string,
	loadInput: () => Promise<OperationsNotificationChannelRequestDto>,
	options: OperationsOperatorOptions,
): Promise<{ id: string }> {
	await visibleSource(sourceId, 'operations.manage', options)
	const existing = (await options.repositories.alerts.listChannels(sourceId)).find((channel) => channel.id === channelId)
	if (existing === undefined) return notFoundError()
	const input = await loadInput()
	if (input.target !== undefined && !isValidWebhookTarget(input.target)) {
		throw badRequest('target must be a public HTTPS URL without credentials or a fragment')
	}
	await options.repositories.alerts.upsertChannel({
		id: channelId,
		sourceId,
		scope: input.scope,
		type: input.type,
		target: input.target ?? existing.target,
		enabled: input.enabled,
	})
	await options.auth.audit({ action: 'operations.alert_channel.update', resourceType: 'operations_alert_channel', resourceId: channelId })
	return { id: channelId }
}

async function deleteAlertChannel(sourceId: string, channelId: string, options: OperationsOperatorOptions): Promise<null> {
	await visibleSource(sourceId, 'operations.manage', options)
	if (!await options.repositories.alerts.deleteChannel(sourceId, channelId)) return notFoundError()
	await options.auth.audit({ action: 'operations.alert_channel.delete', resourceType: 'operations_alert_channel', resourceId: channelId })
	return null
}

async function completeIssue(issue: IdentifiedOperatorIssueRow, options: OperationsOperatorOptions): Promise<OperationsIssueDetailDto> {
	await options.repositories.operator.ensureIssueIds([issue.source_id])
	const [activity, occurrence, release, mergedInto] = await Promise.all([
		options.repositories.issues.activity(issue.source_id, issue.fingerprint),
		options.repositories.operator.latestOccurrence(issue.source_id, issue.fingerprint),
		issue.resolved_in_release === null
			? Promise.resolve(null)
			: options.repositories.operator.getReleaseByName(issue.source_id, issue.resolved_in_release),
		issue.merged_into === null
			? Promise.resolve(null)
			: options.repositories.operator.getIssueByCoordinate(issue.source_id, issue.merged_into),
	])
	return {
		...issueSummary(issue),
		snoozeUntil: nullableNumeric(issue.snooze_until),
		snoozeUntilCount: nullableNumeric(issue.snooze_until_count),
		resolvedInRelease: release === null ? null : { id: release.id, name: release.release_name },
		mergedIntoIssueId: mergedInto?.id ?? null,
		activity,
		latestOccurrence: occurrence === null ? null : occurrenceSummary(occurrence),
	}
}

async function healthForSource(source: SourceRow, options: OperationsOperatorOptions): Promise<OperationsSourceHealthDto> {
	const checks = await options.health.listChecks(source.id)
	const telemetryState = await options.health.getTelemetryState(source.id)
	return {
		source: sourceDto(source),
		httpChecks: await Promise.all(checks.map((check) => healthCheckDto(check, options))),
		telemetryState: telemetryState ?? 'unavailable',
	}
}

async function healthCheckDto(check: HealthCheckRow, options: OperationsOperatorOptions): Promise<OperationsHealthCheckDto> {
	const [current, history] = await Promise.all([
		options.health.getCurrent(check.id),
		options.health.history(check.id, 20),
	])
	const currentDto = current === null
		? null
		: {
			state: current.state,
			observedAt: current.observedAt,
			latencyMs: current.latencyMs,
			detailCode: current.detailCode,
			consecutiveFailures: current.consecutiveFailures,
			consecutiveSuccesses: current.consecutiveSuccesses,
		}
	const visibleState = current === null ? null : visibleHealthState(current, now(options), numeric(check.stale_after_ms))
	if (visibleState === 'unavailable') throw new Error('stored HTTP health unexpectedly resolved as unavailable')
	return {
		id: check.id,
		sourceId: check.source_id,
		path: check.path,
		enabled: check.enabled === 1,
		intervalMs: numeric(check.interval_ms),
		timeoutMs: numeric(check.timeout_ms),
		expectedStatus: check.expected_status,
		failureThreshold: check.failure_threshold,
		recoveryThreshold: check.recovery_threshold,
		staleAfterMs: numeric(check.stale_after_ms),
		current: currentDto === null
			? null
			: { ...currentDto, state: visibleState ?? currentDto.state },
		history: history.map((item) => ({
			id: item.id,
			state: item.state,
			observedAt: item.observedAt,
			latencyMs: item.latencyMs,
			detailCode: item.detailCode,
			successful: item.successful,
			statusCode: item.statusCode,
		})),
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

function issueSummary(row: IdentifiedOperatorIssueRow): OperationsIssueSummaryDto {
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
		trend: [],
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

function sourceDto(source: SourceRow | IdentifiedOperatorIssueRow | OperatorReleaseRow): OperationsSourceSummaryDto {
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

function sourceAccess(source: SourceRow | IdentifiedOperatorIssueRow | OperatorReleaseRow): OperationsSourceAccess {
	if ('app_id' in source) return { id: source.id, appId: source.app_id, environment: source.environment, serviceKey: source.service_key }
	return {
		id: source.source_id,
		appId: source.source_app_id,
		environment: source.source_environment,
		serviceKey: source.source_service_key,
	}
}

async function authorizedSources(
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

async function visibleSource(
	sourceId: string,
	action: 'operations.read' | 'operations.triage' | 'operations.manage',
	options: OperationsOperatorOptions,
): Promise<SourceRow> {
	const source = await options.repositories.sources.get(sourceId)
	if (source === null || !canAccessOperationsSource(options.auth, action, sourceAccess(source))) return notFoundError()
	return source
}

async function visibleIssue(
	issueId: string,
	action: 'operations.read' | 'operations.triage',
	options: OperationsOperatorOptions,
): Promise<IdentifiedOperatorIssueRow> {
	const issue = await options.repositories.operator.getIssueById(issueId)
	if (issue === null || !canAccessOperationsSource(options.auth, action, sourceAccess(issue))) return notFoundError()
	return issue
}

function occurrenceSummary(occurrence: OperatorOccurrenceRow): OperationsIssueDetailDto['latestOccurrence'] {
	return {
		id: occurrence.id,
		eventId: occurrence.event_id,
		receivedAt: numeric(occurrence.received_at),
		release: occurrence.release,
	}
}

async function healthCheckInput(request: Request): Promise<OperationsHealthCheckUpsertRequestDto> {
	const body = await jsonObject(request)
	return healthCheckInputFromObject(body)
}

function healthCheckInputFromObject(body: Record<string, unknown>): OperationsHealthCheckUpsertRequestDto {
	const path = string(body['path'], 'path')
	return {
		path,
		enabled: boolean(body['enabled'], 'enabled'),
		intervalMs: positiveInteger(body['intervalMs'], 'intervalMs'),
		timeoutMs: positiveInteger(body['timeoutMs'], 'timeoutMs'),
		expectedStatus: positiveInteger(body['expectedStatus'], 'expectedStatus'),
		failureThreshold: positiveInteger(body['failureThreshold'], 'failureThreshold'),
		recoveryThreshold: positiveInteger(body['recoveryThreshold'], 'recoveryThreshold'),
		staleAfterMs: positiveInteger(body['staleAfterMs'], 'staleAfterMs'),
	}
}

function channelInput(body: Record<string, unknown>, requireTarget: boolean): OperationsNotificationChannelRequestDto {
	const scope = alertKind(string(body['scope'], 'scope'))
	if (scope === null) throw badRequest('invalid alert scope')
	if (body['type'] !== 'webhook') throw badRequest('type must be webhook')
	const target = body['target']
	if (requireTarget && typeof target !== 'string') throw badRequest('target is required')
	if (target !== undefined && typeof target !== 'string') throw badRequest('target must be a string')
	if (typeof target === 'string' && !isValidWebhookTarget(target)) {
		throw badRequest('target must be a public HTTPS URL without credentials or a fragment')
	}
	return {
		scope,
		type: 'webhook',
		...(typeof target === 'string' ? { target } : {}),
		enabled: boolean(body['enabled'], 'enabled'),
	}
}

function spikeAlertInput(body: Record<string, unknown>): OperationsSpikeAlertRequestDto {
	return {
		threshold: positiveInteger(body['threshold'], 'threshold'),
		enabled: boolean(body['enabled'], 'enabled'),
	}
}

function alertRuleInput(body: Record<string, unknown>): { enabled: boolean } {
	return { enabled: boolean(body['enabled'], 'enabled') }
}

async function bulkIssueStatusInput(request: Request): Promise<{ issueIds: string[]; status: IssueStatus }> {
	const body = await jsonObject(request)
	return { issueIds: stringArray(body['issueIds']), status: issueStatus(body['status']) }
}

function issueQuery(url: URL): OperationsIssueQuery {
	const sourceId = url.searchParams.get('sourceId')
	const status = optionalIssueStatus(url.searchParams.get('status'))
	const query = url.searchParams.get('query')
	const cursorValue = url.searchParams.get('cursor')
	const limitValue = url.searchParams.get('limit')
	return {
		...(sourceId === null ? {} : { sourceId }),
		...(status === undefined ? {} : { status }),
		...(query === null ? {} : { query }),
		...(cursorValue === null || cursorValue === '' ? {} : { cursor: String(cursor(cursorValue)) }),
		...(limitValue === null || limitValue === '' ? {} : { limit: boundedLimit(limitValue) }),
	}
}

function releaseQuery(url: URL): OperationsReleaseQuery {
	const sourceId = url.searchParams.get('sourceId')
	const cursorValue = url.searchParams.get('cursor')
	const limitValue = url.searchParams.get('limit')
	return {
		...(sourceId === null ? {} : { sourceId }),
		...(cursorValue === null || cursorValue === '' ? {} : { cursor: String(cursor(cursorValue)) }),
		...(limitValue === null || limitValue === '' ? {} : { limit: boundedLimit(limitValue) }),
	}
}

function issueMutation(body: Record<string, unknown>): OperationsIssueMutationRequestDto {
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
			throw badRequest('invalid issue mutation')
	}
}

async function jsonObject(request: Request): Promise<Record<string, unknown>> {
	let value: unknown
	try {
		value = await request.json()
	} catch {
		throw badRequest('request body must be valid JSON')
	}
	if (!isRecord(value)) throw badRequest('request body must be an object')
	return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function issueStatus(value: unknown): IssueStatus {
	if (value === 'open' || value === 'resolved' || value === 'ignored') return value
	throw badRequest('invalid issue status')
}

function optionalIssueStatus(value: string | null): IssueStatus | undefined {
	return value === null || value === '' ? undefined : issueStatus(value)
}

function alertKind(value: string): OperationsAlertKind | null {
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

function requiredAlertKind(value: string): OperationsAlertKind {
	const kind = alertKind(value)
	if (kind === null) return notFoundError()
	return kind
}

function string(value: unknown, field: string): string {
	if (typeof value !== 'string' || value === '') throw badRequest(`${field} must be a non-empty string`)
	return value
}

function nullableString(value: unknown, field: string): string | null {
	if (value === null) return null
	return string(value, field)
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) throw badRequest('issueIds must be an array')
	const result: string[] = []
	for (const item of value) result.push(string(item, 'issueId'))
	return result
}

function boolean(value: unknown, field: string): boolean {
	if (typeof value !== 'boolean') throw badRequest(`${field} must be a boolean`)
	return value
}

function positiveInteger(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw badRequest(`${field} must be a positive integer`)
	return value
}

function boundedLimit(value: string | null): number {
	if (value === null || value === '') return 50
	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) throw badRequest('limit must be between 1 and 100')
	return parsed
}

function cursor(value: string | null): number {
	if (value === null || value === '') return 0
	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < 0) throw badRequest('invalid cursor')
	return parsed
}

function redactTarget(target: string): string {
	try {
		const url = new URL(target)
		return `${url.protocol}//${url.host}/…`
	} catch {
		return 'configured'
	}
}

function decode(value: string | undefined): string {
	if (value === undefined) throw badRequest('invalid path')
	try {
		return decodeURIComponent(value)
	} catch {
		throw badRequest('invalid path encoding')
	}
}

function numeric(value: number | string): number {
	const parsed = typeof value === 'number' ? value : Number(value)
	if (!Number.isSafeInteger(parsed)) throw new Error('invalid stored numeric value')
	return parsed
}

function nullableNumeric(value: number | string | null): number | null {
	return value === null ? null : numeric(value)
}

function now(options: OperationsOperatorOptions): number {
	return (options.now ?? Date.now)()
}

class OperatorRequestError extends Error {
	readonly type: string

	constructor(readonly httpStatus: number, message: string) {
		super(message)
		this.type = httpStatus === 404 ? 'not_found' : httpStatus === 400 ? 'bad_request' : 'request_error'
	}
}

function badRequest(message: string): OperatorRequestError {
	return new OperatorRequestError(400, message)
}

function notFoundError(): never {
	throw new OperatorRequestError(404, 'not found')
}

function notFound(): Response {
	return Response.json({ error: 'not found' }, { status: 404 })
}
