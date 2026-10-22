// The test kit over an application on `@fabrika/db`: the kit hands `boot` the connection a runtime adapter would, so
// the scoped layer runs on a REAL Postgres behind the production proxy decision. Skips cleanly when
// FABRIKA_TEST_POSTGRES_URL is unset; the file gets its own application schema `app_<id>`.

import { createClient, RpcError } from '@fabrika/app/client'
import { testKit } from '@fabrika/app/testing'
import { applicationSchema, Database, type Ref, scoped, type Within } from '@fabrika/db'
import { openPostgres } from '@fabrika/db/postgres'
import { defineStore } from '@fabrika/db/testing'
import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { implement } from '../implement/implement'
import { contract } from './fixtures/scoped-notes/fabrika.contract'
import { migration } from './fixtures/scoped-notes/migration'
import { tables } from './fixtures/scoped-notes/src/db/tables'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''

if (!hasPostgres) {
	console.warn(`test-kit-database.test.ts skipped: set ${URL_VAR} to run the Postgres-backed tests`)
}

const schema = applicationSchema(`kit-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`)

/**
 * The fixture's contract over a data layer of its own: a data layer is bound once per process, and
 * `scoped-database.test.ts` binds the fixture's.
 */
function kitNotesApp() {
	const layer = scoped(tables)
	const notes = defineStore(layer, 'notes', (t) => ({
		list: (within: Within<'workspace', 'notes.read'>) => t.select(within, (q) => q.columns(['id', 'title']).orderBy('id')),
		get: (note: Ref<'note', 'notes.read'>) => t.get(note),
		create: (workspace: Ref<'workspace', 'notes.write'>, title: string) => t.insert(workspace, { title }),
	}))
	return implement(contract, {
		database: layer,
		deps: () => ({}),
		handlers: () => ({
			api: {
				notes: {
					list: async ({ ctx }) => ({ items: await notes.list(ctx.within) }),
					get: async ({ ctx }) => {
						const note = await notes.get(ctx.target)
						return { id: note.id, title: note.title }
					},
					create: async ({ input, ctx }) => ({ id: (await notes.create(ctx.target, input.title)).id }),
					keep: () => ({ kept: true }),
					reuse: () => Promise.reject(new Error('not used here')),
				},
			},
		}),
	})
}
let database: Database

async function admin(statement: string): Promise<void> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		await sql.unsafe(statement)
	} finally {
		await sql.close()
	}
}

beforeAll(async () => {
	if (hasPostgres) {
		await admin(`create schema ${schema}; set search_path to ${schema}; ${migration}`)
		database = openPostgres({ url, schema, max: 2 })
	}
})

afterAll(async () => {
	if (hasPostgres) {
		await database.close()
		await admin(`drop schema ${schema} cascade`)
	}
})

test('a scoped database without a connection does not boot, as boot refuses it', () => {
	expect(() => testKit(kitNotesApp())).toThrow('the runtime adapter supplies no database connection')
})

describe.skipIf(!hasPostgres)('the kit over @fabrika/db on Postgres', () => {
	test('an editor creates and reads in its workspace; another workspace’s note is 404', async () => {
		const kit = testKit(kitNotesApp(), { database })
		const w1 = createClient(contract, 'api', { fetch: kit.browser(kit.testCaller([{ role: 'editor', scope: { type: 'workspace', value: 'w1' } }])) })
		const w2 = createClient(contract, 'api', { fetch: kit.browser(kit.testCaller([{ role: 'editor', scope: { type: 'workspace', value: 'w2' } }])) })
		const { id } = await w1.notes.create({ workspaceId: 'w1', title: 'first' })
		expect(await w1.notes.get({ id })).toEqual({ id, title: 'first' })
		const refused = await w2.notes.get({ id }).then(() => null, (error: unknown) => error)
		expect(refused).toBeInstanceOf(RpcError)
		expect(refused).toMatchObject({ httpStatus: 404 })
	})
})
