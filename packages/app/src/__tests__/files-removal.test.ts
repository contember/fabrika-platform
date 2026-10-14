// Removing a record's files from server code, and the framework's scheduled sweep, on a REAL Postgres: an erasure job
// blanks a note and removes its files in its transaction, a mutation on the note removes them, and the sweep job deletes
// the objects of removed and orphaned files without any request, in a collection that does not scan too. Skips cleanly
// without FABRIKA_TEST_POSTGRES_URL.

import { createClient } from '@fabrika/app/client'
import { FILE_SWEEP_JOB } from '@fabrika/app/implement'
import { type TestKit, testKit } from '@fabrika/app/testing'
import { applicationSchema, Database } from '@fabrika/db'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { SQL } from 'bun'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { contract } from './fixtures/kit-files/fabrika.contract'
import { migration } from './fixtures/kit-files/migration'
import { filesApp } from './fixtures/kit-files/src/app'
import type { FilesWorld } from './fixtures/kit-files/src/world'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''
if (!hasPostgres) {
	console.warn(`files-removal.test.ts skipped: set ${URL_VAR} to run it (the file rows and the jobs' leases live in @fabrika/db)`)
}

const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n')
const schema = applicationSchema(`fremove-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`)
let database: Database

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

beforeAll(async () => {
	if (!hasPostgres) return
	await admin((sql) => sql.unsafe(`create schema ${schema}; set search_path to ${schema}; ${migration}`))
	database = Database.postgres({ url, schema, max: 4 })
})

beforeEach(async () => {
	if (!hasPostgres) return
	await admin((sql) =>
		sql.unsafe(
			`truncate ${schema}.fabrika_files_documents, ${schema}.fabrika_files_attachments, ${schema}.notes; delete from ${schema}.fabrika_job_leases`,
		)
	)
})

afterAll(async () => {
	if (!hasPostgres) return
	await database.close()
	await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
})

async function seedNote(title: string): Promise<string> {
	const id = Bun.randomUUIDv7()
	await admin((sql) =>
		sql.unsafe(`insert into ${schema}.notes (id, workspace_id, title, created_by, version) values ($1, 'w1', $2, 'user-1', 1)`, [id, title])
	)
	return id
}

async function titleOf(note: string): Promise<unknown> {
	const [row] = await admin((sql) => sql.unsafe(`select title from ${schema}.notes where id = $1`, [note]))
	return row?.title
}

async function rowsOf(collection: 'documents' | 'attachments'): Promise<number> {
	const [row] = await admin((sql) => sql.unsafe(`select count(*)::int as count from ${schema}.fabrika_files_${collection}`))
	return Number(row?.count)
}

interface Booted {
	readonly kit: TestKit<typeof contract>
	readonly world: FilesWorld
	readonly store: MemoryFileObjects
	readonly api: ReturnType<typeof createClient<typeof contract, 'api'>>
	upload(collection: 'documents' | 'attachments', note: string): Promise<string>
}

function boot(): Booted {
	const world: FilesWorld = { sent: [], refusals: [], removed: [], failErase: false }
	const app = filesApp(world)
	const store = new MemoryFileObjects()
	const kit = testKit(app.implementation, { database, files: store, env: app.variables })
	const api = createClient(contract, 'api', { fetch: kit.browser(kit.testCaller([{ role: 'editor', scope: kit.scope('workspace', 'w1') }])) })
	return {
		kit,
		world,
		store,
		api,
		upload: async (collection, note) => (await api.files[collection].upload(note, new File([PDF], 'a.pdf', { type: 'application/pdf' }))).id,
	}
}

describe.skipIf(!hasPostgres)('removing files from server code', () => {
	test('an erasure job blanks a note and removes its files in one transaction; the sweep job then deletes their objects', async () => {
		const { kit, world, store, api, upload } = boot()
		const erased = await seedNote('erase me')
		const kept = await seedNote('keep me')
		await upload('attachments', erased)
		await upload('attachments', erased)
		await upload('documents', erased)
		const other = await upload('attachments', kept)

		expect(await kit.runJob('erase')).toEqual({ status: 'succeeded', attempts: 1 })
		expect(world.removed).toEqual([2, 1])
		expect(await titleOf(erased)).toBe('')
		expect((await api.files.attachments.list({ owner: erased })).items).toEqual([])
		expect((await api.files.documents.list({ owner: erased })).items).toEqual([])
		expect(store.objects.size).toBe(4)

		expect(await kit.runJob(FILE_SWEEP_JOB)).toEqual({ status: 'succeeded', attempts: 1 })
		expect([...store.objects.keys()]).toEqual([`attachments/${other}`])
		expect([await rowsOf('attachments'), await rowsOf('documents')]).toEqual([1, 0])
		expect(await titleOf(kept)).toBe('keep me')
	})

	test('a removal whose transaction rolls back removes nothing', async () => {
		const { kit, world, store, api, upload } = boot()
		const note = await seedNote('erase me')
		await upload('attachments', note)
		world.failErase = true

		expect(await kit.runJob('erase')).toMatchObject({ status: 'failed', code: 'handler_failed' })
		expect(await titleOf(note)).toBe('erase me')
		expect((await api.files.attachments.list({ owner: note })).items).toHaveLength(1)
		await kit.runJob(FILE_SWEEP_JOB)
		expect(store.objects.size).toBe(1)
	})

	test('a mutation on the owner removes its files under the collection’s delete action', async () => {
		const { kit, store, api, upload } = boot()
		const note = await seedNote('a note')
		await upload('attachments', note)
		expect(await api.notes.clear({ id: note })).toEqual({ files: 1 })
		expect((await api.files.attachments.list({ owner: note })).items).toEqual([])
		await kit.runJob(FILE_SWEEP_JOB)
		expect(store.objects.size).toBe(0)
	})

	test('the sweep job deletes an orphaned file of a collection that does not scan, without any request', async () => {
		const { kit, store, upload } = boot()
		const note = await seedNote('a note')
		const id = await upload('attachments', note)
		await admin((sql) => sql.unsafe(`delete from ${schema}.notes where id = $1`, [note]))
		expect([...store.objects.keys()]).toEqual([`attachments/${id}`])

		expect(await kit.runJob(FILE_SWEEP_JOB)).toEqual({ status: 'succeeded', attempts: 1 })
		expect(store.objects.size).toBe(0)
		expect(await rowsOf('attachments')).toBe(0)
	})
})
