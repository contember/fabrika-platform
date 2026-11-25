// `data.start` and `data.recover` (ADR-0069, ADR-0070): an operation of an environment's object, started directly by a
// person or a key the gate lets through, or by an approved request (ADR-0083 §8), which runs it under the lease it holds.

import type { AuthContext } from '@fabrika/auth'
import { CONTROL_ACTIONS, type DataOperationDto, type RecoverDataOperationInput, type StartDataOperationInput } from '@fabrika/control-contract'
import type { DeployLocks } from '@fabrika/platform'
import {
	type DataOperationDeps,
	type HeldOperation,
	type OperationDeploys,
	type OpsTransport,
	startMaintenance,
	startRecovery,
	startRestore,
} from '../data-operations'
import type { ControlRepositories } from '../db'
import { requireDataEnvironment } from './backup-schedule'
import { dataOperationResult } from './data-operation-result'
import { fail } from './domain'
import { runActor } from './runs'

export interface DataUseCaseContext {
	readonly repositories: ControlRepositories
	readonly auth: AuthContext
	/** The environment's deploy lease every operation runs under; absent, operations answer 503. */
	readonly lock?: DeployLocks
	/** The ops channel; absent, the views and operations answer 503. */
	readonly ops?: OpsTransport
	/** A restore's own deploys; absent, a restore is refused. */
	readonly deploys?: () => Promise<OperationDeploys>
	/** An approved request's execution: the operation is its operation, under the lease it holds. */
	readonly held?: HeldOperation
}

export async function startDataOperationUseCase(c: DataUseCaseContext, input: StartDataOperationInput): Promise<DataOperationDto> {
	await requireDataEnvironment(c, CONTROL_ACTIONS.DATA_MANAGE, input.appId, input.env)
	if (input.kind === 'backup') fail(501, 'backups are not available in this release')
	const held = c.held === undefined ? {} : { held: c.held }
	if (input.kind === 'restore') {
		const deps = await restoreDeps(c)
		return dataOperationResult(
			await startRestore(deps, { appId: input.appId, env: input.env, at: new Date(input.at).toISOString(), actor: runActor(c.auth), ...held }),
		)
	}
	const outcome = await startMaintenance(operationDeps(c), { appId: input.appId, env: input.env, mode: input.mode, actor: runActor(c.auth), ...held })
	return dataOperationResult(outcome)
}

/** A recovery may resume a restore, which deploys, so it carries the restore's deploys where the composition has them. */
export async function recoverDataOperationUseCase(c: DataUseCaseContext, input: RecoverDataOperationInput): Promise<DataOperationDto> {
	await requireDataEnvironment(c, CONTROL_ACTIONS.DATA_MANAGE, input.appId, input.env)
	const deps = c.deploys === undefined ? operationDeps(c) : await restoreDeps(c)
	return dataOperationResult(await startRecovery(deps, { ...input, actor: runActor(c.auth), ...(c.held === undefined ? {} : { held: c.held }) }))
}

function operationDeps(c: DataUseCaseContext): { repositories: ControlRepositories; lock: DeployLocks; ops: OpsTransport } {
	if (c.lock === undefined || c.ops === undefined) fail(503, 'data operations unavailable')
	return { repositories: c.repositories, lock: c.lock, ops: c.ops }
}

async function restoreDeps(c: DataUseCaseContext): Promise<DataOperationDeps> {
	const deps = operationDeps(c)
	if (c.deploys === undefined) fail(503, 'restores are unavailable: this composition does not deploy from a data operation')
	return { ...deps, deploys: await c.deploys() }
}
