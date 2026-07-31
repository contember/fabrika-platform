// Run-history + manual-trigger handlers. These feed the M3b dashboard:
//   - listRuns / getRun           — the run history table + detail.
//   - getRunLog / tailRunLog      — read the streamed NDJSON log from R2 (full + live-ish tail).
//   - triggerDeploy               — the manual "Deploy" button: create a pending run + enqueue it.
//
// The queue producer is injected (a `JobQueue`) so this stays testable without a real Queue. The
// run row is created BEFORE the enqueue so a trigger is durable even if delivery is delayed.

import type { AuthContext } from '@fabrika/auth'
import type { CursorList, RunDto, RunListInput, RunLogLine, RunLogResponse, RunTailResponse, TriggerDeployRequest } from '@fabrika/control-contract'
import type { BlobStore, JobQueue } from '@fabrika/platform'
import { logsKey } from '@fabrika/runner-cloudflare'
import { ACTIONS } from '../actions'
import type { ControlRepositories, RunRow } from '../db'
import { uuidv7 } from '../db'
import { error, readJson } from '../http'
import { appScope, envScope } from '../iam'
import { stringField } from '../json'
import { isRefPattern } from '../ref-match'
import type { DeployJobMessage } from '../run-lifecycle'
import { fail, jsonAdapter } from './domain'

/** The deploy queue producer — the platform `JobQueue` port, carrying the run pointer. */
export type DeployQueue = JobQueue<DeployJobMessage>

/**
 * The blob-store slice the log reads need. Narrowed to `get` on purpose: the control plane only READS
 * run logs (vozka-runner's relay is what writes them), so a handler that could overwrite a log would be
 * a wider dependency than the code has any use for.
 */
export type LogReader = Pick<BlobStore, 'get'>

export interface RunsContext {
	repositories: ControlRepositories
	queue: DeployQueue
	logs: LogReader
	/** Cancel seam: destroy the run's container (off-local) + mark it failed + free the deploy lock. */
	cancel(run: RunRow): Promise<void>
	request: Request
	url: URL
	auth: AuthContext
}

export type RunsUseCaseContext = Omit<RunsContext, 'request' | 'url'>

function toRunDto(row: RunRow): RunDto {
	return {
		id: row.id,
		appId: row.app_id,
		env: row.env,
		ref: row.ref,
		commitSha: row.commit_sha,
		trigger: row.trigger,
		status: row.status,
		exitCode: row.exit_code,
		externalRunId: row.external_run_id,
		logKey: row.log_key,
		createdAt: row.created_at,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
	}
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

function parseLimit(url: URL): number {
	const raw = url.searchParams.get('limit')
	if (!raw) {
		return DEFAULT_LIMIT
	}
	const n = Number.parseInt(raw, 10)
	if (!Number.isFinite(n) || n <= 0) {
		return DEFAULT_LIMIT
	}
	return Math.min(n, MAX_LIMIT)
}

/** List runs, newest first, optionally filtered by `?app=` and/or `?env=`, keyset-paged by `?before=`. */
export async function listRuns(c: RunsContext): Promise<Response> {
	const p = c.url.searchParams
	const input: RunListInput = {
		...(p.get('app') === null ? {} : { appId: p.get('app') ?? undefined }),
		...(p.get('env') === null ? {} : { env: p.get('env') ?? undefined }),
		...(p.get('before') === null ? {} : { before: p.get('before') ?? undefined }),
		limit: parseLimit(c.url),
	}
	return jsonAdapter(() => listRunsUseCase(c, input))
}

export async function listRunsUseCase(c: RunsUseCaseContext, input: RunListInput): Promise<CursorList<RunDto>> {
	authorizeList(c.auth, input)
	const limit = input.limit ?? DEFAULT_LIMIT
	const appId = input.appId
	const env = input.env
	const before = input.before
	const rows = await c.repositories.runs.listRuns({
		...(appId !== undefined ? { appId } : {}),
		...(env !== undefined ? { env } : {}),
		...(before !== undefined ? { before } : {}),
		limit,
	})
	const items = rows.map(toRunDto)
	const last = rows.at(-1)
	const nextCursor = rows.length === limit && last ? last.id : null
	return { items, nextCursor }
}

export async function getRun(c: RunsContext, id: string): Promise<Response> {
	return jsonAdapter(() => getRunUseCase(c, id))
}

export async function getRunUseCase(c: RunsUseCaseContext, id: string): Promise<RunDto> {
	const row = await requireVisibleRun(c, id, ACTIONS.DEPLOY_READ)
	return toRunDto(row)
}

/**
 * Cancel a pending/running deploy (the "Cancel" button): destroy its container + record it failed + free
 * the per-app-env lock (via the `cancel` seam). A run that already finished is a 409 (nothing to cancel).
 * The use case resolves the run before its scoped ACL check and hides denied rows as not found.
 */
export async function cancelRun(c: RunsContext, id: string): Promise<Response> {
	return jsonAdapter(() => cancelRunUseCase(c, id))
}

export async function cancelRunUseCase(c: RunsUseCaseContext, id: string): Promise<RunDto> {
	const run = await requireVisibleRun(c, id, ACTIONS.DEPLOY_TRIGGER)
	if (run.status !== 'pending' && run.status !== 'running') {
		fail(409, 'run already finished')
	}
	await c.cancel(run)
	await c.auth.audit({
		action: 'deploy.trigger',
		resourceType: 'run',
		resourceId: id,
		metadata: { appId: run.app_id, env: run.env, cancelled: true },
	})
	const updated = await c.repositories.runs.getRun(id)
	if (updated === null) fail(404, 'run not found')
	return toRunDto(updated)
}

/**
 * The full streamed log for a run, read from R2 (runs/<id>/logs.ndjson). Returns the parsed lines so
 * the dashboard renders them without re-parsing NDJSON. 404 when the run / its log doesn't exist yet.
 */
export async function getRunLog(c: RunsContext, id: string): Promise<Response> {
	return jsonAdapter(() => getRunLogUseCase(c, id))
}

export async function getRunLogUseCase(c: RunsUseCaseContext, id: string): Promise<RunLogResponse> {
	const run = await requireVisibleRun(c, id, ACTIONS.DEPLOY_READ)
	const object = await c.logs.get(run.log_key ?? logsKey(id))
	if (!object) {
		return { lines: [] }
	}
	const text = await object.text()
	const lines = parseNdjsonLogs(text)
	return { lines, status: run.status }
}

/**
 * Live-ish log tail: the lines after byte/line cursor `?after=`. Polled by the dashboard while a run
 * is `running`. The relay re-flushes the whole accumulated NDJSON to one R2 object, so a "tail" is the
 * slice of lines past the cursor the dashboard already has. Returns the new lines + the next cursor.
 */
export async function tailRunLog(c: RunsContext, id: string): Promise<Response> {
	const afterRaw = c.url.searchParams.get('after')
	const after = afterRaw !== null && /^\d+$/.test(afterRaw) ? Number.parseInt(afterRaw, 10) : 0
	return jsonAdapter(() => tailRunLogUseCase(c, id, after))
}

export async function tailRunLogUseCase(c: RunsUseCaseContext, id: string, after: number): Promise<RunTailResponse> {
	const run = await requireVisibleRun(c, id, ACTIONS.DEPLOY_READ)
	const object = await c.logs.get(run.log_key ?? logsKey(id))
	const all = object ? parseNdjsonLogs(await object.text()) : []
	const lines = all.slice(after)
	return {
		lines,
		cursor: all.length,
		done: run.status === 'succeeded' || run.status === 'failed',
		status: run.status,
	}
}

/** Parse the relay's NDJSON log into typed lines (skips blanks; tolerant of a trailing partial line). */
function parseNdjsonLogs(text: string): RunLogLine[] {
	const out: RunLogLine[] = []
	for (const raw of text.split('\n')) {
		if (raw.trim().length === 0) {
			continue
		}
		try {
			const parsed: unknown = JSON.parse(raw)
			if (isRunLogLine(parsed)) {
				out.push(parsed)
			}
		} catch {
			// A trailing partial line (mid-flush) is skipped, not fatal.
		}
	}
	return out
}

function isRunLogLine(value: unknown): value is RunLogLine {
	if (typeof value !== 'object' || value === null) {
		return false
	}
	const ts = Reflect.get(value, 'ts')
	const stream = Reflect.get(value, 'stream')
	const text = Reflect.get(value, 'text')
	return typeof ts === 'number'
		&& (stream === 'stdout' || stream === 'stderr' || stream === 'meta')
		&& typeof text === 'string'
}

/**
 * Manual deploy trigger (the "Deploy" button / `triggerDeploy` RPC): resolve the app + env, create a
 * `pending` run, then enqueue it. `ref` defaults to the env's trigger_ref (when set) else the app's
 * default branch. The use case checks deploy.trigger against the resolved app/environment coordinates.
 */
export async function triggerDeploy(c: RunsContext): Promise<Response> {
	const body = await readJson(c.request)
	const appId = stringField(body, 'appId')
	const env = stringField(body, 'env')
	if (!appId || !env) {
		return error(400, 'appId and env required')
	}
	const ref = stringField(body, 'ref')
	return jsonAdapter(() => triggerDeployUseCase(c, { appId, env, ...(ref === undefined ? {} : { ref }) }), { status: 201 })
}

export async function triggerDeployUseCase(c: RunsUseCaseContext, input: TriggerDeployRequest): Promise<RunDto> {
	const { appId, env } = input
	const app = await c.repositories.registry.getApp(appId)
	if (!app) {
		fail(404, 'app env not found')
	}
	const appEnv = await c.repositories.registry.getAppEnv(appId, env)
	if (!appEnv) {
		fail(404, 'app env not found')
	}
	if (!canAtCoordinates(c.auth, ACTIONS.DEPLOY_TRIGGER, appId, env)) fail(404, 'app env not found')
	// Explicit ref wins; else the env's trigger_ref when it's a concrete ref; else the app's default
	// branch. A GLOB trigger_ref (e.g. `refs/tags/v*`) is never a deployable ref, so it falls through to
	// the default branch — pass an explicit `ref` to manually deploy a specific tag of a pattern env.
	const concreteTriggerRef = appEnv.trigger_ref !== null && !isRefPattern(appEnv.trigger_ref) ? appEnv.trigger_ref : null
	const ref = input.ref ?? concreteTriggerRef ?? `refs/heads/${app.default_branch}`
	const run = await c.repositories.runs.createRun({ id: uuidv7(), appId, env, ref, trigger: 'manual' })
	await c.queue.send({ runId: run.id })
	await c.auth.audit({
		action: 'deploy.trigger',
		resourceType: 'run',
		resourceId: run.id,
		metadata: { appId, env, ref, trigger: 'manual' },
	})
	return toRunDto(run)
}

async function requireVisibleRun(c: RunsUseCaseContext, id: string, action: string): Promise<RunRow> {
	const run = await c.repositories.runs.getRun(id)
	if (run === null || !canAtCoordinates(c.auth, action, run.app_id, run.env)) fail(404, 'run not found')
	return run
}

function authorizeList(auth: AuthContext, input: RunListInput): void {
	const appId = input.appId
	const env = input.env
	const allowed = appId !== undefined && appId !== ''
		? env !== undefined && env !== ''
			? auth.can(ACTIONS.DEPLOY_READ, appScope(appId)) || auth.can(ACTIONS.DEPLOY_READ, envScope(env))
			: auth.can(ACTIONS.DEPLOY_READ, appScope(appId))
		: env !== undefined && env !== ''
		? auth.can(ACTIONS.DEPLOY_READ, envScope(env))
		: auth.can(ACTIONS.DEPLOY_READ)
	if (!allowed) fail(403, `not authorized: ${ACTIONS.DEPLOY_READ}`)
}

function canAtCoordinates(auth: AuthContext, action: string, appId: string, env: string): boolean {
	return auth.can(action, appScope(appId)) || auth.can(action, envScope(env))
}
