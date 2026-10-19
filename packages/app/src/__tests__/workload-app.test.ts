// `ctx.app('<action>')` and `ctx.db.app('<action>')` of a workload site: a job mints an application-wide capability for
// a declared action its IAM token carries, and reaches the application tables through it, outside its transaction to
// read and inside it to write; outside it the types refuse a write. A webhook bound to a dimension holds none. Through the test kit and a REAL Postgres, over
// the app-wide fixture; skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset.

import { createClient } from '@fabrika/app/client'
import type { App, Declared, JobKitContext, JobTransaction, KitTypes, Unavailable, WebhookKitContext } from '@fabrika/app/contract'
import { type AppCapability, serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { scoped } from '@fabrika/db'
import { testDatabase } from '@fabrika/db/testing'
import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { admin } from './app-wide-fixture/src/admin/endpoints'
import { app } from './app-wide-fixture/src/app-kit'
import { tables } from './app-wide-fixture/src/db/tables'

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T
type Kit = typeof app extends App<infer K extends KitTypes> ? K : never
type Reached<H> = { [P in keyof H]: H[P] extends Unavailable<string> ? never : P }[keyof H]
type Job = JobKitContext<Kit, 'positions.read' | 'positions.manage', Declared<never, never, never, never>>
type Tx = JobTransaction<Kit, 'positions.read' | 'positions.manage', Declared<never, never, never, never>>
type Hook = WebhookKitContext<Kit, 'candidate', 'candidates.read', Declared<never, never, never, never>>

/** A job mints `ctx.app` for its declared actions only, and `ctx.db.app` holds what that action reaches. */
export type WorkloadAppContext = [
	Expect<Equal<ReturnType<Job['app']>, AppCapability<'positions.read' | 'positions.manage'>>>,
	Expect<Equal<Parameters<Job['app']>[0], 'positions.read' | 'positions.manage'>>,
	Expect<Equal<Parameters<Job['db']['app']>[0], 'positions.read' | 'positions.manage'>>,
	Expect<'positions' extends Reached<ReturnType<Job['db']['app']>> ? true : false>,
	Expect<ReturnType<Job['db']['app']>['positions']['insert'] extends Unavailable<string> ? true : false>,
	Expect<Equal<Parameters<Tx['db']['app']>[0], 'positions.read' | 'positions.manage'>>,
	Expect<Hook['app'] extends Unavailable<string> ? true : false>,
	Expect<Hook['db']['app'] extends Unavailable<string> ? true : false>,
]

const fixtureRoot = join(import.meta.dir, 'app-wide-fixture')
const postgres = await testDatabase({ migrations: join(fixtureRoot, 'db', 'migrations'), label: 'workload-app.test.ts' })

afterAll(async () => {
	await postgres?.close()
})

const seen: { title?: string; listed?: boolean; action?: string } = {}

const open = app.cron('* * * * *', { actions: ['positions.read', 'positions.manage'] }).handle(async ({ ctx }) => {
	const title = `Opened by the job ${crypto.randomUUID()}`
	seen.action = ctx.app('positions.manage').action
	await ctx.transaction(async (tx) => {
		await tx.db.app('positions.manage').positions.insert({ title })
	})
	seen.title = title
	seen.listed = (await ctx.db.app('positions.read').positions.list()).items.some((row) => row.title === title)
})

const undeclared = app.cron('0 3 * * *', { actions: ['positions.read'] }).handle(({ ctx }) => {
	// The types refuse the action; at run time the runner refuses one the job does not declare.
	Reflect.apply(ctx.app, ctx, ['positions.manage'])
})

const contract = app.contract((c) => ({ api: c.rpc('/api', { admin }), jobs: { open, undeclared } }))

if (postgres !== null) {
	const kit = testKit(serve(contract, { database: scoped(tables) }), { database: postgres.database })
	const staff = createClient(contract, 'api', { fetch: kit.browser(kit.testCaller([{ action: 'positions.read' }])) })

	describe('ctx.app and ctx.db.app of a job', () => {
		test('a job writes an application table in its transaction and reads it outside, by its declared actions', async () => {
			expect(await kit.runJob('open')).toEqual({ status: 'succeeded', attempts: 1 })
			expect(seen.action).toBe('positions.manage')
			expect(seen.listed).toBe(true)
			expect((await staff.admin.positions()).items.some((item) => item.title === seen.title)).toBe(true)
		})

		test('an action the job does not declare is refused', async () => {
			expect(await kit.runJob('undeclared')).toMatchObject({ status: 'failed', code: 'capability_refused' })
		})
	})
} else {
	test.skip('ctx.app and ctx.db.app of a job (set FABRIKA_TEST_POSTGRES_URL)', () => {})
}
