// The `dev` environment of an application (ADR-0049): one workspace at a time is bound to it, and each commit to that
// workspace reaches the running service through the dev launcher, without a run. The first bind, and any change the
// launcher cannot apply, is a bootstrap: an ordinary run with every check. Denied or foreign coordinates are a 404.

import { type DevCheckResult, devCheckResultSchema, type DevLogLine, devLogLineSchema, type DevStatus } from '@fabrika/app/dev/wire'
import type { RunDto } from '@fabrika/control-contract'
import { CONTROL_ACTIONS } from '@fabrika/control-contract'
import { z } from 'zod/v4'
import type { AppEnvRow, DevEnvironmentRow, RunRow } from '../db'
import { devReportKey, type DevSignals, devTargetKey, waitForRecord } from '../dev/signals'
import { fail } from './domain'
import { canAtCoordinates, createManualRun, toRunDto } from './runs'
import {
	type DeploymentLogQuery,
	logWindow,
	type LogWindowDto,
	type OwnedWorkspace,
	requireHead,
	requireOwner,
	requireWorkspace,
	type WorkspaceUseCaseContext,
} from './workspaces'

/** How long `apply_changes` waits for the launcher to serve the new head, and `run_checks` for the check chain. */
export const DEV_APPLY_WAIT_MS = 10_000
export const DEV_CHECKS_WAIT_MS = 50_000
export const DEV_RESET_WAIT_MS = 20_000
/** The lines `apply_changes` returns with the dev state. */
export const DEV_APPLY_LOG_LINES = 20

/** What the dev use cases need beyond a workspace's: this process's wake-ups and the provider's start of the service. */
export interface DevUseCaseDeps {
	readonly signals: DevSignals
	/** Starts the environment's service when maintenance stopped it. */
	readonly start: (row: DevEnvironmentRow, signal: AbortSignal) => Promise<void>
}

export interface DevUseCaseContext extends WorkspaceUseCaseContext {
	/** Absent on an installation whose provider runs no dev environment. */
	readonly dev: DevUseCaseDeps | undefined
}

/**
 * Where the environment stands. `unbound`: no workspace is bound. `bootstrapping`: its bootstrap run has not finished.
 * `bootstrap_failed`: that run failed. `stopped`: idle, and the next commit starts it. `pending`: the launcher has not
 * reported the head yet. Otherwise the launcher's own status.
 */
export type DevStateDto = 'unbound' | 'bootstrapping' | 'bootstrap_failed' | 'stopped' | 'pending' | DevStatus

export interface DevChecksDto {
	request: number
	results: DevCheckResult[]
}

export interface DevEnvironmentDto {
	appId: string
	env: string
	/** The bound workspace; null when none is. */
	workspaceId: string | null
	/** True when the bound workspace is the caller's own. */
	yours: boolean
	url: string | null
	state: DevStateDto
	/** What the state means and what to do next, in one line. */
	summary: string
	/** The commit the container serves, as its launcher last reported. */
	head: string | null
	/** The commit it should serve: the bound workspace's newest commit Control knows of. */
	target: string | null
	/** Why a sync was refused or failed, in one line. */
	message: string | null
	bootstrapRun: RunDto | null
	/** The newest output of the application and the launcher; never the environment. */
	log: LogWindowDto<DevLogLine>
	checks: DevChecksDto | null
}

/** What `apply_changes` adds when the workspace is bound to the dev environment. */
export interface DevApplyDto {
	head: string | null
	state: DevStateDto
	summary: string
	url: string | null
	log: DevLogLine[]
}

/**
 * Bind the workspace to its application's dev environment. The first bind, a bind after a failed bootstrap and a bind
 * after a refused sync start a bootstrap run of the workspace head; any other bind switches the running container to
 * the workspace, which syncs its files and resets the schema.
 */
export async function bindDevUseCase(c: DevUseCaseContext, input: { workspaceId: string }): Promise<DevEnvironmentDto> {
	const dev = requireDev(c)
	const owned = await requireWorkspace(c, input.workspaceId, CONTROL_ACTIONS.DEPLOY_TRIGGER)
	const appEnv = await requireDevEnvironment(c, owned.workspace.app_id, CONTROL_ACTIONS.DEPLOY_TRIGGER)
	const head = await requireHead(c, owned)
	const row = await c.repositories.devEnvironments.get(appEnv.app_id, appEnv.env)
	const switching = row !== null && row.workspace_id !== null && row.workspace_id !== owned.workspace.id
	// A stopped service first starts: a rebind syncs the running container, and a bootstrap deploys into it.
	if (row !== null) await dev.start(row, c.signal)
	const run = await needsBootstrap(c, row)
		? await createManualRun(c, { appId: appEnv.app_id, env: appEnv.env, ref: `refs/heads/${owned.workspace.branch}`, commitSha: head })
		: null
	const bound = await c.repositories.devEnvironments.bind({
		appId: appEnv.app_id,
		env: appEnv.env,
		workspaceId: owned.workspace.id,
		targetSha: head,
		bootstrapRunId: run?.id ?? null,
		reset: switching,
	})
	dev.signals.notify(devTargetKey(appEnv.app_id, appEnv.env))
	await c.auth.audit({
		action: 'dev.bind',
		resourceType: 'workspace',
		resourceId: owned.workspace.id,
		metadata: { appId: appEnv.app_id, env: appEnv.env, head, bootstrapRunId: run?.id ?? null, switched: switching },
	})
	return describe(c, appEnv, bound, { lines: 0, failuresOnly: false })
}

export async function getDevStatusUseCase(c: DevUseCaseContext, input: { workspaceId: string; log: DeploymentLogQuery }): Promise<DevEnvironmentDto> {
	requireDev(c)
	const owned = await requireWorkspace(c, input.workspaceId, CONTROL_ACTIONS.DEPLOY_READ)
	const appEnv = await requireDevEnvironment(c, owned.workspace.app_id, CONTROL_ACTIONS.DEPLOY_READ)
	return describe(c, appEnv, await c.repositories.devEnvironments.get(appEnv.app_id, appEnv.env), input.log)
}

/**
 * Run the build's check chain in the dev container, on what it holds now. The results gate nothing; `deploy_stage`
 * still builds the head with every check. Waits for them, and answers the running state when they take longer.
 */
export async function runChecksUseCase(c: DevUseCaseContext, input: { workspaceId: string }): Promise<DevEnvironmentDto> {
	const dev = requireDev(c)
	const { appEnv, row } = await requireBound(c, input.workspaceId)
	await dev.start(row, c.signal)
	const requested = await c.repositories.devEnvironments.advanceChecks(appEnv.app_id, appEnv.env)
	if (requested === null) fail(404, 'the dev environment disappeared')
	dev.signals.notify(devTargetKey(appEnv.app_id, appEnv.env))
	await audit(c, 'dev.checks', input.workspaceId, appEnv, { request: requested.checks_generation })
	const done = await waitForRecord(dev.signals, devReportKey(appEnv.app_id, appEnv.env), DEV_CHECKS_WAIT_MS, async () => {
		const current = await c.repositories.devEnvironments.get(appEnv.app_id, appEnv.env)
		return current !== null && parseChecks(current.checks_json)?.request === requested.checks_generation ? current : null
	}, c.signal)
	return describe(c, appEnv, done ?? await c.repositories.devEnvironments.get(appEnv.app_id, appEnv.env), { lines: 0, failuresOnly: false })
}

/** Drop the dev environment's schema and role family, and migrate the workspace's migrations from scratch. */
export async function resetDevUseCase(c: DevUseCaseContext, input: { workspaceId: string }): Promise<DevEnvironmentDto> {
	const dev = requireDev(c)
	const { appEnv, row } = await requireBound(c, input.workspaceId)
	await dev.start(row, c.signal)
	const requested = await c.repositories.devEnvironments.advanceReset(appEnv.app_id, appEnv.env)
	if (requested === null) fail(404, 'the dev environment disappeared')
	dev.signals.notify(devTargetKey(appEnv.app_id, appEnv.env))
	await audit(c, 'dev.reset', input.workspaceId, appEnv, { generation: requested.reset_generation })
	const done = await waitForRecord(dev.signals, devReportKey(appEnv.app_id, appEnv.env), DEV_RESET_WAIT_MS, async () => {
		const current = await c.repositories.devEnvironments.get(appEnv.app_id, appEnv.env)
		return current !== null && (current.reset_applied ?? -1) >= requested.reset_generation && !BUSY.has(current.status) ? current : null
	}, c.signal)
	return describe(c, appEnv, done ?? await c.repositories.devEnvironments.get(appEnv.app_id, appEnv.env), {
		lines: DEV_APPLY_LOG_LINES,
		failuresOnly: false,
	})
}

/**
 * After a commit to a workspace: when it is bound to the dev environment, record the new head, wake the launcher and
 * wait a short while for it to serve. Null when the workspace is not bound, or the caller may not read the environment.
 */
export async function followDevCommit(c: DevUseCaseContext, input: { workspaceId: string; commitSha: string }): Promise<DevApplyDto | null> {
	const dev = c.dev
	if (dev === undefined) return null
	const bound = await c.repositories.devEnvironments.getByWorkspace(input.workspaceId)
	if (bound === null || !canAtCoordinates(c.auth, CONTROL_ACTIONS.DEPLOY_READ, bound.app_id, bound.env)) return null
	const appEnv = await c.repositories.registry.getAppEnv(bound.app_id, bound.env)
	if (appEnv === null || appEnv.kind !== 'dev') return null
	const row = await c.repositories.devEnvironments.advanceTarget(bound.app_id, bound.env, input.workspaceId, input.commitSha)
	if (row === null) return null
	await dev.start(row, c.signal)
	dev.signals.notify(devTargetKey(row.app_id, row.env))
	const bootstrap = await bootstrapRunOf(c, row)
	const settled = bootstrap !== null && bootstrap.status !== 'succeeded'
		? row
		: await waitForRecord(dev.signals, devReportKey(row.app_id, row.env), DEV_APPLY_WAIT_MS, async () => {
			const current = await c.repositories.devEnvironments.get(row.app_id, row.env)
			return current !== null && servesOrRefused(current, input.commitSha) ? current : null
		}, c.signal)
	const current = settled ?? await c.repositories.devEnvironments.get(row.app_id, row.env) ?? row
	const described = await describe(c, appEnv, current, { lines: DEV_APPLY_LOG_LINES, failuresOnly: false })
	return { head: described.head, state: described.state, summary: described.summary, url: described.url, log: described.log.lines }
}

const BUSY: ReadonlySet<string> = new Set(['syncing', 'resetting', 'checking'])

function servesOrRefused(row: DevEnvironmentRow, commitSha: string): boolean {
	if (row.refused_sha === commitSha) return true
	return row.head_sha === commitSha && (row.status === 'serving' || row.status === 'failed')
}

async function needsBootstrap(c: DevUseCaseContext, row: DevEnvironmentRow | null): Promise<boolean> {
	if (row === null) return true
	const run = await bootstrapRunOf(c, row)
	if (run === null || run.status === 'failed') return true
	if (run.status !== 'succeeded') return false
	return row.refused_sha !== null
}

async function bootstrapRunOf(c: DevUseCaseContext, row: DevEnvironmentRow): Promise<RunRow | null> {
	return row.bootstrap_run_id === null ? null : c.repositories.runs.getRun(row.bootstrap_run_id)
}

async function describe(
	c: DevUseCaseContext,
	appEnv: AppEnvRow,
	row: DevEnvironmentRow | null,
	log: DeploymentLogQuery,
): Promise<DevEnvironmentDto> {
	const workspace = row?.workspace_id == null ? null : await c.repositories.workspaces.getWorkspace(row.workspace_id)
	const run = row === null ? null : await bootstrapRunOf(c, row)
	const state = stateOf(row, run)
	const url = appEnv.public_origin === null || appEnv.public_origin === '' ? null : appEnv.public_origin
	return {
		appId: appEnv.app_id,
		env: appEnv.env,
		workspaceId: workspace?.id ?? null,
		yours: workspace !== null && workspace.owner_id === requireOwner(c.auth),
		url,
		state,
		summary: summaryOf(state, row),
		head: row?.head_sha ?? null,
		target: row?.target_sha ?? null,
		message: row?.message ?? null,
		bootstrapRun: run === null ? null : toRunDto(run),
		log: logWindow(parseLog(row?.log_json ?? '[]'), log),
		checks: parseChecks(row?.checks_json ?? null),
	}
}

function stateOf(row: DevEnvironmentRow | null, run: RunRow | null): DevStateDto {
	if (row === null || row.workspace_id === null) return 'unbound'
	if (run !== null && run.status === 'failed') return 'bootstrap_failed'
	if (run !== null && run.status !== 'succeeded') return 'bootstrapping'
	if (row.stopped_at !== null) return 'stopped'
	if (row.refused_sha !== null && row.refused_sha === row.target_sha) return 'needs_bootstrap'
	if (row.head_sha !== row.target_sha && !BUSY.has(row.status)) return 'pending'
	return isDevStatus(row.status) ? row.status : 'pending'
}

function summaryOf(state: DevStateDto, row: DevEnvironmentRow | null): string {
	switch (state) {
		case 'unbound':
			return 'No workspace is bound; call bind_dev with your workspace.'
		case 'bootstrapping':
			return 'The bootstrap run builds the workspace head; follow it with get_deployment, then commits sync without a run.'
		case 'bootstrap_failed':
			return 'The bootstrap run failed; read it with get_deployment, fix the cause, and call bind_dev again.'
		case 'stopped':
			return 'Stopped after an idle period; the next apply_changes starts it.'
		case 'pending':
			return 'The launcher has not reported the newest commit yet; call get_dev_status in a few seconds.'
		case 'syncing':
			return 'The launcher is applying the newest commit; call get_dev_status in a few seconds.'
		case 'resetting':
			return 'The launcher is resetting the schema and migrating from scratch.'
		case 'checking':
			return 'The launcher is running the check chain.'
		case 'serving':
			return `Serving ${row?.head_sha ?? 'the newest commit'}.`
		case 'failed':
			return 'The newest commit does not serve: read message and the log, then commit a fix.'
		case 'needs_bootstrap':
			return row?.message ?? 'The newest commit needs a bootstrap run: call bind_dev again.'
	}
}

const DEV_STATES: ReadonlySet<string> = new Set<DevStatus>(['syncing', 'serving', 'failed', 'needs_bootstrap', 'resetting', 'checking'])

function isDevStatus(value: string): value is DevStatus {
	return DEV_STATES.has(value)
}

const storedLog = z.array(devLogLineSchema)
const storedChecks = z.object({ request: z.number().int().min(0), results: z.array(devCheckResultSchema) })

/** The stored log as the launcher reported it; a row this release cannot read shows no lines. */
function parseLog(json: string): DevLogLine[] {
	const parsed = storedLog.safeParse(safeJson(json))
	return parsed.success ? parsed.data : []
}

function parseChecks(json: string | null): DevChecksDto | null {
	if (json === null) return null
	const parsed = storedChecks.safeParse(safeJson(json))
	return parsed.success ? parsed.data : null
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return null
	}
}

function requireDev(c: DevUseCaseContext): DevUseCaseDeps {
	if (c.dev === undefined) fail(409, 'this installation runs no dev environments; use deploy_stage')
	return c.dev
}

/** The application's dev environment, when the caller holds `action` at its coordinates. */
async function requireDevEnvironment(c: DevUseCaseContext, appId: string, action: string): Promise<AppEnvRow> {
	const appEnv = (await c.repositories.registry.listAppEnvs(appId)).find((row) => row.kind === 'dev')
	if (appEnv === undefined || !canAtCoordinates(c.auth, action, appId, appEnv.env)) {
		fail(404, 'the application has no dev environment; an operator registers one with kind dev')
	}
	return appEnv
}

/** The dev environment the workspace is bound to; refused when another workspace, or none, is bound. */
async function requireBound(
	c: DevUseCaseContext,
	workspaceId: string,
): Promise<{ owned: OwnedWorkspace; appEnv: AppEnvRow; row: DevEnvironmentRow }> {
	const owned = await requireWorkspace(c, workspaceId, CONTROL_ACTIONS.DEPLOY_TRIGGER)
	const appEnv = await requireDevEnvironment(c, owned.workspace.app_id, CONTROL_ACTIONS.DEPLOY_TRIGGER)
	const row = await c.repositories.devEnvironments.get(appEnv.app_id, appEnv.env)
	if (row === null || row.workspace_id !== workspaceId) fail(409, 'the workspace is not bound to the dev environment; call bind_dev first')
	return { owned, appEnv, row }
}

async function audit(c: DevUseCaseContext, action: string, workspaceId: string, appEnv: AppEnvRow, metadata: Record<string, number>): Promise<void> {
	await c.auth.audit({ action, resourceType: 'workspace', resourceId: workspaceId, metadata: { appId: appEnv.app_id, env: appEnv.env, ...metadata } })
}
