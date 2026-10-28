// The platform transport's `source` receiver (ADR-0064): the launcher of a `dev` environment waits here for the next head
// of the workspace it follows and reports what it serves. With one sandbox per workspace, its key names that workspace
// and reads only its files; otherwise it reads the bound workspace's files of one `<app>@dev`, which is source that
// environment already runs. Runtime-neutral, but only the Bun process hands it a `DevSource`.

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
import type { DevEnvironmentRepository, DevSandboxRepository, PlatformTransportKeyRepository, RunRow } from '../db'
import { errorLabel } from '../error-label'
import { bearerOf, error, json, readBoundedText } from '../http'
import { repositories } from '../services'
import { WorkspaceSourceError, type WorkspaceSourcePort, type WorkspaceSourceTarget } from '../workspace-source-port'
import { type DevRecord, type DevStore, environmentStore, sandboxStore } from './service'
import { type DevSignals, waitForRecord } from './signals'
import { buildDevSync, relayableSync } from './sync'

const SOURCE_RECEIVER = 'source'

/** A wait is a few fields; a report carries the log and the check output. */
const WAIT_MAX_BODY_BYTES = 16 * 1024
const REPORT_MAX_BODY_BYTES = 4 * 1024 * 1024

/** What the Zerops composition root hands the receiver and the dev use cases: GitHub, and this process's wake-ups. */
export interface DevSource {
	readonly source: WorkspaceSourcePort
	readonly signals: DevSignals
	/** True when the provider gives each workspace its own sandbox (`ControlProvider.devSandboxes`). */
	readonly sandboxes: boolean
}

export interface DevReceiverDeps {
	readonly keys: Pick<PlatformTransportKeyRepository, 'findValidByHash'>
	readonly devEnvironments: DevEnvironmentRepository
	readonly devSandboxes: DevSandboxRepository
	/** True when a launcher's key must name its workspace: each workspace has its own sandbox. */
	readonly sandboxes: boolean
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
		devSandboxes: persistence.devSandboxes,
		sandboxes: dev.sandboxes,
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
	const launcher = await authenticate(deps, request)
	if (launcher instanceof Response) return launcher
	const body = await readJson(request, WAIT_MAX_BODY_BYTES)
	const parsed = body === undefined ? null : parseDevWaitRequest(body)
	if (parsed === null || !parsed.ok) return refuseLauncher(deps, launcher, 'wait')
	const { store } = launcher
	try {
		if (await superseded(deps, await store.read(), parsed.value.bootstrap)) return error(409, SUPERSEDED)
		await store.recordLauncherSeen()
		const ready = async () => {
			const row = await store.read()
			return row === null || answersNow(row, parsed.value) ? { row } : null
		}
		const found = parsed.value.hold
			? await waitForRecord(deps.signals, store.targetKey, deps.waitMs, ready, request.signal)
			: await ready()
		const row = found?.row ?? await store.read()
		return json(await answer(deps, launcher, row, parsed.value, request.signal))
	} catch (cause) {
		const failure = cause instanceof WorkspaceSourceError ? `GitHub answered ${cause.kind}` : errorLabel(cause)
		console.error(`dev source: answering a wait of ${launcher.label} failed: ${failure}`)
		return error(503, 'the source is unavailable; retry')
	}
}

export async function acceptDevReport(deps: DevReceiverDeps, request: Request): Promise<Response> {
	const launcher = await authenticate(deps, request)
	if (launcher instanceof Response) return launcher
	const body = await readJson(request, REPORT_MAX_BODY_BYTES)
	const parsed = body === undefined ? null : parseDevReport(body)
	if (parsed === null || !parsed.ok) return refuseLauncher(deps, launcher, 'report')
	const { store } = launcher
	try {
		if (await superseded(deps, await store.read(), parsed.value.bootstrap)) return error(409, SUPERSEDED)
		await store.recordReport(reportInput(parsed.value))
	} catch (cause) {
		console.error(`dev source: recording a report of ${launcher.label} failed: ${errorLabel(cause)}`)
		return error(503, 'the report was not recorded; retry')
	}
	deps.signals.notify(store.reportKey)
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
 * replaces keeps running until the platform swaps it, and a sync or report from it would overwrite the new one's. With
 * one sandbox per workspace, the newest bootstrap run is that workspace's.
 */
async function superseded(deps: DevReceiverDeps, row: DevRecord | null, bootstrap: string): Promise<boolean> {
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
async function refuseLauncher(deps: DevReceiverDeps, launcher: Launcher, request: 'wait' | 'report'): Promise<Response> {
	const { store } = launcher
	try {
		const row = await store.read()
		const run = row?.bootstrap_run_id == null ? null : await deps.run(row.bootstrap_run_id)
		if (row !== null && run !== null && run.status === 'succeeded' && run.finished_at !== null) {
			const booted = Math.max(run.finished_at, row.resumed_at ?? 0)
			if (await store.recordLauncherRefused(LAUNCHER_UNREADABLE, booted)) deps.signals.notify(store.reportKey)
		}
	} catch (cause) {
		console.error(`dev source: recording an unreadable ${request} of ${launcher.label} failed: ${errorLabel(cause)}`)
	}
	return error(400, `not a ${request} this release reads`)
}

/** Whether the record asks the launcher for something it has not done: a head to sync to, a reset, or checks. */
function answersNow(row: DevRecord, request: DevWaitRequest): boolean {
	return needsSync(row, request.head)
		|| request.reset === null || row.reset_generation > request.reset
		|| request.checks === null || row.checks_generation > request.checks
}

function needsSync(row: DevRecord, head: string): row is DevRecord & { target_sha: string; workspace_id: string } {
	return row.workspace_id !== null && row.target_sha !== null && row.target_sha !== head && row.target_sha !== row.refused_sha
}

async function answer(
	deps: DevReceiverDeps,
	launcher: Launcher,
	row: DevRecord | null,
	request: DevWaitRequest,
	signal: AbortSignal,
): Promise<DevWaitAnswer> {
	const { appId, store } = launcher
	if (row === null) return { sync: null, reset: 0, checks: 0 }
	// A container without a state file adopts the answer's generation as applied. Its database is the previous
	// container's, so it learns the generation that one applied, and the next answer asks for any reset still pending.
	const reset = request.reset === null ? Math.min(row.reset_applied ?? 0, row.reset_generation) : row.reset_generation
	const generations = { reset, checks: row.checks_generation }
	if (!needsSync(row, request.head)) return { sync: null, ...generations }
	const handedOff = deps.signals.take(store.targetKey, request.head, row.target_sha)
	const relayed = handedOff === null ? null : relayableSync(handedOff)
	if (relayed !== null) return { sync: relayed, ...generations }
	const target = await deps.sourceTarget(appId)
	if (target === null) {
		await store.recordRefusal(row.target_sha, 'the application has no GitHub source any more')
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
		await store.recordRefusal(row.target_sha, outcome.reason)
		deps.signals.notify(store.reportKey)
		return { sync: null, ...generations }
	}
	return { sync: outcome.sync, ...generations }
}

/** The launcher a `source` key authenticates, with the record it follows. */
interface Launcher {
	readonly appId: string
	/** Names the launcher in a log line. */
	readonly label: string
	readonly store: DevStore
}

/**
 * The launcher a `source` key names; a refusal response for any other bearer. With one sandbox per workspace the key
 * must name its workspace, whose sandbox, when it has one, is in the key's environment.
 */
async function authenticate(deps: DevReceiverDeps, request: Request): Promise<Launcher | Response> {
	const bearer = bearerOf(request)
	if (bearer === null) return error(401, 'unauthorized')
	try {
		const key = await deps.keys.findValidByHash(await hashPlatformKey(bearer), deps.now())
		if (key === null || key.receiver !== SOURCE_RECEIVER) return error(401, 'unauthorized')
		const { app_id: appId, env, workspace_id: workspaceId } = key
		if (workspaceId === null) {
			if (deps.sandboxes) return error(401, 'unauthorized')
			return { appId, label: `${appId}@${env}`, store: environmentStore(deps.devEnvironments, appId, env, null) }
		}
		const sandbox = await deps.devSandboxes.get(workspaceId)
		if (sandbox !== null && (sandbox.app_id !== appId || sandbox.env !== env)) return error(401, 'unauthorized')
		return { appId, label: `${appId}@${env} workspace ${workspaceId}`, store: sandboxStore(deps.devSandboxes, workspaceId) }
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
