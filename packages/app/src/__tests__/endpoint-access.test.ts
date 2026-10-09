// The endpoint access kit over the application's own implementation: an honest one passes every case, and one whose
// handlers cache rows across requests (the "performance" edit) is caught. Skips cleanly when
// FABRIKA_TEST_POSTGRES_URL is unset.

import { implement } from '@fabrika/app/implement'
import { endpointAccessKit } from '@fabrika/app/testing/isolation'
import { type Ref, scoped, type Within } from '@fabrika/db'
import { testDatabase } from '@fabrika/db/testing'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contract } from './fixtures/scoped-notes/fabrika.contract'
import { migration } from './fixtures/scoped-notes/migration'
import { tables } from './fixtures/scoped-notes/src/db/tables'

const migrations = mkdtempSync(join(tmpdir(), 'fabrika-endpoint-access-'))
writeFileSync(join(migrations, '20261009120000_init.sql'), migration)
const postgres = await testDatabase({ migrations, label: 'endpoint-access.test.ts' })

afterAll(async () => {
	await postgres?.close()
	rmSync(migrations, { recursive: true, force: true })
})

interface Row {
	readonly id: string
	readonly title: string
}

/**
 * The fixture's contract on a data layer of its own. `row` keeps the first answer and serves it to every caller;
 * `title` serves each caller its own id with the first caller's title, so only the data leaks.
 */
function notesApp(cache: 'none' | 'row' | 'title') {
	const cached = cache === 'row'
	const layer = scoped(tables)
	const notes = layer.defineStore('notes', (t) => ({
		list: (within: Within<'workspace', 'notes.read'>) => t.select(within, (q) => q.columns(['id', 'title']).orderBy('id')),
		get: (note: Ref<'note', 'notes.read'>) => t.get(note),
		create: (workspace: Ref<'workspace', 'notes.write'>, title: string) => t.insert(workspace, { title }),
	}))
	let first: Row | undefined
	let firstList: Row[] | undefined
	let firstTitle: string | undefined
	return implement(contract, {
		database: layer,
		deps: () => ({}),
		handlers: () => ({
			api: {
				notes: {
					list: async ({ ctx }) => {
						const items = cached && firstList !== undefined ? firstList : await notes.list(ctx.within)
						firstList ??= items
						return { items }
					},
					get: async ({ ctx }) => {
						const note = cached && first !== undefined ? first : await notes.get(ctx.target)
						first ??= note
						return { id: note.id, title: cache === 'title' ? (firstTitle ??= note.title) : note.title }
					},
					create: async ({ input, ctx }) => ({ id: (await notes.create(ctx.target, input.title)).id }),
					keep: () => ({ kept: true }),
					reuse: () => Promise.reject(new Error('not used here')),
				},
			},
		}),
	})
}

const ID = { id: '00000000-0000-4000-8000-000000000000' }

describe.skipIf(postgres === null)('the endpoint access kit', () => {
	test('an honest application refuses the other scope and answers nothing of it', async () => {
		if (postgres === null) return
		const kit = endpointAccessKit(notesApp('none'), tables, postgres)
		expect(await kit.denied('api.notes.get', ID)).toEqual({ status: 404 })
		expect(await kit.denied('api.notes.create', { workspaceId: '', title: 'x' })).toEqual({ status: 403 })
		expect(await kit.leaked('api.notes.get', ID)).toEqual({ status: 200, leaked: [] })
		expect(await kit.leaked('api.notes.list', {})).toEqual({ status: 200, leaked: [] })
	})

	test('a handler that serves a cached row to the next caller is caught', async () => {
		if (postgres === null) return
		const kit = endpointAccessKit(notesApp('row'), tables, postgres)
		expect((await kit.leaked('api.notes.get', ID)).leaked.length).toBeGreaterThan(0)
		expect((await kit.leaked('api.notes.list', {})).leaked.length).toBeGreaterThan(0)
	})

	test('a handler that serves the next caller only the first caller’s title is caught by the text markers', async () => {
		if (postgres === null) return
		const kit = endpointAccessKit(notesApp('title'), tables, postgres)
		const outcome = await kit.leaked('api.notes.get', ID)
		expect(outcome.status).toBe(200)
		expect(outcome.leaked).toHaveLength(1)
		expect(outcome.leaked[0]).toMatch(/^m[0-9a-f]{16}$/)
	})

	test('a case whose input the endpoint schema refuses fails, rather than passing on a 400', async () => {
		if (postgres === null) return
		const kit = endpointAccessKit(notesApp('none'), tables, postgres)
		await expect(kit.denied('api.notes.get', { id: 'not-a-uuid', extra: true })).rejects.toThrow(
			"api.notes.get: the case's input does not match the endpoint's input schema",
		)
	})

	test('an endpoint without an action, or with another access form, is refused by name', async () => {
		if (postgres === null) return
		const kit = endpointAccessKit(notesApp('none'), tables, postgres)
		await expect(kit.denied('api.notes.reuse', {})).rejects.toThrow('not an endpoint of the contract with an action requirement')
		await expect(kit.denied('api.notes.list', {})).rejects.toThrow('only on and in name an object')
		await expect(kit.leaked('api.notes.create', {})).rejects.toThrow('only on and over answer')
	})
})
