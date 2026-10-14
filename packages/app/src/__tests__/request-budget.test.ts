// The request budget through the real pipeline: a mutation that writes and then runs past REQUEST_BUDGET_MS sees its
// ctx.signal abort although the client stays, returns normally, and still answers 500 with nothing written. It takes the
// budget's 10 s of real time. Skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset.

import { defineApp } from '@fabrika/app/contract'
import { REQUEST_BUDGET_MS, serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { scoped } from '@fabrika/db'
import { testDatabase } from '@fabrika/db/testing'
import { SQL } from 'bun'
import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { tables } from './kit-fixture/src/db/tables'
import { vocabulary } from './kit-fixture/src/vocabulary'
import { migration } from './orm-fixture/migration'

const migrations = mkdtempSync(join(tmpdir(), 'fabrika-request-budget-'))
writeFileSync(join(migrations, '20261014120000_init.sql'), migration)
const postgres = await testDatabase({ migrations, label: 'request-budget.test.ts' })

afterAll(async () => {
	await postgres?.close()
	rmSync(migrations, { recursive: true, force: true })
})

/** What the handler saw: whether its signal aborted while the client still waited, and after how long. */
const seen = { aborted: false, afterMs: 0 }

const app = defineApp(vocabulary, tables)
const Note = z.strictObject({ id: z.string() })
const Noted = z.strictObject({ ok: z.boolean() })

const deals = app.group({ callers: ['human'] }, (r) => ({
	/** Writes a note, then waits for its signal and returns normally, as a handler that ignores the abort would. */
	slowNote: r.mutation({ input: Note, output: Noted, access: { action: 'deals.write', on: 'deal', from: 'id' } })
		.handle(async ({ ctx }) => {
			const started = Date.now()
			await ctx.db.target.deal_activities.insert({ body: 'written before the budget ran out' })
			await new Promise<void>((resolve) => {
				const giveUp = setTimeout(resolve, REQUEST_BUDGET_MS * 2)
				ctx.signal.addEventListener('abort', () => {
					clearTimeout(giveUp)
					resolve()
				}, { once: true })
			})
			seen.aborted = ctx.signal.aborted
			seen.afterMs = Date.now() - started
			return { ok: true }
		}),
}))
const contract = app.contract((c) => ({ api: c.rpc('/api', { deals }), health: c.health('/healthz') }))

async function notes(schema: string, deal: string): Promise<number> {
	const sql = new SQL({ url: process.env['FABRIKA_TEST_POSTGRES_URL'] ?? '', adapter: 'postgres', max: 1 })
	try {
		const [row] = await sql.unsafe(`select count(*)::int as n from ${schema}.deal_activities where deal_id = $1`, [deal])
		return Number(row?.n)
	} finally {
		await sql.close()
	}
}

if (postgres !== null) {
	describe('a request past its budget', () => {
		test('aborts its signal without the client leaving, answers 500 and writes nothing', async () => {
			const worlds = await postgres.seedWorlds(tables, 'deals')
			const deal = worlds.own.key
			const kit = testKit(serve(contract, { database: scoped(tables) }), { database: postgres.database })
			const writer = kit.testCaller([{ action: 'deals.write', scope: { type: 'deal', value: deal } }])
			const log = spyOn(console, 'error').mockImplementation(() => {})
			let lines: string[] = []
			let status = 0
			try {
				const response = await kit.browser(writer)('/api/deals.slowNote', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ id: deal }),
				})
				status = response.status
				lines = log.mock.calls.map((call) => call.map(String).join(' '))
			} finally {
				log.mockRestore()
			}
			expect(seen.aborted).toBe(true)
			expect(seen.afterMs).toBeGreaterThanOrEqual(REQUEST_BUDGET_MS - 100)
			expect(seen.afterMs).toBeLessThan(REQUEST_BUDGET_MS * 2)
			expect(status).toBe(500)
			expect(lines.join('\n')).toContain('api.deals.slowNote: framework_fault: request_cancelled')
			expect(await notes(postgres.schema, deal)).toBe(0)
		}, REQUEST_BUDGET_MS * 3)
	})
}
