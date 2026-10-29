// What runs a `dev` environment outside a run: one sandbox per workspace. `bind_dev` creates the workspace's sandbox,
// maintenance parks an idle one and removes one idle for weeks, and abandoning the workspace removes it. None of it is a
// deploy, so none of it takes the namespace lease.

import {
	type ControlProvider,
	PROVIDER_DEV_HOST_PENDING,
	type ProviderDevSandbox,
	type ProviderDevSandboxes,
	ProviderNamespaceError,
} from '@fabrika/provider-contract'
import { type NamespaceProxyChanged, republishNamespace } from '../api/namespaces'
import type { AppEnvRow, ControlRepositories, DevSandboxReportInput, DevSandboxRepository, DevSandboxRow } from '../db'
import type { Env } from '../env'
import type { PlatformTransportPort } from '../platform-transport'
import { providerEnvironment } from '../run-lifecycle'
import { installationBrandDeps, locks, platformTransportDeps, proxySecretDeps, repositories } from '../services'
import { deleteDevSandboxProxySecret, type DevSandboxKeyDeps, devSandboxProxySecret, requireVault, sandboxHostKey } from './sandbox-keys'
import { devSandboxReportKey, devSandboxTargetKey } from './signals'

/** How long a workspace sandbox runs with no activity before maintenance parks it. */
export const DEV_IDLE_STOP_SECONDS = 30 * 60
/** How long a workspace sandbox may see no activity before maintenance removes it; the workspace itself stays. */
export const DEV_SANDBOX_STALE_SECONDS = 14 * 24 * 60 * 60
/** How long one provider call of maintenance may take. */
const MAINTENANCE_CALL_MS = 60_000

/** What the dev use cases and the `source` receiver read of the record a workspace sandbox's launcher follows. */
export type DevRecord =
	& Pick<
		DevSandboxRow,
		| 'bootstrap_run_id'
		| 'target_sha'
		| 'head_sha'
		| 'refused_sha'
		| 'status'
		| 'message'
		| 'log_json'
		| 'checks_json'
		| 'reset_generation'
		| 'checks_generation'
		| 'reset_applied'
		| 'launcher_seen_at'
		| 'launcher_refused'
		| 'workspace_id'
	>
	& {
		/** When maintenance parked the sandbox; null while it runs. */
		readonly idle_at: number | null
		/** When the sandbox last woke after that. */
		readonly resumed_at: number | null
		readonly sandbox: DevSandboxRow
	}

/** One launcher's record and the keys its waiters wake on. */
export interface DevStore {
	readonly targetKey: string
	readonly reportKey: string
	read(): Promise<DevRecord | null>
	advanceTarget(targetSha: string): Promise<DevRecord | null>
	advanceReset(): Promise<DevRecord | null>
	advanceChecks(): Promise<DevRecord | null>
	recordRefusal(refusedSha: string, message: string): Promise<void>
	recordLauncherSeen(): Promise<void>
	recordLauncherRefused(reason: string, since: number): Promise<boolean>
	recordReport(report: DevSandboxReportInput): Promise<void>
}

export function sandboxRecord(row: DevSandboxRow): DevRecord {
	return { ...row, idle_at: row.parked_at, resumed_at: row.woke_at, sandbox: row }
}

const mapped = <Row>(map: (row: Row) => DevRecord) => (row: Row | null): DevRecord | null => row === null ? null : map(row)

/** The record of one workspace's sandbox. */
export function sandboxStore(repository: DevSandboxRepository, workspaceId: string): DevStore {
	const record = mapped(sandboxRecord)
	return {
		targetKey: devSandboxTargetKey(workspaceId),
		reportKey: devSandboxReportKey(workspaceId),
		read: async () => record(await repository.get(workspaceId)),
		advanceTarget: async (targetSha) => record(await repository.advanceTarget(workspaceId, targetSha)),
		advanceReset: async () => record(await repository.advanceReset(workspaceId)),
		advanceChecks: async () => record(await repository.advanceChecks(workspaceId)),
		recordRefusal: (refusedSha, message) => repository.recordRefusal(workspaceId, refusedSha, message),
		recordLauncherSeen: () => repository.recordLauncherSeen(workspaceId),
		recordLauncherRefused: (reason, since) => repository.recordLauncherRefused(workspaceId, reason, since),
		recordReport: async (report) => {
			await repository.recordReport(workspaceId, report)
		},
	}
}

/** What creating, parking, waking and removing a workspace's sandbox needs. */
export interface DevSandboxDeps extends DevSandboxKeyDeps {
	readonly repositories: Pick<ControlRepositories, 'registry' | 'runs' | 'devSandboxes'>
	readonly provider: { readonly devSandboxes: ProviderDevSandboxes }
	/** Absent without a vault, like `vault`. */
	readonly platformTransport?: Pick<PlatformTransportPort, 'revokeWorkspaceSourceKeys'>
	/** Republishes a namespace proxy, as a registry change does; absent on a provider without namespace republish. */
	readonly namespaceProxyChanged?: NamespaceProxyChanged
}

/** The sandbox dependencies of a process whose provider gives each workspace a sandbox; undefined otherwise. */
export function devSandboxDepsOf(env: Env, provider: ControlProvider): DevSandboxDeps | undefined {
	const devSandboxes = provider.devSandboxes
	if (devSandboxes === undefined) return undefined
	const persistence = repositories(env)
	const { platformTransport } = platformTransportDeps(env)
	return {
		repositories: persistence,
		provider: { devSandboxes },
		...proxySecretDeps(env),
		...(platformTransport === undefined ? {} : { platformTransport }),
		...(provider.namespaces?.republish === undefined ? {} : {
			namespaceProxyChanged: (namespaceId) =>
				republishNamespace(
					{
						repositories: persistence,
						provider,
						lock: locks(env),
						queue: env.DEPLOY_QUEUE,
						...proxySecretDeps(env),
						...installationBrandDeps(env),
					},
					namespaceId,
					{ wait: 'started' },
				),
		}),
	}
}

function namespaceOf(appEnv: AppEnvRow): string {
	if (appEnv.namespace_id === null) throw new Error(`dev environment ${appEnv.app_id}/${appEnv.env} has no deployment namespace`)
	return appEnv.namespace_id
}

/** The workspace's sandbox as `ensureDevSandbox` left it. */
export interface EnsuredDevSandbox {
	readonly row: DevSandboxRow
	/** True when Box created another sandbox than the one recorded: the previous one was lost, and nothing runs in this one. */
	readonly replaced: boolean
}

/** The provider refused to place a sandbox in the environment; its message is the one-line refusal. */
export class DevSandboxRefusedError extends Error {}

/**
 * The workspace's sandbox, created when it has none and created again when Box lost it: `ensure` is idempotent, and the
 * only call that replaces a failed or missing sandbox. The provider admits the placement before the row exists, because
 * every republish of the namespace hands a recorded sandbox on. Its proxy secret is sealed first and recorded with the
 * sandbox, or deleted when it is not the one recorded. A replaced sandbox has a new upstream, so the namespace
 * republishes. Null when the workspace was abandoned or its sandbox is being removed.
 */
export async function ensureDevSandbox(
	deps: DevSandboxDeps,
	appEnv: AppEnvRow,
	workspaceId: string,
	now: number,
	signal: AbortSignal,
): Promise<EnsuredDevSandbox | null> {
	const sandboxes = deps.repositories.devSandboxes
	const environment = await providerEnvironment(deps.repositories, appEnv)
	try {
		deps.provider.devSandboxes.admit({ environment })
	} catch (cause) {
		throw new DevSandboxRefusedError(cause instanceof Error ? cause.message : 'the provider cannot place a dev sandbox here')
	}
	const row = await sandboxes.insertCreating({ workspaceId, appId: appEnv.app_id, env: appEnv.env, now })
	if (row === null || row.state === 'removing') return null
	const namespaceId = namespaceOf(appEnv)
	const sandboxKey = await sandboxHostKey(deps, namespaceId)
	const { ref } = await devSandboxProxySecret(deps, { appId: appEnv.app_id, env: appEnv.env, workspaceId })
	const forget = async (): Promise<void> => {
		if (ref === row.proxy_secret_ref) return
		await deleteDevSandboxProxySecret(deps, ref).catch(() =>
			console.error(`dev sandboxes: an unused proxy secret of workspace ${workspaceId} was kept`)
		)
	}
	const ensure = async (): Promise<ProviderDevSandbox> =>
		deps.provider.devSandboxes.ensure({
			environment: await providerEnvironment(deps.repositories, appEnv),
			workspaceId,
			sandboxKey,
			signal,
		})
	let created: ProviderDevSandbox
	try {
		try {
			created = await ensure()
		} catch (cause) {
			if (!(cause instanceof ProviderNamespaceError && cause.code === PROVIDER_DEV_HOST_PENDING) || deps.namespaceProxyChanged === undefined) {
				throw cause
			}
			// The first sandbox of the namespace: this row hands the republish the host key, so it creates the host.
			await deps.namespaceProxyChanged(namespaceId)
			created = await ensure()
		}
	} catch (cause) {
		await forget()
		throw cause
	}
	const ready = await sandboxes.markReady({
		workspaceId,
		sandboxId: created.sandboxId,
		baseDigest: created.baseDigest,
		upstreamHost: created.upstreamHost,
		proxySecretRef: ref,
	})
	// A concurrent bind recorded its secret first: this one is no sandbox's.
	if (ready === null || ready.proxy_secret_ref !== ref) await forget()
	if (ready === null) return null
	const replaced = row.sandbox_id !== null && row.sandbox_id !== created.sandboxId
	if (replaced) await republish(deps, namespaceId, workspaceId)
	return { row: ready, replaced }
}

/**
 * Wake the sandbox; returns whether it was recorded as parked. Box's wake is idempotent, so it is asked even when the
 * record says the sandbox runs: a launcher request may have cleared the mark while Box was still parking it.
 */
export async function wakeDevSandbox(deps: DevSandboxDeps, appEnv: AppEnvRow, row: DevSandboxRow, signal: AbortSignal): Promise<boolean> {
	if (row.sandbox_id === null) return false
	await deps.provider.devSandboxes.wake({
		environment: await providerEnvironment(deps.repositories, appEnv),
		sandbox: { sandboxId: row.sandbox_id },
		sandboxKey: await sandboxHostKey(deps, namespaceOf(appEnv)),
		signal,
	})
	return deps.repositories.devSandboxes.markWoke(row.workspace_id)
}

async function republish(deps: DevSandboxDeps, namespaceId: string, workspaceId: string): Promise<void> {
	// A failed or busy republish has queued a reconcile, which publishes the namespace as the registry now says.
	await deps.namespaceProxyChanged?.(namespaceId).catch(() =>
		console.error(`dev sandboxes: the proxy of namespace ${namespaceId} did not republish for workspace ${workspaceId}`)
	)
}

export type DevSandboxRemoval = 'removed' | 'absent' | 'failed'

/**
 * Remove the workspace's sandbox: Box's sandbox (found by the workspace when none was recorded), the workspace's source
 * keys and proxy secret, the row, and then its entry in the namespace proxy. The proxy stops routing it from the
 * moment it is marked; the keys are revoked and the proxy republished even when Box failed, and the row stays
 * `removing` with its secret for maintenance to retry. `staleBefore` makes it maintenance's removal, which leaves a
 * sandbox a bind or commit made active again. Throws only without a vault.
 */
export async function removeDevSandbox(
	deps: DevSandboxDeps,
	workspaceId: string,
	signal: AbortSignal,
	staleBefore?: number,
): Promise<DevSandboxRemoval> {
	await requireVault(deps)
	const sandboxes = deps.repositories.devSandboxes
	const row = staleBefore === undefined ? await sandboxes.markRemoving(workspaceId) : await sandboxes.markRemovingIfRemovable(workspaceId, staleBefore)
	if (row === null) return 'absent'
	let failed = false
	const step = async (what: string, effect: () => Promise<unknown>): Promise<void> => {
		try {
			await effect()
		} catch {
			// Never the error object: a provider failure may carry a request detail.
			console.error(`dev sandboxes: ${what} of workspace ${workspaceId} failed; maintenance retries`)
			failed = true
		}
	}
	const appEnv = await deps.repositories.registry.getAppEnv(row.app_id, row.env)
	if (appEnv === null) {
		console.error(`dev sandboxes: the dev environment of workspace ${workspaceId} is gone; maintenance retries its removal`)
		return 'failed'
	}
	await step('removing the Box sandbox', async () =>
		deps.provider.devSandboxes.remove({
			environment: await providerEnvironment(deps.repositories, appEnv),
			workspaceId,
			sandbox: row.sandbox_id === null ? null : { sandboxId: row.sandbox_id },
			sandboxKey: await sandboxHostKey(deps, namespaceOf(appEnv)),
			signal,
		}))
	await step('revoking the source keys', async () => {
		if (deps.platformTransport === undefined) throw new Error('Control holds no platform transport')
		await deps.platformTransport.revokeWorkspaceSourceKeys(row.app_id, row.env, workspaceId)
	})
	if (!failed) {
		await step('dropping the sandbox record', async () => {
			await deleteDevSandboxProxySecret(deps, row.proxy_secret_ref)
			await sandboxes.delete(workspaceId)
		})
	}
	if (appEnv.namespace_id !== null) await republish(deps, appEnv.namespace_id, workspaceId)
	return failed ? 'failed' : 'removed'
}

export interface DevMaintenanceSummary {
	/** Sandboxes parked after their idle period. */
	readonly parked: number
	/** Sandboxes removed: stale, of an abandoned workspace, or left `removing` by an earlier attempt. */
	readonly removed: number
	readonly failed: number
}

/**
 * One maintenance pass over the workspace sandboxes: remove every one left `removing`, of an abandoned workspace, or
 * idle for `DEV_SANDBOX_STALE_SECONDS`, then park every one idle for `idleSeconds`. One failure does not stop the others.
 */
export async function maintainDevSandboxes(deps: DevSandboxDeps, now: number, idleSeconds = DEV_IDLE_STOP_SECONDS): Promise<DevMaintenanceSummary> {
	let removed = 0
	let failed = 0
	const stale = now - DEV_SANDBOX_STALE_SECONDS
	const sandboxes = deps.repositories.devSandboxes
	const candidates = new Set(
		[...await sandboxes.listRemoving(), ...await sandboxes.listOfAbandonedWorkspaces(), ...await sandboxes.listStale(stale)].map((row) =>
			row.workspace_id
		),
	)
	for (const workspaceId of candidates) {
		try {
			const outcome = await removeDevSandbox(deps, workspaceId, AbortSignal.timeout(MAINTENANCE_CALL_MS), stale)
			if (outcome === 'removed') removed += 1
			if (outcome === 'failed') failed += 1
		} catch {
			console.error(`dev sandboxes: removing the sandbox of workspace ${workspaceId} failed; the next maintenance pass retries`)
			failed += 1
		}
	}
	const parked = await parkIdleDevSandboxes(deps, now, idleSeconds)
	return { parked: parked.parked, removed, failed: failed + parked.failed }
}

/** Park every ready sandbox that saw no activity for `idleSeconds`. */
export async function parkIdleDevSandboxes(
	deps: DevSandboxDeps,
	now: number,
	idleSeconds = DEV_IDLE_STOP_SECONDS,
): Promise<{ readonly parked: number; readonly failed: number }> {
	const before = now - idleSeconds
	let parked = 0
	let failed = 0
	for (const row of await deps.repositories.devSandboxes.listIdle(before)) {
		try {
			const appEnv = await deps.repositories.registry.getAppEnv(row.app_id, row.env)
			if (appEnv === null || row.sandbox_id === null) continue
			// Recorded first: a commit that arrives meanwhile sees the sandbox as parked and wakes it again.
			if (!await deps.repositories.devSandboxes.markParked(row.workspace_id, before)) continue
			await deps.provider.devSandboxes.park({
				environment: await providerEnvironment(deps.repositories, appEnv),
				sandbox: { sandboxId: row.sandbox_id },
				sandboxKey: await sandboxHostKey(deps, namespaceOf(appEnv)),
				signal: AbortSignal.timeout(MAINTENANCE_CALL_MS),
			})
			parked += 1
		} catch {
			// The mark stays, so a sandbox Box lost is not retried every pass: a launcher that still talks clears it within
			// one wait, and the next bind replaces a lost sandbox.
			console.error(`dev sandboxes: parking the sandbox of workspace ${row.workspace_id} failed`)
			failed += 1
		}
	}
	return { parked, failed }
}
