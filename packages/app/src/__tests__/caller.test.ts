// `ctx.caller`: the caller's row of the table `defineApp`'s `caller` declares, read once per request after
// authorization and before the handler. A person without a row, or with one a refusal meets, is a 403 and the handler
// does not run; a procedure that opts out (`caller: false`) runs without one; a script gets `null`, a public procedure
// reads none. Through the test kit, so the proxy's decision sits in front of boot. On the SQLite test database, so it
// never skips.

import { createClient } from '@fabrika/app/client'
import { type App, defineApp, defineVocabulary, type KitTypes } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { scoped, type TypedColumnList } from '@fabrika/db'
import { defineTables } from '@fabrika/db/tables'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import type { ColumnType } from 'kysely'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { parseCallerDeclaration } from '../contract/caller'
import { optsOutOfCaller, withoutCaller } from '../contract/handled'

interface PeopleTable {
	id: string
	principal_id: string | null
	nickname: string
	archived_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>
}

const columns: TypedColumnList<{ people: PeopleTable }> = {
	people: { columns: ['id', 'principal_id', 'nickname', 'archived_at'], foreignKeys: [], timestamps: ['archived_at'] },
}

const vocabulary = defineVocabulary({
	app: 'staff',
	dimensions: {},
	actions: { 'people.read': 'Read the staff', 'people.bind': 'Bind an account to a card', 'people.archive': 'Archive a card' },
	roles: { staff: { grants: ['people.read', 'people.bind', 'people.archive'] } },
})

const tables = defineTables(vocabulary, columns)({
	people: {
		scope: { app: 'the staff of the application' },
		actions: { read: 'people.read', insert: 'people.bind', update: 'people.archive' },
		insert: ['principal_id', 'nickname'],
		update: ['archived_at'],
	},
})

const MISSING = 'No staff card belongs to this account.'
const ARCHIVED = 'The staff card of this account is archived.'

const app = defineApp(vocabulary, tables, {
	caller: { table: 'people', principal: 'principal_id', missing: MISSING, refuse: [{ column: 'archived_at', not: null, message: ARCHIVED }] },
})

type Kit = typeof app extends App<infer K extends KitTypes> ? K : never
type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T
/** `ctx.caller` is the table's row as its read action reads it. */
export type CallerIsTheRow = Expect<Equal<Kit['caller']['archived_at'], Date | null>>

/** Each handler that ran, by name: a refused caller adds nothing. */
const ran: string[] = []

const Card = z.strictObject({ id: z.string(), nickname: z.string() })

const session = app.group({ callers: ['human'] }, (r) => ({
	bind: r.mutation({
		input: z.strictObject({ nickname: z.string() }),
		output: z.strictObject({ id: z.string() }),
		access: { action: 'people.bind', app: true },
		caller: false,
	}).handle(async ({ input, ctx }) => {
		ran.push('bind')
		expect('caller' in ctx).toBe(false)
		return ctx.db.app.people.insert({ principal_id: ctx.principal.id, nickname: input.nickname })
	}),
	archive: r.mutation({
		input: z.strictObject({ id: z.string() }),
		output: z.null(),
		access: { action: 'people.archive', app: true },
		caller: false,
	}).handle(async ({ input, ctx }) => {
		await ctx.db.app.people.update(input.id, { archived_at: new Date() })
		return null
	}),
	me: r.query({ output: Card, access: { action: 'people.read', app: true } }).handle(({ ctx }) => {
		ran.push('me')
		const nickname: string = ctx.caller.nickname
		return { id: ctx.caller.id, nickname }
	}),
	rename: r.mutation({
		input: z.strictObject({ nickname: z.string() }),
		output: z.null(),
		access: { action: 'people.bind', app: true },
	}).handle(() => {
		ran.push('rename')
		return null
	}),
}))

const scripts = app.group({ callers: ['human', 'machine'] }, (r) => ({
	whoami: r.query({ output: z.strictObject({ card: z.nullable(z.string()) }), access: { action: 'people.read', app: true } }).handle(({ ctx }) => {
		ran.push('whoami')
		return { card: ctx.caller === null ? null : ctx.caller.id }
	}),
}))

const open = app.group({}, (r) => ({
	ping: r.query({ output: z.strictObject({ ok: z.boolean() }), access: { public: true }, actions: ['people.read'] }).handle(({ ctx }) => {
		ran.push('ping')
		expect('caller' in ctx).toBe(false)
		return { ok: true }
	}),
}))

const contract = app.contract((c) => ({ api: c.rpc('/api', { session, open }), script: c.rpc('/script', { scripts }) }))

const directory = mkdtempSync(join(tmpdir(), 'fabrika-caller-'))
mkdirSync(join(directory, 'migrations'))
writeFileSync(
	join(directory, 'migrations', '20261121120000_people.sql'),
	`CREATE TABLE people (
	id TEXT PRIMARY KEY,
	principal_id TEXT,
	nickname TEXT NOT NULL,
	archived_at TEXT
) STRICT;
`,
)
const database = await testDatabase({ migrations: join(directory, 'migrations'), label: 'caller.test.ts' })
const kit = testKit(serve(contract, { database: scoped(tables) }), { database: database.database })
const grants = [{ role: 'staff' }] as const

afterAll(async () => {
	await database.close()
	rmSync(directory, { recursive: true, force: true })
})

beforeEach(() => {
	ran.length = 0
})

interface Answer {
	readonly status: number
	readonly body: unknown
}

async function call(fetch: typeof kit.fetch, path: string, input: object = {}): Promise<Answer> {
	const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
	return { status: response.status, body: await response.json() }
}

const refused = (message: string) => ({ status: 403, body: { error: { type: 'forbidden', message } } })

describe('ctx.caller', () => {
	test('a person without a row is refused before the handler, on a query and a mutation', async () => {
		const person = kit.browser(kit.testCaller(grants))
		expect(await call(person, '/api/session.me')).toEqual(refused(MISSING))
		expect(await call(person, '/api/session.rename', { nickname: 'x' })).toEqual(refused(MISSING))
		expect(ran).toEqual([])
	})

	test('a procedure that opts out runs without a row, and binds the one the next request reads', async () => {
		const person = kit.browser(kit.testCaller(grants))
		const bound = await call(person, '/api/session.bind', { nickname: 'Ada' })
		expect(bound.status).toBe(200)
		expect(await call(person, '/api/session.me')).toEqual({ status: 200, body: { result: { id: expect.any(String), nickname: 'Ada' } } })
		expect(ran).toEqual(['bind', 'me'])
	})

	test('an archived person is refused before the handler; an opted-out procedure still runs for them', async () => {
		const person = kit.browser(kit.testCaller(grants))
		const bound = await call(person, '/api/session.bind', { nickname: 'Bob' })
		const { result } = z.strictObject({ result: z.strictObject({ id: z.string() }) }).parse(bound.body)
		expect((await call(person, '/api/session.archive', { id: result.id })).status).toBe(200)
		ran.length = 0
		expect(await call(person, '/api/session.me')).toEqual(refused(ARCHIVED))
		expect(await call(person, '/api/session.rename', { nickname: 'x' })).toEqual(refused(ARCHIVED))
		expect(ran).toEqual([])
	})

	test("another person's row is not the caller's", async () => {
		const first = kit.browser(kit.testCaller(grants))
		expect((await call(first, '/api/session.bind', { nickname: 'Cleo' })).status).toBe(200)
		expect(await call(kit.browser(kit.testCaller(grants)), '/api/session.me')).toEqual(refused(MISSING))
	})

	test('two rows for one person are a server fault, never a pick of one', async () => {
		const person = kit.browser(kit.testCaller(grants))
		await call(person, '/api/session.bind', { nickname: 'Dan' })
		await call(person, '/api/session.bind', { nickname: 'Dan again' })
		ran.length = 0
		expect((await call(person, '/api/session.me')).status).toBe(500)
		expect(ran).toEqual([])
	})

	test('a script gets null and runs; a person in the same group still needs a row', async () => {
		const script = createClient(contract, 'script', { fetch: kit.fetch, key: kit.testCaller(grants, { kind: 'machine' }).key ?? '' })
		expect(await script.scripts.whoami()).toEqual({ card: null })
		expect(await call(kit.browser(kit.testCaller(grants)), '/script/scripts.whoami')).toEqual(refused(MISSING))
		expect(ran).toEqual(['whoami'])
	})

	test('a public procedure reads no caller row', async () => {
		expect(await call(kit.fetch, '/api/open.ping')).toEqual({ status: 200, body: { result: { ok: true } } })
		expect(ran).toEqual(['ping'])
	})
})

describe('the caller declaration', () => {
	test('the parse refuses a declaration the types would refuse', () => {
		const valid = { table: 'people', principal: 'principal_id', missing: MISSING }
		expect(parseCallerDeclaration({ ...valid, refuse: [{ column: 'archived_at', not: null, message: ARCHIVED }] })).toEqual({
			...valid,
			refuse: [{ column: 'archived_at', not: null, message: ARCHIVED }],
		})
		expect(parseCallerDeclaration({ table: 'people', principal: 'principal_id' })).toEqual([
			'defineApp: caller.missing is the message of the 403 for a person without a row',
		])
		expect(parseCallerDeclaration({ ...valid, refuse: [{ column: 'archived_at', message: ARCHIVED }] })).toEqual([
			'defineApp: caller.refuse[0] is { column, equals, message } or { column, not, message }',
		])
		expect(parseCallerDeclaration({ ...valid, refuse: [{ column: 'archived_at', equals: null, not: null, message: ARCHIVED }] })).toHaveLength(1)
		expect(parseCallerDeclaration({ ...valid, extra: true })).toEqual([
			'defineApp: caller.extra is not a field (allowed: table, principal, missing, refuse)',
		])
	})

	test('serve refuses caller: false where no caller row is read', () => {
		// The types refuse caller: false on a kit without a caller row (kit-mistakes/62); serve refuses it again.
		const plain = defineApp(vocabulary, tables)
		const people = plain.group({ callers: ['human'] }, (r) => ({
			me: r.query({ output: z.null(), access: { action: 'people.read', app: true } }).handle(() => null),
		}))
		withoutCaller(people.endpoints.me)
		expect(optsOutOfCaller(people.endpoints.me)).toBe(true)
		const built = plain.contract((c) => ({ api: c.rpc('/api', { people }) }))
		expect(() => serve(built, { database: scoped(tables) })).toThrow(/caller: false opts a group procedure out/)
	})
})
