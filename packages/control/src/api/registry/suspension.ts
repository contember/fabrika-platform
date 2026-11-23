import type { OpsMode } from '@fabrika/auth-core'
import type { AppEnvDto } from '@fabrika/control-contract'
import type { DeployLocks } from '@fabrika/platform'
import { ProviderNamespaceError } from '@fabrika/provider-contract'
import { type OpsTransport, recordedMaintenance, startMaintenance } from '../../data-operations'
import type { AppEnvRow } from '../../db'
import { dataOperationResult } from '../data-operation-result'
import { fail } from '../domain'
import { syncChangedNamespaceProxies, toProviderNamespace } from '../namespaces'
import { runActor } from '../runs'
import type { RegistryUseCaseContext } from './context'
import { toAppEnvDto } from './registration'

export interface SuspensionUseCaseContext extends RegistryUseCaseContext {
	/**
	 * The environment's object (ADR-0069), which a provider without a namespace proxy suspends through: its deploy lease
	 * and its ops channel. Absent, such a provider cannot suspend.
	 */
	readonly maintenance?: { readonly lock: DeployLocks; readonly ops: OpsTransport }
}

/**
 * Take an environment offline in an incident. Behind a namespace proxy the registry records it and the proxy is
 * republished with the environment's entry answering 503; elsewhere its object goes into maintenance `closed`, after
 * Control recorded the mode `resume` restores. A repeated call is a retry: it republishes, or closes again.
 */
export async function suspendAppEnvUseCase(c: SuspensionUseCaseContext, appId: string, env: string, now: number): Promise<AppEnvDto> {
	const row = await requireAppEnv(c, appId, env)
	if (c.provider.namespaces?.republish !== undefined) return toAppEnvDto(await suspendBehindProxy(c, row, now))
	return toAppEnvDto(await suspendObject(c, row, now))
}

/** Undo `suspendAppEnvUseCase`: the proxy routes the environment again, or the object returns to the mode it was in. */
export async function resumeAppEnvUseCase(c: SuspensionUseCaseContext, appId: string, env: string): Promise<AppEnvDto> {
	const row = await requireAppEnv(c, appId, env)
	if (c.provider.namespaces?.republish !== undefined) return toAppEnvDto(await resumeBehindProxy(c, row))
	return toAppEnvDto(await resumeObject(c, row))
}

async function requireAppEnv(c: SuspensionUseCaseContext, appId: string, env: string): Promise<AppEnvRow> {
	const row = await c.repositories.registry.getAppEnv(appId, env)
	if (row === null) fail(404, 'app env not found')
	return row
}

/**
 * The flag reaches the proxy only through a republish, which is refused before anything is written when the namespace's
 * pinned proxy cannot read it: its strict parser would fail the build and the previous manifest would keep serving.
 */
async function suspendBehindProxy(c: SuspensionUseCaseContext, row: AppEnvRow, now: number): Promise<AppEnvRow> {
	const namespaceId = await suspendableNamespace(c, row)
	const updated = row.suspended_at === null ? (await recordSuspension(c, row, { at: now, fromMode: null })).row : row
	await c.auth.audit({ action: 'app.env.suspend', resourceType: 'app_env', resourceId: `${row.app_id}/${row.env}`, metadata: { namespaceId } })
	// Waits until the rebuild starts, not until it is live: a proxy build takes minutes.
	await syncChangedNamespaceProxies(c.namespaceProxyChanged, [namespaceId])
	return updated
}

async function resumeBehindProxy(c: SuspensionUseCaseContext, row: AppEnvRow): Promise<AppEnvRow> {
	const namespaceId = row.namespace_id
	if (namespaceId === null) fail(409, `app env ${row.app_id}/${row.env} has no deployment namespace, so no proxy routes it`)
	if (c.namespaceProxyChanged === undefined) fail(503, 'namespace proxy republish unavailable')
	const updated = row.suspended_at === null ? row : await clearSuspension(c, row)
	await c.auth.audit({ action: 'app.env.resume', resourceType: 'app_env', resourceId: `${row.app_id}/${row.env}`, metadata: { namespaceId } })
	await syncChangedNamespaceProxies(c.namespaceProxyChanged, [namespaceId])
	return updated
}

async function suspendableNamespace(c: SuspensionUseCaseContext, row: AppEnvRow): Promise<string> {
	if (row.namespace_id === null) fail(409, `app env ${row.app_id}/${row.env} has no deployment namespace, so no proxy routes it`)
	const assertSuspendable = c.provider.namespaces?.assertSuspendable
	if (assertSuspendable === undefined || c.namespaceProxyChanged === undefined) {
		fail(409, `the ${c.provider.id} namespace proxy cannot take an environment offline`)
	}
	const namespace = await c.repositories.registry.getDeploymentNamespace(row.namespace_id)
	if (namespace === null) fail(409, `deployment namespace ${row.namespace_id} not found`)
	try {
		assertSuspendable(toProviderNamespace(namespace))
	} catch (cause) {
		if (cause instanceof ProviderNamespaceError) fail(409, cause.message)
		throw cause
	}
	return namespace.id
}

/** The object's mode before the suspension is recorded first, so a `resume` after an interrupted close still restores it. */
async function suspendObject(c: SuspensionUseCaseContext, row: AppEnvRow, now: number): Promise<AppEnvRow> {
	const deps = maintenanceDeps(c)
	const target = { appId: row.app_id, env: row.env }
	const mode = await recordedMaintenance(deps, target)
	let recorded = row
	let owned = false
	if (row.suspended_at === null) {
		const record = await recordSuspension(c, row, { at: now, fromMode: restorableMode(mode) })
		recorded = record.row
		owned = record.owned
	} else if (mode === 'closed') {
		return row
	}
	const outcome = await startMaintenance(deps, { ...target, mode: 'closed', actor: runActor(c.auth) })
	if (outcome.kind === 'busy' || outcome.kind === 'refused') {
		// Nothing changed the object: the call that wrote the record removes it; a concurrent one's stays with its close.
		if (owned) await clearSuspension(c, recorded)
		dataOperationResult(outcome)
	}
	const operation = dataOperationResult(outcome)
	await c.auth.audit({
		action: 'app.env.suspend',
		resourceType: 'app_env',
		resourceId: `${row.app_id}/${row.env}`,
		metadata: { mode: 'closed', operationId: operation.id, state: operation.state },
	})
	if (operation.state !== 'succeeded') fail(502, objectUnsettled(operation.id, operation.state, 'closed'))
	return recorded
}

async function resumeObject(c: SuspensionUseCaseContext, row: AppEnvRow): Promise<AppEnvRow> {
	const deps = maintenanceDeps(c)
	if (row.suspended_at === null) fail(409, `app env ${row.app_id}/${row.env} is not suspended`)
	const target = { appId: row.app_id, env: row.env }
	const restored: OpsMode = row.suspended_from_mode ?? 'open'
	const operation = (await recordedMaintenance(deps, target)) === restored
		? null
		: dataOperationResult(await startMaintenance(deps, { ...target, mode: restored, actor: runActor(c.auth) }))
	await c.auth.audit({
		action: 'app.env.resume',
		resourceType: 'app_env',
		resourceId: `${row.app_id}/${row.env}`,
		metadata: { mode: restored, operationId: operation?.id ?? null, ...(operation === null ? {} : { state: operation.state }) },
	})
	// The record stays until the object serves again, so a retry still knows the mode to restore.
	if (operation !== null && operation.state !== 'succeeded') fail(502, objectUnsettled(operation.id, operation.state, restored))
	return clearSuspension(c, row)
}

function maintenanceDeps(
	c: SuspensionUseCaseContext,
): { repositories: SuspensionUseCaseContext['repositories']; lock: DeployLocks; ops: OpsTransport } {
	if (c.maintenance === undefined) fail(409, `a ${c.provider.id} environment cannot be taken offline from Control here`)
	return { repositories: c.repositories, lock: c.maintenance.lock, ops: c.maintenance.ops }
}

/** Only an object that serves can be suspended; `resume` returns it to exactly this mode. */
function restorableMode(mode: OpsMode | 'unsettled'): 'open' | 'read-only' {
	if (mode === 'open' || mode === 'read-only') return mode
	if (mode === 'unsettled') fail(409, 'an operation of this environment is still running or did not finish: recover it first')
	fail(409, `the environment is already in maintenance \`${mode}\`, so it serves no ordinary request`)
}

function objectUnsettled(operationId: string, state: string, mode: OpsMode): string {
	return `the environment's object did not acknowledge \`${mode}\`: operation ${operationId} is ${state}; recover it, then try again`
}

/**
 * Record a first suspension. `owned` is false when a concurrent call recorded one first; the answer is then the row it
 * wrote, and this call proceeds as a retry of it.
 */
async function recordSuspension(
	c: SuspensionUseCaseContext,
	row: AppEnvRow,
	suspension: { readonly at: number; readonly fromMode: 'open' | 'read-only' | null },
): Promise<{ readonly row: AppEnvRow; readonly owned: boolean }> {
	const updated = await c.repositories.registry.setAppEnvSuspension(row.app_id, row.env, suspension, null)
	if (updated !== null) return { row: updated, owned: true }
	return { row: await requireAppEnv(c, row.app_id, row.env), owned: false }
}

/** Clear the suspension `row` holds; one a concurrent call already cleared or replaced is left as that call wrote it. */
async function clearSuspension(c: SuspensionUseCaseContext, row: AppEnvRow): Promise<AppEnvRow> {
	const updated = await c.repositories.registry.setAppEnvSuspension(row.app_id, row.env, null, row.suspended_at)
	return updated ?? requireAppEnv(c, row.app_id, row.env)
}
