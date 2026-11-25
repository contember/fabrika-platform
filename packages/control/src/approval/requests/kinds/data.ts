// The `data` kinds Control executes itself (ADR-0083 §1, §8): an environment's daily backups switched on or off.
// Suspending and resuming, a maintenance mode and a restore reach the environment's object or its namespace proxy, so
// they are not requestable in this release.

import { CONTROL_ACTIONS } from '@fabrika/control-contract'
import { z } from 'zod'
import { setBackupScheduleUseCase } from '../../../api/backup-schedule'
import { dailyBackups } from '../../../backups'
import { requestKind, type RequestKindContext } from '../kind'
import { appIdField, envField, observed, outcomeOf, ownText } from './shared'

const scheduleInput = z.object({ appId: appIdField, env: envField, daily: z.boolean() })
type ScheduleInput = z.infer<typeof scheduleInput>

/** What a schedule write binds: the environment, and whether it takes daily backups now. */
const scheduleBefore = z.object({ generation: z.number(), daily: z.boolean() })
type ScheduleBefore = z.infer<typeof scheduleBefore>

async function dailyNow(c: RequestKindContext, input: ScheduleInput): Promise<boolean> {
	return dailyBackups(await c.repositories.backups.getSchedule(input.appId, input.env))
}

export const setBackupScheduleKind = requestKind<ScheduleInput, ScheduleBefore>({
	kind: 'data.backups.setSchedule',
	category: 'data',
	input: scheduleInput,
	before: scheduleBefore,
	coordinates: (input) => ({ appId: input.appId, env: input.env }),
	requesterAction: CONTROL_ACTIONS.DATA_MANAGE,
	captureBefore: async (c, input) => ({
		generation: (await c.repositories.registry.getAppEnv(input.appId, input.env))?.generation ?? 0,
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
			{ label: 'Now', value: ownText(before.daily ? 'daily backups on' : 'daily backups off') },
			...(input.daily ? [] : [{ label: 'Kept', value: ownText('the backup before each migration still runs') }]),
		],
	}),
})
