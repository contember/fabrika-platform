import type { AuthContext } from '@fabrika/auth'
import { CONTROL_ACTIONS, type DataBackupScheduleDto, type SetDataBackupScheduleInput } from '@fabrika/control-contract'
import { toBackupScheduleDto } from '../backups'
import type { ControlRepositories } from '../db'
import { fail } from './domain'
import { canAtCoordinates, runActor } from './runs'

/** What the data use cases of an environment read and act through, at the least. */
export interface DataEnvironmentContext {
	readonly repositories: ControlRepositories
	readonly auth: AuthContext
}

/** An environment the caller may act on with `action`; any other, existing or not, is the same 404. */
export async function requireDataEnvironment(c: DataEnvironmentContext, action: string, appId: string, env: string): Promise<void> {
	if (!canAtCoordinates(c.auth, action, appId, env) || (await c.repositories.registry.getAppEnv(appId, env)) === null) {
		fail(404, 'app env not found')
	}
}

/** Opting out stops the daily backup only; the pre-migration backup always runs (ADR-0070 §8). */
export async function setBackupScheduleUseCase(c: DataEnvironmentContext, input: SetDataBackupScheduleInput): Promise<DataBackupScheduleDto> {
	await requireDataEnvironment(c, CONTROL_ACTIONS.DATA_MANAGE, input.appId, input.env)
	const schedule = await c.repositories.backups.setSchedule(input.appId, input.env, input.daily, runActor(c.auth))
	await c.auth.audit({
		action: 'data.backups.schedule',
		resourceType: 'app_env',
		resourceId: `${input.appId}/${input.env}`,
		metadata: { appId: input.appId, env: input.env, daily: input.daily },
	})
	return toBackupScheduleDto(input, schedule)
}
