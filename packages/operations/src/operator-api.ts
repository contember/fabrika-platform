import type { AuthContext, ListPrincipalsFailure, PrincipalList } from '@fabrika/auth'
import type { IssueMutation, IssueStatus } from '@fabrika/operations-contract/operator'
import type {
	OperationsAlertKind,
	OperationsAlertSettingsResponseDto,
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
	OperationsSourceHealthDto,
	OperationsSourceListResponseDto,
	OperationsSourceSummaryDto,
} from '@fabrika/operations-contract/operator-api'
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

export async function handleOperationsOperatorRequest(request: Request, options: OperationsOperatorOptions): Promise<Response> {
	try {
		const url = new URL(request.url)
		if (!url.pathname.startsWith('/api/')) return notFound()

		if (url.pathname === '/api/sources' && request.method === 'GET') return await listSources(options)
		if (url.pathname === '/api/issues' && request.method === 'GET') return await listIssues(url, options)
		if (url.pathname === '/api/issues/bulk' && request.method === 'PUT') return await bulkIssueStatus(request, options)
		if (url.pathname === '/api/releases' && request.method === 'GET') return await listReleases(url, options)
		if (url.pathname === '/api/health' && request.method === 'GET') return await healthOverview(options)

		const latestEvent = ISSUE_LATEST_EVENT.exec(url.pathname)
		if (latestEvent && request.method === 'GET') return await issueLatestEvent(decode(latestEvent[1]), options)
		const issue = ISSUE_DETAIL.exec(url.pathname)
		if (issue && request.method === 'GET') return await issueDetail(decode(issue[1]), options)
		if (issue && request.method === 'PUT') return await mutateIssue(request, decode(issue[1]), options)

		const assignees = SOURCE_ASSIGNEES.exec(url.pathname)
		if (assignees && request.method === 'GET') return await listAssignees(request, decode(assignees[1]), options)
		const health = SOURCE_HEALTH.exec(url.pathname)
		if (health && request.method === 'GET') return await sourceHealth(decode(health[1]), options)
		const healthChecks = SOURCE_HEALTH_CHECKS.exec(url.pathname)
		if (healthChecks && request.method === 'POST') return await createHealthCheck(request, decode(healthChecks[1]), options)
		const healthCheck = SOURCE_HEALTH_CHECK.exec(url.pathname)
		if (healthCheck && request.method === 'PUT') {
			return await updateHealthCheck(request, decode(healthCheck[1]), decode(healthCheck[2]), options)
		}
		if (healthCheck && request.method === 'DELETE') {
			return await deleteHealthCheck(decode(healthCheck[1]), decode(healthCheck[2]), options)
		}

		const alerts = SOURCE_ALERTS.exec(url.pathname)
		if (alerts && request.method === 'GET') return await alertSettings(decode(alerts[1]), options)
		const spike = SOURCE_ALERT_SPIKE.exec(url.pathname)
		if (spike && request.method === 'PUT') return await updateSpikeAlert(request, decode(spike[1]), options)
		const rule = SOURCE_ALERT_RULE.exec(url.pathname)
		if (rule && request.method === 'PUT') return await updateAlertRule(request, decode(rule[1]), decode(rule[2]), options)
		const channels = SOURCE_ALERT_CHANNELS.exec(url.pathname)
		if (channels && request.method === 'POST') return await createAlertChannel(request, decode(channels[1]), options)
		const channel = SOURCE_ALERT_CHANNEL.exec(url.pathname)
		if (channel && request.method === 'PUT') {
			return await updateAlertChannel(request, decode(channel[1]), decode(channel[2]), options)
		}
		if (channel && request.method === 'DELETE') {
			return await deleteAlertChannel(decode(channel[1]), decode(channel[2]), options)
		}

		const source = SOURCE_DETAIL.exec(url.pathname)
		if (source && request.method === 'GET') return await sourceDetail(decode(source[1]), options)
		const release = RELEASE_DETAIL.exec(url.pathname)
		if (release && request.method === 'GET') return await releaseDetail(decode(release[1]), options)
		return notFound()
	} catch (error) {
		if (error instanceof OperatorRequestError) return Response.json({ error: error.message }, { status: error.status })
		if (error instanceof RangeError) return Response.json({ error: error.message }, { status: 400 })
		console.error('operations operator request failed')
		return Response.json({ error: 'internal error' }, { status: 500 })
	}
}

async function listSources(options: OperationsOperatorOptions): Promise<Response> {
	const sources = await authorizedSources(options, 'operations.read')
	const body: OperationsSourceListResponseDto = { items: sources.map(sourceDto) }
	return Response.json(body)
}

async function sourceDetail(sourceId: string, options: OperationsOperatorOptions): Promise<Response> {
	const source = await visibleSource(sourceId, 'operations.read', options)
	return Response.json({ source: sourceDto(source) })
}

async function listIssues(url: URL, options: OperationsOperatorOptions): Promise<Response> {
	let sources = await authorizedSources(options, 'operations.read')
	const requestedSource = url.searchParams.get('sourceId')
	if (requestedSource !== null) sources = sources.filter((source) => source.id === requestedSource)
	const status = optionalIssueStatus(url.searchParams.get('status'))
	const query = url.searchParams.get('query')?.trim()
	const offset = cursor(url.searchParams.get('cursor'))
	const limit = boundedLimit(url.searchParams.get('limit'))
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
	const body: OperationsIssueListResponseDto = {
		items: rows.map(issueSummary),
		nextCursor: rows.length === limit ? String(offset + rows.length) : null,
		summary,
	}
	return Response.json(body)
}

async function issueDetail(issueId: string, options: OperationsOperatorOptions): Promise<Response> {
	const issue = await visibleIssue(issueId, 'operations.read', options)
	const body: OperationsIssueDetailResponseDto = { issue: await completeIssue(issue, options) }
	return Response.json(body)
}

async function issueLatestEvent(issueId: string, options: OperationsOperatorOptions): Promise<Response> {
	const issue = await visibleIssue(issueId, 'operations.read', options)
	const occurrence = await options.repositories.operator.latestOccurrence(issue.source_id, issue.fingerprint)
	if (occurrence === null) return notFound()
	const object = await options.payloads.get(occurrence.blob_key)
	if (object === null) return notFound()
	const detail = await parseEventDetail(await object.text(), {
		get: (key) => options.payloads.get(key),
		getSourceMap: async (releaseName, logicalPath) => {
			const key = await options.repositories.artifacts.sourceMapKey(releaseName, logicalPath)
			return key === null ? null : options.payloads.get(key)
		},
	})
	const body: OperationsEventDetailResponseDto = {
		occurrenceId: occurrence.id,
		receivedAt: numeric(occurrence.received_at),
		detail,
	}
	return Response.json(body)
}

async function mutateIssue(request: Request, issueId: string, options: OperationsOperatorOptions): Promise<Response> {
	const issue = await visibleIssue(issueId, 'operations.triage', options)
	const mutation = await internalMutation(request, issue, options)
	const principal = options.auth.principal
	const updated = await options.repositories.issues.mutate({
		sourceId: issue.source_id,
		fingerprint: issue.fingerprint,
		mutation,
		actorId: principal?.id ?? null,
		actorLabel: principal?.label ?? null,
	})
	if (updated === null) return notFound()
	await auditIssueMutation(options.auth, issueId, mutation)
	const identified = await options.repositories.operator.getIssueById(issueId)
	if (identified === null) return notFound()
	const body: OperationsIssueDetailResponseDto = { issue: await completeIssue(identified, options) }
	return Response.json(body)
}

async function bulkIssueStatus(request: Request, options: OperationsOperatorOptions): Promise<Response> {
	const body = await jsonObject(request)
	const rawIds = stringArray(body['issueIds'])
	if (rawIds.length === 0 || rawIds.length > 100) throw badRequest('issueIds must contain between 1 and 100 ids')
	const ids = [...new Set(rawIds)]
	if (ids.length !== rawIds.length) throw badRequest('issueIds must not contain duplicates')
	const status = issueStatus(body['status'])
	const issues = await options.repositories.operator.getIssuesByIds(ids)
	if (issues.length !== ids.length) return notFound()
	for (const issue of issues) {
		if (!canAccessOperationsSource(options.auth, 'operations.triage', sourceAccess(issue))) return notFound()
	}
	const principal = options.auth.principal
	const updated = await options.repositories.operator.bulkStatus({
		issues,
		status,
		actorId: principal?.id ?? null,
		actorLabel: principal?.label ?? null,
	})
	await Promise.all(ids.map((id) => auditIssueMutation(options.auth, id, { kind: 'status', status })))
	const bodyOut: OperationsBulkIssueStatusResponseDto = { items: updated.map(issueSummary) }
	return Response.json(bodyOut)
}

async function listAssignees(request: Request, sourceId: string, options: OperationsOperatorOptions): Promise<Response> {
	await visibleSource(sourceId, 'operations.triage', options)
	const result = await options.principals.listPrincipals(request)
	if (!result.ok) throw new OperatorRequestError(result.status, result.reason)
	return Response.json({
		items: result.principals
			.filter((principal) => principal.type === 'user' && !principal.disabled)
			.map((principal) => ({ id: principal.id, label: principal.label })),
	})
}

async function listReleases(url: URL, options: OperationsOperatorOptions): Promise<Response> {
	let sources = await authorizedSources(options, 'operations.read')
	const requestedSource = url.searchParams.get('sourceId')
	if (requestedSource !== null) sources = sources.filter((source) => source.id === requestedSource)
	const offset = cursor(url.searchParams.get('cursor'))
	const limit = boundedLimit(url.searchParams.get('limit'))
	const rows = await options.repositories.operator.listReleases({ sourceIds: sources.map((source) => source.id), offset, limit })
	const body: OperationsReleaseListResponseDto = {
		items: rows.map(releaseSummary),
		nextCursor: rows.length === limit ? String(offset + rows.length) : null,
	}
	return Response.json(body)
}

async function releaseDetail(releaseId: string, options: OperationsOperatorOptions): Promise<Response> {
	const release = await options.repositories.operator.getReleaseById(releaseId)
	if (release === null || !canAccessOperationsSource(options.auth, 'operations.read', sourceAccess(release))) return notFound()
	const issues = await options.repositories.operator.listReleaseIssues(release)
	const body: OperationsReleaseDetailResponseDto = {
		release: releaseSummary(release),
		issues: issues.map(issueSummary),
	}
	return Response.json(body)
}

async function healthOverview(options: OperationsOperatorOptions): Promise<Response> {
	const sources = await authorizedSources(options, 'operations.read')
	const body: OperationsHealthResponseDto = {
		sources: await Promise.all(sources.map((source) => healthForSource(source, options))),
	}
	return Response.json(body)
}

async function sourceHealth(sourceId: string, options: OperationsOperatorOptions): Promise<Response> {
	const source = await visibleSource(sourceId, 'operations.read', options)
	return Response.json(await healthForSource(source, options))
}

async function createHealthCheck(request: Request, sourceId: string, options: OperationsOperatorOptions): Promise<Response> {
	await visibleSource(sourceId, 'operations.manage', options)
	const input = await healthCheckInput(request)
	const checkId = uuidv7(now(options))
	await options.health.upsertCheck({ id: checkId, sourceId, ...input })
	await options.auth.audit({ action: 'operations.health_check.create', resourceType: 'operations_health_check', resourceId: checkId })
	return Response.json({ id: checkId }, { status: 201 })
}

async function updateHealthCheck(request: Request, sourceId: string, checkId: string, options: OperationsOperatorOptions): Promise<Response> {
	await visibleSource(sourceId, 'operations.manage', options)
	const existing = await options.health.getCheck(checkId)
	if (existing === null || existing.source_id !== sourceId) return notFound()
	const input = await healthCheckInput(request)
	await options.health.upsertCheck({ id: checkId, sourceId, ...input })
	await options.auth.audit({ action: 'operations.health_check.update', resourceType: 'operations_health_check', resourceId: checkId })
	return Response.json({ id: checkId })
}

async function deleteHealthCheck(sourceId: string, checkId: string, options: OperationsOperatorOptions): Promise<Response> {
	await visibleSource(sourceId, 'operations.manage', options)
	const existing = await options.health.getCheck(checkId)
	if (existing === null || existing.source_id !== sourceId) return notFound()
	if (!await options.health.deleteCheck(sourceId, checkId)) return notFound()
	await options.auth.audit({ action: 'operations.health_check.delete', resourceType: 'operations_health_check', resourceId: checkId })
	return new Response(null, { status: 204 })
}

async function alertSettings(sourceId: string, options: OperationsOperatorOptions): Promise<Response> {
	await visibleSource(sourceId, 'operations.manage', options)
	const [config, rules, channels] = await Promise.all([
		options.repositories.alerts.getConfig(sourceId),
		options.repositories.alerts.listRules(sourceId),
		options.repositories.alerts.listChannels(sourceId),
	])
	const body: OperationsAlertSettingsResponseDto = {
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
	return Response.json(body)
}

async function updateSpikeAlert(request: Request, sourceId: string, options: OperationsOperatorOptions): Promise<Response> {
	await visibleSource(sourceId, 'operations.manage', options)
	const body = await jsonObject(request)
	const threshold = positiveInteger(body['threshold'], 'threshold')
	const enabled = boolean(body['enabled'], 'enabled')
	await options.repositories.alerts.setConfig(sourceId, { threshold, enabled })
	await options.auth.audit({ action: 'operations.alert.spike', resourceType: 'operations_source', resourceId: sourceId })
	return Response.json({ threshold, enabled })
}

async function updateAlertRule(request: Request, sourceId: string, rawKind: string, options: OperationsOperatorOptions): Promise<Response> {
	await visibleSource(sourceId, 'operations.manage', options)
	const kind = alertKind(rawKind)
	if (kind === null) return notFound()
	const body = await jsonObject(request)
	const enabled = boolean(body['enabled'], 'enabled')
	await options.repositories.alerts.setRule(sourceId, kind, enabled)
	await options.auth.audit({ action: 'operations.alert.rule', resourceType: 'operations_source', resourceId: sourceId })
	return Response.json({ kind, enabled })
}

async function createAlertChannel(request: Request, sourceId: string, options: OperationsOperatorOptions): Promise<Response> {
	await visibleSource(sourceId, 'operations.manage', options)
	const input = await channelInput(request, true)
	if (input.target === undefined) throw badRequest('target is required')
	const id = uuidv7(now(options))
	await options.repositories.alerts.upsertChannel({ id, sourceId, ...input, target: input.target })
	await options.auth.audit({ action: 'operations.alert_channel.create', resourceType: 'operations_alert_channel', resourceId: id })
	return Response.json({ id }, { status: 201 })
}

async function updateAlertChannel(
	request: Request,
	sourceId: string,
	channelId: string,
	options: OperationsOperatorOptions,
): Promise<Response> {
	await visibleSource(sourceId, 'operations.manage', options)
	const existing = (await options.repositories.alerts.listChannels(sourceId)).find((channel) => channel.id === channelId)
	if (existing === undefined) return notFound()
	const input = await channelInput(request, false)
	await options.repositories.alerts.upsertChannel({
		id: channelId,
		sourceId,
		scope: input.scope,
		type: input.type,
		target: input.target ?? existing.target,
		enabled: input.enabled,
	})
	await options.auth.audit({ action: 'operations.alert_channel.update', resourceType: 'operations_alert_channel', resourceId: channelId })
	return Response.json({ id: channelId })
}

async function deleteAlertChannel(sourceId: string, channelId: string, options: OperationsOperatorOptions): Promise<Response> {
	await visibleSource(sourceId, 'operations.manage', options)
	if (!await options.repositories.alerts.deleteChannel(sourceId, channelId)) return notFound()
	await options.auth.audit({ action: 'operations.alert_channel.delete', resourceType: 'operations_alert_channel', resourceId: channelId })
	return new Response(null, { status: 204 })
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
	issue: IdentifiedOperatorIssueRow,
	options: OperationsOperatorOptions,
): Promise<IssueMutation> {
	const mutation = issueMutation(await jsonObject(request))
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

async function channelInput(request: Request, requireTarget: boolean): Promise<OperationsNotificationChannelRequestDto> {
	const body = await jsonObject(request)
	const scope = alertKind(string(body['scope'], 'scope'))
	if (scope === null) throw badRequest('invalid alert scope')
	if (body['type'] !== 'webhook') throw badRequest('type must be webhook')
	const target = body['target']
	if (requireTarget && typeof target !== 'string') throw badRequest('target is required')
	if (target !== undefined && typeof target !== 'string') throw badRequest('target must be a string')
	if (typeof target === 'string') validateWebhookTarget(target)
	return {
		scope,
		type: 'webhook',
		...(typeof target === 'string' ? { target } : {}),
		enabled: boolean(body['enabled'], 'enabled'),
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

function validateWebhookTarget(target: string): void {
	let url: URL
	try {
		url = new URL(target)
	} catch {
		throw badRequest('target must be an absolute HTTP URL')
	}
	if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '') {
		throw badRequest('target must be an HTTP URL without embedded credentials')
	}
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
	constructor(readonly status: number, message: string) {
		super(message)
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
