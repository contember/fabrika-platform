// A mutation's `then` in the conservative access diff: it kicks a cron job of the same approved contract, which runs
// under its own declared actions, so declaring, moving or dropping it shows a line, widens nothing and is no deviation.

import { compileContract, defineApp } from '@fabrika/app/contract'
import { describe, expect, test } from 'bun:test'
import { tables } from '../../../app/src/__tests__/kit-fixture/src/db/tables'
import { ById } from '../../../app/src/__tests__/kit-fixture/src/schemas'
import { vocabulary } from '../../../app/src/__tests__/kit-fixture/src/vocabulary'
import { classifyAccess, snapshotDeviations } from '../approval/diff'
import type { AccessSnapshot } from '../approval/snapshot'

const app = defineApp(vocabulary, tables)

const digest = app.cron('0 3 * * *', { actions: ['crm.read'], scope: 'app' }).handle(async () => {})
const weekly = app.cron('0 4 * * 1', { actions: ['crm.read'], scope: 'app' }).handle(async () => {})

const access = { action: 'deals.write', on: 'deal', from: 'id' } as const

// `then` takes one literal job name, so each variant spells its own.
const KICKS = {
	none: app.group({ callers: ['human'] }, (r) => ({
		touch: r.mutation({ input: ById, output: ById, access }).handle(({ ctx }) => ({ id: ctx.target.value })),
	})),
	digest: app.group({ callers: ['human'] }, (r) => ({
		touch: r.mutation({ input: ById, output: ById, access, then: 'digest' }).handle(({ ctx }) => ({ id: ctx.target.value })),
	})),
	weekly: app.group({ callers: ['human'] }, (r) => ({
		touch: r.mutation({ input: ById, output: ById, access, then: 'weekly' }).handle(({ ctx }) => ({ id: ctx.target.value })),
	})),
}

function snapshot(then: keyof typeof KICKS): AccessSnapshot {
	const kicks = KICKS[then]
	const contract = app.contract((c) => ({ api: c.rpc('/api', { kicks }), jobs: { digest, weekly } }))
	return { version: 1, contract: compileContract(contract, tables), migrations: [], checker: '0.0.0' }
}

describe("a mutation's then in the approval diff", () => {
	test('a new then is shown and widens nothing, and is no deviation', () => {
		expect(classifyAccess(snapshot('none'), snapshot('digest'))).toEqual({
			outcome: 'no-widening',
			changes: [{ effect: 'neutral', line: 'Endpoint `api.kicks.touch` starts job `digest` after each committed call, beside its schedule' }],
		})
		expect(snapshotDeviations(snapshot('digest'))).toEqual([])
	})

	test('another job, or none, is shown and widens nothing', () => {
		expect(classifyAccess(snapshot('digest'), snapshot('weekly')).changes).toEqual([
			{ effect: 'neutral', line: 'Endpoint `api.kicks.touch` starts job `weekly` after each committed call, beside its schedule' },
		])
		expect(classifyAccess(snapshot('digest'), snapshot('none'))).toEqual({
			outcome: 'no-widening',
			changes: [{ effect: 'neutral', line: 'Endpoint `api.kicks.touch` no longer starts job `digest` after a call' }],
		})
	})
})
