// A list cursor is the caller's input: one that does not decode, has another shape, or belongs to another order of the
// list is a 400 `list_cursor` through the real dispatcher, never a 500. On the SQLite test database, so it never skips.

import { defineApp } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { scoped } from '@fabrika/db'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { tables } from './cloudflare-fixture/src/db/tables'
import { vocabulary } from './cloudflare-fixture/src/vocabulary'

const app = defineApp(vocabulary, tables)

const Page = z.strictObject({ titles: z.array(z.string()), next: z.string().nullable() })

const notes = app.group({ callers: ['human'] }, (r) => ({
	create: r.mutation({
		input: z.strictObject({ workspaceId: z.string().min(1), title: z.string().min(1) }),
		output: z.strictObject({ id: z.uuid() }),
		access: { action: 'notes.write', in: 'workspace', from: 'workspaceId' },
	})
		.handle(async ({ input, ctx }) => await ctx.db.target.notes.insert({ title: input.title })),
	page: r.query({
		input: z.strictObject({ workspaceId: z.string().min(1), order: z.enum(['asc', 'desc']), after: z.string().optional() }),
		output: Page,
		access: { action: 'notes.read', in: 'workspace', from: 'workspaceId' },
	})
		.handle(async ({ input, ctx }) => {
			const page = await ctx.db.target.notes.list({
				orderBy: [['title', input.order]],
				limit: 1,
				...(input.after === undefined ? {} : { after: input.after }),
			})
			return { titles: page.items.map((note) => note.title), next: page.next }
		}),
}))

const contract = app.contract((c) => ({ api: c.rpc('/api', { notes }) }))

const database = await testDatabase({ migrations: new URL('./cloudflare-fixture/db/migrations/', import.meta.url), label: 'list-cursor.test.ts' })
const kit = testKit(serve(contract, { database: scoped(tables) }), { database: database.database })
const call = kit.browser(kit.testCaller([{ role: 'editor', scope: kit.scope('workspace', 'w1') }]))

afterAll(async () => {
	await database.close()
})

async function post(procedure: string, input: unknown): Promise<{ readonly status: number; readonly body: unknown }> {
	const response = await call(`/api/notes.${procedure}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(input),
	})
	return { status: response.status, body: await response.json() }
}

async function page(order: 'asc' | 'desc', after?: string): Promise<{ readonly status: number; readonly body: unknown }> {
	return await post('page', { workspaceId: 'w1', order, ...(after === undefined ? {} : { after }) })
}

const Answer = z.strictObject({ result: Page })

function pageOf(body: unknown): z.infer<typeof Page> {
	return Answer.parse(body).result
}

function nextOf(body: unknown): string {
	return pageOf(body).next ?? ''
}

const refused = {
	status: 400,
	body: { error: { type: 'list_cursor', message: 'The cursor is not the next cursor of a page of this list; list from the first page again' } },
}

const base64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')

describe('a list cursor from the caller', () => {
	test('pages the list it came from', async () => {
		for (const title of ['a', 'b', 'c']) {
			expect((await post('create', { workspaceId: 'w1', title })).status).toBe(200)
		}
		const titles: string[] = []
		let after: string | undefined
		do {
			const answer = await page('asc', after)
			expect(answer.status).toBe(200)
			titles.push(...pageOf(answer.body).titles)
			after = pageOf(answer.body).next ?? undefined
		} while (after !== undefined)
		expect(titles).toEqual(['a', 'b', 'c'])
	})

	test('that is not base64url JSON is a 400 list_cursor', async () => {
		expect(await page('asc', 'not a cursor!')).toEqual(refused)
		expect(await page('asc', '%%%')).toEqual(refused)
		expect(await page('asc', Buffer.from('{"truncated').toString('base64url'))).toEqual(refused)
	})

	test('of another shape is a 400 list_cursor', async () => {
		const next = nextOf((await page('asc')).body)
		const decoded: unknown = JSON.parse(Buffer.from(next, 'base64url').toString('utf8'))
		expect(Array.isArray(decoded)).toBe(true)
		for (
			const shape of [
				{},
				'a',
				['a', 'id'],
				[...(Array.isArray(decoded) ? decoded.slice(0, 2) : []), ['a']],
				[...(Array.isArray(decoded) ? decoded.slice(0, 2) : []), [1, 2]],
				[...(Array.isArray(decoded) ? decoded : []), 'extra'],
			]
		) {
			expect(await page('asc', base64url(shape))).toEqual(refused)
		}
	})

	test('of another order of the same list is a 400 list_cursor', async () => {
		const ascending = nextOf((await page('asc')).body)
		expect(await page('desc', ascending)).toEqual(refused)
		const descending = nextOf((await page('desc')).body)
		expect(await page('asc', descending)).toEqual(refused)
	})
})
