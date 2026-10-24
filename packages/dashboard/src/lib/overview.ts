import { createRpcClient, RpcError, type RpcFetch } from '@fabrika/app'
import { CONTROL_ACTIONS, type RunDto } from '@fabrika/control-contract'
import type { ApiKeyDetail, IamAdminRpcContract } from '@fabrika/iam-contract'
import { OPERATIONS_ACTIONS } from '@fabrika/operations-contract/access'
import type { OperationsSourceHealthDto } from '@fabrika/operations-contract/operator-api'
import { actorIdsToResolve, resolveActors } from '../access/lib/audit-actors'
import { createOperationsClient } from '../operations/client'
import { createControlClient } from './api'
import { type ConsoleCaller, holdsGlobally, mayDo, mayOpen } from './console-access'
import { runtimeHealth } from './health'
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
export const OVERVIEW_ISSUE_LIMIT = 100
export const OVERVIEW_KEY_LIMIT = 25
export const OVERVIEW_CHANGE_LIMIT = 6
/**
 * Applications whose environments the table reads; past this it links to the full list. Control answers one
 * application's environments per call (docs/backlog/190), and each published run outside the run window is one more.
 */
export const OVERVIEW_APP_LIMIT = 8
/**
 * IAM audits every admin read, the console's own included, so a timed refresh reads Access again only after this
 * long; navigating to the page or pressing refresh reads it at once.
 */
export const OVERVIEW_ACCESS_REFRESH_MS = 10 * 60_000

/** The Access half of the overview: everything it reads from IAM, and when. */
async function readAccess(allowed: boolean, fetcher: RpcFetch) {
	// IAM's 401 starts no sign-in: Control and Operations answer the same expired session, and their clients do.
	const iam = createRpcClient<IamAdminRpcContract>({ baseUrl: '/iam/admin/rpc', fetch: fetcher, bounceOnAuth: false })
	const auditPromise = overviewRead(allowed, () => recentAuditChangePage(OVERVIEW_CHANGE_LIMIT, fetcher))
	const [keys, audit, auditActors] = await Promise.all([
		overviewRead(allowed, async () => {
			// Each row carries its live credential, so expiry costs no read per key: every IAM read is an audited one.
			const page = await iam.apiKeys.list({ limit: OVERVIEW_KEY_LIMIT })
			return { items: page.items.filter((key) => key.status === 'active'), limited: page.nextCursor !== null }
		}),
		auditPromise,
		auditPromise.then((read) => resolveActors(actorIdsToResolve(read.data?.items ?? []), (principalId) => iam.principals.get({ principalId }))),
	])
	return { keys, audit, auditActors, readAt: Date.now() }
}

export type OverviewAccess = Awaited<ReturnType<typeof readAccess>>

/**
 * Every plane's reads for the overview. `previous` is the Access half of the last load, which a timed refresh passes:
 * it is kept while younger than `OVERVIEW_ACCESS_REFRESH_MS`.
 */
export async function loadOverview(caller: ConsoleCaller, fetcher: RpcFetch = fetch, previous: OverviewAccess | null = null) {
	// The shared clients: a session that expired while the page stayed open signs in again rather than reading as an outage.
	const control = createControlClient(fetcher)
	const operations = createOperationsClient(fetcher)
	const readsOperations = mayOpen(caller, 'operations')
	const readsAccess = mayOpen(caller, 'access')
	const readsMail = caller.access === null || holdsGlobally(caller.access, CONTROL_ACTIONS.MAIL_READ)
	// The installation-wide run lists need `deploy.read` held globally, which the page itself requires.
	const readsRuns = caller.access === null || holdsGlobally(caller.access, CONTROL_ACTIONS.DEPLOY_READ)
	const accessPromise = previous !== null && Date.now() - previous.readAt < OVERVIEW_ACCESS_REFRESH_MS
		? Promise.resolve(previous)
		: readAccess(readsAccess, fetcher)
	const appsPromise = overviewRead(mayOpen(caller, 'apps'), () => control.apps.list())
	const environmentsPromise = appsPromise.then(async (apps) => {
		const environments = new Map<string, OverviewRead<Awaited<ReturnType<typeof control.apps.environments.list>>>>()
		await Promise.all(
			(apps.data?.items ?? []).slice(0, OVERVIEW_APP_LIMIT).map(async (app) => {
				environments.set(app.id, await overviewRead(true, () => control.apps.environments.list({ appId: app.id })))
			}),
		)
		return environments
	})
	const [apps, environments, namespaces, runs, activeRuns, failures, approvals, health, issues, mailHeld, mailFailed, access] = await Promise.all(
		[
			appsPromise,
			environmentsPromise,
			overviewRead(mayOpen(caller, 'namespaces'), () => control.namespaces.list()),
			overviewRead(readsRuns, () => control.runs.list({ limit: OVERVIEW_RUN_LIMIT })),
			overviewRead(readsRuns, () => control.runs.list({ statuses: ['pending', 'running'], limit: OVERVIEW_RUN_LIMIT })),
			overviewRead(readsRuns, () => control.runs.latestFailures()),
			overviewRead(mayOpen(caller, 'approvals'), () => control.approvals.list()),
			overviewRead(readsOperations, () => operations.health()),
			overviewRead(readsOperations, () => operations.issues({ status: 'open', window: 'all', sort: 'recent', limit: OVERVIEW_ISSUE_LIMIT })),
			overviewRead(readsMail, () => control.mail.messages.list({ state: 'held' })),
			overviewRead(readsMail, () => control.mail.messages.list({ state: 'failed' })),
			accessPromise,
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
		keys: access.keys,
		audit: access.audit,
		auditActors: access.auditActors,
		access,
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
		incidents: states.filter((health) => health.state === 'failed' || health.state === 'degraded').length,
		monitored: states.filter((state) => state.monitored).length,
	}
}

/** A bounded list reports a lower bound, including an empty slice whose older rows are unknown. */
export function boundedCount(count: number, limited: boolean): string {
	return `${count}${limited ? '+' : ''}`
}

const KEY_EXPIRY_WINDOW = 7 * 86_400

/**
 * The key's own expiry when it falls within a week or has passed (the key no longer works), else the nearest grant
 * expiry within a week either side: a lapsed grant stays a week, then it is history rather than something to act on.
 * An IAM whose list rows carry no `credential` yet answers grants only.
 */
export function expiringKey(key: ApiKeyDetail, now: number) {
	const expiry = key.credential?.expiresAt
	if (expiry !== undefined && expiry !== null && expiry <= now + KEY_EXPIRY_WINDOW) return { expiresAt: expiry, kind: 'Key' }
	const grantExpiry = key.grants.map((grant) => grant.expiresAt)
		.filter((value): value is number => value !== null && value > now - KEY_EXPIRY_WINDOW && value <= now + KEY_EXPIRY_WINDOW)
		.sort((a, b) => a - b)[0]
	return grantExpiry === undefined ? null : { expiresAt: grantExpiry, kind: 'Key permission' }
}

/** How long before the chart's window a run may have been created and still finish inside it, waiting for an approval. */
const DEPLOY_HISTORY_MARGIN = 7 * 86_400

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
	// The API orders by creation: a sample whose oldest run predates the window by the margin holds every run that
	// finished inside it, except one that waited longer than the margin.
	const oldest = data.items.at(-1)
	const windowStart = days[0]?.start ?? now / 1000
	const limited = data.nextCursor !== null && (oldest === undefined || oldest.createdAt > windowStart - DEPLOY_HISTORY_MARGIN)
	return { days, limited }
}
