// The endpoint access kit and the leak sweep over a group only a person's agent calls (ADR-0090): each case asks as the
// person's agent with an unnarrowed grant, `read` for a query and `write` for a mutation, so a clean list leaks nothing,
// a planted leak is found and a write in another scope is refused. On SQLite, which needs no service.

import { defineApp, defineVocabulary } from '@fabrika/app/contract'
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
import { planSweep } from '../testing/leak-sweep'

const vocabulary = defineVocabulary({
	app: 'notes',
	dimensions: { workspace: {}, note: { in: 'workspace' } },
	actions: { 'notes.read': 'Read notes', 'notes.write': 'Write notes' },
	roles: { editor: { grants: ['notes.read', 'notes.write'] } },
})

interface DB {
	notes: { id: string; workspace_id: string; title: string }
}

const columns: TypedColumnList<DB> = { notes: { columns: ['id', 'workspace_id', 'title'], foreignKeys: [] } }

const tables = defineTables(vocabulary, columns)({
	notes: {
		scope: { dimension: 'note', key: 'id', in: { dimension: 'workspace', column: 'workspace_id' } },
		actions: { read: 'notes.read', insert: 'notes.write' },
		insert: ['title'],
	},
})

const app = defineApp(vocabulary, tables)

const Titles = z.strictObject({ titles: z.array(z.string()) })
const NewNote = z.strictObject({ workspaceId: z.string(), title: z.string() })

/** A group of the agent alone: the workspace's notes, or, planted, every workspace's; and a write in one workspace. */
const contractOf = (leaky: boolean) => {
	const notes = app.group({ callers: ['agent'] }, (r) => ({
		list: r.query({ output: Titles, access: { action: 'notes.read', over: 'workspace' }, unscoped: { notes: 'read' } })
			.handle(async ({ ctx }) => {
				const page = leaky ? await ctx.db.unscoped.notes.list({ limit: 100 }) : await ctx.db.within.notes.list({ limit: 100 })
				return { titles: page.items.map((note) => note.title) }
			}),
		create: r.mutation({
			input: NewNote,
			output: z.strictObject({ id: z.string() }),
			access: { action: 'notes.write', in: 'workspace', from: 'workspaceId' },
		})
			.handle(async ({ input, ctx }) => {
				const { id } = await ctx.db.target.notes.insert({ title: input.title })
				return { id }
			}),
	}))
	return app.contract((c) => ({ api: c.rpc('/api', { notes }) }))
}

const migrations = mkdtempSync(join(tmpdir(), 'endpoint-access-agent-'))
writeFileSync(
	join(migrations, '20261126120000_init.sql'),
	'CREATE TABLE notes (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL, UNIQUE (id, workspace_id)) STRICT;\n',
)
const database = await testDatabase({ migrations, label: 'endpoint-access-agent.test.ts' })
afterAll(async () => {
	await database.close()
	rmSync(migrations, { recursive: true, force: true })
})

describe('an agent-only group in the endpoint access kit and the leak sweep', () => {
	test("each case asks as the person's agent: a clean list leaks nothing, a planted leak is found", async () => {
		const clean = endpointAccessKit(serve(contractOf(false), { database: scoped(tables) }), tables, database)
		expect(await clean.leaked('api.notes.list', {})).toEqual({ answered: true, leaked: [] })
		const leaky = endpointAccessKit(serve(contractOf(true), { database: scoped(tables) }), tables, database)
		const outcome = await leaky.leaked('api.notes.list', {})
		expect(outcome.answered).toBe(true)
		expect(outcome.leaked.length).toBeGreaterThan(0)
	})

	test('a mutation is asked with a write grant: a value of another workspace is refused', async () => {
		const kit = endpointAccessKit(serve(contractOf(false), { database: scoped(tables) }), tables, database)
		expect(await kit.denied('api.notes.create', { title: 'x' })).toEqual({ status: 403 })
	})

	test('the leak sweep plans the group: the write as a case, the list, which declares unscoped, as a hint', () => {
		const { cases, hints } = planSweep(serve(contractOf(false), { database: scoped(tables) }), tables)
		expect(cases.map((planned) => planned.endpoint)).toEqual(['api.notes.create'])
		expect(hints).toContain('api.notes.list: declares unscoped, so it reaches across scopes by design; the sweep does not ask it')
	})
})
