// The `data` kinds (ADR-0083 §1, §8): an environment's daily backups switched on or off, its suspension and resumption,
// a maintenance mode or a side restore (`data.start`) and the recovery of a stuck operation (`data.recover`). An
// operation of the environment's object runs under the request's operation id and the lease its execution holds, so it
// records its own steps (ADR-0069) and `follow` reads the request's outcome from that record. Behind a namespace proxy
// a suspension is the registry's record and a republish.

import type { ApplicationObjects } from '@fabrika/auth-core'
import { type ApprovalRequestDescription, CONTROL_ACTIONS, DATA_OPERATION_RESOLUTIONS } from '@fabrika/control-contract'
import type { JsonValue } from '@fabrika/provider-contract'
import { z } from 'zod'
import { setBackupScheduleUseCase } from '../../../api/backup-schedule'
import { type DataUseCaseContext, recoverDataOperationUseCase, startDataOperationUseCase } from '../../../api/data-operations'
import { fail } from '../../../api/domain'
import { resumeAppEnvUseCase, suspendAppEnvUseCase, type SuspensionUseCaseContext } from '../../../api/registry/suspension'
import { dailyBackups } from '../../../backups'
import { recordedMaintenance, recordedObjects, toDataOperationDto } from '../../../data-operations'
import type { DataOperationRow } from '../../../db'
import {
	type RequestActionContext,
	type RequestExecution,
	type RequestExecutionContext,
	type RequestKind,
	requestKind,
	type RequestKindContext,
	type RequestOutcome,
} from '../kind'
import { appIdField, envField, observed, outcomeOf, ownText, registryContext } from './shared'

const scheduleInput = z.object({ appId: appIdField, env: envField, daily: z.boolean() })
type ScheduleInput = z.infer<typeof scheduleInput>

/** What a schedule write binds: the environment, and whether it takes daily backups now. */
const scheduleBefore = z.object({ generation: z.number(), daily: z.boolean() })
type ScheduleBefore = z.infer<typeof scheduleBefore>

async function dailyNow(c: RequestKindContext, input: ScheduleInput): Promise<boolean> {
	return dailyBackups(await c.repositories.backups.getSchedule(input.appId, input.env))
}

async function generationOf(c: RequestKindContext, appId: string, env: string): Promise<number> {
	return (await c.repositories.registry.getAppEnv(appId, env))?.generation ?? 0
}

export const setBackupScheduleKind = requestKind<ScheduleInput, ScheduleBefore>({
	kind: 'data.backups.setSchedule',
	category: 'data',
	input: scheduleInput,
	before: scheduleBefore,
	coordinates: (input) => ({ appId: input.appId, env: input.env }),
	requesterAction: CONTROL_ACTIONS.DATA_MANAGE,
	captureBefore: async (c, input) => ({
		generation: await generationOf(c, input.appId, input.env),
		daily: await dailyNow(c, input),
	}),
	execute: (c, input) =>
		outcomeOf(async () => {
			const schedule = await setBackupScheduleUseCase(c, input)
			return { appId: schedule.appId, env: schedule.env, daily: schedule.daily }
		}),
	follow: async (c, input) => observed((await dailyNow(c, input)) === input.daily, { appId: input.appId, env: input.env, daily: input.daily }),
	describe: (input, before) => ({
		summary: [ownText(`${input.daily ? 'Take' : 'Stop taking'} daily backups of ${input.appId}@${input.env}`)],
		facts: [
			...(before === null ? [] : [{ label: 'Now', value: ownText(before.daily ? 'daily backups on' : 'daily backups off') }]),
			...(input.daily ? [] : [{ label: 'Kept', value: ownText('the backup before each migration still runs') }]),
		],
	}),
})

/** The operation an execution records under its own operation id, under the lease it holds. */
function heldOperation(execution: RequestExecution): { readonly id: string; readonly lease: RequestExecution['lease'] } {
	return { id: execution.operationId, lease: execution.lease }
}

const NO_OPERATION = 'no operation was recorded, so nothing reached the environment; ask again'

const environmentInput = z.object({ appId: appIdField, env: envField })
type EnvironmentInput = z.infer<typeof environmentInput>

/**
 * What a suspension or resumption binds: the environment, whether and since when it is suspended, the namespace whose
 * proxy routes it, and the mode Control's record leaves its object in.
 */
const suspensionBefore = z.object({
	generation: z.number(),
	suspendedAt: z.number().nullable(),
	namespaceId: z.string().nullable(),
	mode: z.string(),
})
type SuspensionBefore = z.infer<typeof suspensionBefore>

function suspensionContext(c: RequestExecutionContext, execution: RequestExecution): SuspensionUseCaseContext {
	return {
		...registryContext(c, execution),
		...(c.maintenance === undefined ? {} : { maintenance: c.maintenance }),
		held: heldOperation(execution),
	}
}

/**
 * Settle an interrupted suspension or resumption: by its operation of the environment's object where one was recorded,
 * which the maintenance pass carries on while it runs; behind a namespace proxy by the registry's record, which the
 * republish follows. Without the provider the sweep cannot tell the two apart.
 */
async function followSuspension(
	c: RequestKindContext,
	input: EnvironmentInput,
	execution: RequestExecution,
	suspend: boolean,
): Promise<RequestOutcome | { readonly state: 'unknown' }> {
	const result = { appId: input.appId, env: input.env, suspended: suspend }
	const appEnv = await c.repositories.registry.getAppEnv(input.appId, input.env)
	if (appEnv === null) return { state: 'failed', error: 'the environment no longer exists' }
	const recorded = appEnv.suspended_at !== null
	const operation = await c.repositories.dataOperations.get(execution.operationId)
	if (operation !== null) {
		if (operation.state === 'running') return { state: 'unknown' }
		if (operation.state === 'failed') {
			return {
				state: 'failed',
				error: `the environment's object did not acknowledge \`${operation.target_mode}\`: operation ${operation.id} failed; recover it`,
			}
		}
		if (!suspend && recorded) {
			return { state: 'failed', error: 'the object serves again, but Control still records the suspension; resume again to clear it' }
		}
		return { state: 'executed', result }
	}
	if (c.provider === undefined) return { state: 'unknown' }
	if (c.provider.namespaces?.republish !== undefined) return observed(recorded === suspend, result)
	if (!suspend && !recorded) return { state: 'executed', result }
	return {
		state: 'failed',
		error: suspend
			? `${NO_OPERATION}: the object still serves, though Control may have recorded the suspension; suspend again, or resume`
			: `${NO_OPERATION}: the object is still offline; resume again`,
	}
}

function suspensionKind(kind: 'apps.environments.suspend' | 'apps.environments.resume'): RequestKind {
	const suspend = kind === 'apps.environments.suspend'
	return requestKind<EnvironmentInput, SuspensionBefore>({
		kind,
		category: 'data',
		input: environmentInput,
		before: suspensionBefore,
		coordinates: (input) => ({ appId: input.appId, env: input.env }),
		requesterAction: CONTROL_ACTIONS.APP_MANAGE,
		requesterAt: 'app',
		captureBefore: async (c, input) => {
			const appEnv = (await c.repositories.registry.getAppEnv(input.appId, input.env)) ?? fail(404, 'app env not found')
			return {
				generation: appEnv.generation,
				suspendedAt: appEnv.suspended_at,
				namespaceId: appEnv.namespace_id,
				mode: await recordedMaintenance(c, input),
			}
		},
		execute: (c, input, execution) =>
			outcomeOf(async () => {
				const context = suspensionContext(c, execution)
				const now = Math.floor(Date.now() / 1000)
				const row = suspend
					? await suspendAppEnvUseCase(context, input.appId, input.env, now)
					: await resumeAppEnvUseCase(context, input.appId, input.env)
				return { appId: row.appId, env: row.env, suspended: row.suspendedAt !== undefined }
			}),
		follow: (c, input, execution) => followSuspension(c, input, execution, suspend),
		describe: (input, before) => ({
			summary: [ownText(suspend ? `Take ${input.appId}@${input.env} offline` : `Bring ${input.appId}@${input.env} back online`)],
			facts: before === null
				? []
				: [{
					label: 'Now',
					value: ownText(before.suspendedAt === null ? 'online' : `offline since ${new Date(before.suspendedAt * 1000).toISOString()}`),
				}],
		}),
	})
}

export const suspendAppEnvKind = suspensionKind('apps.environments.suspend')
export const resumeAppEnvKind = suspensionKind('apps.environments.resume')

/** `data.start` as its procedure takes it, read without `.strict()` so a stored row parses again. */
const startInput = z.discriminatedUnion('kind', [
	z.object({ appId: appIdField, env: envField, kind: z.literal('maintenance'), mode: z.enum(['open', 'read-only', 'closed', 'inspect']) }),
	z.object({ appId: appIdField, env: envField, kind: z.literal('backup') }),
	z.object({ appId: appIdField, env: envField, kind: z.literal('restore'), at: z.string().datetime({ offset: true }) }),
])
type StartInput = z.infer<typeof startInput>

const recoverInput = z.object({ appId: appIdField, env: envField, operationId: z.string().min(1), resolution: z.enum(DATA_OPERATION_RESOLUTIONS) })
type RecoverInput = z.infer<typeof recoverInput>

/** What each resolution does, in an approval request's summary. */
const RESOLUTION_TEXT: Readonly<Record<RecoverInput['resolution'], string>> = {
	resume: 'resume it from its recorded step',
	open: 'open the object past it',
	rollback: 'roll the failed migration back with a fresh deploy of the last succeeded commit, then open the object',
}

const objectsField = z.object({ serving: z.string(), listed: z.array(z.string()) })

/** What a data operation binds: the environment, and the object serving it with the object list (a restore adds a clone). */
const operationBefore = z.object({ generation: z.number(), objects: objectsField })
type OperationBefore = z.infer<typeof operationBefore>

/** A recovery binds the state of the operation it recovers too. */
const recoveryBefore = operationBefore.extend({ recovers: z.string().nullable() })
type RecoveryBefore = z.infer<typeof recoveryBefore>

function objectsOf(objects: ApplicationObjects): z.infer<typeof objectsField> {
	return { serving: objects.object, listed: [...objects.objects] }
}

async function operationBeforeOf(c: RequestKindContext, input: { readonly appId: string; readonly env: string }): Promise<OperationBefore> {
	return { generation: await generationOf(c, input.appId, input.env), objects: objectsOf(await recordedObjects(c, input)) }
}

function dataContext(c: RequestExecutionContext, execution: RequestExecution): DataUseCaseContext {
	return {
		repositories: c.repositories,
		auth: c.auth,
		...(c.maintenance === undefined ? {} : { lock: c.maintenance.lock, ops: c.maintenance.ops }),
		...(c.deploys === undefined ? {} : { deploys: c.deploys }),
		held: heldOperation(execution),
	}
}

/** Refuse, when it is asked for, an operation this Control could not run at all. */
function requireOperations(c: RequestActionContext): void {
	if (c.maintenance === undefined) fail(503, 'data operations unavailable')
}

/** The request's outcome is that its operation was recorded; the operation's own record carries the rest. */
async function followOperation(c: RequestKindContext, execution: RequestExecution): Promise<RequestOutcome> {
	const operation = await c.repositories.dataOperations.get(execution.operationId)
	return operation === null ? { state: 'failed', error: NO_OPERATION } : { state: 'executed', result: operationResult(operation) }
}

function operationResult(operation: DataOperationRow): JsonValue {
	const dto = toDataOperationDto(operation)
	return { id: dto.id, kind: dto.kind, state: dto.state, step: dto.step, targetMode: dto.targetMode, errorCode: dto.errorCode }
}

function objectFacts(before: OperationBefore | null): ApprovalRequestDescription['facts'] {
	if (before === null) return []
	return [
		{ label: 'Serving object', value: ownText(before.objects.serving) },
		{ label: 'Objects', value: ownText(before.objects.listed.join(', ')) },
	]
}

export const startDataOperationKind = requestKind<StartInput, OperationBefore>({
	kind: 'data.start',
	category: 'data',
	input: startInput,
	before: operationBefore,
	coordinates: (input) => ({ appId: input.appId, env: input.env }),
	requesterAction: CONTROL_ACTIONS.DATA_MANAGE,
	admit: (c, input) => {
		if (input.kind === 'backup') fail(501, 'backups are not available in this release')
		requireOperations(c)
		if (input.kind === 'restore') {
			if (c.deploys === undefined) fail(503, 'restores are unavailable: this composition does not deploy from a data operation')
			if (!(Date.parse(input.at) < Date.now())) fail(400, 'the restore time must lie in the past')
		}
		return Promise.resolve()
	},
	captureBefore: operationBeforeOf,
	execute: (c, input, execution) =>
		outcomeOf(async () => {
			const started = await startDataOperationUseCase(dataContext(c, execution), input)
			return {
				id: started.id,
				kind: started.kind,
				state: started.state,
				step: started.step,
				targetMode: started.targetMode,
				errorCode: started.errorCode,
			}
		}),
	follow: (c, _input, execution) => followOperation(c, execution),
	describe: (input, before) => {
		if (input.kind === 'restore') {
			return {
				summary: [ownText(`Restore the data of ${input.appId}@${input.env} as of ${input.at}, beside the original`)],
				facts: [
					{ label: 'As of', value: ownText(input.at) },
					...objectFacts(before),
					{ label: 'Kept', value: ownText('the original is frozen and kept for an operator to read; ordinary traffic moves to the restored copy') },
				],
			}
		}
		const mode = input.kind === 'maintenance' ? input.mode : 'backup'
		return {
			summary: [ownText(`Put ${input.appId}@${input.env} into maintenance \`${mode}\``)],
			facts: [{ label: 'Mode', value: ownText(mode) }, ...objectFacts(before)],
		}
	},
})

export const recoverDataOperationKind = requestKind<RecoverInput, RecoveryBefore>({
	kind: 'data.recover',
	category: 'data',
	input: recoverInput,
	before: recoveryBefore,
	coordinates: (input) => ({ appId: input.appId, env: input.env }),
	requesterAction: CONTROL_ACTIONS.DATA_MANAGE,
	admit: async (c, input) => {
		requireOperations(c)
		const operation = await c.repositories.dataOperations.get(input.operationId)
		if (operation === null || operation.app_id !== input.appId || operation.env !== input.env) {
			fail(409, 'that operation is not one this environment can recover')
		}
	},
	captureBefore: async (c, input) => ({
		...(await operationBeforeOf(c, input)),
		recovers: (await c.repositories.dataOperations.get(input.operationId))?.state ?? null,
	}),
	execute: (c, input, execution) =>
		outcomeOf(async () => {
			const recovered = await recoverDataOperationUseCase(dataContext(c, execution), input)
			return {
				id: recovered.id,
				kind: recovered.kind,
				state: recovered.state,
				step: recovered.step,
				targetMode: recovered.targetMode,
				errorCode: recovered.errorCode,
			}
		}),
	follow: (c, _input, execution) => followOperation(c, execution),
	describe: (input, before) => ({
		summary: [
			ownText(
				`Recover operation ${input.operationId} of ${input.appId}@${input.env}: ${RESOLUTION_TEXT[input.resolution]}`,
			),
		],
		facts: [
			...(before === null ? [] : [{ label: 'Operation now', value: ownText(before.recovers ?? 'not found') }]),
			...objectFacts(before),
		],
	}),
})
