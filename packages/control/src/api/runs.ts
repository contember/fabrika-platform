// Run-history + manual-trigger handlers. These feed the M3b dashboard:
//   - listRuns / getRun           — the run history table + detail.
//   - getRunLog / tailRunLog      — read the streamed NDJSON log from R2 (full + live-ish tail).
//   - triggerDeploy               — the manual "Deploy" button: create a pending run + enqueue it.
//
// The queue producer is injected (a `JobQueue`) so this stays testable without a real Queue. The
// run row is created BEFORE the enqueue so a trigger is durable even if delivery is delayed.

import type { BlobStore, JobQueue } from '@fabrika/platform'
import { type LogLine, logsKey } from '@fabrika/runner'
import type { Db, RunRow } from '../db'
import { uuidv7 } from '../db'
import { error, json, readJson } from '../http'
import type { Authorized } from '../iam'
import { stringField } from '../json'
import { isRefPattern } from '../ref-match'
import type { DeployJobMessage } from '../run-lifecycle'

/** The deploy queue producer — the platform `JobQueue` port, carrying the run pointer. */
export type DeployQueue = JobQueue<DeployJobMessage>

/**
 * The blob-store slice the log reads need. Narrowed to `get` on purpose: the control plane only READS
 * run logs (vozka-runner's relay is what writes them), so a handler that could overwrite a log would be
 * a wider dependency than the code has any use for.
 */
export type LogReader = Pick<BlobStore, 'get'>

export interface RunsContext {
	db: Db
	queue: DeployQueue
	logs: LogReader
	/** Cancel seam: destroy the run's container (off-local) + mark it failed + free the deploy lock. */
	cancel(run: RunRow): Promise<void>
	request: Request
	url: URL
	authorized: Authorized
}

function toRunDto(row: RunRow): unknown {
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
	const limit = parseLimit(c.url)
	const appId = p.get('app') ?? undefined
	const env = p.get('env') ?? undefined
	const before = p.get('before') ?? undefined
	const rows = await c.db.listRuns({
		...(appId !== undefined ? { appId } : {}),
		...(env !== undefined ? { env } : {}),
		...(before !== undefined ? { before } : {}),
		limit,
	})
	const items = rows.map(toRunDto)
	const last = rows.at(-1)
	const nextCursor = rows.length === limit && last ? last.id : null
	return json({ items, nextCursor })
}

export async function getRun(c: RunsContext, id: string): Promise<Response> {
	const row = await c.db.getRun(id)
	return row ? json(toRunDto(row)) : error(404, 'run not found')
}

/**
 * Cancel a pending/running deploy (the "Cancel" button): destroy its container + record it failed + free
 * the per-app-env lock (via the `cancel` seam). A run that already finished is a 409 (nothing to cancel).
 * ACL (`deploy.trigger`) is enforced by the router before this runs. Returns the updated (failed) run.
 */
export async function cancelRun(c: RunsContext, id: string): Promise<Response> {
	const run = await c.db.getRun(id)
	if (!run) {
		return error(404, 'run not found')
	}
	if (run.status !== 'pending' && run.status !== 'running') {
		return error(409, 'run already finished')
	}
	await c.cancel(run)
	await c.authorized.auth.audit({
		action: 'deploy.trigger',
		resourceType: 'run',
		resourceId: id,
		metadata: { appId: run.app_id, env: run.env, cancelled: true },
	})
	const updated = await c.db.getRun(id)
	return updated ? json(toRunDto(updated)) : error(404, 'run not found')
}

/**
 * The full streamed log for a run, read from R2 (runs/<id>/logs.ndjson). Returns the parsed lines so
 * the dashboard renders them without re-parsing NDJSON. 404 when the run / its log doesn't exist yet.
 */
export async function getRunLog(c: RunsContext, id: string): Promise<Response> {
	const run = await c.db.getRun(id)
	if (!run) {
		return error(404, 'run not found')
	}
	const object = await c.logs.get(run.log_key ?? logsKey(id))
	if (!object) {
		return json({ lines: [] })
	}
	const text = await object.text()
	const lines = parseNdjsonLogs(text)
	return json({ lines, status: run.status })
}

/**
 * Live-ish log tail: the lines after byte/line cursor `?after=`. Polled by the dashboard while a run
 * is `running`. The relay re-flushes the whole accumulated NDJSON to one R2 object, so a "tail" is the
 * slice of lines past the cursor the dashboard already has. Returns the new lines + the next cursor.
 */
export async function tailRunLog(c: RunsContext, id: string): Promise<Response> {
	const run = await c.db.getRun(id)
	if (!run) {
		return error(404, 'run not found')
	}
	const afterRaw = c.url.searchParams.get('after')
	const after = afterRaw !== null && /^\d+$/.test(afterRaw) ? Number.parseInt(afterRaw, 10) : 0
	const object = await c.logs.get(run.log_key ?? logsKey(id))
	const all = object ? parseNdjsonLogs(await object.text()) : []
	const lines = all.slice(after)
	return json({ lines, cursor: all.length, done: run.status === 'succeeded' || run.status === 'failed', status: run.status })
}

/** Parse the relay's NDJSON log into typed lines (skips blanks; tolerant of a trailing partial line). */
function parseNdjsonLogs(text: string): LogLine[] {
	const out: LogLine[] = []
	for (const raw of text.split('\n')) {
		if (raw.trim().length === 0) {
			continue
		}
		try {
			const parsed: unknown = JSON.parse(raw)
			if (isLogLine(parsed)) {
				out.push(parsed)
			}
		} catch {
			// A trailing partial line (mid-flush) is skipped, not fatal.
		}
	}
	return out
}

function isLogLine(value: unknown): value is LogLine {
	if (typeof value !== 'object' || value === null) {
		return false
	}
	return 'ts' in value && 'stream' in value && 'text' in value && typeof Reflect.get(value, 'text') === 'string'
}

/**
 * Manual deploy trigger (the "Deploy" button / `triggerDeploy` RPC): resolve the app + env, create a
 * `pending` run, then enqueue it. `ref` defaults to the env's trigger_ref (when set) else the app's
 * default branch. Returns the created run. ACL (`deploy.trigger`) is enforced by the router with the
 * app+env scope before this runs.
 */
export async function triggerDeploy(c: RunsContext): Promise<Response> {
	const body = await readJson(c.request)
	const appId = stringField(body, 'appId')
	const env = stringField(body, 'env')
	if (!appId || !env) {
		return error(400, 'appId and env required')
	}
	const app = await c.db.getApp(appId)
	if (!app) {
		return error(404, 'app not found')
	}
	const appEnv = await c.db.getAppEnv(appId, env)
	if (!appEnv) {
		return error(404, 'app env not found')
	}
	// Explicit ref wins; else the env's trigger_ref when it's a concrete ref; else the app's default
	// branch. A GLOB trigger_ref (e.g. `refs/tags/v*`) is never a deployable ref, so it falls through to
	// the default branch — pass an explicit `ref` to manually deploy a specific tag of a pattern env.
	const concreteTriggerRef = appEnv.trigger_ref !== null && !isRefPattern(appEnv.trigger_ref) ? appEnv.trigger_ref : null
	const ref = stringField(body, 'ref') ?? concreteTriggerRef ?? `refs/heads/${app.default_branch}`
	const run = await c.db.createRun({ id: uuidv7(), appId, env, ref, trigger: 'manual' })
	await c.queue.send({ runId: run.id })
	await c.authorized.auth.audit({
		action: 'deploy.trigger',
		resourceType: 'run',
		resourceId: run.id,
		metadata: { appId, env, ref, trigger: 'manual' },
	})
	return json(toRunDto(run), { status: 201 })
}
