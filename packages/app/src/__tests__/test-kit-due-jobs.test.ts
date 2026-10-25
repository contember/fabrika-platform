// The test kit's scheduler driver: `kit.runDueJobs({ within })` runs each job whose wake is due within the window,
// once, through the scheduler the Cloudflare object's alarm drives, and nothing fires without it. On SQLite (the object's
// storage) always, and on Postgres when FABRIKA_TEST_POSTGRES_URL is set.

import { createClient } from '@fabrika/app/client'
import { defineApp } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { applicationSchema, type Database, scoped } from '@fabrika/db'
import { frameworkTablesOf } from '@fabrika/db/framework'
import { FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'
import { openPostgres } from '@fabrika/db/postgres'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { SQL } from 'bun'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { tables } from './cloudflare-fixture/src/db/tables'
import { vocabulary } from './cloudflare-fixture/src/vocabulary'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** A daily cron fire `hoursAhead` from now, so its next fire lies just under that far ahead. */
function dailyAhead(hoursAhead: number): string {
	const fire = new Date(Date.now() + hoursAhead * HOUR)
	return `${fire.getUTCMinutes()} ${fire.getUTCHours()} * * *`
}

const app = defineApp(vocabulary, tables)

let runs: { readonly job: string; readonly attempt: number }[] = []
let failNext = false

const LATER = dailyAhead(2)

const later = app.cron(LATER, { actions: ['notes.read'] }).handle(({ ctx }) => {
	runs.push({ job: 'later', attempt: ctx.attempt })
})

const remind = app.cron(dailyAhead(12), { actions: ['notes.read'], retries: 1 }).handle(({ ctx }) => {
	runs.push({ job: 'remind', attempt: ctx.attempt })
	if (failNext) {
		failNext = false
		throw new Error('the reminder failed')
	}
})

const deliver = app.cron(dailyAhead(12), { actions: ['notes.read'] }).handle(({ ctx }) => {
	runs.push({ job: 'deliver', attempt: ctx.attempt })
})

const notes = app.group({ callers: ['human'] }, (r) => ({
	remindLater: r.mutation({
		input: z.strictObject({ workspaceId: z.string().min(1), title: z.string().min(1), at: z.number() }),
		output: z.strictObject({ id: z.uuid() }),
		access: { action: 'notes.write', in: 'workspace', from: 'workspaceId' },
		kicks: ['deliver'],
	})
		.handle(async ({ input, ctx }) => {
			const { id } = await ctx.db.target.notes.insert({ title: input.title })
			ctx.kick('deliver', { at: new Date(input.at) })
			return { id }
		}),
}))

const contract = app.contract((c) => ({ api: c.rpc('/api', { notes }), health: c.health('/healthz'), jobs: { later, remind, deliver } }))

const POSTGRES_TABLE = `create table notes (
	id text primary key,
	workspace_id text not null,
	title text not null,
	created_by text not null,
	version integer not null,
	unique (id, workspace_id)
);`

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
if (url === '') {
	console.warn(`test-kit-due-jobs.test.ts: set ${URL_VAR} to run the Postgres half as well`)
}

async function admin(statement: string): Promise<void> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		await sql.unsafe(statement)
	} finally {
		await sql.close()
	}
}

/** A migrated database of the driver, and what closes it. */
interface Fresh {
	readonly database: Database
	close(): Promise<void>
}

const drivers: readonly { readonly name: string; readonly enabled: boolean; readonly open: () => Promise<Fresh> }[] = [
	{
		name: 'SQLite',
		enabled: true,
		open: () => testDatabase({ migrations: new URL('./cloudflare-fixture/db/migrations/', import.meta.url), label: 'test-kit-due-jobs.test.ts' }),
	},
	{
		name: 'Postgres',
		enabled: url !== '',
		async open() {
			const schema = applicationSchema(`due-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`)
			const framework = FRAMEWORK_MIGRATIONS.map((file) => file.sql).join('\n')
			await admin(`create schema ${schema}; set search_path to ${schema}; ${framework} ${POSTGRES_TABLE}`)
			const database = openPostgres({ url, schema, max: 3 })
			return {
				database,
				async close() {
					await database.close()
					await admin(`drop schema ${schema} cascade`)
				},
			}
		},
	},
]

for (const driver of drivers) {
	describe.skipIf(!driver.enabled)(`kit.runDueJobs on ${driver.name}`, () => {
		let fresh: Fresh

		beforeEach(async () => {
			runs = []
			failNext = false
			fresh = await driver.open()
		})

		afterEach(async () => {
			await fresh.close()
		})

		/** A kit over its own data layer, and that layer's pending wakes. */
		function kitOver() {
			const layer = scoped(tables)
			const kit = testKit(serve(contract, { database: layer }), { database: fresh.database })
			return { kit, wakes: frameworkTablesOf(layer).wakes }
		}

		test('a cron wake fires only once the window reaches it, once, and a second call runs it no more', async () => {
			const { kit, wakes } = kitOver()
			expect(await kit.runDueJobs()).toEqual([])
			const [cron] = await wakes.pending('later')
			expect(cron).toMatchObject({ reason: 'cron', dedupe: `cron:later:${LATER}` })
			const ahead = (cron?.dueAt.getTime() ?? 0) - Date.now()
			expect(ahead).toBeGreaterThan(2 * HOUR - 2 * MINUTE)
			expect(ahead).toBeLessThanOrEqual(2 * HOUR)
			expect(await kit.runDueJobs({ within: HOUR })).toEqual([])
			expect(runs).toEqual([])
			expect(await kit.runDueJobs({ within: 3 * HOUR })).toEqual([{ job: 'later', result: { status: 'succeeded', attempts: 1 } }])
			expect(runs).toEqual([{ job: 'later', attempt: 1 }])
			expect(await kit.runDueJobs({ within: 3 * HOUR })).toEqual([])
			expect(await kit.runDueJobs()).toEqual([])
			expect(runs).toEqual([{ job: 'later', attempt: 1 }])
			// The run scheduled its fire again from the real now: the same occurrence, which the kit already ran.
			expect((await wakes.pending('later')).map((wake) => wake.dueAt.getTime())).toEqual([cron?.dueAt.getTime() ?? Number.NaN])
			await expect(kit.runDueJobs({ within: -1 })).rejects.toThrow('takes milliseconds, 0 or more')
		})

		test('a wake written through the store fires within reach; the failed run retries on a later call, once', async () => {
			const { kit, wakes } = kitOver()
			expect(await kit.runDueJobs()).toEqual([])
			await wakes.schedule({ job: 'remind', reason: 'kick', dueAt: new Date(Date.now() + 10 * MINUTE) })
			expect(await kit.runDueJobs({ within: 5 * MINUTE })).toEqual([])
			expect(runs).toEqual([])
			failNext = true
			expect(await kit.runDueJobs({ within: 15 * MINUTE })).toEqual([
				{ job: 'remind', result: { status: 'failed', attempts: 1, code: 'handler_failed' } },
			])
			const retry = (await wakes.pending('remind')).find((wake) => wake.reason === 'kick')
			expect(retry?.attempt).toBe(1)
			expect((retry?.dueAt.getTime() ?? 0) - Date.now()).toBeLessThanOrEqual(1_000)
			expect(await kit.runDueJobs({ within: 2_000 })).toEqual([{ job: 'remind', result: { status: 'succeeded', attempts: 2 } }])
			expect(await kit.runDueJobs({ within: 2_000 })).toEqual([])
			expect(runs).toEqual([{ job: 'remind', attempt: 1 }, { job: 'remind', attempt: 2 }])
			expect((await wakes.pending('remind')).map((wake) => wake.reason)).toEqual(['cron'])
		})

		test("a mutation's delayed kick runs only once the window reaches it, once, and a second call runs it no more", async () => {
			const { kit, wakes } = kitOver()
			const editor = kit.testCaller([{ role: 'editor', scope: kit.scope('workspace', 'w1') }])
			const api = createClient(contract, 'api', { fetch: kit.browser(editor) })
			const at = Date.now() + 5 * MINUTE
			await api.notes.remindLater({ workspaceId: 'w1', title: 'Call back', at })
			await kit.drain()
			expect(runs).toEqual([])
			expect((await wakes.pending('deliver')).map(({ reason, dueAt }) => ({ reason, due: dueAt.getTime() }))).toEqual([{ reason: 'kick', due: at }])
			expect(await kit.runDueJobs({ within: 2 * MINUTE })).toEqual([])
			expect(runs).toEqual([])
			expect(await kit.runDueJobs({ within: 10 * MINUTE })).toEqual([{ job: 'deliver', result: { status: 'succeeded', attempts: 1 } }])
			expect(await kit.runDueJobs({ within: 10 * MINUTE })).toEqual([])
			expect(runs).toEqual([{ job: 'deliver', attempt: 1 }])
			// The run consumed the kick; only the cron wake the repair keeps is left.
			expect((await wakes.pending('deliver')).map((wake) => wake.reason)).toEqual(['cron'])
		})
	})
}
