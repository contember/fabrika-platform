// An application table read with `'any'`, through the test kit on SQLite: an `app` endpoint of any action, a job and a
// webhook read it; the data layer refuses a public procedure and a scoped endpoint (`@fabrika/db`'s read-any-sqlite test
// pins the types that refuse them first).

import { createClient } from '@fabrika/app/client'
import { defineApp, WebhookSecret } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { scoped } from '@fabrika/db'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { z } from 'zod/v4'
import { tables } from './read-any-fixture/src/db/tables'
import { vocabulary } from './read-any-fixture/src/vocabulary'

const app = defineApp(vocabulary, tables)

const Empty = z.strictObject({})
const Notice = z.strictObject({ id: z.string(), body: z.string() })
const Notices = z.strictObject({ items: z.array(Notice) })
const Event = z.strictObject({ id: z.string() })
const seen: { job?: readonly string[]; webhook?: readonly string[] } = {}

const bodies = (page: { readonly items: readonly { readonly body: string }[] }): string[] => page.items.map((item) => item.body).sort()

const digest = app.cron('0 3 * * *', { actions: ['reports.run'] }).handle(async ({ ctx }) => {
	seen.job = bodies(await ctx.db.app('reports.run').notices.list())
})

const feed = app.webhook('/hooks/feed', { scheme: 'stripe', boundTo: 'app', actions: ['reports.run'], input: Event })
	.handle(async ({ ctx }) => {
		seen.webhook = bodies(await ctx.db.app('reports.run').notices.list())
	})

/** Calls `notices.list` on a handle whose type refuses it, as a handler that defeated the types would. */
async function listUntyped(tablesHandle: unknown): Promise<unknown> {
	const notices: unknown = Reflect.get(Object(tablesHandle), 'notices')
	const list: unknown = Reflect.get(Object(notices), 'list')
	if (typeof list !== 'function') throw new TypeError('notices has no list')
	return await Reflect.apply(list, notices, [])
}

const board = app.group({ callers: ['human'] }, (r) => ({
	post: r.mutation({
		input: z.strictObject({ body: z.string(), internal: z.string() }),
		output: z.strictObject({ id: z.string() }),
		access: { action: 'notices.post', app: true },
	}).handle(async ({ input, ctx }) => await ctx.db.app.notices.insert(input)),
	// `reports.run` is named by no policy of notices.
	list: r.query({ output: Notices, access: { action: 'reports.run', app: true } }).handle(async ({ ctx }) => {
		const page = await ctx.db.app.notices.list()
		return { items: page.items.map((item) => ({ id: item.id, body: item.body })) }
	}),
	columns: r.query({
		input: z.strictObject({ id: z.string() }),
		output: z.strictObject({ columns: z.array(z.string()) }),
		access: { action: 'reports.run', app: true },
	})
		.handle(async ({ input, ctx }) => ({ columns: Object.keys(await ctx.db.app.notices.get(input.id)).sort() })),
	audit: r.query({
		input: z.strictObject({ id: z.string() }),
		output: z.strictObject({ internal: z.string() }),
		access: { action: 'notices.audit', app: true },
	})
		.handle(async ({ input, ctx }) => ({ internal: (await ctx.db.app.notices.get(input.id)).internal })),
	connect: r.mutation({
		input: z.strictObject({ account: z.string() }),
		output: WebhookSecret,
		access: { action: 'reports.run', app: true },
		binds: 'feed',
	})
		.handle(({ input, ctx }) => ctx.webhooks('feed').bind(ctx.app, input.account)),
	scoped: r.query({ output: Empty, access: { action: 'notes.read', over: 'workspace' } }).handle(async ({ ctx }) => {
		await listUntyped(ctx.db.app)
		return {}
	}),
}))

const intake = app.group({}, (r) => ({
	peek: r.query({ output: Empty, access: { public: true }, actions: ['intake.submit'] }).handle(async ({ ctx }) => {
		await listUntyped(ctx.db.app('intake.submit'))
		return {}
	}),
	submit: r.mutation({ input: z.strictObject({ body: z.string() }), output: Empty, access: { public: true }, actions: ['intake.submit'] })
		.handle(async ({ input, ctx }) => {
			await ctx.db.app('intake.submit').notices.insert({ body: input.body, internal: '' })
			return {}
		}),
}))

const contract = app.contract((c) => ({ api: c.rpc('/api', { board, intake }), feed, health: c.health('/healthz'), jobs: { digest } }))

const database = await testDatabase({ migrations: new URL('./read-any-fixture/db/migrations/', import.meta.url), label: 'read-any.test.ts' })
afterAll(() => database.close())

const kit = testKit(serve(contract, { database: scoped(tables) }), { database: database.database })
const api = (action: 'notices.post' | 'notices.audit' | 'reports.run') =>
	createClient(contract, 'api', { fetch: kit.browser(kit.testCaller([{ action }])) })
const anonymous = (path: string, body: unknown) =>
	kit.fetch(`/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

const { id } = await api('notices.post').board.post({ body: 'first', internal: 'for auditors' })
await api('notices.post').board.post({ body: 'second', internal: 'also internal' })

describe("an application table read with 'any'", () => {
	test('an app endpoint of an action the table does not name reads every row, without a column of its own read action', async () => {
		expect(bodies(await api('reports.run').board.list())).toEqual(['first', 'second'])
		expect((await api('reports.run').board.columns({ id })).columns).toEqual(['body', 'created_by', 'id'])
		expect((await api('notices.audit').board.audit({ id })).internal).toBe('for auditors')
	})

	test('a job reads it under its declared action', async () => {
		expect(await kit.runJob('digest')).toMatchObject({ status: 'succeeded' })
		expect(seen.job).toEqual(['first', 'second'])
	})

	test('a webhook delivery reads it under its declared action', async () => {
		const binding = await api('reports.run').board.connect({ account: 'acct_1' })
		const body = JSON.stringify({ id: 'evt_1' })
		const t = String(Math.floor(Date.now() / 1000))
		const signature = createHmac('sha256', binding.secret).update(`${t}.${body}`).digest('hex')
		const delivery = await kit.fetch(binding.url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${signature}` },
			body,
		})
		expect(delivery.status).toBe(200)
		expect(seen.webhook).toEqual(['first', 'second'])
	})

	test('a public procedure inserts under its action and is refused the read', async () => {
		expect((await anonymous('intake.submit', { body: 'anonymous' })).status).toBe(200)
		expect((await anonymous('intake.peek', {})).status).toBe(500)
	})

	test('a scoped endpoint is refused the read', async () => {
		const scopedCaller = createClient(contract, 'api', {
			fetch: kit.browser(kit.testCaller([{ action: 'notes.read', scope: { type: 'workspace', value: 'w1' } }])),
		})
		await expect(scopedCaller.board.scoped()).rejects.toMatchObject({ httpStatus: 500 })
	})
})
