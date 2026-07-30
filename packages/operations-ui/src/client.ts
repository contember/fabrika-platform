import type {
	OperationsAlertKind,
	OperationsAlertRuleRequestDto,
	OperationsAlertSettingsResponseDto,
	OperationsAssigneeListResponseDto,
	OperationsBulkIssueStatusRequestDto,
	OperationsBulkIssueStatusResponseDto,
	OperationsEventDetailResponseDto,
	OperationsHealthCheckUpsertRequestDto,
	OperationsHealthResponseDto,
	OperationsIssueDetailResponseDto,
	OperationsIssueListResponseDto,
	OperationsIssueMutationRequestDto,
	OperationsNotificationChannelRequestDto,
	OperationsReleaseDetailResponseDto,
	OperationsReleaseListResponseDto,
	OperationsSourceDetailResponseDto,
	OperationsSourceHealthDto,
	OperationsSourceListResponseDto,
	OperationsSpikeAlertRequestDto,
} from '@fabrika/operations-contract/operator-api'

export class OperationsApiError extends Error {
	readonly status: number
	readonly loginUrl?: string

	constructor(status: number, message: string, loginUrl?: string) {
		super(message)
		this.name = 'OperationsApiError'
		this.status = status
		if (loginUrl !== undefined) this.loginUrl = loginUrl
	}
}

const BASE = '/operations/api'
const LOGIN_BOUNCE_KEY = 'fabrika.operations.auth.login-bounce'
const LOGIN_BOUNCE_WINDOW_MS = 10_000

export function operationsApiUrl(path: string): string {
	if (!path.startsWith('/') || path.startsWith('//')) {
		throw new Error('Operations API paths must be same-origin absolute paths')
	}
	return `${BASE}${path}`
}

function redirectToLogin(loginUrl: string): boolean {
	if (typeof window === 'undefined' || typeof sessionStorage === 'undefined') return false
	const now = Date.now()
	const last = Number(sessionStorage.getItem(LOGIN_BOUNCE_KEY) ?? '0')
	if (Number.isFinite(last) && now - last < LOGIN_BOUNCE_WINDOW_MS) return false
	sessionStorage.setItem(LOGIN_BOUNCE_KEY, String(now))
	const target = new URL(loginUrl)
	target.searchParams.set('redirect', window.location.href)
	window.location.assign(target.toString())
	return true
}

async function readError(response: Response): Promise<OperationsApiError> {
	let message = `Request failed (${response.status})`
	let loginUrl: string | undefined
	try {
		const contentType = response.headers.get('content-type') ?? ''
		if (contentType.includes('application/json')) {
			const body: unknown = await response.json()
			if (body !== null && typeof body === 'object' && 'message' in body && typeof body.message === 'string') {
				message = body.message
			} else if (body !== null && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
				message = body.error
			}
			if (body !== null && typeof body === 'object' && 'loginUrl' in body && typeof body.loginUrl === 'string') {
				loginUrl = body.loginUrl
			}
		} else {
			const text = await response.text()
			if (text.trim().length > 0 && text.length < 500) message = text
		}
	} catch {
		// Keep the status-based message when an error body is unreadable.
	}
	return new OperationsApiError(response.status, message, loginUrl)
}

export interface OperationsIssueQuery {
	sourceId?: string
	status?: 'open' | 'resolved' | 'ignored'
	query?: string
	cursor?: string
	limit?: number
}

export interface OperationsReleaseQuery {
	sourceId?: string
	cursor?: string
	limit?: number
}

export interface OperationsClient {
	request<T>(method: string, path: string, body?: unknown): Promise<T>
	sources(): Promise<OperationsSourceListResponseDto>
	source(sourceId: string): Promise<OperationsSourceDetailResponseDto>
	issues(query?: OperationsIssueQuery): Promise<OperationsIssueListResponseDto>
	issue(issueId: string): Promise<OperationsIssueDetailResponseDto>
	latestEvent(issueId: string): Promise<OperationsEventDetailResponseDto>
	mutateIssue(issueId: string, mutation: OperationsIssueMutationRequestDto): Promise<OperationsIssueDetailResponseDto>
	bulkIssueStatus(input: OperationsBulkIssueStatusRequestDto): Promise<OperationsBulkIssueStatusResponseDto>
	assignees(sourceId: string): Promise<OperationsAssigneeListResponseDto>
	releases(query?: OperationsReleaseQuery): Promise<OperationsReleaseListResponseDto>
	release(releaseId: string): Promise<OperationsReleaseDetailResponseDto>
	health(): Promise<OperationsHealthResponseDto>
	sourceHealth(sourceId: string): Promise<OperationsSourceHealthDto>
	createHealthCheck(sourceId: string, input: OperationsHealthCheckUpsertRequestDto): Promise<{ id: string }>
	updateHealthCheck(sourceId: string, checkId: string, input: OperationsHealthCheckUpsertRequestDto): Promise<{ id: string }>
	deleteHealthCheck(sourceId: string, checkId: string): Promise<null>
	alerts(sourceId: string): Promise<OperationsAlertSettingsResponseDto>
	updateSpikeAlert(sourceId: string, input: OperationsSpikeAlertRequestDto): Promise<unknown>
	updateAlertRule(sourceId: string, kind: OperationsAlertKind, input: OperationsAlertRuleRequestDto): Promise<unknown>
	createAlertChannel(sourceId: string, input: OperationsNotificationChannelRequestDto): Promise<{ id: string }>
	updateAlertChannel(sourceId: string, channelId: string, input: OperationsNotificationChannelRequestDto): Promise<{ id: string }>
	deleteAlertChannel(sourceId: string, channelId: string): Promise<null>
}

export type OperationsFetch = (input: string, init: RequestInit) => Promise<Response>

function resourcePath(kind: string, id: string): string {
	return `/${kind}/${encodeURIComponent(id)}`
}

function queryPath(path: string, query: Record<string, string | number | undefined>): string {
	const search = new URLSearchParams()
	for (const [key, value] of Object.entries(query)) {
		if (value !== undefined && value !== '') search.set(key, String(value))
	}
	const suffix = search.toString()
	return suffix === '' ? path : `${path}?${suffix}`
}

export function createOperationsClient(fetcher: OperationsFetch = (input, init) => fetch(input, init)): OperationsClient {
	async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const headers: Record<string, string> = { accept: 'application/json' }
		if (body !== undefined) headers['content-type'] = 'application/json'

		let response: Response
		try {
			response = await fetcher(operationsApiUrl(path), {
				method,
				headers,
				credentials: 'include',
				redirect: 'manual',
				body: body === undefined ? undefined : JSON.stringify(body),
			})
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : 'Network request failed'
			throw new OperationsApiError(0, message)
		}

		if (!response.ok) {
			const error = await readError(response)
			if (response.status === 401 && error.loginUrl !== undefined && redirectToLogin(error.loginUrl)) {
				return await new Promise<never>(() => {})
			}
			throw error
		}
		if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(LOGIN_BOUNCE_KEY)
		const text = await response.text()
		return JSON.parse(text.trim() === '' ? 'null' : text)
	}

	return {
		request,
		sources: () => request('GET', '/sources'),
		source: (sourceId) => request('GET', resourcePath('sources', sourceId)),
		issues: (query = {}) =>
			request(
				'GET',
				queryPath('/issues', {
					sourceId: query.sourceId,
					status: query.status,
					query: query.query,
					cursor: query.cursor,
					limit: query.limit,
				}),
			),
		issue: (issueId) => request('GET', resourcePath('issues', issueId)),
		latestEvent: (issueId) => request('GET', `${resourcePath('issues', issueId)}/events/latest`),
		mutateIssue: (issueId, mutation) => request('PUT', resourcePath('issues', issueId), mutation),
		bulkIssueStatus: (input) => request('PUT', '/issues/bulk', input),
		assignees: (sourceId) => request('GET', `${resourcePath('sources', sourceId)}/assignees`),
		releases: (query = {}) =>
			request(
				'GET',
				queryPath('/releases', {
					sourceId: query.sourceId,
					cursor: query.cursor,
					limit: query.limit,
				}),
			),
		release: (releaseId) => request('GET', resourcePath('releases', releaseId)),
		health: () => request('GET', '/health'),
		sourceHealth: (sourceId) => request('GET', `${resourcePath('sources', sourceId)}/health`),
		createHealthCheck: (sourceId, input) => request('POST', `${resourcePath('sources', sourceId)}/health-checks`, input),
		updateHealthCheck: (sourceId, checkId, input) =>
			request('PUT', `${resourcePath('sources', sourceId)}/health-checks/${encodeURIComponent(checkId)}`, input),
		deleteHealthCheck: (sourceId, checkId) => request('DELETE', `${resourcePath('sources', sourceId)}/health-checks/${encodeURIComponent(checkId)}`),
		alerts: (sourceId) => request('GET', `${resourcePath('sources', sourceId)}/alerts`),
		updateSpikeAlert: (sourceId, input) => request('PUT', `${resourcePath('sources', sourceId)}/alerts/spike`, input),
		updateAlertRule: (sourceId, kind, input) => request('PUT', `${resourcePath('sources', sourceId)}/alerts/rules/${encodeURIComponent(kind)}`, input),
		createAlertChannel: (sourceId, input) => request('POST', `${resourcePath('sources', sourceId)}/alerts/channels`, input),
		updateAlertChannel: (sourceId, channelId, input) =>
			request('PUT', `${resourcePath('sources', sourceId)}/alerts/channels/${encodeURIComponent(channelId)}`, input),
		deleteAlertChannel: (sourceId, channelId) =>
			request('DELETE', `${resourcePath('sources', sourceId)}/alerts/channels/${encodeURIComponent(channelId)}`),
	}
}

export const operationsClient = createOperationsClient()
