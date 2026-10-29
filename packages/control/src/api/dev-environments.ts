// The `dev` environment of an application (ADR-0049). Each workspace is served by its own sandbox at its own URL. Each
// commit to the workspace reaches the running sandbox through the dev launcher, without a run. The first bind, and any
// change the launcher cannot apply, is a bootstrap: an ordinary run with every check. Denied or foreign coordinates are
// a 404.

import { type DevCheckResult, devCheckResultSchema, type DevLogLine, devLogLineSchema, type DevStatus } from '@fabrika/app/dev/wire'
import type { RunDto } from '@fabrika/control-contract'
import { CONTROL_ACTIONS } from '@fabrika/control-contract'
import { PROVIDER_DEV_CAPACITY, PROVIDER_DEV_HOST_PENDING, ProviderNamespaceError } from '@fabrika/provider-contract'
import { z } from 'zod/v4'
import type { AppEnvRow, DevSandboxRow, RunRow } from '../db'
import { DEV_SANDBOX_VAULT_REQUIRED, devSandboxOrigin, workspacePublication } from '../dev/sandbox-keys'
import {
	type DevRecord,
	type DevSandboxDeps,
	DevSandboxRefusedError,
	type DevStore,
	ensureDevSandbox,
	removeDevSandbox,
	sandboxRecord,
	sandboxStore,
	wakeDevSandbox,
} from '../dev/service'
import { type DevSignals, waitForRecord } from '../dev/signals'
import { syncRefusal } from '../dev/sync'
import { logFailure } from '../error-label'
import { ControlApiError, fail } from './domain'
import { NamespaceProxyBusyError } from './namespaces'
import { canAtCoordinates, createManualRun, toRunDto } from './runs'
import {
	type AuthoringTargetDto,
	type DeploymentLogQuery,
	type DevSandboxRemovalPort,
	listTargetsUseCase,
	logWindow,
	type LogWindowDto,
	type OwnedWorkspace,
	requireHead,
	requireOwner,
	requireWorkspace,
	type WorkspaceFileWrite,
	workspaceSourceTarget,
	type WorkspaceUseCaseContext,
} from './workspaces'

/** How long `apply_changes` waits for the launcher to serve the new head, and `run_checks` for the check chain. */
export const DEV_APPLY_WAIT_MS = 10_000
export const DEV_CHECKS_WAIT_MS = 50_000
export const DEV_RESET_WAIT_MS = 20_000
/** How long `bind_dev` waits for the first request of a launcher whose sandbox it woke, to learn whether it is usable. */
export const DEV_BOOT_WAIT_MS = 15_000
/** The lines `apply_changes` returns with the dev state. */
export const DEV_APPLY_LOG_LINES = 20
/**
 * How long a running launcher may go without a request before Control counts it as gone. It holds a wait for at most
 * 25 s and waits again at once, except while it syncs, resets or runs the checks, which may take minutes.
 */
export const DEV_LAUNCHER_SILENT_SECONDS = 90
export const DEV_LAUNCHER_BUSY_SILENT_SECONDS = 15 * 60

/** Why a sandbox was not created or woken: the namespace's sandbox host has no room for one more. */
export const DEV_SANDBOX_CAPACITY = 'the sandbox host is full; abandon idle workspaces or ask the operator to size the zbox service'
/** Why the first sandbox of a namespace was not created: its sandbox host is still being created. */
export const DEV_SANDBOX_HOST_PENDING = "the namespace's sandbox host is being created; retry bind_dev in a minute"
const DEV_SANDBOX_REMOVING = "the workspace's dev sandbox is being removed, or the workspace was abandoned; retry in a minute"

/** What the dev use cases need beyond a workspace's: this process's wake-ups and the workspace sandboxes. */
export interface DevUseCaseDeps {
	readonly signals: DevSignals
	readonly sandboxes: DevSandboxDeps
	/** Unix seconds. */
	readonly now: () => number
}

export interface DevUseCaseContext extends WorkspaceUseCaseContext {
	/** Absent on an installation whose provider runs no dev environment. */
	readonly dev: DevUseCaseDeps | undefined
}

/**
 * Where the workspace's sandbox stands. `unbound`: the workspace has no sandbox. `bootstrapping`: its bootstrap run has
 * not finished. `bootstrap_failed`: that run failed. `stopped`: parked while idle, and the next commit wakes it.
 * `pending`: the launcher has not reported the head yet. Otherwise the launcher's own status.
 */
export type DevStateDto = 'unbound' | 'bootstrapping' | 'bootstrap_failed' | 'stopped' | 'pending' | DevStatus

export interface DevChecksDto {
	request: number
	/** The commit whose files the checks ran on. */
	head: string
	results: DevCheckResult[]
}

export interface DevEnvironmentDto {
	appId: string
	env: string
	/** The workspace whose sandbox this is; null when none is. */
	workspaceId: string | null
	/** True when that workspace is the caller's own. */
	yours: boolean
	url: string | null
	state: DevStateDto
	/** What the state means and what to do next, in one line. */
	summary: string
	/** The commit the container serves, as its launcher last reported. */
	head: string | null
	/** The commit it should serve: the workspace's newest commit Control knows of. */
	target: string | null
	/** Why a sync was refused or failed, in one line. */
	message: string | null
	bootstrapRun: RunDto | null
	/** The newest output of the application and the launcher; never the environment. */
	log: LogWindowDto<DevLogLine>
	checks: DevChecksDto | null
}

/** What `apply_changes` adds when the workspace is served by the dev environment. */
export interface DevApplyDto {
	head: string | null
	/**
	 * `unavailable`: Control could not read or wake the environment after the commit, which persisted. `not_followed`:
	 * the caller may read the environment but not trigger its deploys, so it was neither advanced nor started.
	 */
	state: DevStateDto | 'unavailable' | 'not_followed'
	summary: string
	url: string | null
	log: DevLogLine[]
	/** The reference of the logged failure, with `unavailable`. */
	reference?: string
}

/** The dev answer of a commit that persisted while following the dev environment failed. */
export function devUnavailable(reference: string): DevApplyDto {
	return {
		head: null,
		state: 'unavailable',
		summary: 'The commit persisted, but Control could not follow the dev environment. Read its state with get_dev_status; '
			+ `if that fails too, tell the operator and quote reference ${reference}.`,
		url: null,
		log: [],
		reference,
	}
}

/** An authoring target with its application's dev environment, when it has one the caller may read. */
export interface DevTargetDto extends AuthoringTargetDto {
	dev: DevEnvironmentSummaryDto | null
}

export interface DevEnvironmentSummaryDto {
	env: string
	kind: 'dev'
	state: DevStateDto
	summary: string
	url: string | null
	/** The caller's own workspace with a sandbox (the most recently active); null when none is. */
	workspaceId: string | null
	yours: boolean
	head: string | null
}

/** The record one workspace's launcher follows, and how to get it running again. */
interface DevTarget {
	readonly appEnv: AppEnvRow
	readonly store: DevStore
	/** Wakes the parked sandbox; true when it was recorded as parked. */
	readonly resume: (record: DevRecord, signal: AbortSignal) => Promise<boolean>
}

/** `list_targets`: each stage target, and beside it the state of its application's dev environment. */
export async function listDevTargetsUseCase(c: DevUseCaseContext): Promise<{ items: DevTargetDto[] }> {
	const { items } = await listTargetsUseCase(c)
	return { items: await Promise.all(items.map(async (item) => ({ ...item, dev: await devSummary(c, item.appId) }))) }
}

async function devSummary(c: DevUseCaseContext, appId: string): Promise<DevEnvironmentSummaryDto | null> {
	if (c.dev === undefined) return null
	const appEnv = (await c.repositories.registry.listAppEnvs(appId)).find((row) => row.kind === 'dev')
	if (appEnv === undefined || !canAtCoordinates(c.auth, CONTROL_ACTIONS.DEPLOY_READ, appId, appEnv.env)) return null
	const described = await describe(c, appEnv, await ownNewestSandbox(c, appEnv), { lines: 0, failuresOnly: false })
	return {
		env: described.env,
		kind: 'dev',
		state: described.state,
		summary: described.summary,
		url: described.url,
		workspaceId: described.workspaceId,
		yours: described.yours,
		head: described.head,
	}
}

/** The caller's most recently active workspace sandbox in the environment, of a workspace still in use. */
async function ownNewestSandbox(c: DevUseCaseContext, appEnv: AppEnvRow): Promise<DevRecord | null> {
	const owner = requireOwner(c.auth)
	let newest: DevSandboxRow | null = null
	for (const row of await c.repositories.devSandboxes.listByEnvironment(appEnv.app_id, appEnv.env)) {
		if (row.state !== 'ready' || (newest !== null && newest.activity_at >= row.activity_at)) continue
		const workspace = await c.repositories.workspaces.getWorkspace(row.workspace_id)
		if (workspace !== null && workspace.owner_id === owner && workspace.abandoned_at === null) newest = row
	}
	return newest === null ? null : sandboxRecord(newest)
}

/**
 * Bind the workspace to its application's dev environment: create the workspace's sandbox when it has none, wake it when
 * maintenance parked it, and bootstrap it on the head when it needs one. Binding one workspace never touches another's
 * sandbox.
 */
export async function bindDevUseCase(c: DevUseCaseContext, input: { workspaceId: string }): Promise<DevEnvironmentDto> {
	const dev = requireDev(c)
	const owned = await requireWorkspace(c, input.workspaceId, CONTROL_ACTIONS.DEPLOY_TRIGGER)
	const appEnv = await requireDevEnvironment(c, owned.workspace.app_id, CONTROL_ACTIONS.DEPLOY_TRIGGER)
	const head = await requireHead(c, owned)
	const sandboxes = dev.sandboxes
	if (sandboxes.vault === undefined) fail(503, DEV_SANDBOX_VAULT_REQUIRED)
	if (appEnv.domain === null || appEnv.domain === '') {
		fail(409, 'the dev environment names no domain to serve workspace sandboxes under; an operator registers it with a wildcard domain')
	}
	const workspaceId = owned.workspace.id
	const ensured = await sandboxCall(() => ensureDevSandbox(sandboxes, appEnv, workspaceId, dev.now(), c.signal))
	if (ensured === null) fail(409, DEV_SANDBOX_REMOVING)
	const target = targetOf(c, dev, appEnv, workspaceId)
	const record = sandboxRecord(ensured.row)
	const run = await bootstrapRunOf(c, record)
	// A woken sandbox whose launcher ran must show it still talks; one that never booted has nothing to wait for.
	const contact = await target.resume(record, c.signal) && run?.status === 'succeeded' && !ensured.replaced
		? await firstContact(c, dev, target.store)
		: { record: await target.store.read(), silent: false }
	// A sandbox Box created again holds nothing: it is bootstrapped like a new one.
	const started = ensured.replaced || contact.silent || await needsBootstrap(c, dev, appEnv, contact.record, owned, head)
		? await createManualRun(c, {
			appId: appEnv.app_id,
			env: appEnv.env,
			ref: `refs/heads/${owned.workspace.branch}`,
			commitSha: head,
			lane: workspaceId,
		})
		: null
	const bound = started === null
		? await target.store.advanceTarget(head)
		: recordOrNull(await c.repositories.devSandboxes.startBootstrap({ workspaceId, runId: started.id, targetSha: head, now: dev.now() }))
	if (bound === null) fail(409, DEV_SANDBOX_REMOVING)
	dev.signals.notify(target.store.targetKey)
	await c.auth.audit({
		action: 'dev.bind',
		resourceType: 'workspace',
		resourceId: workspaceId,
		metadata: {
			appId: appEnv.app_id,
			env: appEnv.env,
			head,
			bootstrapRunId: started?.id ?? null,
			sandboxId: ensured.row.sandbox_id,
			replaced: ensured.replaced,
		},
	})
	return describe(c, appEnv, bound, { lines: 0, failuresOnly: false })
}

export async function getDevStatusUseCase(c: DevUseCaseContext, input: { workspaceId: string; log: DeploymentLogQuery }): Promise<DevEnvironmentDto> {
	const dev = requireDev(c)
	const owned = await requireWorkspace(c, input.workspaceId, CONTROL_ACTIONS.DEPLOY_READ)
	const appEnv = await requireDevEnvironment(c, owned.workspace.app_id, CONTROL_ACTIONS.DEPLOY_READ)
	const target = targetOf(c, dev, appEnv, owned.workspace.id)
	return describe(c, appEnv, await target.store.read(), input.log)
}

/**
 * Run the build's check chain in the dev container, on what it holds now. The results gate nothing; `deploy_stage`
 * still builds the head with every check. Waits for them, and answers the running state when they take longer.
 * Refused while the container holds another commit than the workspace's newest: the results would name a commit
 * the author no longer works on.
 */
export async function runChecksUseCase(c: DevUseCaseContext, input: { workspaceId: string }): Promise<DevEnvironmentDto> {
	const dev = requireDev(c)
	const { target, record } = await requireBound(c, dev, input.workspaceId)
	if (record.head_sha !== record.target_sha) {
		const run = await bootstrapRunOf(c, record)
		const problem = launcherProblem(record, run, dev.now())
		const state = stateOf(record, run, problem)
		fail(
			409,
			`the dev environment holds ${record.head_sha ?? 'no commit yet'}, not the workspace's newest commit ${record.target_sha ?? 'unknown'} `
				+ `(state ${state}): ${problem ?? summaryOf(state, record)} Run the checks once it serves that commit.`,
		)
	}
	await target.resume(record, c.signal)
	const requested = await target.store.advanceChecks()
	if (requested === null) fail(404, 'the dev environment disappeared')
	dev.signals.notify(target.store.targetKey)
	await audit(c, 'dev.checks', input.workspaceId, target.appEnv, { request: requested.checks_generation })
	const done = await waitForRecord(dev.signals, target.store.reportKey, DEV_CHECKS_WAIT_MS, async () => {
		const current = await target.store.read()
		return current !== null && parseChecks(current.checks_json)?.request === requested.checks_generation ? current : null
	}, c.signal)
	return describe(c, target.appEnv, done ?? await target.store.read(), { lines: 0, failuresOnly: false })
}

/** Drop the dev environment's schema and role family, and migrate the workspace's migrations from scratch. */
export async function resetDevUseCase(c: DevUseCaseContext, input: { workspaceId: string }): Promise<DevEnvironmentDto> {
	const dev = requireDev(c)
	const { target, record } = await requireBound(c, dev, input.workspaceId)
	await target.resume(record, c.signal)
	const requested = await target.store.advanceReset()
	if (requested === null) fail(404, 'the dev environment disappeared')
	dev.signals.notify(target.store.targetKey)
	await audit(c, 'dev.reset', input.workspaceId, target.appEnv, { generation: requested.reset_generation })
	const done = await waitForRecord(dev.signals, target.store.reportKey, DEV_RESET_WAIT_MS, async () => {
		const current = await target.store.read()
		return current !== null && (current.reset_applied ?? -1) >= requested.reset_generation && !BUSY.has(current.status) ? current : null
	}, c.signal)
	return describe(c, target.appEnv, done ?? await target.store.read(), {
		lines: DEV_APPLY_LOG_LINES,
		failuresOnly: false,
	})
}

/**
 * After a commit to a workspace: when the dev environment serves it, record the new head, wake the launcher and wait a
 * short while for it to serve. Null when it does not, or the caller may not read the environment. Advancing, starting or
 * waking the environment needs `deploy.trigger`, as `bind_dev` does; without it the answer says so.
 */
export async function followDevCommit(
	c: DevUseCaseContext,
	input: { workspaceId: string; commitSha: string; parentSha: string; written: readonly WorkspaceFileWrite[] },
): Promise<DevApplyDto | null> {
	const dev = c.dev
	if (dev === undefined) return null
	const followed = await followedRecord(c, input.workspaceId)
	if (followed === null || !canAtCoordinates(c.auth, CONTROL_ACTIONS.DEPLOY_READ, followed.appId, followed.env)) return null
	const appEnv = await c.repositories.registry.getAppEnv(followed.appId, followed.env)
	if (appEnv === null || appEnv.kind !== 'dev') return null
	if (!canAtCoordinates(c.auth, CONTROL_ACTIONS.DEPLOY_TRIGGER, followed.appId, followed.env)) {
		return {
			head: followed.record.head_sha,
			state: 'not_followed',
			summary: `The commit persisted, but the dev environment ${followed.env} still follows ${followed.record.target_sha ?? 'no commit'}: `
				+ 'advancing it needs deploy.trigger on that environment, which you do not hold.',
			url: null,
			log: [],
		}
	}
	const target = targetOf(c, dev, appEnv, input.workspaceId)
	const record = await target.store.advanceTarget(input.commitSha)
	if (record === null) return null
	await target.resume(record, c.signal)
	// A launcher at the parent gets these files without a GitHub read; at any other head it reads the compare.
	const key = target.store.targetKey
	dev.signals.offer(key, { from: input.parentSha, to: input.commitSha, files: input.written.map(({ path, content }) => ({ path, content })) })
	dev.signals.notify(key)
	const bootstrap = await bootstrapRunOf(c, record)
	// Nothing would answer: a bootstrap run builds the container, or its launcher is gone or unreadable.
	const settled = (bootstrap !== null && bootstrap.status !== 'succeeded') || launcherProblem(record, bootstrap, dev.now()) !== null
		? record
		: await waitForRecord(dev.signals, target.store.reportKey, DEV_APPLY_WAIT_MS, async () => {
			const current = await target.store.read()
			return current !== null && servesOrRefused(current, input.commitSha) ? current : null
		}, c.signal)
	const current = settled ?? await target.store.read() ?? record
	const described = await describe(c, appEnv, current, { lines: DEV_APPLY_LOG_LINES, failuresOnly: false })
	return { head: described.head, state: described.state, summary: described.summary, url: described.url, log: described.log.lines }
}

/** The record that follows the workspace's commits, with its coordinates; null when nothing does. */
async function followedRecord(c: DevUseCaseContext, workspaceId: string): Promise<{ appId: string; env: string; record: DevRecord } | null> {
	const sandbox = await c.repositories.devSandboxes.get(workspaceId)
	return sandbox === null || sandbox.state !== 'ready' ? null : { appId: sandbox.app_id, env: sandbox.env, record: sandboxRecord(sandbox) }
}

/**
 * The workspace's sandbox removal for `delete_workspace`: nothing when the workspace has no sandbox. `prepare` refuses,
 * before anything changes, when Control has no vault to remove it with; a failure after the sandbox is marked
 * `removing` is left to maintenance.
 */
export function devSandboxRemoval(deps: DevSandboxDeps): DevSandboxRemovalPort {
	return {
		prepare: async (workspaceId) => {
			if (deps.vault === undefined && await deps.repositories.devSandboxes.get(workspaceId) !== null) fail(503, DEV_SANDBOX_VAULT_REQUIRED)
		},
		remove: async (workspaceId, signal) => {
			if (await deps.repositories.devSandboxes.get(workspaceId) === null) return
			if (deps.vault === undefined) fail(503, DEV_SANDBOX_VAULT_REQUIRED)
			await removeDevSandbox(deps, workspaceId, signal)
		},
	}
}

const BUSY: ReadonlySet<string> = new Set(['syncing', 'resetting', 'checking'])

function servesOrRefused(row: DevRecord, commitSha: string): boolean {
	if (row.refused_sha === commitSha) return true
	return row.head_sha === commitSha && (row.status === 'serving' || row.status === 'failed')
}

/** Where the workspace's launcher runs: its own sandbox. */
function targetOf(c: DevUseCaseContext, dev: DevUseCaseDeps, appEnv: AppEnvRow, workspaceId: string): DevTarget {
	return {
		appEnv,
		store: sandboxStore(c.repositories.devSandboxes, workspaceId),
		resume: async (record, signal) => {
			try {
				return await sandboxCall(() => wakeDevSandbox(dev.sandboxes, appEnv, record.sandbox, signal))
			} catch (cause) {
				if (cause instanceof ControlApiError) throw cause
				const reference = logFailure('dev: waking a sandbox', cause)
				fail(503, `the workspace's dev sandbox did not wake; call bind_dev, which replaces a sandbox that is gone (reference ${reference})`)
			}
		},
	}
}

/** A provider call on a sandbox; a full sandbox host is the caller's to resolve, so it is answered as such. */
async function sandboxCall<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation()
	} catch (cause) {
		if (cause instanceof ProviderNamespaceError && cause.code === PROVIDER_DEV_CAPACITY) fail(503, DEV_SANDBOX_CAPACITY)
		// A busy namespace has queued the reconcile that creates the host.
		if (cause instanceof ProviderNamespaceError && cause.code === PROVIDER_DEV_HOST_PENDING) fail(503, DEV_SANDBOX_HOST_PENDING)
		if (cause instanceof NamespaceProxyBusyError) fail(503, DEV_SANDBOX_HOST_PENDING)
		if (cause instanceof DevSandboxRefusedError) fail(409, cause.message)
		throw cause
	}
}

/**
 * The record once the launcher of a sandbox that just woke sent its first request, or Control refused it. `silent` when neither happened within `DEV_BOOT_WAIT_MS`: a launcher that does not talk after a
 * start cannot follow a bind.
 */
async function firstContact(c: DevUseCaseContext, dev: DevUseCaseDeps, store: DevStore): Promise<{ record: DevRecord | null; silent: boolean }> {
	const contacted = await waitForRecord(dev.signals, store.reportKey, DEV_BOOT_WAIT_MS, async () => {
		const current = await store.read()
		if (current === null) return null
		const booted = current.resumed_at ?? 0
		return current.launcher_refused !== null || (current.launcher_seen_at ?? 0) >= booted ? current : null
	}, c.signal)
	return contacted === null ? { record: await store.read(), silent: true } : { record: contacted, silent: false }
}

/**
 * Whether binding `head` needs a bootstrap run: none ran or the last one failed, a head was refused, the running
 * launcher is gone or unreadable, IAM holds another workspace's schema, or the files from what the container holds to
 * `head` change something the build owns.
 */
async function needsBootstrap(
	c: DevUseCaseContext,
	dev: DevUseCaseDeps,
	appEnv: AppEnvRow,
	row: DevRecord | null,
	owned: OwnedWorkspace,
	head: string,
): Promise<boolean> {
	if (row === null) return true
	const run = await bootstrapRunOf(c, row)
	if (run === null || run.status === 'failed') return true
	if (run.status !== 'succeeded') return false
	if (row.refused_sha !== null || launcherProblem(row, run, dev.now()) !== null) return true
	if (await iamDigestNote(c, appEnv, row) !== null) return true
	const held = row.head_sha ?? run.commit_sha
	if (held === null) return true
	if (held === head) return false
	const target = await workspaceSourceTarget(c.repositories, owned.workspace.app_id)
	if (target === null) return true
	return await c.source.session({ target, signal: c.signal }, (source) => syncRefusal(source, held, head)) !== null
}

/**
 * Why the running launcher cannot follow the environment, in one line, or null. Its requests are unreadable to this
 * Control, or it has sent none for longer than it ever waits. Only after its bootstrap run, and while it runs.
 */
function launcherProblem(row: DevRecord, run: RunRow | null, now: number): string | null {
	if (run === null || run.status !== 'succeeded' || row.idle_at !== null) return null
	if (row.launcher_refused !== null) return row.launcher_refused
	const since = Math.max(row.launcher_seen_at ?? 0, run.finished_at ?? 0, row.resumed_at ?? 0)
	const silent = BUSY.has(row.status) ? DEV_LAUNCHER_BUSY_SILENT_SECONDS : DEV_LAUNCHER_SILENT_SECONDS
	if (now - since <= silent) return null
	return `the launcher has sent no request for ${now - since} s: its container stopped following Control or runs an older `
		+ 'framework release; call bind_dev to bootstrap the environment on the workspace head'
}

async function bootstrapRunOf(c: DevUseCaseContext, row: DevRecord): Promise<RunRow | null> {
	return row.bootstrap_run_id === null ? null : c.repositories.runs.getRun(row.bootstrap_run_id)
}

/**
 * IAM holds one schema for the environment, the one the most recently bootstrapped workspace published. A line saying
 * so when this workspace's own contract differs from it; null when they agree or either is unknown.
 */
async function iamDigestNote(c: DevUseCaseContext, appEnv: AppEnvRow, row: DevRecord | null): Promise<string | null> {
	if (row === null || appEnv.iam_digest === null) return null
	const publication = await workspacePublication(c.repositories, row.sandbox)
	if (publication === null || publication.access.contractDigest === appEnv.iam_digest) return null
	return "Roles and actions follow the most recently bootstrapped workspace, whose contract differs from this one's; "
		+ 'call bind_dev to refresh them.'
}

async function describe(c: DevUseCaseContext, appEnv: AppEnvRow, row: DevRecord | null, log: DeploymentLogQuery): Promise<DevEnvironmentDto> {
	const workspace = row === null ? null : await c.repositories.workspaces.getWorkspace(row.workspace_id)
	const run = row === null ? null : await bootstrapRunOf(c, row)
	const problem = row === null || c.dev === undefined ? null : launcherProblem(row, run, c.dev.now())
	const state = stateOf(row, run, problem)
	const note = await iamDigestNote(c, appEnv, row)
	const summary = problem ?? summaryOf(state, row)
	return {
		appId: appEnv.app_id,
		env: appEnv.env,
		workspaceId: workspace?.id ?? null,
		yours: workspace !== null && workspace.owner_id === requireOwner(c.auth),
		url: urlOf(appEnv, row),
		state,
		summary: note === null ? summary : `${summary} ${note}`,
		head: row?.head_sha ?? null,
		target: row?.target_sha ?? null,
		message: problem ?? row?.message ?? null,
		bootstrapRun: run === null ? null : toRunDto(run),
		log: devLogWindow(parseLog(row?.log_json ?? '[]'), log),
		checks: parseChecks(row?.checks_json ?? null),
	}
}

/** The workspace sandbox's own origin once it exists. */
function urlOf(appEnv: AppEnvRow, row: DevRecord | null): string | null {
	const sandbox = row?.sandbox ?? null
	if (sandbox === null || sandbox.state !== 'ready' || appEnv.domain === null || appEnv.domain === '') return null
	return devSandboxOrigin(appEnv, sandbox.workspace_id)
}

function stateOf(row: DevRecord | null, run: RunRow | null, problem: string | null): DevStateDto {
	if (row === null || row.sandbox.state !== 'ready') return 'unbound'
	if (run !== null && run.status === 'failed') return 'bootstrap_failed'
	if (run !== null && run.status !== 'succeeded') return 'bootstrapping'
	if (row.idle_at !== null) return 'stopped'
	if (problem !== null) return 'needs_bootstrap'
	if (row.refused_sha !== null && row.refused_sha === row.target_sha) return 'needs_bootstrap'
	if (row.head_sha !== row.target_sha && !BUSY.has(row.status)) return 'pending'
	return isDevStatus(row.status) ? row.status : 'pending'
}

function summaryOf(state: DevStateDto, row: DevRecord | null): string {
	switch (state) {
		case 'unbound':
			return 'No dev sandbox serves this workspace yet; call bind_dev with your workspace.'
		case 'bootstrapping':
			return 'The bootstrap run builds the workspace head; follow it with get_deployment, then commits sync without a run.'
		case 'bootstrap_failed':
			return 'The bootstrap run failed; read it with get_deployment, fix the cause, and call bind_dev again.'
		case 'stopped':
			return 'Parked after an idle period; the next apply_changes or bind_dev wakes it.'
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

/**
 * A window of the launcher's reported lines, indexed by their line numbers (`n`) rather than their place in the report:
 * each report replaces the stored lines, so `after: log.to` stays put across reports. A `total` smaller than the
 * previous one means a new container, whose numbers start again from 0.
 */
function devLogWindow(lines: readonly DevLogLine[], query: DeploymentLogQuery): LogWindowDto<DevLogLine> {
	const first = lines[0]?.n ?? 0
	const shift = (index: number | undefined): number | undefined => index === undefined ? undefined : Math.max(0, index - first)
	const window = logWindow(lines, { ...query, after: shift(query.after), before: shift(query.before) })
	return { lines: window.lines, from: window.from + first, to: window.to + first, total: window.total + first }
}

const storedLog = z.array(devLogLineSchema)
const storedChecks = z.object({ request: z.number().int().min(0), head: z.string(), results: z.array(devCheckResultSchema) })

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

function recordOrNull(row: DevSandboxRow | null): DevRecord | null {
	return row === null ? null : sandboxRecord(row)
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

/** The record the workspace's launcher follows; refused when the workspace has no ready sandbox. */
async function requireBound(c: DevUseCaseContext, dev: DevUseCaseDeps, workspaceId: string): Promise<{ target: DevTarget; record: DevRecord }> {
	const owned = await requireWorkspace(c, workspaceId, CONTROL_ACTIONS.DEPLOY_TRIGGER)
	const appEnv = await requireDevEnvironment(c, owned.workspace.app_id, CONTROL_ACTIONS.DEPLOY_TRIGGER)
	const target = targetOf(c, dev, appEnv, workspaceId)
	const record = await target.store.read()
	if (record === null || record.sandbox.state !== 'ready') fail(409, 'the workspace has no dev sandbox yet; call bind_dev first')
	return { target, record }
}

async function audit(c: DevUseCaseContext, action: string, workspaceId: string, appEnv: AppEnvRow, metadata: Record<string, number>): Promise<void> {
	await c.auth.audit({ action, resourceType: 'workspace', resourceId: workspaceId, metadata: { appId: appEnv.app_id, env: appEnv.env, ...metadata } })
}
