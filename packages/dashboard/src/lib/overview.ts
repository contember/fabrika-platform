import { createRpcClient, RpcError, type RpcFetch } from '@fabrika/app'
import { CONTROL_ACTIONS, type ControlRpcContract, type RunDto } from '@fabrika/control-contract'
import type { IamAdminRpcContract } from '@fabrika/iam-contract'
import { OPERATIONS_ACTIONS } from '@fabrika/operations-contract/access'
import type { OperationsSourceHealthDto } from '@fabrika/operations-contract/operator-api'
import type { OperationsRpcContract } from '@fabrika/operations-contract/rpc'
import type { Lamp } from '../components/Status'
import { type ConsoleCaller, holdsGlobally, mayDo, mayOpen } from './console-access'
import { recentAuditChangePage } from './iam'

export type OverviewRead<T> = { data: T; problem: null } | { data: null; problem: 'unavailable' | 'forbidden' }

/** Independent planes may refuse or fail without taking the whole overview down or looking empty. */
export async function overviewRead<T>(allowed: boolean, read: () => Promise<T>): Promise<OverviewRead<T>> {
	if (!allowed) return { data: null, problem: 'forbidden' }
	try {
		return { data: await read(), problem: null }
	} catch (cause) {
		return { data: null, problem: cause instanceof RpcError && cause.httpStatus === 403 ? 'forbidden' : 'unavailable' }
	}
}

export const OVERVIEW_RUN_LIMIT = 200
const KEY_LIMIT = 25

export async function loadOverview(caller: ConsoleCaller, fetcher: RpcFetch = fetch) {
	const control = createRpcClient<ControlRpcContract>({ baseUrl: '/api/rpc', fetch: fetcher, bounceOnAuth: false })
	const operations = createRpcClient<OperationsRpcContract>({ baseUrl: '/operations/api/rpc', fetch: fetcher, bounceOnAuth: false })
	const iam = createRpcClient<IamAdminRpcContract>({ baseUrl: '/iam/admin/rpc', fetch: fetcher, bounceOnAuth: false })
	const readsOperations = mayOpen(caller, 'operations')
	const readsAccess = mayOpen(caller, 'access')
	const readsMail = caller.access === null || holdsGlobally(caller.access, CONTROL_ACTIONS.MAIL_READ)
	const appsPromise = overviewRead(mayOpen(caller, 'apps'), () => control.apps.list())
	const environmentsPromise = appsPromise.then(async (apps) => {
		const environments = new Map<string, OverviewRead<Awaited<ReturnType<typeof control.apps.environments.list>>>>()
		await Promise.all((apps.data?.items ?? []).map(async (app) => {
			environments.set(app.id, await overviewRead(true, () => control.apps.environments.list({ appId: app.id })))
		}))
		return environments
	})
	const [apps, environments, namespaces, runs, activeRuns, failures, approvals, health, issues, mailHeld, mailFailed, keys, audit] = await Promise.all(
		[
			appsPromise,
			environmentsPromise,
			overviewRead(mayOpen(caller, 'namespaces'), () => control.namespaces.list()),
			overviewRead(mayOpen(caller, 'runs'), () => control.runs.list({ limit: OVERVIEW_RUN_LIMIT })),
			overviewRead(mayOpen(caller, 'runs'), () => control.runs.list({ statuses: ['pending', 'running'], limit: OVERVIEW_RUN_LIMIT })),
			overviewRead(mayOpen(caller, 'runs'), () => control.runs.latestFailures()),
			overviewRead(mayOpen(caller, 'approvals'), () => control.approvals.list()),
			overviewRead(readsOperations, () => operations.health()),
			overviewRead(readsOperations, () => operations.issues({ status: 'open', window: 'all', sort: 'recent', limit: 100 })),
			overviewRead(readsMail, () => control.mail.messages.list({ state: 'held' })),
			overviewRead(readsMail, () => control.mail.messages.list({ state: 'failed' })),
			overviewRead(readsAccess, async () => {
				const page = await iam.apiKeys.list({ limit: KEY_LIMIT })
				// Expiry belongs to the credential, not just its grants. The list exposes grants only.
				const items = await Promise.all(
					page.items.filter((key) => key.status === 'active').map(async (key) => ({
						key,
						detail: await overviewRead(true, () => iam.apiKeys.get({ principalId: key.principalId })),
					})),
				)
				return { items, limited: page.nextCursor !== null }
			}),
			overviewRead(readsAccess, () => recentAuditChangePage(6, fetcher)),
		],
	)
	const publishedRuns = new Map<string, OverviewRead<RunDto>>()
	const publicationIds = new Set(
		[...environments.values()].flatMap((read) => read.data?.items.flatMap((env) => env.publishedRunId === null ? [] : [env.publishedRunId]) ?? []),
	)
	await Promise.all([...publicationIds].map(async (id) => {
		const known = runs.data?.items.find((run) => run.id === id)
		publishedRuns.set(id, known === undefined ? await overviewRead(true, () => control.runs.get({ runId: id })) : { data: known, problem: null })
	}))
	return {
		caller,
		apps,
		environments,
		namespaces,
		runs,
		activeRuns,
		publishedRuns,
		failures,
		approvals,
		health,
		issues,
		mailHeld,
		mailFailed,
		keys,
		audit,
		loadedAt: Date.now(),
	}
}

export type OverviewData = Awaited<ReturnType<typeof loadOverview>>

export function isProduction(environment: string): boolean {
	return /^(prod|production)$/i.test(environment)
}

export function environmentSources(data: OverviewData, app: string, env: string): OperationsSourceHealthDto[] | null {
	if (data.health.data === null || !mayDo(data.caller.access, OPERATIONS_ACTIONS.READ, { app, env })) return null
	return data.health.data.sources.filter((source) => source.source.appId === app && source.source.environment === env && source.source.enabled)
}

export interface RuntimeHealth {
	lamp: Lamp
	label: string
	note: string
	monitored: boolean
}

/** HTTP availability and telemetry are different signals. Healthy telemetry never makes an HTTP check healthy. */
export function runtimeHealth(sources: OperationsSourceHealthDto[] | null, now = Date.now()): RuntimeHealth {
	if (sources === null) return { lamp: 'idle', label: 'Unknown', note: 'Health is not readable', monitored: false }
	const checks = sources.flatMap((source) => source.source.enabled ? source.httpChecks.filter((check) => check.enabled) : [])
	if (checks.length === 0) return { lamp: 'idle', label: 'Not monitored', note: 'No enabled HTTP check', monitored: false }
	const states = checks.map((check) => {
		if (check.current === null) return 'unavailable'
		if (now - check.current.observedAt > check.staleAfterMs) return 'stale'
		return check.current.state
	})
	if (states.includes('failed')) return { lamp: 'stop', label: 'Failing', note: 'HTTP check failed', monitored: true }
	if (states.includes('degraded')) return { lamp: 'run', label: 'Degraded', note: 'HTTP check is degraded', monitored: true }
	if (states.includes('stale') || states.includes('unavailable')) {
		return { lamp: 'idle', label: 'Unknown', note: states.includes('stale') ? 'HTTP checks are stale' : 'Waiting for an HTTP check', monitored: true }
	}
	const oldest = Math.min(...checks.map((check) => check.current?.observedAt ?? now))
	return { lamp: 'ok', label: 'Healthy', note: `Checked ${Math.max(0, Math.floor((now - oldest) / 1000))}s ago`, monitored: true }
}

export function unhealthyTelemetry(source: OperationsSourceHealthDto): boolean {
	return source.source.enabled && source.telemetryState !== 'healthy'
}

export function productionHealth(data: OverviewData) {
	const environments = new Map<string, OperationsSourceHealthDto[]>()
	for (const source of data.health.data?.sources ?? []) {
		if (!source.source.enabled || !isProduction(source.source.environment)) continue
		const key = JSON.stringify([source.source.appId, source.source.environment])
		const group = environments.get(key) ?? []
		group.push(source)
		environments.set(key, group)
	}
	const states = [...environments.values()].map((sources) => runtimeHealth(sources, data.loadedAt))
	return {
		incidents: states.filter((state) => state.lamp === 'stop' || state.lamp === 'run').length,
		monitored: states.filter((state) => state.monitored).length,
	}
}

/** A bounded list reports a lower bound, including an empty slice whose older rows are unknown. */
export function boundedCount(count: number, limited: boolean): string {
	return `${count}${limited ? '+' : ''}`
}

export function expiringKey(key: NonNullable<OverviewData['keys']['data']>['items'][number], now: number) {
	const credential = key.detail.data?.credential
	const expiry = credential?.expiresAt
	if (expiry !== undefined && expiry !== null && expiry <= now + 7 * 86_400) return { expiresAt: expiry, kind: 'Key' }
	const grantExpiry = key.key.grants.map((grant) => grant.expiresAt)
		.filter((value): value is number => value !== null && value > now && value <= now + 7 * 86_400).sort((a, b) => a - b)[0]
	return grantExpiry === undefined ? null : { expiresAt: grantExpiry, kind: 'Key permission' }
}

/** Finished runs are bucketed by completion, on local calendar days (including DST changes). */
export function deployHistory(data: NonNullable<OverviewData['runs']['data']>, now: number) {
	const today = new Date(now)
	today.setHours(0, 0, 0, 0)
	const days = Array.from({ length: 14 }, (_, index) => {
		const date = new Date(today)
		date.setDate(date.getDate() - 13 + index)
		return { start: date.getTime() / 1000, ok: 0, failed: 0 }
	})
	for (const run of data.items) {
		if ((run.status !== 'succeeded' && run.status !== 'failed') || run.finishedAt === null || run.finishedAt > now / 1000) continue
		const day = [...days].reverse().find((day) => day.start <= (run.finishedAt ?? 0))
		if (day === undefined) continue
		if (run.status === 'succeeded') day.ok++
		else day.failed++
	}
	// The API orders by creation, so even a run created before this window may have finished inside it.
	return { days, limited: data.nextCursor !== null }
}
