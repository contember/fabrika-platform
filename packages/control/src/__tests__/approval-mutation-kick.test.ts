// A mutation's `then` in the conservative access diff: it kicks a cron job of the same approved contract, which runs
// under its own declared actions, so declaring, moving or dropping it shows a line, widens nothing and is no deviation.
// Only a 0.5 application declares `then`, so each snapshot is its commit read by that release's reader.

import { describe, expect, test } from 'bun:test'
import { classifyAccess, snapshotDeviations } from '../approval/diff'
import type { AccessSnapshot } from '../approval/snapshot'
import { snapshot05 } from './helpers/contracts'
import { kitFiles } from './helpers/kit-contract'

const JOBS = `import { app } from './app-kit'

export const digest = app.cron('0 3 * * *', { actions: ['notes.read'], scope: 'app' }).handle(async () => {})
export const weekly = app.cron('0 4 * * 1', { actions: ['notes.read'], scope: 'app' }).handle(async () => {})
`

const CONTRACT = `import { app } from './src/app-kit'
import { digest, weekly } from './src/jobs'
import { notes } from './src/notes/endpoints'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { notes }),
	health: c.health('/healthz'),
	jobs: { digest, weekly },
}))
`

function snapshot(then: 'digest' | 'weekly' | null): AccessSnapshot {
	const { 'fabrika.contract.ts': _contract, ...files } = kitFiles(then === null ? {} : { retitle: `then: '${then}'` })
	return snapshot05(CONTRACT, undefined, { ...files, 'src/jobs.ts': JOBS })
}

describe("a mutation's then in the approval diff", () => {
	test('a new then is shown and widens nothing, and is no deviation', () => {
		expect(classifyAccess(snapshot(null), snapshot('digest'))).toEqual({
			outcome: 'no-widening',
			changes: [{ effect: 'neutral', line: 'Endpoint `api.notes.retitle` starts job `digest` after each committed call, beside its schedule' }],
		})
		expect(snapshotDeviations(snapshot('digest'))).toEqual([])
	})

	test('another job, or none, is shown and widens nothing', () => {
		expect(classifyAccess(snapshot('digest'), snapshot('weekly')).changes).toEqual([
			{ effect: 'neutral', line: 'Endpoint `api.notes.retitle` starts job `weekly` after each committed call, beside its schedule' },
		])
		expect(classifyAccess(snapshot('digest'), snapshot(null))).toEqual({
			outcome: 'no-widening',
			changes: [{ effect: 'neutral', line: 'Endpoint `api.notes.retitle` no longer starts job `digest` after a call' }],
		})
	})
})
