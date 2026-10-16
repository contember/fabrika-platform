// A cron job's `mailer` in the conservative access diff: sending through the installation's transport reaches the
// installation's credentials and widens with closer review; the application's own transport widens; dropping either narrows.

import { compileContract, defineApp } from '@fabrika/app/contract'
import type { JobMailer } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { tables } from '../../../app/src/__tests__/kit-fixture/src/db/tables'
import { shared } from '../../../app/src/__tests__/kit-fixture/src/shared'
import { vocabulary } from '../../../app/src/__tests__/kit-fixture/src/vocabulary'
import { classifyAccess, snapshotDeviations } from '../approval/diff'
import type { AccessSnapshot } from '../approval/snapshot'

const app = defineApp(vocabulary, tables)

function snapshot(mailer: JobMailer | undefined): AccessSnapshot {
	const actions = ['crm.read'] as const
	const digest = mailer === undefined
		? app.cron('0 3 * * *', { actions, scope: 'app' }).handle(async () => {})
		: app.cron('0 3 * * *', { actions, scope: 'app', mailer }).handle(async () => {})
	const contract = app.contract(() => ({ shared, jobs: { digest } }))
	return { version: 1, contract: compileContract(contract, tables), migrations: [], checker: '0.0.0' }
}

const INSTALLATION = "Job `digest` sends e-mail through the installation's mail transport"
const OWN = 'Job `digest` sends e-mail through its own transport'

describe("a job's mailer in the approval diff", () => {
	test("a job that starts sending through the installation's transport widens with closer review, and is a deviation", () => {
		expect(classifyAccess(snapshot(undefined), snapshot('installation'))).toEqual({
			outcome: 'widening',
			changes: [{ widens: true, line: INSTALLATION, review: 'closer' }],
		})
		expect(classifyAccess(snapshot('own'), snapshot('installation'))).toEqual({
			outcome: 'widening',
			changes: [{ widens: true, line: INSTALLATION, review: 'closer' }],
		})
		expect(snapshotDeviations(snapshot('installation'))).toEqual([
			{ subject: 'Job `digest`', steps: ["sends e-mail through the installation's mail transport"] },
		])
	})

	test('a job that starts sending through its own transport widens', () => {
		expect(classifyAccess(snapshot(undefined), snapshot('own'))).toEqual({ outcome: 'widening', changes: [{ widens: true, line: OWN }] })
		expect(snapshotDeviations(snapshot('own'))).toEqual([{ subject: 'Job `digest`', steps: ['sends e-mail through its own transport'] }])
	})

	test("moving from the installation's transport to its own, or dropping mail, narrows", () => {
		expect(classifyAccess(snapshot('installation'), snapshot('own'))).toEqual({
			outcome: 'removal',
			changes: [{ widens: false, line: "Job `digest` sends e-mail through its own transport, no longer the installation's" }],
		})
		for (const before of ['installation', 'own'] as const) {
			expect(classifyAccess(snapshot(before), snapshot(undefined))).toEqual({
				outcome: 'removal',
				changes: [{ widens: false, line: 'Job `digest` no longer sends e-mail' }],
			})
		}
		expect(snapshotDeviations(snapshot(undefined))).toEqual([])
	})
})
