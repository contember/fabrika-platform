// The platform transport's `source` receiver (ADR-0064): the launcher of a `dev` environment waits here for the next head
// of the workspace bound to it and reports what it serves. Its key reads the bound workspace's files of one `<app>@dev`,
// which is source that environment already runs. Runtime-neutral, but only the Bun process hands it a `DevSource`.

import {
	DEV_REPORT_MAX_LINES,
	DEV_SOURCE_REPORT_PATH,
	DEV_SOURCE_WAIT_MS,
	DEV_SOURCE_WAIT_PATH,
	type DevReport,
	type DevWaitAnswer,
	type DevWaitRequest,
	parseDevReport,
	parseDevWaitRequest,
} from '@fabrika/app/dev/wire'
import { hashPlatformKey } from '@fabrika/email/platform'
import { workspaceSourceTarget } from '../api/workspaces'
import type { ControlAppContext } from '../app'
import type { DevEnvironmentRepository, DevEnvironmentRow, PlatformTransportKeyRepository, RunRow } from '../db'
import { errorLabel } from '../error-label'
import { bearerOf, error, json, readBoundedText } from '../http'
import { repositories } from '../services'
import { WorkspaceSourceError, type WorkspaceSourcePort, type WorkspaceSourceTarget } from '../workspace-source-port'
import { devReportKey, type DevSignals, devTargetKey, waitForRecord } from './signals'
import { buildDevSync, relayableSync } from './sync'

const SOURCE_RECEIVER = 'source'

/** A wait is a few fields; a report carries the log and the check output. */
const WAIT_MAX_BODY_BYTES = 16 * 1024
const REPORT_MAX_BODY_BYTES = 4 * 1024 * 1024

/** What the Zerops composition root hands the receiver and the dev use cases: GitHub, and this process's wake-ups. */
export interface DevSource {
	readonly source: WorkspaceSourcePort
	readonly signals: DevSignals
}

export interface DevReceiverDeps {
	readonly keys: Pick<PlatformTransportKeyRepository, 'findValidByHash'>
	readonly devEnvironments: DevEnvironmentRepository
	/** The repository and connection of the application's GitHub source; null when it has none any more. */
	readonly sourceTarget: (appId: string) => Promise<WorkspaceSourceTarget | null>
	readonly source: WorkspaceSourcePort
	readonly signals: DevSignals
	/** Unix seconds. */
	readonly now: () => number
	/** How long a held wait lasts at most. */
	readonly waitMs: number
	/** A run, for the commit it built and when it finished; null for a run that does not exist. */
	readonly run: (runId: string) => Promise<BootstrapRun | null>
}

export type BootstrapRun = Pick<RunRow, 'commit_sha' | 'status' | 'finished_at'>

/** `POST /platform/source/wait` and `/platform/source/report`; anything else under the row, and the Worker, answer 404. */
export function handleDevSource(ctx: ControlAppContext): Promise<Response> {
	const dev = ctx.env.DEV_SOURCE
	if (dev === undefined || ctx.request.method !== 'POST') return Promise.resolve(error(404, 'not found'))
	const persistence = repositories(ctx.env)
	const deps: DevReceiverDeps = {
		keys: persistence.platformTransportKeys,
		devEnvironments: persistence.devEnvironments,
		sourceTarget: (appId) => workspaceSourceTarget(persistence, appId),
		source: dev.source,
		signals: dev.signals,
		now: () => Math.floor(Date.now() / 1000),
		waitMs: DEV_SOURCE_WAIT_MS,
		run: (runId) => persistence.runs.getRun(runId),
	}
	const path = new URL(ctx.request.url).pathname
	if (path === DEV_SOURCE_WAIT_PATH) return acceptDevWait(deps, ctx.request)
	if (path === DEV_SOURCE_REPORT_PATH) return acceptDevReport(deps, ctx.request)
	return Promise.resolve(error(404, 'not found'))
}

export async function acceptDevWait(deps: DevReceiverDeps, request: Request): Promise<Response> {
	const environment = await authenticate(deps, request)
	if (environment instanceof Response) return environment
	const body = await readJson(request, WAIT_MAX_BODY_BYTES)
	const parsed = body === undefined ? null : parseDevWaitRequest(body)
	if (parsed === null || !parsed.ok) return refuseLauncher(deps, environment, 'wait')
	const { appId, env } = environment
	try {
		if (await superseded(deps, await deps.devEnvironments.get(appId, env), parsed.value.bootstrap)) return error(409, SUPERSEDED)
		await deps.devEnvironments.recordLauncherSeen(appId, env)
		const ready = async () => {
			const row = await deps.devEnvironments.get(appId, env)
			return row === null || answersNow(row, parsed.value) ? { row } : null
		}
		const found = parsed.value.hold
			? await waitForRecord(deps.signals, devTargetKey(appId, env), deps.waitMs, ready, request.signal)
			: await ready()
		const row = found?.row ?? await deps.devEnvironments.get(appId, env)
		return json(await answer(deps, appId, env, row, parsed.value, request.signal))
	} catch (cause) {
		const failure = cause instanceof WorkspaceSourceError ? `GitHub answered ${cause.kind}` : errorLabel(cause)
		console.error(`dev source: answering a wait of ${appId}@${env} failed: ${failure}`)
		return error(503, 'the source is unavailable; retry')
	}
}

export async function acceptDevReport(deps: DevReceiverDeps, request: Request): Promise<Response> {
	const environment = await authenticate(deps, request)
	if (environment instanceof Response) return environment
	const body = await readJson(request, REPORT_MAX_BODY_BYTES)
	const parsed = body === undefined ? null : parseDevReport(body)
	if (parsed === null || !parsed.ok) return refuseLauncher(deps, environment, 'report')
	const { appId, env } = environment
	try {
		if (await superseded(deps, await deps.devEnvironments.get(appId, env), parsed.value.bootstrap)) return error(409, SUPERSEDED)
		await deps.devEnvironments.recordReport(appId, env, reportInput(parsed.value))
	} catch (cause) {
		console.error(`dev source: recording a report of ${appId}@${env} failed: ${errorLabel(cause)}`)
		return error(503, 'the report was not recorded; retry')
	}
	deps.signals.notify(devReportKey(appId, env))
	return new Response(null, { status: 204 })
}

/** A report replaces the previous one, so a repeated report records the same state: it needs no idempotency key. */
function reportInput(report: DevReport) {
	return {
		head: report.head,
		status: report.status,
		refused: report.status === 'needs_bootstrap' ? report.target : null,
		message: report.message,
		logJson: JSON.stringify(report.log.slice(-DEV_REPORT_MAX_LINES)),
		resetApplied: report.reset,
		checksJson: report.checks === null ? null : JSON.stringify(report.checks),
	}
}

const SUPERSEDED = 'a newer bootstrap run replaced this container'

/**
 * A container is the environment's only while its bootstrap commit is the newest bootstrap run's. The one a new run
 * replaces keeps running until the platform swaps it, and a sync or report from it would overwrite the new one's.
 */
async function superseded(deps: DevReceiverDeps, row: DevEnvironmentRow | null, bootstrap: string): Promise<boolean> {
	if (row === null || row.bootstrap_run_id === null) return false
	const built = (await deps.run(row.bootstrap_run_id))?.commit_sha ?? null
	return built !== null && built !== bootstrap
}

/** Why the environment needs a bootstrap run when its launcher speaks a wire this Control does not read. */
export const LAUNCHER_UNREADABLE = 'the container runs a launcher whose requests this Control does not read (an older or newer framework '
	+ 'release); call bind_dev to bootstrap the environment on the workspace head'

/**
 * A wait or report this release cannot parse is answered 400. When it comes from the container of the current
 * bootstrap run, that launcher can never sync again, so the environment records why and the next bind bootstraps.
 */
async function refuseLauncher(deps: DevReceiverDeps, environment: { appId: string; env: string }, request: 'wait' | 'report'): Promise<Response> {
	const { appId, env } = environment
	try {
		const row = await deps.devEnvironments.get(appId, env)
		const run = row?.bootstrap_run_id == null ? null : await deps.run(row.bootstrap_run_id)
		if (row !== null && run !== null && run.status === 'succeeded' && run.finished_at !== null) {
			const booted = Math.max(run.finished_at, row.service_started_at ?? 0)
			if (await deps.devEnvironments.recordLauncherRefused(appId, env, LAUNCHER_UNREADABLE, booted)) {
				deps.signals.notify(devReportKey(appId, env))
			}
		}
	} catch (cause) {
		console.error(`dev source: recording an unreadable ${request} of ${appId}@${env} failed: ${errorLabel(cause)}`)
	}
	return error(400, `not a ${request} this release reads`)
}

/** Whether the record asks the launcher for something it has not done: a head to sync to, a reset, or checks. */
function answersNow(row: DevEnvironmentRow, request: DevWaitRequest): boolean {
	return needsSync(row, request.head)
		|| request.reset === null || row.reset_generation > request.reset
		|| request.checks === null || row.checks_generation > request.checks
}

function needsSync(row: DevEnvironmentRow, head: string): row is DevEnvironmentRow & { target_sha: string; workspace_id: string } {
	return row.workspace_id !== null && row.target_sha !== null && row.target_sha !== head && row.target_sha !== row.refused_sha
}

async function answer(
	deps: DevReceiverDeps,
	appId: string,
	env: string,
	row: DevEnvironmentRow | null,
	request: DevWaitRequest,
	signal: AbortSignal,
): Promise<DevWaitAnswer> {
	if (row === null) return { sync: null, reset: 0, checks: 0 }
	// A container without a state file adopts the answer's generation as applied. Its database is the previous
	// container's, so it learns the generation that one applied, and the next answer asks for any reset still pending.
	const reset = request.reset === null ? Math.min(row.reset_applied ?? 0, row.reset_generation) : row.reset_generation
	const generations = { reset, checks: row.checks_generation }
	if (!needsSync(row, request.head)) return { sync: null, ...generations }
	const handedOff = deps.signals.take(devTargetKey(appId, env), request.head, row.target_sha)
	const relayed = handedOff === null ? null : relayableSync(handedOff)
	if (relayed !== null) return { sync: relayed, ...generations }
	const target = await deps.sourceTarget(appId)
	if (target === null) {
		await deps.devEnvironments.recordRefusal(appId, env, row.target_sha, 'the application has no GitHub source any more')
		return { sync: null, ...generations }
	}
	let outcome: Awaited<ReturnType<typeof buildDevSync>>
	try {
		const to = row.target_sha
		outcome = await deps.source.session({ target, signal }, (source) => buildDevSync(source, request.head, to))
	} catch (cause) {
		if (!(cause instanceof WorkspaceSourceError) || cause.kind !== 'not_found') throw cause
		outcome = { kind: 'refused', reason: `GitHub does not know the commit ${request.head} this container holds; call bind_dev again` }
	}
	if (outcome.kind === 'refused') {
		await deps.devEnvironments.recordRefusal(appId, env, row.target_sha, outcome.reason)
		deps.signals.notify(devReportKey(appId, env))
		return { sync: null, ...generations }
	}
	return { sync: outcome.sync, ...generations }
}

/** The environment a `source` key names; a refusal response for any other bearer. */
async function authenticate(deps: DevReceiverDeps, request: Request): Promise<{ appId: string; env: string } | Response> {
	const bearer = bearerOf(request)
	if (bearer === null) return error(401, 'unauthorized')
	try {
		const key = await deps.keys.findValidByHash(await hashPlatformKey(bearer), deps.now())
		if (key === null || key.receiver !== SOURCE_RECEIVER) return error(401, 'unauthorized')
		return { appId: key.app_id, env: key.env }
	} catch {
		console.error('dev source: key lookup failed')
		return error(503, 'unavailable; retry')
	}
}

/** The body as parsed JSON, or `undefined` when it is too large or no JSON. */
async function readJson(request: Request, maxBytes: number): Promise<unknown> {
	const text = await readBoundedText(request, maxBytes)
	if (text === null) return undefined
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}
