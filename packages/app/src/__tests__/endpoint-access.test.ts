// The endpoint access kit over the application's own implementation: an honest one passes every case, and one whose
// handlers cache rows across requests (the "performance" edit) is caught. Over a kit application (`access-fixture/`):
// a write and a link holder reach their own target, a seed meets a precondition, and a report `in` a scope that
// forgets the scope is caught. Skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset.

import { testKit } from '@fabrika/app/testing'
import { endpointAccessKit } from '@fabrika/app/testing/isolation'
import { type Ref, scoped, type Within } from '@fabrika/db'
import { defineStore, testDatabase } from '@fabrika/db/testing'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { implement } from '../implement/implement'
import { migration as accessMigration } from './access-fixture/migration'
import { accessApp } from './access-fixture/src/app'
import { tables as accessTables } from './access-fixture/src/db/tables'
import { contract } from './fixtures/scoped-notes/fabrika.contract'
import { migration } from './fixtures/scoped-notes/migration'
import { tables } from './fixtures/scoped-notes/src/db/tables'

const migrations = mkdtempSync(join(tmpdir(), 'fabrika-endpoint-access-'))
writeFileSync(join(migrations, '20261009120000_init.sql'), migration)
const postgres = await testDatabase({ migrations, label: 'endpoint-access.test.ts' })
const accessMigrations = mkdtempSync(join(tmpdir(), 'fabrika-endpoint-access-kit-'))
writeFileSync(join(accessMigrations, '20261012120000_notes.sql'), accessMigration)
const accessPostgres = await testDatabase({ migrations: accessMigrations, label: 'endpoint-access.test.ts' })

afterAll(async () => {
	await postgres?.close()
	await accessPostgres?.close()
	rmSync(migrations, { recursive: true, force: true })
	rmSync(accessMigrations, { recursive: true, force: true })
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
	const notes = defineStore(layer, 'notes', (t) => ({
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
		expect(await kit.leaked('api.notes.get', ID)).toEqual({ answered: true, leaked: [] })
		expect(await kit.leaked('api.notes.list', {})).toEqual({ answered: true, leaked: [] })
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
		expect(outcome.answered).toBe(true)
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
		await expect(kit.leaked('api.notes.reuse', {})).rejects.toThrow('not an endpoint of the contract with an action requirement')
		await expect(kit.own('api.notes.list', {})).rejects.toThrow('only on addresses an object of its own')
	})
})

const VERSIONED = { id: '00000000-0000-4000-8000-000000000000', expectVersion: 1 }

describe.skipIf(accessPostgres === null)('the endpoint access kit over a kit application', () => {
	const accessKit = () => {
		if (accessPostgres === null) throw new Error('no test database')
		return endpointAccessKit(accessApp(), accessTables, accessPostgres)
	}

	test('a caller holding only the write action reaches its own note, through the write handle', async () => {
		const kit = accessKit()
		expect(await kit.own('api.notes.trash', VERSIONED)).toEqual({ status: 200 })
		expect(await kit.denied('api.notes.trash', VERSIONED)).toEqual({ status: 404 })
	})

	test('a precondition the seed does not meet is an answer that leaks nothing; the seed meets it', async () => {
		const kit = accessKit()
		expect(await kit.leaked('api.notes.restore', VERSIONED)).toEqual({ answered: true, leaked: [] })
		expect(await kit.own('api.notes.restore', VERSIONED)).toEqual({ status: 409 })
		expect(await kit.own('api.notes.restore', VERSIONED, { trashed: true })).toEqual({ status: 200 })
		expect(await kit.leaked('api.notes.restore', VERSIONED, { trashed: true })).toEqual({ answered: true, leaked: [] })
	})

	test('a seed sets only the row its own state: a column that places it is refused', async () => {
		const kit = accessKit()
		await expect(kit.own('api.notes.restore', VERSIONED, { workspace_id: 'elsewhere' })).rejects.toThrow('places the row in its scope')
	})

	test('a report in a scope through ctx.sql answers its own scope only; one that forgets the scope is caught', async () => {
		const kit = accessKit()
		expect(await kit.leaked('api.notes.titles', { organizationId: 'x' })).toEqual({ answered: true, leaked: [] })
		const leaky = await kit.leaked('api.notes.everyTitle', { organizationId: 'x' })
		expect(leaky.answered).toBe(true)
		expect(leaky.leaked.length).toBeGreaterThan(0)
	})

	test('a report written with ctx.sql.scope answers its own scope only, in an outer scope and in a contained one', async () => {
		const kit = accessKit()
		expect(await kit.leaked('api.notes.scopedTitles', { organizationId: 'x' })).toEqual({ answered: true, leaked: [] })
		expect(await kit.leaked('api.notes.workspaceTitles', { workspaceId: 'x' })).toEqual({ answered: true, leaked: [] })
		expect(await kit.denied('api.notes.workspaceTitles', { workspaceId: 'x' })).toEqual({ status: 403 })
	})

	test('a scope ORed with a filter is refused before it is sent, so it leaks nothing; a parenthesized filter ANDed with it answers', async () => {
		const kit = accessKit()
		expect(await kit.leaked('api.notes.orTitles', { organizationId: 'x' })).toEqual({ answered: false, leaked: [], status: 500 })
		expect(await kit.leaked('api.notes.filteredTitles', { organizationId: 'x' })).toEqual({ answered: true, leaked: [] })
	})

	test('a handler that leaks only in the state a seed sets aside is caught by the unseeded probe', async () => {
		const kit = accessKit()
		const leaky = await kit.leaked('api.notes.peek', { id: VERSIONED.id })
		expect(leaky.answered).toBe(true)
		expect(leaky.leaked.length).toBeGreaterThan(0)
		expect(await kit.leaked('api.notes.peek', { id: VERSIONED.id }, { trashed: true })).toEqual({ answered: true, leaked: [] })
	})

	test('a seed may not replace a text marker the leak cases look for', async () => {
		const kit = accessKit()
		await expect(kit.leaked('api.notes.get', { id: VERSIONED.id }, { title: 'authored title' })).rejects.toThrow(
			'notes.title holds a text marker the leak cases look for',
		)
	})

	test("a report in an outer scope that answers another scope's values of it is caught", async () => {
		const leaky = await accessKit().leaked('api.notes.organizationIds', { organizationId: 'x' })
		expect(leaky.answered).toBe(true)
		expect(leaky.leaked.length).toBeGreaterThan(0)
	})

	test('the holder of a link bound to its own note reads it', async () => {
		expect(await accessKit().own('shared.note', {})).toEqual({ status: 200 })
	})

	test('the test kit runs a cron job under its lease, with the actions its key holds', async () => {
		if (accessPostgres === null) return
		const kit = testKit(accessApp(), { database: accessPostgres.database })
		const worlds = await accessPostgres.seedWorlds(accessTables, 'notes', { trashed: true })
		const editor = kit.testCaller([{ role: 'editor', scope: { type: 'workspace', value: worlds.own.scope } }])
		const read = () =>
			kit.browser(editor)('/api/notes.get', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: worlds.own.key }),
			})
		expect((await read()).status).toBe(200)
		expect(await kit.runJob('purge')).toEqual({ status: 'succeeded', attempts: 1 })
		expect((await read()).status).toBe(404)
	})
})
