import { buildRouteTree, createMemoryNavigationAdapter, Router } from '@buzola/router'
import { BuzolaProvider } from '@buzola/router/react'
import type { RpcFetch } from '@fabrika/app'
import type { AppDto, AppEnvDto, RunDto } from '@fabrika/control-contract'
import type { ApiKeyDetail, AuditEventDto, GrantDto, PrincipalListItem } from '@fabrika/iam-contract'
import type { OperationsHealthCheckDto, OperationsSourceHealthDto } from '@fabrika/operations-contract/operator-api'
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { z } from 'zod'
import { RecentChanges } from '../components/overview/Activity'
import { Applications } from '../components/overview/Applications'
import type { ConsoleCaller } from '../lib/console-access'
import { healthCheckState, healthLamp, needsMonitoringAttention, runtimeHealth } from '../lib/health'
import { deployHistory, environmentSources, expiringKey, loadOverview, OVERVIEW_ACCESS_REFRESH_MS, OVERVIEW_APP_LIMIT } from '../lib/overview'
import { DEFAULT_ISSUE_FILTERS, ErrorsView } from '../operations/views/Errors'
import auditPage from '../routes/access/audit'
import appPage from '../routes/apps/detail'
import appsPage from '../routes/apps/index'
import errorPage from '../routes/operations/errors/detail'
import errorsPage from '../routes/operations/errors/index'
import healthPage from '../routes/operations/health/index'
import runPage from '../routes/runs/detail'
import runsPage from '../routes/runs/index'

// Read the real paths without depending on codegen having run before the test suite.
const pageRegistry = {
	'access/audit': auditPage.route,
	apps: appsPage.route,
	'apps/detail': appPage.route,
	'operations/errors': errorsPage.route,
	'operations/errors/detail': errorPage.route,
	'operations/health': healthPage.route,
	'runs/detail': runPage.route,
	runs: runsPage.route,
}

const NOW = Date.UTC(2026, 9, 24, 12)
const caller: ConsoleCaller = { access: null, iam: { kind: 'installation' }, administersPeople: false }
const app: AppDto = {
	id: 'crm',
	repoUrl: 'https://example.test/crm',
	defaultBranch: 'main',
	workerDir: null,
	buildCmd: null,
	configPath: null,
	githubInstallationId: null,
	createdAt: 1,
}
const env: AppEnvDto = {
	appId: 'crm',
	env: 'prod',
	domain: 'crm.example.test',
	publicOrigin: null,
	crossOrigins: [],
	triggerRef: null,
	authoring: false,
	protected: true,
	publishedRunId: 'old-publication',
	deviationSubjects: [],
	surface: [],
	namespaceId: null,
	provider: 'test',
	target: { provider: 'test', version: 1, payload: {} },
	artifact: { provider: 'test', version: 1, payload: {} },
	createdAt: 1,
}
const check: OperationsHealthCheckDto = {
	id: 'check',
	sourceId: 'source',
	path: '/healthz',
	enabled: true,
	intervalMs: 30_000,
	timeoutMs: 5_000,
	expectedStatus: 200,
	failureThreshold: 3,
	recoveryThreshold: 2,
	staleAfterMs: 90_000,
	current: { state: 'healthy', observedAt: NOW - 1_000, latencyMs: 2, detailCode: 'http_200', consecutiveFailures: 0, consecutiveSuccesses: 3 },
	history: [],
}
const source: OperationsSourceHealthDto = {
	source: { id: 'source', appId: 'crm', environment: 'prod', serviceKey: 'web', displayName: 'CRM', publicOrigin: null, enabled: true },
	httpChecks: [check],
	telemetryState: 'stale',
}
const run: RunDto = {
	id: 'run',
	appId: 'crm',
	env: 'prod',
	ref: 'main',
	commitSha: 'abc123',
	trigger: 'manual',
	actor: null,
	status: 'succeeded',
	exitCode: 0,
	externalRunId: null,
	logKey: null,
	createdAt: NOW / 1000 - 20 * 86_400,
	startedAt: NOW / 1000 - 60,
	finishedAt: NOW / 1000 - 10,
}
const requestBody = z.object({ method: z.string(), input: z.unknown().optional() })

const GRANT: GrantDto = {
	id: 'grant-1',
	principalId: 'integration',
	roleKey: null,
	permissions: ['report.write'],
	scopeType: null,
	scopeValue: null,
	app: 'crm@prod',
	grantedBy: null,
	expiresAt: null,
	createdAt: 1,
	dangling: false,
}

/** The applications table as a page renders it, `filter` its environment filter's initial value. */
function renderTable(data: Awaited<ReturnType<typeof loadOverview>>, filter: 'all' | 'production' = 'all'): string {
	const router = new Router({
		routes: buildRouteTree([{ path: '/', component: () => null, isIndex: true }]),
		adapter: createMemoryNavigationAdapter(),
		pageRegistry,
	})
	return renderToStaticMarkup(createElement(BuzolaProvider, { router }, createElement(Applications, { data, initialFilter: filter })))
}

function fetchOverview(overrides: Record<string, unknown> = {}, calls: string[] = [], refuse: string[] = []): RpcFetch {
	return async (url, init) => {
		const body = requestBody.parse(JSON.parse(String(init?.body)))
		const key = `${url}:${body.method}`
		calls.push(key)
		if (refuse.includes(body.method)) return Response.json({ error: { type: 'forbidden', message: 'Not authorized' } }, { status: 403 })
		if (key in overrides) return Response.json({ result: overrides[key] })
		switch (body.method) {
			case 'apps.list':
				return Response.json({ result: { items: [app] } })
			case 'apps.environments.list':
				return Response.json({ result: { items: [env] } })
			case 'runs.get':
				return Response.json({ result: { ...run, id: 'old-publication' } })
			case 'health':
				return Response.json({ result: { sources: [source] } })
			case 'issues':
				return Response.json({ result: { items: [], nextCursor: null, summary: { total: 0, open: 0, resolved: 0, ignored: 0 } } })
			default:
				return Response.json({ result: { items: [], nextCursor: null } })
		}
	}
}

describe('overview data boundaries', () => {
	test('an optional-plane outage keeps Delivery and does not become a forbidden or empty response', async () => {
		const base = fetchOverview()
		const data = await loadOverview(caller, async (url, init) => {
			if (String(url).startsWith('/operations/')) throw new Error('offline')
			return base(url, init)
		})
		expect(data.apps.data?.items).toEqual([app])
		expect(data.health).toEqual({ data: null, problem: 'unavailable' })
		expect(data.issues).toEqual({ data: null, problem: 'unavailable' })
	})

	test('known access restrictions avoid optional reads, and a server refusal stays distinct', async () => {
		const calls: string[] = []
		const restricted: ConsoleCaller = {
			access: { principal: null, global: ['app.manage', 'namespace.manage', 'deploy.read'], scopes: [] },
			iam: false,
			administersPeople: false,
		}
		const data = await loadOverview(restricted, fetchOverview({}, calls, ['apps.environments.list']))
		expect(calls.every((call) => call.startsWith('/api/rpc:'))).toBe(true)
		expect(calls).not.toContain('/api/rpc:approvals.list')
		expect(calls).not.toContain('/api/rpc:mail.messages.list')
		expect(data.health.problem).toBe('forbidden')
		expect(data.environments.get('crm')?.problem).toBe('forbidden')
	})

	test('active runs are requested separately with a server-side status filter', async () => {
		const base = fetchOverview()
		const inputs: unknown[] = []
		await loadOverview(caller, async (url, init) => {
			const body = requestBody.parse(JSON.parse(String(init?.body)))
			if (body.method === 'runs.list') inputs.push(body.input)
			return base(url, init)
		})
		expect(inputs).toContainEqual({ statuses: ['pending', 'running'], limit: 200 })
	})

	test('a publication outside the run window remains published and links to its own run', async () => {
		const calls: string[] = []
		const data = await loadOverview(caller, fetchOverview({}, calls))
		const markup = renderToStaticMarkup(createElement(BuzolaProvider, {
			router: new Router({
				routes: buildRouteTree([{ path: '/', component: () => null, isIndex: true }]),
				adapter: createMemoryNavigationAdapter(),
				pageRegistry,
			}),
		}, createElement(Applications, { data })))
		expect(markup).toContain('href="/runs/old-publication"')
		expect(calls).toContain('/api/rpc:runs.get')
		expect(markup).toContain('abc123')
		expect(markup).not.toContain('Not published')
		expect(markup).not.toContain('never')
	})

	test('a source omitted by scoped authorization is unknown, not unmonitored', async () => {
		const data = await loadOverview(caller, fetchOverview())
		data.caller = { ...caller, access: { principal: null, global: [], scopes: [{ type: 'app', value: 'other', actions: ['operations.read'] }] } }
		expect(environmentSources(data, 'crm', 'prod')).toBeNull()
	})

	test('an overview error link opens the same source and all-time window it counted', async () => {
		const data = await loadOverview(caller, fetchOverview())
		data.health = { data: { sources: [{ ...source, telemetryState: 'healthy' }] }, problem: null }
		const router = new Router({
			routes: buildRouteTree([{ path: '/', component: () => null, isIndex: true }]),
			adapter: createMemoryNavigationAdapter(),
			pageRegistry,
		})
		const table = renderToStaticMarkup(createElement(BuzolaProvider, { router }, createElement(Applications, { data })))
		expect(table).toContain('window=all')
		expect(table).toContain('source=source')
		const page = { items: [], nextCursor: null, summary: { total: 0, open: 0, ignored: 0, resolved: 0 } }
		const errors = renderToStaticMarkup(createElement(
			BuzolaProvider,
			{ router },
			createElement(ErrorsView, {
				initialPage: page,
				sources: [source.source],
				initialFilters: { ...DEFAULT_ISSUE_FILTERS, sourceId: 'source', window: 'all' },
				onQuery: async () => page,
			}),
		))
		expect(errors).toContain('source:CRM')
		expect(errors).not.toContain('window:24h')
	})

	test('an environment with several sources shows its error count without a link that would list every error', async () => {
		const data = await loadOverview(caller, fetchOverview())
		const worker = { ...source, source: { ...source.source, id: 'worker', serviceKey: 'worker' }, telemetryState: 'healthy' as const }
		data.health = { data: { sources: [{ ...source, telemetryState: 'healthy' }, worker] }, problem: null }
		data.issues = {
			data: { items: [], nextCursor: null, summary: { total: 0, open: 0, resolved: 0, ignored: 0 } },
			problem: null,
		}
		const table = renderTable(data)
		expect(table).toContain('0 open')
		expect(table).not.toContain('operations/errors')
	})

	test('the table reads the environments of the first applications only, and links to the rest', async () => {
		const apps = Array.from({ length: OVERVIEW_APP_LIMIT + 2 }, (_, index) => ({ ...app, id: `app-${index}` }))
		const calls: string[] = []
		const data = await loadOverview(caller, fetchOverview({ '/api/rpc:apps.list': { items: apps } }, calls))
		expect(calls.filter((call) => call === '/api/rpc:apps.environments.list')).toHaveLength(OVERVIEW_APP_LIMIT)
		const table = renderTable(data)
		expect(table).toContain(`All ${apps.length} applications`)
		expect(table).not.toContain('app-9')
	})

	test('Production leaves out an application with no environment to show', async () => {
		const data = await loadOverview(caller, fetchOverview({ '/api/rpc:apps.environments.list': { items: [] } }))
		expect(renderTable(data)).toContain('No environments configured')
		expect(renderTable(data, 'production')).not.toContain('No environments configured')
	})

	test('a load given the last Access reads keeps them while they are young, and asks IAM again once they are not', async () => {
		const first: string[] = []
		const data = await loadOverview(caller, fetchOverview({}, first))
		expect(first.filter((call) => call.startsWith('/iam/'))).not.toEqual([])

		const timed: string[] = []
		const again = await loadOverview(caller, fetchOverview({}, timed), data.access)
		expect(timed.filter((call) => call.startsWith('/iam/'))).toEqual([])
		expect(timed.filter((call) => call.startsWith('/api/'))).not.toEqual([])
		expect(again.keys).toBe(data.keys)

		const stale: string[] = []
		await loadOverview(caller, fetchOverview({}, stale), { ...data.access, readAt: Date.now() - OVERVIEW_ACCESS_REFRESH_MS })
		expect(stale.filter((call) => call.startsWith('/iam/'))).not.toEqual([])
	})

	test('an audit page of reads, from an IAM older than changesOnly, is marked incomplete', async () => {
		const data = await loadOverview(
			caller,
			fetchOverview({ '/iam/admin/rpc:audit.list': { items: [{ action: 'iam.admin.access' }], nextCursor: 'older' } }),
		)
		expect(data.audit.data).toEqual({ items: [], limited: true })
	})

	test('recent changes resolve audit actors once and open the exact request', async () => {
		const event: AuditEventDto = {
			id: 'event-1',
			requestId: 'request-1',
			principalId: 'user-1',
			principalLabel: 'user-1',
			credentialId: null,
			app: 'iam',
			action: 'iam.principal.disable',
			resourceType: 'principal',
			resourceId: 'subject-1',
			diff: null,
			metadata: null,
			createdAt: NOW / 1000,
		}
		const principal: PrincipalListItem = {
			id: 'user-1',
			type: 'user',
			label: 'Ada',
			email: 'ada@example.test',
			externalId: null,
			status: 'active',
			affiliation: 'internal',
			createdAt: 1,
		}
		const calls: string[] = []
		const data = await loadOverview(
			caller,
			fetchOverview({
				'/iam/admin/rpc:audit.list': { items: [event, { ...event, id: 'event-2', requestId: 'request-2' }], nextCursor: null },
				'/iam/admin/rpc:principals.get': principal,
			}, calls),
		)
		expect(calls.filter((call) => call === '/iam/admin/rpc:principals.get')).toHaveLength(1)
		const markup = renderToStaticMarkup(createElement(BuzolaProvider, {
			router: new Router({
				routes: buildRouteTree([{ path: '/', component: () => null, isIndex: true }]),
				adapter: createMemoryNavigationAdapter(),
				pageRegistry,
			}),
		}, createElement(RecentChanges, { data })))
		expect(markup).toContain('Ada · subject-1')
		expect(markup).not.toContain('user-1')
		expect(markup).toContain('href="/access/audit?requestId=request-1"')
		expect(markup).toContain('href="/access/audit?requestId=request-2"')
	})

	test('a failed actor lookup preserves the audit events and the overview', async () => {
		const event: AuditEventDto = {
			id: 'event-1',
			requestId: 'request-1',
			principalId: 'user-1',
			principalLabel: 'user-1',
			credentialId: null,
			app: 'iam',
			action: 'iam.principal.disable',
			resourceType: 'principal',
			resourceId: 'subject-1',
			diff: null,
			metadata: null,
			createdAt: NOW / 1000,
		}
		const data = await loadOverview(
			caller,
			fetchOverview(
				{
					'/iam/admin/rpc:audit.list': { items: [event], nextCursor: null },
				},
				[],
				['principals.get'],
			),
		)
		expect(data.audit.data?.items).toEqual([event])
		expect(data.auditActors.size).toBe(0)
		expect(data.apps.data?.items).toEqual([app])
	})
})

describe('overview signal semantics', () => {
	test('HTTP health is independent of telemetry and unpublished deploys', () => {
		expect(runtimeHealth([source], NOW)).toMatchObject({ label: 'Healthy', lamp: 'ok' })
		expect(runtimeHealth(null, NOW).label).toBe('Unknown')
		expect(runtimeHealth([], NOW).label).toBe('Not monitored')
		expect(runtimeHealth([{ ...source, httpChecks: [{ ...check, enabled: false }] }], NOW).label).toBe('Not monitored')
		expect(runtimeHealth([source], NOW + 100_000).label).toBe('Unknown')
		expect(runtimeHealth([{ ...source, httpChecks: [{ ...check, current: null }] }], NOW).label).toBe('Unknown')
	})

	test('one failed service wins over a healthy service in the same environment', () => {
		const failed: OperationsSourceHealthDto = {
			...source,
			httpChecks: [{
				...check,
				current: { state: 'failed', observedAt: NOW, latencyMs: null, detailCode: 'http_503', consecutiveFailures: 3, consecutiveSuccesses: 0 },
			}],
		}
		expect(runtimeHealth([source, failed], NOW).label).toBe('Failing')
	})

	test('stale successes stop being green and need attention on every health view', () => {
		const healthy = { ...source, telemetryState: 'healthy' } satisfies OperationsSourceHealthDto
		expect(needsMonitoringAttention(healthy, NOW)).toBe(false)
		const later = NOW + check.staleAfterMs
		expect(healthCheckState(check, later)).toBe('stale')
		expect(healthLamp(healthCheckState(check, later))).toBe('idle')
		expect(runtimeHealth([healthy], later)).toMatchObject({ state: 'stale', lamp: 'idle', monitored: true })
		expect(needsMonitoringAttention(healthy, later)).toBe(true)
	})

	test('disabled sources and checks cannot report availability or monitoring alerts', () => {
		const disabled = { ...source, source: { ...source.source, enabled: false } }
		expect(runtimeHealth([disabled], NOW)).toMatchObject({ state: 'unmonitored', lamp: 'idle', monitored: false })
		expect(needsMonitoringAttention(disabled, NOW)).toBe(false)
		expect(healthCheckState({ ...check, enabled: false }, NOW)).toBe('disabled')
		expect(needsMonitoringAttention({ ...source, telemetryState: 'healthy', httpChecks: [{ ...check, enabled: false }] }, NOW)).toBe(false)
		expect(needsMonitoringAttention({ ...source, telemetryState: 'healthy', httpChecks: [{ ...check, current: null }] }, NOW)).toBe(true)
	})

	test('missing telemetry asks for attention without changing the HTTP result', () => {
		expect(runtimeHealth([source], NOW)).toMatchObject({ state: 'healthy', lamp: 'ok' })
		expect(needsMonitoringAttention(source, NOW)).toBe(true)
	})

	test('credential expiry is read from the key itself even when its grants never expire', () => {
		const now = NOW / 1000
		const key: ApiKeyDetail = { principalId: 'integration', label: 'Export', status: 'active', grants: [], createdAt: 1, credential: null }
		expect(expiringKey({ ...key, credential: { app: null, expiresAt: now + 86_400 } }, now)).toEqual({ kind: 'Key', expiresAt: now + 86_400 })
		expect(expiringKey({ ...key, credential: { app: null, expiresAt: now - 30 * 86_400 } }, now)).toEqual({ kind: 'Key', expiresAt: now - 30 * 86_400 })
		expect(expiringKey(key, now)).toBeNull()
	})

	test('a grant that lapsed this week is reported as expired, and one that lapsed earlier is history', () => {
		const now = NOW / 1000
		const grant = (expiresAt: number | null) => ({ ...GRANT, expiresAt })
		const key = (expiresAt: number | null): ApiKeyDetail => ({
			principalId: 'integration',
			label: 'Export',
			status: 'active',
			grants: [grant(expiresAt)],
			createdAt: 1,
			credential: { app: null, expiresAt: null },
		})
		expect(expiringKey(key(now - 86_400), now)).toEqual({ kind: 'Key permission', expiresAt: now - 86_400 })
		expect(expiringKey(key(now + 86_400), now)).toEqual({ kind: 'Key permission', expiresAt: now + 86_400 })
		expect(expiringKey(key(now - 8 * 86_400), now)).toBeNull()
		expect(expiringKey(key(null), now)).toBeNull()
	})

	test('deploy charts use completion dates and disclose a truncated creation-ordered window', () => {
		const chart = deployHistory({ items: [run], nextCursor: 'older' }, NOW)
		expect(chart.days.reduce((sum, day) => sum + day.ok, 0)).toBe(1)
		// A sample reaching three weeks before the window holds every run that finished in it, more runs or not.
		expect(deployHistory({ items: [{ ...run, createdAt: NOW / 1000 - 35 * 86_400 }], nextCursor: 'older' }, NOW).limited).toBe(false)
		// One whose oldest run is from inside the window may miss older runs that finished in it.
		expect(deployHistory({ items: [{ ...run, createdAt: NOW / 1000 - 3 * 86_400 }], nextCursor: 'older' }, NOW).limited).toBe(true)
		expect(chart.days.length).toBe(14)
		expect(
			deployHistory({ items: [{ ...run, status: 'running', finishedAt: null }], nextCursor: null }, NOW).days.every((day) =>
				day.ok === 0 && day.failed === 0
			),
		).toBe(true)
	})
})
