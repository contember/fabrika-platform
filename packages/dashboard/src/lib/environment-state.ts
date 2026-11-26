import type { OpsView } from '@fabrika/control-contract'
import type { Lamp } from '../components/Status'
import { ApiError, type AppEnvDto, type createControlClient, type DataOperationDto } from './api'

type ControlClient = ReturnType<typeof createControlClient>

/**
 * What an environment's state lamp says, worst first: Control took it offline, a data operation runs or failed, the
 * application failed to boot, it admits less than everything, it serves. An environment whose provider has no ops channel
 * (ADR-0069) has only Control's own facts; one the caller may not read, or that did not answer, says so.
 */
export type EnvironmentState =
	| { readonly kind: 'reading' }
	| { readonly kind: 'suspended'; readonly at: number }
	| { readonly kind: 'operation'; readonly operation: DataOperationDto }
	| { readonly kind: 'boot-failure'; readonly at: string }
	| { readonly kind: 'mode'; readonly mode: OpsView['maintenance']['mode'] }
	| { readonly kind: 'serving'; readonly published: boolean; readonly source: 'object' | 'control' }
	| { readonly kind: 'unknown'; readonly reason: 'not-allowed' | 'unavailable' }

/** The newest operation, while it runs or once it failed: the one a person recovers (`recoveryChoice` on the data page). */
function stuckOperation(operations: readonly DataOperationDto[]): DataOperationDto | null {
	const [newest] = operations
	return newest !== undefined && (newest.state === 'running' || newest.state === 'failed') ? newest : null
}

/** The state from what Control and the environment's object answered; `view` is null without an ops channel. */
export function environmentState(
	env: Pick<AppEnvDto, 'suspendedAt' | 'publishedRunId'>,
	view: Pick<OpsView, 'maintenance' | 'bootFailure'> | null,
	operations: readonly DataOperationDto[],
): EnvironmentState {
	if (env.suspendedAt !== undefined) return { kind: 'suspended', at: env.suspendedAt }
	const stuck = stuckOperation(operations)
	if (stuck !== null) return { kind: 'operation', operation: stuck }
	if (view === null) return { kind: 'serving', published: env.publishedRunId !== null, source: 'control' }
	if (view.bootFailure !== null) return { kind: 'boot-failure', at: view.bootFailure.at }
	if (view.maintenance.mode !== 'open') return { kind: 'mode', mode: view.maintenance.mode }
	return { kind: 'serving', published: env.publishedRunId !== null, source: 'object' }
}

type Read<T> = { readonly kind: 'ok'; readonly value: T } | { readonly kind: 'no-channel' | 'not-allowed' | 'unavailable' }

async function read<T>(call: () => Promise<T>): Promise<Read<T>> {
	try {
		return { kind: 'ok', value: await call() }
	} catch (cause) {
		if (!(cause instanceof ApiError)) return { kind: 'unavailable' }
		if (cause.httpStatus === 403 || cause.httpStatus === 404) return { kind: 'not-allowed' }
		if (cause.httpStatus === 409) return { kind: 'no-channel' }
		return { kind: 'unavailable' }
	}
}

/**
 * Read one environment's state: Control's newest data operation and the object's view, which is a live call to the
 * application object. A caller without `data.read` there gets `unknown`; Control decides that, not this.
 */
export async function readEnvironmentState(
	client: ControlClient,
	env: Pick<AppEnvDto, 'appId' | 'env' | 'suspendedAt' | 'publishedRunId'>,
): Promise<EnvironmentState> {
	if (env.suspendedAt !== undefined) return { kind: 'suspended', at: env.suspendedAt }
	const at = { appId: env.appId, env: env.env }
	const [view, operations] = await Promise.all([read(() => client.data.view(at)), read(() => client.data.operations.list({ ...at, limit: 1 }))])
	if (view.kind === 'not-allowed' || operations.kind === 'not-allowed') return { kind: 'unknown', reason: 'not-allowed' }
	if (view.kind === 'unavailable') return { kind: 'unknown', reason: 'unavailable' }
	return environmentState(env, view.kind === 'ok' ? view.value : null, operations.kind === 'ok' ? operations.value.items : [])
}

export function stateLamp(state: EnvironmentState): Lamp {
	switch (state.kind) {
		case 'serving':
			return state.published ? 'ok' : 'idle'
		case 'operation':
			return state.operation.state === 'running' ? 'run' : 'stop'
		case 'reading':
		case 'unknown':
			return 'idle'
		default:
			return 'stop'
	}
}

export function stateLabel(state: EnvironmentState): string {
	switch (state.kind) {
		case 'reading':
			return 'Reading…'
		case 'suspended':
			return 'Offline'
		case 'operation':
			return state.operation.state === 'running' ? `${operationName(state.operation)} running` : `${operationName(state.operation)} failed`
		case 'boot-failure':
			return 'Fails to boot'
		case 'mode':
			return state.mode === 'read-only' ? 'Read-only' : state.mode === 'closed' ? 'Closed' : 'Inspect only'
		case 'serving':
			// Without an ops channel only Control's facts are known: published, not whether the object admits everything.
			return !state.published ? 'Not published' : state.source === 'object' ? 'Open' : 'Published'
		case 'unknown':
			return state.reason === 'not-allowed' ? 'State not readable' : 'State unavailable'
	}
}

/** Whether the state asks a person to act on the environment's data: the Data tab carries a lamp for it. */
export function needsDataAttention(state: EnvironmentState): boolean {
	return state.kind === 'operation' || state.kind === 'boot-failure' || state.kind === 'mode'
}

function operationName(operation: DataOperationDto): string {
	switch (operation.kind) {
		case 'restore':
			return 'Restore'
		case 'maintenance':
			return 'Maintenance'
		case 'backup':
			return 'Backup'
		case 'migrate':
			return 'Migration'
		case 'recovery':
			return 'Recovery'
	}
}
