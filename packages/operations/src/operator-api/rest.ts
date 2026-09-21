import type { IssueStatus } from '@fabrika/operations-contract/operator'
import type { OperationsAlertKind, OperationsHealthCheckUpsertRequestDto } from '@fabrika/operations-contract/operator-api'
import type { OperationsIssueQuery, OperationsReleaseQuery } from '@fabrika/operations-contract/rpc'
import {
	alertKind,
	alertRuleInput,
	bulkIssueStatusInput as parseBulkIssueStatus,
	channelInput,
	healthCheckInput as healthCheckInputFromObject,
	issueMutation,
	issueStatus,
	OperatorPayloadError,
	spikeAlertInput,
} from '../operator-input.js'
import type { OperationsOperatorOptions } from './context.js'
import { badRequest, notFoundError, OperatorRequestError } from './errors.js'
import { boundedLimit, offsetCursor } from './pagination.js'
import { OperationsOperatorUseCases } from './use-cases.js'
import { isRecord } from './values.js'

const ISSUE_DETAIL = /^\/api\/issues\/([^/]+)$/
const ISSUE_LATEST_EVENT = /^\/api\/issues\/([^/]+)\/events\/latest$/
const ISSUE_EVENT = /^\/api\/issues\/([^/]+)\/events\/([^/]+)$/
const ISSUE_OCCURRENCES = /^\/api\/issues\/([^/]+)\/occurrences$/
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
		const event = ISSUE_EVENT.exec(url.pathname)
		if (event && request.method === 'GET') return Response.json(await useCases.event(decode(event[1]), decode(event[2])))
		const occurrences = ISSUE_OCCURRENCES.exec(url.pathname)
		if (occurrences && request.method === 'GET') {
			return Response.json(
				await useCases.issueOccurrences(
					decode(occurrences[1]),
					url.searchParams.get('cursor') ?? undefined,
					boundedLimit(url.searchParams.get('limit')),
				),
			)
		}
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
					async () => channelInput(await jsonObject(request), true, 'rest'),
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
					async () => channelInput(await jsonObject(request), false, 'rest'),
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
		if (error instanceof OperatorPayloadError) return Response.json({ error: error.message }, { status: 400 })
		if (error instanceof RangeError) return Response.json({ error: error.message }, { status: 400 })
		console.error('operations operator request failed')
		return Response.json({ error: 'internal error' }, { status: 500 })
	}
}

async function healthCheckInput(request: Request): Promise<OperationsHealthCheckUpsertRequestDto> {
	const body = await jsonObject(request)
	return healthCheckInputFromObject(body)
}

async function bulkIssueStatusInput(request: Request): Promise<{ issueIds: string[]; status: IssueStatus }> {
	const body = await jsonObject(request)
	return parseBulkIssueStatus(body)
}

function issueQuery(url: URL): OperationsIssueQuery {
	const sourceId = url.searchParams.get('sourceId')
	const status = optionalIssueStatus(url.searchParams.get('status'))
	const level = optionalIssueLevel(url.searchParams.get('level'))
	const window = optionalIssueWindow(url.searchParams.get('window'))
	const query = url.searchParams.get('query')
	const assignee = optionalIssueAssignee(url.searchParams.get('assignee'))
	const sort = optionalIssueSort(url.searchParams.get('sort'))
	const cursorValue = url.searchParams.get('cursor')
	const limitValue = url.searchParams.get('limit')
	return {
		...(sourceId === null ? {} : { sourceId }),
		...(status === undefined ? {} : { status }),
		...(level === undefined ? {} : { level }),
		...(window === undefined ? {} : { window }),
		...(query === null ? {} : { query }),
		...(assignee === undefined ? {} : { assignee }),
		...(sort === undefined ? {} : { sort }),
		...(cursorValue === null || cursorValue === '' ? {} : { cursor: cursorValue }),
		...(limitValue === null || limitValue === '' ? {} : { limit: boundedLimit(limitValue) }),
	}
}

function releaseQuery(url: URL): OperationsReleaseQuery {
	const sourceId = url.searchParams.get('sourceId')
	const cursorValue = url.searchParams.get('cursor')
	const limitValue = url.searchParams.get('limit')
	return {
		...(sourceId === null ? {} : { sourceId }),
		...(cursorValue === null || cursorValue === '' ? {} : { cursor: String(offsetCursor(cursorValue)) }),
		...(limitValue === null || limitValue === '' ? {} : { limit: boundedLimit(limitValue) }),
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

function optionalIssueStatus(value: string | null): IssueStatus | undefined {
	return value === null || value === '' ? undefined : issueStatus(value)
}

function optionalIssueLevel(value: string | null): OperationsIssueQuery['level'] {
	if (value === null || value === '') return undefined
	if (value === 'fatal' || value === 'error' || value === 'warning' || value === 'info') return value
	throw badRequest('invalid issue level')
}

function optionalIssueWindow(value: string | null): OperationsIssueQuery['window'] {
	if (value === null || value === '') return undefined
	if (value === 'all' || value === '24h' || value === '7d' || value === '30d') return value
	throw badRequest('invalid issue window')
}

function optionalIssueAssignee(value: string | null): OperationsIssueQuery['assignee'] {
	if (value === null || value === '') return undefined
	if (value === 'all' || value === 'me' || value === 'none') return value
	throw badRequest('invalid issue assignee')
}

function optionalIssueSort(value: string | null): OperationsIssueQuery['sort'] {
	if (value === null || value === '') return undefined
	if (value === 'recent' || value === 'new' || value === 'frequency') return value
	throw badRequest('invalid issue sort')
}

function requiredAlertKind(value: string): OperationsAlertKind {
	const kind = alertKind(value)
	if (kind === null) return notFoundError()
	return kind
}

function decode(value: string | undefined): string {
	if (value === undefined) throw badRequest('invalid path')
	try {
		return decodeURIComponent(value)
	} catch {
		throw badRequest('invalid path encoding')
	}
}

function notFound(): Response {
	return Response.json({ error: 'not found' }, { status: 404 })
}
