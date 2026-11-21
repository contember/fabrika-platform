// The endpoint access kit over a contract that declares `caller` (ADR-0079): every person a case asks as holds the
// declared row, seeded from `callerRows` for that request, so a leak case reaches the handler and finds a planted leak.
// Without that row in `callerRows` every case would end in the framework's 403 and check nothing, so the kit refuses to
// start. On SQLite, which needs no service.

import { defineApp, defineVocabulary, GENERATED_CALLER } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { endpointAccessKit } from '@fabrika/app/testing/isolation'
import { scoped, type TypedColumnList } from '@fabrika/db'
import { defineTables } from '@fabrika/db/tables'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

const vocabulary = defineVocabulary({
	app: 'notes',
	dimensions: { workspace: {}, note: { in: 'workspace' } },
	actions: { 'notes.read': 'Read notes', 'notes.write': 'Write notes' },
	roles: { editor: { grants: ['notes.read', 'notes.write'] } },
})

interface DB {
	notes: { id: string; workspace_id: string; title: string; created_by: string; version: number }
	people: { id: string; principal_id: string | null; nickname: string }
}

const columns: TypedColumnList<DB> = {
	notes: { columns: ['id', 'workspace_id', 'title', 'created_by', 'version'], foreignKeys: [] },
	people: { columns: ['id', 'principal_id', 'nickname'], foreignKeys: [] },
}

const tables = defineTables(vocabulary, columns)({
	notes: {
		scope: { dimension: 'note', key: 'id', in: { dimension: 'workspace', column: 'workspace_id' } },
		actions: { read: 'notes.read', insert: 'notes.write', update: 'notes.write' },
		insert: ['title'],
		update: ['title'],
		version: 'version',
		createdBy: 'created_by',
	},
	people: { scope: { app: 'the staff' }, actions: { read: 'notes.read' } },
})

const app = defineApp(vocabulary, tables, { caller: { table: 'people', principal: 'principal_id', missing: 'No card belongs to this account.' } })

const Titles = z.strictObject({ titles: z.array(z.string()), by: z.string() })

/** The workspace's notes, or, planted, every workspace's. */
const contractOf = (leaky: boolean) => {
	const notes = app.group({ callers: ['human'] }, (r) => ({
		list: r.query({ output: Titles, access: { action: 'notes.read', over: 'workspace' }, unscoped: { notes: 'read' } })
			.handle(async ({ ctx }) => {
				const page = leaky ? await ctx.db.unscoped.notes.list({ limit: 100 }) : await ctx.db.within.notes.list({ limit: 100 })
				return { titles: page.items.map((note) => note.title), by: ctx.caller.nickname }
			}),
	}))
	return app.contract((c) => ({ api: c.rpc('/api', { notes }) }))
}

const migrations = mkdtempSync(join(tmpdir(), 'endpoint-access-caller-'))
writeFileSync(
	join(migrations, '20261121120000_init.sql'),
	[
		'CREATE TABLE notes (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL, created_by TEXT NOT NULL, version INTEGER NOT NULL, UNIQUE (id, workspace_id)) STRICT;',
		'CREATE TABLE people (id TEXT PRIMARY KEY NOT NULL, principal_id TEXT UNIQUE, nickname TEXT NOT NULL) STRICT;',
		'',
	].join('\n'),
)
const database = await testDatabase({ migrations, label: 'endpoint-access-caller.test.ts' })
afterAll(async () => {
	await database.close()
	rmSync(migrations, { recursive: true, force: true })
})

const callerRows = { people: { principal_id: GENERATED_CALLER, nickname: 'case caller' } }

describe("the endpoint access kit over a contract's caller row", () => {
	test('each case caller holds the row, so the handler runs: a clean list leaks nothing, a planted leak is found', async () => {
		const clean = endpointAccessKit(serve(contractOf(false), { database: scoped(tables) }), tables, database, { callerRows })
		expect(await clean.leaked('api.notes.list', {})).toEqual({ answered: true, leaked: [] })
		const leaky = endpointAccessKit(serve(contractOf(true), { database: scoped(tables) }), tables, database, { callerRows })
		const outcome = await leaky.leaked('api.notes.list', {})
		expect(outcome.answered).toBe(true)
		expect(outcome.leaked.length).toBeGreaterThan(0)
	})

	test('the case rows are removed after each request, so the next case seeds the same values', async () => {
		const kit = endpointAccessKit(serve(contractOf(false), { database: scoped(tables) }), tables, database, { callerRows })
		expect(await kit.leaked('api.notes.list', {})).toEqual({ answered: true, leaked: [] })
		expect(await kit.leaked('api.notes.list', {})).toEqual({ answered: true, leaked: [] })
	})

	test('refuses to start without the declared row in callerRows, bound to the caller', () => {
		const implementation = serve(contractOf(false), { database: scoped(tables) })
		expect(() => endpointAccessKit(implementation, tables, database)).toThrow("the contract reads each person's people row")
		expect(() => endpointAccessKit(implementation, tables, database, { callerRows: { people: { nickname: 'x' } } })).toThrow(
			'callerRows: { people: { principal_id: GENERATED_CALLER',
		)
	})
})
