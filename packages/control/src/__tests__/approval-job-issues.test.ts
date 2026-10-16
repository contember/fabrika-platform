// A cron job's `issues: '<link mount>'` (WU15) in the conservative access diff: a job that starts issuing share links
// widens with closer review, keyed by the job as an endpoint's is keyed by its id; stopping narrows.

import { compileContract, defineApp } from '@fabrika/app/contract'
import { describe, expect, test } from 'bun:test'
import { tables } from '../../../app/src/__tests__/kit-fixture/src/db/tables'
import { shared } from '../../../app/src/__tests__/kit-fixture/src/shared'
import { vocabulary } from '../../../app/src/__tests__/kit-fixture/src/vocabulary'
import { classifyAccess, snapshotDeviations } from '../approval/diff'
import type { AccessSnapshot } from '../approval/snapshot'

const app = defineApp(vocabulary, tables)

function snapshot(issues: boolean): AccessSnapshot {
	const actions = ['crm.read', 'deals.share'] as const
	const invite = issues
		? app.cron('* * * * *', { actions, scope: 'app', issues: 'shared' }).handle(async () => {})
		: app.cron('* * * * *', { actions, scope: 'app' }).handle(async () => {})
	const contract = app.contract(() => ({ shared, jobs: { invite } }))
	return { version: 1, contract: compileContract(contract, tables), migrations: [], checker: '0.0.0' }
}

const LINE = 'Job `invite` issues share links of mount `shared`'
const STEP = 'issues share links of mount `shared`'

describe("a job's issues in the approval diff", () => {
	test('a job that starts issuing widens with closer review, and the environment lists it as a deviation', () => {
		const classification = classifyAccess(snapshot(false), snapshot(true))
		expect(classification).toEqual({ outcome: 'widening', changes: [{ widens: true, line: LINE, review: 'closer' }] })
		expect(snapshotDeviations(snapshot(true))).toEqual([{ subject: 'Job `invite`', steps: [STEP] }])
	})

	test('a job that stops issuing narrows', () => {
		expect(classifyAccess(snapshot(true), snapshot(false))).toEqual({
			outcome: 'removal',
			changes: [{ widens: false, line: 'Job `invite` no longer issues share links of mount `shared`' }],
		})
	})
})
