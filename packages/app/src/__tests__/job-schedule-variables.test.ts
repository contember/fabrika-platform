// Who schedules the jobs on Bun (ADR-0080): `FABRIKA_JOBS_SCHEDULE` and its generation as `serveContract` reads them.
// No backend: the process schedule itself runs in process-schedule.test.ts.

import { jobScheduleOf } from '@fabrika/app/bun'
import { isFrameworkVariableName } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { BootError } from '../implement/boot'

const GENERATION = '019a0000-0000-7000-8000-000000000001'

function refusal(framework: Readonly<Record<string, string>>): string {
	try {
		jobScheduleOf(framework)
	} catch (error) {
		expect(error).toBeInstanceOf(BootError)
		return error instanceof Error ? error.message : ''
	}
	throw new Error('the schedule was not refused')
}

describe('FABRIKA_JOBS_SCHEDULE', () => {
	test('unset or crontab: crontab schedules, as on Zerops', () => {
		expect(jobScheduleOf({})).toBeUndefined()
		expect(jobScheduleOf({ FABRIKA_JOBS_SCHEDULE: 'crontab' })).toBeUndefined()
		expect(jobScheduleOf({ FABRIKA_JOBS_SCHEDULE: '' })).toBeUndefined()
	})

	test('process with its generation: the serving process keeps the schedule as that deploy', () => {
		expect(jobScheduleOf({ FABRIKA_JOBS_SCHEDULE: 'process', FABRIKA_JOBS_SCHEDULE_GENERATION: GENERATION })).toEqual({ generation: GENERATION })
	})

	test('another mode, a process schedule without a lowercase UUID, or a generation alone stops the boot', () => {
		expect(refusal({ FABRIKA_JOBS_SCHEDULE: 'cron' })).toContain("is 'crontab' or 'process'")
		expect(refusal({ FABRIKA_JOBS_SCHEDULE: 'process' })).toContain('is not a lowercase UUID')
		expect(refusal({ FABRIKA_JOBS_SCHEDULE: 'process', FABRIKA_JOBS_SCHEDULE_GENERATION: GENERATION.toUpperCase() })).toContain(
			'is not a lowercase UUID',
		)
		expect(refusal({ FABRIKA_JOBS_SCHEDULE: 'process', FABRIKA_JOBS_SCHEDULE_GENERATION: 'later' })).toContain('is not a lowercase UUID')
		expect(refusal({ FABRIKA_JOBS_SCHEDULE_GENERATION: GENERATION })).toContain("is not 'process'")
		expect(refusal({ FABRIKA_JOBS_SCHEDULE: 'crontab', FABRIKA_JOBS_SCHEDULE_GENERATION: GENERATION })).toContain("is not 'process'")
	})

	test('a refusal quotes no value it read', () => {
		expect(refusal({ FABRIKA_JOBS_SCHEDULE: 'process', FABRIKA_JOBS_SCHEDULE_GENERATION: 'not-a-generation' })).not.toContain('not-a-generation')
	})

	test('both are framework variables, which an application never writes', () => {
		expect(isFrameworkVariableName('FABRIKA_JOBS_SCHEDULE')).toBe(true)
		expect(isFrameworkVariableName('FABRIKA_JOBS_SCHEDULE_GENERATION')).toBe(true)
	})
})
