// `ctx.caller` beside the facilities a procedure reaches. The row is read before the access form, so a person without a
// row never makes IAM create a scope; and a file column of the row is a reference the request may open, as a file
// column read through `ctx.db` is. On the SQLite test database, so it never skips.

import { defineApp, defineVocabulary, file } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { scoped, type TypedColumnList } from '@fabrika/db'
import { defineTables } from '@fabrika/db/tables'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { RecordingMembership } from './fixtures/multi-tenant/iam'

interface PeopleTable {
	id: string
	principal_id: string | null
	avatar: string
}

const columns: TypedColumnList<{ people: PeopleTable }> = {
	people: { columns: ['id', 'principal_id', 'avatar'], foreignKeys: [], timestamps: [] },
}

const vocabulary = defineVocabulary({
	app: 'staff',
	dimensions: { workspace: { creator: 'owner' } },
	actions: { 'people.read': 'Read the staff', 'people.bind': 'Bind an account to a card', 'workspaces.create': 'Start a workspace' },
	roles: { owner: { grants: ['people.read'], member: { scope: 'workspace', assignableBy: ['owner'] } } },
})

const tables = defineTables(vocabulary, columns)({
	people: {
		scope: { app: 'the staff of the application' },
		actions: { read: 'people.read', insert: 'people.bind' },
		insert: ['principal_id', 'avatar'],
		files: { avatar: 'avatar' },
	},
})

const MISSING = 'No staff card belongs to this account.'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

const app = defineApp(vocabulary, tables, { caller: { table: 'people', principal: 'principal_id', missing: MISSING } })

const session = app.group({ callers: ['human'] }, (r) => ({
	bind: r.mutation({ output: z.null(), access: { action: 'people.bind', app: true }, caller: false }).handle(async ({ ctx }) => {
		const avatar = await ctx.files.put('avatar', PNG, { type: 'image/png', name: 'me.png' })
		await ctx.db.app.people.insert({ principal_id: ctx.principal.id, avatar })
		return null
	}),
	avatar: r.query({ output: file('avatar'), access: { action: 'people.read', app: true } }).handle(({ ctx }) => ctx.caller.avatar),
	start: r.mutation({
		output: z.strictObject({ workspace: z.string() }),
		access: { action: 'workspaces.create', creates: 'workspace' },
	}).handle(({ ctx }) => ({ workspace: ctx.created.value })),
}))

const contract = app.contract((c) => ({
	api: c.rpc('/api', { session }),
	files: { avatar: c.files({ types: ['image/png'], maxBytes: 65536 }) },
}))

const directory = mkdtempSync(join(tmpdir(), 'fabrika-caller-reach-'))
mkdirSync(join(directory, 'migrations'))
writeFileSync(
	join(directory, 'migrations', '20261121130000_people.sql'),
	`CREATE TABLE people (
	id TEXT PRIMARY KEY,
	principal_id TEXT UNIQUE,
	avatar TEXT NOT NULL REFERENCES fabrika_files (id)
) STRICT;
CREATE INDEX people_avatar ON people (avatar);
`,
)
const database = await testDatabase({ migrations: join(directory, 'migrations'), label: 'caller-reach.test.ts' })
const membership = new RecordingMembership()
const kit = testKit(serve(contract, { database: scoped(tables) }), { database: database.database, files: new MemoryFileObjects(), membership })
const grants = [{ action: 'people.read' }, { action: 'people.bind' }, { action: 'workspaces.create' }] as const

afterAll(async () => {
	await database.close()
	rmSync(directory, { recursive: true, force: true })
})

const post = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }

describe('ctx.caller beside what the procedure reaches', () => {
	test('a person without a row is refused before the access form: IAM creates no scope', async () => {
		const person = kit.browser(kit.testCaller(grants))
		const refused = await person('/api/session.start', post)
		expect(refused.status).toBe(403)
		expect(await refused.json()).toEqual({ error: { type: 'forbidden', message: MISSING } })
		expect(membership.calls).toEqual([])
	})

	test('a person with a row starts one: the access form runs after the row', async () => {
		const person = kit.browser(kit.testCaller(grants))
		expect((await person('/api/session.bind', post)).status).toBe(200)
		const started = await person('/api/session.start', post)
		expect(await started.json()).toEqual({ result: { workspace: 'w-new' } })
		expect(membership.calls.map((call) => call.method)).toEqual(['createScope'])
	})

	test("a file column of the caller's row is a reference the request may open", async () => {
		const person = kit.browser(kit.testCaller(grants))
		expect((await person('/api/session.bind', post)).status).toBe(200)
		const avatar = await person('/api/session.avatar')
		expect(avatar.status).toBe(200)
		expect(new Uint8Array(await avatar.arrayBuffer())).toEqual(PNG)
	})
})
