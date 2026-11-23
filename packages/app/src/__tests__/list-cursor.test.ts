// A list cursor is the caller's input, signed with the database's own key: one that does not decode, was edited, has
// another shape, or belongs to another order of the list is a 400 `list_cursor` through the real dispatcher, never a
// 500 or a page from a position no page ended at. On the SQLite test database, which never skips, and on a real
// Postgres (skips cleanly without FABRIKA_TEST_POSTGRES_URL), where an edited uuid used to fail the statement.

import { defineApp } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { type Database, scoped } from '@fabrika/db'
import { testDatabase as postgresTestDatabase } from '@fabrika/db/testing'
import { testDatabase as sqliteTestDatabase } from '@fabrika/db/testing-sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

/** A browser session of an editor of w1, over a kit of its own on `database`. */
function poster(database: Database | null): (procedure: string, input: unknown) => Promise<{ readonly status: number; readonly body: unknown }> {
	if (database === null) throw new Error('no database')
	const kit = testKit(serve(contract, { database: scoped(tables) }), { database })
	const call = kit.browser(kit.testCaller([{ role: 'editor', scope: kit.scope('workspace', 'w1') }]))
	return async (procedure, input) => {
		const response = await call(`/api/notes.${procedure}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(input),
		})
		return { status: response.status, body: await response.json() }
	}
}

const Answer = z.strictObject({ result: Page })

function pageOf(body: unknown): z.infer<typeof Page> {
	return Answer.parse(body).result
}

/** The next cursor of a page that has one: a case that asks for it must not pass on an empty `after`. */
function nextOf(body: unknown): string {
	const next = pageOf(body).next
	if (next === null) {
		throw new Error('the page has no next cursor')
	}
	return next
}

const refused = {
	status: 400,
	body: { error: { type: 'list_cursor', message: 'The cursor is not the next cursor of a page of this list; list from the first page again' } },
}

const base64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')

/** A cursor's two parts: its payload, the base64url JSON of the order values, and its signature. */
function partsOf(cursor: string): { readonly values: unknown; readonly signature: string } {
	const [payload = '', signature = ''] = cursor.split('.')
	return { values: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')), signature }
}

// The Postgres half's notes: the key is a uuid, so an edited key is text the column's type cannot parse.
const postgresMigration = `CREATE TABLE notes (
	id UUID PRIMARY KEY,
	workspace_id TEXT NOT NULL,
	title TEXT NOT NULL,
	created_by TEXT NOT NULL,
	version INTEGER NOT NULL,
	UNIQUE (id, workspace_id)
);
`
const postgresMigrations = mkdtempSync(join(tmpdir(), 'fabrika-list-cursor-'))
writeFileSync(join(postgresMigrations, '20261123120000_notes.sql'), postgresMigration)

const sqlite = await sqliteTestDatabase({ migrations: new URL('./cloudflare-fixture/db/migrations/', import.meta.url), label: 'list-cursor.test.ts' })
const postgres = await postgresTestDatabase({ migrations: postgresMigrations, label: 'list-cursor.test.ts' })

afterAll(async () => {
	await sqlite.close()
	await postgres?.close()
	rmSync(postgresMigrations, { recursive: true, force: true })
})

for (const [dialect, database] of [['SQLite', sqlite.database], ['Postgres', postgres?.database ?? null]] as const) {
	describe.skipIf(database === null)(`a list cursor from the caller, on ${dialect}`, () => {
		let post: (procedure: string, input: unknown) => Promise<{ readonly status: number; readonly body: unknown }>

		async function page(order: 'asc' | 'desc', after?: string): Promise<{ readonly status: number; readonly body: unknown }> {
			return await post('page', { workspaceId: 'w1', order, ...(after === undefined ? {} : { after }) })
		}

		beforeAll(async () => {
			post = poster(database)
			for (const title of ['a', 'b', 'c']) {
				expect((await post('create', { workspaceId: 'w1', title })).status).toBe(200)
			}
		})

		test('pages the list it came from', async () => {
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

		test('carries the order values only, no table or column name', async () => {
			const { values } = partsOf(nextOf((await page('asc')).body))
			expect(values).toEqual(['a', expect.any(String)])
		})

		test('that is not a cursor, or an unsigned one, is a 400 list_cursor', async () => {
			expect(await page('asc', 'not a cursor!')).toEqual(refused)
			expect(await page('asc', '%%%')).toEqual(refused)
			expect(await page('asc', Buffer.from('{"truncated').toString('base64url'))).toEqual(refused)
			const { values } = partsOf(nextOf((await page('asc')).body))
			expect(await page('asc', base64url(['notes', [['title', 'asc'], ['id', 'asc']], values]))).toEqual(refused)
			expect(await page('asc', base64url(values))).toEqual(refused)
		})

		test('whose values were edited is a 400 list_cursor, never a 500 or another page', async () => {
			const next = nextOf((await page('asc')).body)
			const { values, signature } = partsOf(next)
			const [title, id] = Array.isArray(values) ? values : []
			for (
				const edited of [
					['b', id], // a valid title: an unsigned cursor would page from there
					[title, 'x'], // no uuid: Postgres would refuse the statement
					[title, null],
					[title, id, 'extra'],
					[title],
					{},
				]
			) {
				expect(await page('asc', `${base64url(edited)}.${signature}`)).toEqual(refused)
			}
			expect(await page('asc', `${next.split('.')[0]}.${signature.slice(0, -1)}`)).toEqual(refused)
			expect(await page('asc', `${next}.`)).toEqual(refused)
			expect((await page('asc', next)).status).toBe(200)
		})

		test('of another order of the same list is a 400 list_cursor', async () => {
			const ascending = nextOf((await page('asc')).body)
			expect(await page('desc', ascending)).toEqual(refused)
			const descending = nextOf((await page('desc')).body)
			expect(await page('asc', descending)).toEqual(refused)
		})
	})
}
