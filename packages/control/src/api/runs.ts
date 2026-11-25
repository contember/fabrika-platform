import type { AuthContext } from '@fabrika/auth'
import {
	CONTROL_ACTIONS,
	type CursorList,
	type ListResponse,
	type RunDto,
	type RunListInput,
	type RunLogLine,
	runLogLineSchema,
	type RunLogResponse,
	type RunTailResponse,
	type TriggerDeployRequest,
} from '@fabrika/control-contract'
import { type BlobStore, type JobQueue, uuidv7 } from '@fabrika/platform'
import { type ConsoleAdmission, protectedDeployOf } from '../approval/human'
import { deployRequestOf } from '../approval/request'
import type { AppEnvRow, ControlRepositories, RunRow } from '../db'
import { DEV_RUN_NEEDS_WORKSPACE } from '../dev/sandbox-keys'
import type { CommitSource } from '../github/source/commit-files'
import { appScope, envScope } from '../iam'
import { isRefPattern } from '../ref-match'
import { type ControlJobMessage, logsKey } from '../run-lifecycle'
import { fail } from './domain'

/** The one control queue producer. This surface only ever sends the run pointer; namespaces share it. */
export type DeployQueue = JobQueue<ControlJobMessage>

/**
 * The blob-store slice the log reads need. Narrowed to `get` on purpose: the control plane only READS
 * run logs (the runner Worker's relay is what writes them), so a handler that could overwrite a log would be
 * a wider dependency than the code has any use for.
 */
export type LogReader = Pick<BlobStore, 'get'>

export interface RunsUseCaseContext {
	repositories: ControlRepositories
	queue: DeployQueue
	logs: LogReader
	/** Cancel seam: destroy the run's container (off-local) + mark it failed + free the deploy lock. */
	cancel(run: RunRow): Promise<void>
	auth: AuthContext
	/** The request the call arrived on: only a console request without a bearer is a person's (`isConsolePerson`). */
	admission?: ConsoleAdmission
	/** Reads a requested commit (ADR-0050 §4); without it a commit that must be merged cannot be shown so, and is refused. */
	commits?: CommitSource
	/** The console's origin, which a parked run's approval link names; without it a run carries no link. */
	consoleOrigin?: string
	signal?: AbortSignal
}

/** The slice a run read needs; a reader never holds the cancel seam. */
export type RunReadContext = Pick<RunsUseCaseContext, 'repositories' | 'logs' | 'auth' | 'consoleOrigin'>

/** The slice that creates and enqueues a run. */
export type RunTriggerContext = Pick<RunsUseCaseContext, 'repositories' | 'queue' | 'auth' | 'admission' | 'commits' | 'consoleOrigin' | 'signal'>

/** Where a person decides a run: the console's approval page of the run. */
export function approvalUrl(consoleOrigin: string, runId: string): string {
	return `${consoleOrigin}/approvals/${encodeURIComponent(runId)}`
}

/**
 * A run as the API answers it. With the console's origin, a run that waits for a decision, or a non-person's request
 * that has not parked yet, carries its approval link (ADR-0050 §4).
 */
export function toRunDto(row: RunRow, consoleOrigin?: string): RunDto {
	const undecidedRequest = row.request_json !== null && row.approval_json === null && (row.status === 'pending' || row.status === 'running')
	const waits = row.status === 'awaiting_approval'
	return {
		id: row.id,
		appId: row.app_id,
		env: row.env,
		ref: row.ref,
		commitSha: row.commit_sha,
		trigger: row.trigger,
		actor: row.actor,
		status: row.status,
		exitCode: row.exit_code,
		externalRunId: row.external_run_id,
		logKey: row.log_key,
		createdAt: row.created_at,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
		cancelRequestedAt: row.cancel_requested_at,
		...(consoleOrigin !== undefined && (waits || undecidedRequest) ? { approvalUrl: approvalUrl(consoleOrigin, row.id) } : {}),
		...(waits && row.approval_deadline !== null ? { approvalDeadline: row.approval_deadline } : {}),
		...(row.failure_cause === null ? {} : { failureCause: row.failure_cause }),
	}
}

const DEFAULT_LIMIT = 50

export async function listRunsUseCase(c: RunsUseCaseContext, input: RunListInput): Promise<CursorList<RunDto>> {
	authorizeList(c.auth, input)
	const limit = input.limit ?? DEFAULT_LIMIT
	const appId = input.appId
	const env = input.env
	const before = input.before
	const rows = await c.repositories.runs.listRuns({
		...(appId !== undefined ? { appId } : {}),
		...(env !== undefined ? { env } : {}),
		...(input.statuses === undefined ? {} : { statuses: input.statuses }),
		...(before !== undefined ? { before } : {}),
		limit,
	})
	const items = rows.map((row) => toRunDto(row, c.consoleOrigin))
	const last = rows.at(-1)
	const nextCursor = rows.length === limit && last ? last.id : null
	return { items, nextCursor }
}

/** Per app environment, its newest finished run when that run failed, limited to the coordinates the caller may read. */
export async function listLatestFailedRunsUseCase(c: RunReadContext): Promise<ListResponse<RunDto>> {
	const rows = await c.repositories.runs.listLatestFailedRuns()
	const visible = rows.filter((row) => canAtCoordinates(c.auth, CONTROL_ACTIONS.DEPLOY_READ, row.app_id, row.env))
	return { items: visible.map((row) => toRunDto(row, c.consoleOrigin)) }
}

export async function getRunUseCase(c: RunReadContext, id: string): Promise<RunDto> {
	const row = await requireVisibleRun(c, id, CONTROL_ACTIONS.DEPLOY_READ)
	return toRunDto(row, c.consoleOrigin)
}

/**
 * Cancel a pending/running deploy (the "Cancel" button): destroy its container + record it failed + free
 * the per-app-env lock (via the `cancel` seam). A run that already finished is a 409 (nothing to cancel).
 * The use case resolves the run before its scoped ACL check and hides denied rows as not found.
 */
export async function cancelRunUseCase(c: RunsUseCaseContext, id: string): Promise<RunDto> {
	const run = await requireVisibleRun(c, id, CONTROL_ACTIONS.DEPLOY_TRIGGER)
	if (run.status !== 'pending' && run.status !== 'running' && run.status !== 'awaiting_approval') {
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
export async function getRunLogUseCase(c: RunReadContext, id: string): Promise<RunLogResponse> {
	const run = await requireVisibleRun(c, id, CONTROL_ACTIONS.DEPLOY_READ)
	const object = await c.logs.get(run.log_key ?? logsKey(id))
	if (!object) {
		return { lines: [] }
	}
	const text = await object.text()
	const lines = parseNdjsonLogs(text)
	return { lines, status: run.status }
}

/**
 * Live-ish log tail: the lines after the line cursor `after`. Polled by the dashboard while a run
 * is `running`. The relay re-flushes the whole accumulated NDJSON to one R2 object, so a "tail" is the
 * slice of lines past the cursor the dashboard already has. Returns the new lines + the next cursor.
 */
export async function tailRunLogUseCase(c: RunsUseCaseContext, id: string, after: number): Promise<RunTailResponse> {
	const run = await requireVisibleRun(c, id, CONTROL_ACTIONS.DEPLOY_READ)
	const object = await c.logs.get(run.log_key ?? logsKey(id))
	const all = object ? parseNdjsonLogs(await object.text()) : []
	const lines = all.slice(after)
	return {
		lines,
		cursor: all.length,
		// A parked run writes no more lines until a person decides; the approval re-queues it as a fresh tail.
		done: run.status === 'succeeded' || run.status === 'failed' || run.status === 'awaiting_approval',
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
			const line = runLogLineSchema.safeParse(parsed)
			if (line.success) {
				out.push(line.data)
			}
		} catch {
			// A trailing partial line (mid-flush) is skipped, not fatal.
		}
	}
	return out
}

/**
 * Manual deploy trigger (the "Deploy" button / `triggerDeploy` RPC): resolve the app + env, create a
 * `pending` run, then enqueue it. `ref` defaults to the env's trigger_ref (when set) else the app's
 * default branch. The use case checks deploy.trigger against the resolved app/environment coordinates.
 */
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
	if (!canAtCoordinates(c.auth, CONTROL_ACTIONS.DEPLOY_TRIGGER, appId, env)) fail(404, 'app env not found')
	// A dev environment deploys per workspace sandbox: only `bind_dev` starts its runs.
	if (appEnv.kind === 'dev') fail(409, DEV_RUN_NEEDS_WORKSPACE)
	// Explicit ref wins; else the env's trigger_ref when it's a concrete ref; else the app's default
	// branch. A GLOB trigger_ref (e.g. `refs/tags/v*`) is never a deployable ref, so it falls through to
	// the default branch — pass an explicit `ref` to manually deploy a specific tag of a pattern env.
	const concreteTriggerRef = appEnv.trigger_ref !== null && !isRefPattern(appEnv.trigger_ref) ? appEnv.trigger_ref : null
	const ref = input.ref ?? concreteTriggerRef ?? `refs/heads/${app.default_branch}`
	return createManualRun(c, { appEnv, ref })
}

/**
 * Write a `pending` manual run, then enqueue it, then audit. The caller has already authorized
 * `deploy.trigger` at the coordinates, so a protected environment's refusal names nothing it cannot see.
 * A `commitSha` pins the run to that exact commit of `ref`. A non-person's run of a protected environment is a request
 * (ADR-0050 §4): it records who asked and the commit's message, pins the commit it names, and parks for a person once
 * classified.
 */
export async function createManualRun(
	c: RunTriggerContext,
	input: { appEnv: AppEnvRow; ref: string; commitSha?: string; lane?: string },
): Promise<RunDto> {
	const { appEnv, ref } = input
	const { byPerson, decision } = protectedDeployOf(c.auth, c.admission, appEnv, ref)
	const request = decision.kind === 'request' ? await deployRequestOf(c, appEnv, ref) : null
	// A request's ref is the SHA the merged check passed; pinning it makes the deploy refuse any other commit the source resolves.
	const commitSha = request === null ? input.commitSha : ref
	const appId = appEnv.app_id
	const env = appEnv.env
	const run = await c.repositories.runs.createRun({
		id: uuidv7(),
		appId,
		env,
		ref,
		...(commitSha === undefined ? {} : { commitSha }),
		trigger: 'manual',
		actor: runActor(c.auth),
		lane: input.lane ?? null,
		byPerson,
		requestJson: request === null ? null : JSON.stringify(request),
	})
	await c.queue.send({ runId: run.id })
	await c.auth.audit({
		action: 'deploy.trigger',
		resourceType: 'run',
		resourceId: run.id,
		metadata: {
			appId,
			env,
			ref,
			...(commitSha === undefined ? {} : { commitSha }),
			trigger: 'manual',
			...(request === null ? {} : { requested: true }),
		},
	})
	return toRunDto(run, c.consoleOrigin)
}

/**
 * Who created a run (ADR-0050): the principal, and for an OAuth (MCP) token the user the client acts for, marked as
 * such so a run an agent started is never mistaken for one the user started in the console.
 */
export function runActor(auth: AuthContext): string {
	const principal = auth.principal
	if (principal === null) return 'anonymous'
	return auth.oauth === undefined ? `${principal.type}:${principal.id}` : `oauth:${principal.id}`
}

async function requireVisibleRun(c: RunReadContext, id: string, action: string): Promise<RunRow> {
	const run = await c.repositories.runs.getRun(id)
	if (run === null || !canAtCoordinates(c.auth, action, run.app_id, run.env)) fail(404, 'run not found')
	return run
}

function authorizeList(auth: AuthContext, input: RunListInput): void {
	const appId = input.appId
	const env = input.env
	const allowed = appId !== undefined && appId !== ''
		? env !== undefined && env !== ''
			? auth.can(CONTROL_ACTIONS.DEPLOY_READ, appScope(appId)) || auth.can(CONTROL_ACTIONS.DEPLOY_READ, envScope(env))
			: auth.can(CONTROL_ACTIONS.DEPLOY_READ, appScope(appId))
		: env !== undefined && env !== ''
		? auth.can(CONTROL_ACTIONS.DEPLOY_READ, envScope(env))
		: auth.can(CONTROL_ACTIONS.DEPLOY_READ)
	if (!allowed) fail(403, `not authorized: ${CONTROL_ACTIONS.DEPLOY_READ}`)
}

export function canAtCoordinates(auth: AuthContext, action: string, appId: string, env: string): boolean {
	return auth.can(action, appScope(appId)) || auth.can(action, envScope(env))
}
