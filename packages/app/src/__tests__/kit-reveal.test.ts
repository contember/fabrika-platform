// `revealHandlerErrors`, the sink of the author's own run (`fabrika app dev`, a test that passes one): the message of a
// framework failure, which every log line withholds (ADR-0059), reaches it beside the line's reason, for a request and a
// job alike, and a job names a `ServerFault` by its reason as a request does, IAM's as the attempt's start names it. A sink that throws changes nothing of the
// failure. Without the sink the log line is the one it always was. On the object's SQLite, so it runs everywhere.

import { createClient } from '@fabrika/app/client'
import { defineApp } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { type HandlerErrorSink, testKit } from '@fabrika/app/testing'
import { scoped } from '@fabrika/db'
import { QUERY_REFUSALS, QueryRefusedError } from '@fabrika/db/framework'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { z } from 'zod/v4'
import { SERVER_FAULTS, ServerFault } from '../implement/faults'
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

const faulty = app.cron('0 4 * * *', { actions: ['notes.read'] }).handle(() => {
	throw new ServerFault('url_unbuildable', "ctx.url names 'api.nowhere', which is no procedure of the contract")
})

const unreachable = app.cron('0 5 * * *', { actions: ['notes.read'] }).handle(() => {
	throw new ServerFault('iam_unavailable', 'IAM could not be asked to issue a link', 503)
})

const revoked = app.cron('0 6 * * *', { actions: ['notes.read'] }).handle(() => {
	throw new ServerFault('workload_unauthorized', "IAM signs no token for the key of job 'revoked'", 503)
})

const contract = app.contract((c) => ({
	api: c.rpc('/api', { notes }),
	health: c.health('/healthz'),
	jobs: { catalog, faulty, unreachable, revoked },
}))

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

	function kitWith(sink: HandlerErrorSink | null) {
		return testKit(serve(contract, { database: scoped(tables) }), {
			database: fresh.database,
			...(sink === null ? {} : { revealHandlerErrors: sink }),
		})
	}

	/** A sink that keeps what it was shown. */
	const into = (revealed: Revealed[]): HandlerErrorSink => (where, error) =>
		void revealed.push({
			where,
			message: error instanceof Error ? error.message : String(error),
			reason: error instanceof QueryRefusedError || error instanceof ServerFault ? error.reason : null,
		})

	const throwing: HandlerErrorSink = () => {
		throw new Error('the sink broke')
	}

	const line = `query_refused: sql_name: ${QUERY_REFUSALS.sql_name}`

	test("a request's refused ctx.sql reaches the sink with its own message; the log line keeps the reason and its text", async () => {
		const revealed: Revealed[] = []
		const kit = kitWith(into(revealed))
		const editor = kit.testCaller([{ role: 'editor', scope: kit.scope('workspace', 'w1') }])
		const api = createClient(contract, 'api', { fetch: kit.browser(editor) })
		await expect(api.notes.catalog({ workspaceId: 'w1' })).rejects.toMatchObject({ httpStatus: 500 })
		expect(revealed).toEqual([{ where: "endpoint 'api.notes.catalog'", message: MESSAGE, reason: 'sql_name' }])
		expect(logged.mock.calls).toEqual([[`fabrika: api.notes.catalog: ${line}`]])
	})

	test("a job's refused ctx.sql reaches the sink with its own message, and kit.runJob answers its code and reason", async () => {
		const revealed: Revealed[] = []
		const kit = kitWith(into(revealed))
		expect(await kit.runJob('catalog')).toMatchObject({ status: 'failed', code: 'query_refused', reason: 'sql_name' })
		expect(revealed[0]).toEqual({ where: "job 'catalog' attempt 1", message: MESSAGE, reason: 'sql_name' })
		expect(logged.mock.calls.flat().join('\n')).not.toContain('sqlite_master')
	})

	test("a job's ServerFault is named by its code and reason, as a request names it, and reaches the sink whole", async () => {
		const revealed: Revealed[] = []
		const kit = kitWith(into(revealed))
		expect(await kit.runJob('faulty')).toMatchObject({ status: 'failed', code: 'framework_fault', reason: 'url_unbuildable' })
		expect(revealed).toEqual([
			{ where: "job 'faulty' attempt 1", message: "ctx.url names 'api.nowhere', which is no procedure of the contract", reason: 'url_unbuildable' },
		])
		const lines = logged.mock.calls.flat().join('\n')
		expect(lines).toContain(`framework_fault: url_unbuildable: ${SERVER_FAULTS.url_unbuildable}`)
		expect(lines).not.toContain('api.nowhere')
	})

	test("IAM met inside a job's handler is named as at the attempt's start: iam_unavailable, unauthorized", async () => {
		const revealed: Revealed[] = []
		const kit = kitWith(into(revealed))
		expect(await kit.runJob('unreachable')).toEqual({ status: 'failed', attempts: 1, code: 'iam_unavailable' })
		expect(await kit.runJob('revoked')).toEqual({ status: 'failed', attempts: 1, code: 'unauthorized' })
		expect(revealed.map((shown) => shown.reason)).toEqual(['iam_unavailable', 'workload_unauthorized'])
		const lines = logged.mock.calls.flat().join('\n')
		expect(lines).toContain("fabrika: job 'unreachable' failed after 1 attempt: iam_unavailable")
		expect(lines).toContain("fabrika: job 'revoked' failed after 1 attempt: unauthorized")
	})

	test('a sink that throws leaves the failure as it was, for a request and a job', async () => {
		const kit = kitWith(throwing)
		const editor = kit.testCaller([{ role: 'editor', scope: kit.scope('workspace', 'w1') }])
		const api = createClient(contract, 'api', { fetch: kit.browser(editor) })
		await expect(api.notes.catalog({ workspaceId: 'w1' })).rejects.toMatchObject({ httpStatus: 500 })
		expect(await kit.runJob('catalog')).toMatchObject({ status: 'failed', code: 'query_refused', reason: 'sql_name' })
		expect(logged.mock.calls.flat()).toContain(`fabrika: api.notes.catalog: ${line}`)
		expect(logged.mock.calls.flat()).toContain(
			"fabrika: revealHandlerErrors threw while it showed endpoint 'api.notes.catalog'; the failure stands as it was",
		)
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
