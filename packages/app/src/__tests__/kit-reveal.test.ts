// `revealHandlerErrors`, the sink of the author's own run (`fabrika app dev`, a test that passes one): the message of a
// framework refusal, which every log line withholds (ADR-0059), reaches it beside the line's reason, for a request and a
// job alike. Without the sink the log line is the one it always was. On the object's SQLite, so it runs everywhere.

import { createClient } from '@fabrika/app/client'
import { defineApp } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { scoped } from '@fabrika/db'
import { QUERY_REFUSALS, QueryRefusedError } from '@fabrika/db/framework'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { z } from 'zod/v4'
import { tables } from './cloudflare-fixture/src/db/tables'
import { vocabulary } from './cloudflare-fixture/src/vocabulary'

const app = defineApp(vocabulary, tables)

const Name = z.strictObject({ name: z.string() })
const Names = z.strictObject({ names: z.array(z.string()) })

/** What the refused statement's own message says, and the log line never does. */
const MESSAGE = "ctx.sql: 'sqlite_master' at line 2 is SQLite's catalog; ctx.sql reaches only the application's own tables"

const notes = app.group({ callers: ['human'] }, (r) => ({
	catalog: r.query({
		input: z.strictObject({ workspaceId: z.string().min(1) }),
		output: Names,
		access: { action: 'notes.read', in: 'workspace', from: 'workspaceId' },
		sql: 'read',
	})
		.handle(async ({ ctx }) => {
			const rows = await ctx.sql(Name)`select name
				from sqlite_master`
			return { names: rows.map((row) => row.name) }
		}),
}))

const catalog = app.cron('0 3 * * *', { actions: ['notes.read'], sql: 'read' }).handle(async ({ ctx }) => {
	await ctx.transaction(async (tx) => {
		await tx.sql(Name)`select name
			from sqlite_master`
	})
})

const contract = app.contract((c) => ({ api: c.rpc('/api', { notes }), health: c.health('/healthz'), jobs: { catalog } }))

interface Revealed {
	readonly where: string
	readonly message: string
	readonly reason: string | null
}

describe("a refusal on the author's own run", () => {
	let fresh: Awaited<ReturnType<typeof testDatabase>>
	let logged: ReturnType<typeof spyOn<Console, 'error'>>

	beforeEach(async () => {
		fresh = await testDatabase({ migrations: new URL('./cloudflare-fixture/db/migrations/', import.meta.url), label: 'kit-reveal.test.ts' })
		logged = spyOn(console, 'error').mockImplementation(() => {})
	})

	afterEach(async () => {
		logged.mockRestore()
		await fresh.close()
	})

	function kitWith(revealed: Revealed[] | null) {
		return testKit(serve(contract, { database: scoped(tables) }), {
			database: fresh.database,
			...(revealed === null ? {} : {
				revealHandlerErrors: (where: string, error: unknown) =>
					revealed.push({
						where,
						message: error instanceof Error ? error.message : String(error),
						reason: error instanceof QueryRefusedError ? error.reason : null,
					}),
			}),
		})
	}

	const line = `query_refused: sql_name: ${QUERY_REFUSALS.sql_name}`

	test("a request's refused ctx.sql reaches the sink with its own message; the log line keeps the reason and its text", async () => {
		const revealed: Revealed[] = []
		const kit = kitWith(revealed)
		const editor = kit.testCaller([{ role: 'editor', scope: kit.scope('workspace', 'w1') }])
		const api = createClient(contract, 'api', { fetch: kit.browser(editor) })
		await expect(api.notes.catalog({ workspaceId: 'w1' })).rejects.toMatchObject({ httpStatus: 500 })
		expect(revealed).toEqual([{ where: "endpoint 'api.notes.catalog'", message: MESSAGE, reason: 'sql_name' }])
		expect(logged.mock.calls).toEqual([[`fabrika: api.notes.catalog: ${line}`]])
	})

	test("a job's refused ctx.sql reaches the sink with its own message, and kit.runJob answers its code and reason", async () => {
		const revealed: Revealed[] = []
		const kit = kitWith(revealed)
		expect(await kit.runJob('catalog')).toMatchObject({ status: 'failed', code: 'query_refused', reason: 'sql_name' })
		expect(revealed[0]).toEqual({ where: "job 'catalog' attempt 1", message: MESSAGE, reason: 'sql_name' })
		expect(logged.mock.calls.flat().join('\n')).not.toContain('sqlite_master')
	})

	test('without the sink nothing of the message is logged, for a request or a job', async () => {
		const kit = kitWith(null)
		const editor = kit.testCaller([{ role: 'editor', scope: kit.scope('workspace', 'w1') }])
		const api = createClient(contract, 'api', { fetch: kit.browser(editor) })
		await expect(api.notes.catalog({ workspaceId: 'w1' })).rejects.toMatchObject({ httpStatus: 500 })
		expect(logged.mock.calls).toEqual([[`fabrika: api.notes.catalog: ${line}`]])
		expect(await kit.runJob('catalog')).toMatchObject({ status: 'failed', code: 'query_refused', reason: 'sql_name' })
		expect(logged.mock.calls.flat().join('\n')).not.toContain('sqlite_master')
	})
})
