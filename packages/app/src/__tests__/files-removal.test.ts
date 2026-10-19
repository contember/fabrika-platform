// Removing a record's files from server code, and the framework's scheduled sweep, on a REAL Postgres: an erasure job
// blanks a note and deletes the rows that reference its files in its transaction, a mutation on the note deletes them,
// and the sweep job deletes each file no column references once past the pending grace, with its object, without any
// request, of a kind that does not scan too. Skips cleanly without FABRIKA_TEST_POSTGRES_URL.

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
			`truncate ${schema}.note_documents, ${schema}.note_attachments, ${schema}.notes; delete from ${schema}.fabrika_files; delete from ${schema}.fabrika_job_leases`,
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

async function rowsOf(table: 'note_documents' | 'note_attachments'): Promise<number> {
	const [row] = await admin((sql) => sql.unsafe(`select count(*)::int as count from ${schema}.${table}`))
	return Number(row?.count)
}

async function filesOf(kind: 'documents' | 'attachments'): Promise<number> {
	const [row] = await admin((sql) => sql.unsafe(`select count(*)::int as count from ${schema}.fabrika_files where kind = $1`, [kind]))
	return Number(row?.count)
}

/** Every file is past the pending grace: what the sweep sees an hour later. */
async function pastGrace(): Promise<void> {
	await admin((sql) => sql.unsafe(`update ${schema}.fabrika_files set created_at = now() - interval '2 hours'`))
}

interface Booted {
	readonly kit: TestKit<typeof contract>
	readonly world: FilesWorld
	readonly store: MemoryFileObjects
	readonly api: ReturnType<typeof createClient<typeof contract, 'api'>>
	upload(kind: 'documents' | 'attachments', note: string): Promise<void>
}

function boot(): Booted {
	const world: FilesWorld = { sent: [], removed: [], failErase: false }
	const app = filesApp(world)
	const store = new MemoryFileObjects()
	const kit = testKit(app.implementation, { database, files: store, env: app.variables })
	const api = createClient(contract, 'api', { fetch: kit.browser(kit.testCaller([{ role: 'editor', scope: kit.scope('workspace', 'w1') }])) })
	return {
		kit,
		world,
		store,
		api,
		upload: async (kind, note) => {
			const file = new File([PDF], 'a.pdf', { type: 'application/pdf' })
			await (kind === 'documents' ? api.notes.upload({ id: note, file }) : api.notes.attach({ id: note, file }))
		},
	}
}

describe.skipIf(!hasPostgres)('removing files from server code', () => {
	test('an erasure job blanks a note and deletes the rows of its files in one transaction; the sweep job then deletes the files', async () => {
		const { kit, world, store, api, upload } = boot()
		const erased = await seedNote('erase me')
		const kept = await seedNote('keep me')
		await upload('attachments', erased)
		await upload('attachments', erased)
		await upload('documents', erased)
		await upload('attachments', kept)

		expect(await kit.runJob('erase')).toEqual({ status: 'succeeded', attempts: 1 })
		expect(world.removed).toEqual([2, 1])
		expect(await titleOf(erased)).toBe('')
		expect(await api.notes.attached({ id: erased })).toEqual({ files: 0 })
		expect(await rowsOf('note_documents')).toBe(0)
		expect(store.objects.size).toBe(4)

		// Within the grace the sweep keeps an unreferenced file; past it, it deletes the file and its object.
		expect(await kit.runJob(FILE_SWEEP_JOB)).toEqual({ status: 'succeeded', attempts: 1 })
		expect(store.objects.size).toBe(4)
		await pastGrace()
		expect(await kit.runJob(FILE_SWEEP_JOB)).toEqual({ status: 'succeeded', attempts: 1 })
		expect(store.objects.size).toBe(1)
		expect([await filesOf('attachments'), await filesOf('documents')]).toEqual([1, 0])
		expect(await api.notes.attached({ id: kept })).toEqual({ files: 1 })
		expect(await titleOf(kept)).toBe('keep me')
	})

	test('a removal whose transaction rolls back removes nothing', async () => {
		const { kit, world, store, api, upload } = boot()
		const note = await seedNote('erase me')
		await upload('attachments', note)
		world.failErase = true

		expect(await kit.runJob('erase')).toMatchObject({ status: 'failed', code: 'handler_failed' })
		expect(await titleOf(note)).toBe('erase me')
		expect(await api.notes.attached({ id: note })).toEqual({ files: 1 })
		await pastGrace()
		await kit.runJob(FILE_SWEEP_JOB)
		expect(store.objects.size).toBe(1)
	})

	test("a mutation on the note deletes the rows of its files under the table's delete action", async () => {
		const { kit, store, api, upload } = boot()
		const note = await seedNote('a note')
		await upload('attachments', note)
		expect(await api.notes.clear({ id: note })).toEqual({ files: 1 })
		expect(await api.notes.attached({ id: note })).toEqual({ files: 0 })
		await pastGrace()
		await kit.runJob(FILE_SWEEP_JOB)
		expect(store.objects.size).toBe(0)
	})

	test('the sweep job deletes a file of a kind that does not scan once nothing references it, without any request', async () => {
		const { kit, store, upload } = boot()
		const note = await seedNote('a note')
		await upload('attachments', note)
		await admin((sql) => sql.unsafe(`delete from ${schema}.note_attachments`))
		await admin((sql) => sql.unsafe(`delete from ${schema}.notes where id = $1`, [note]))
		expect(store.objects.size).toBe(1)
		await pastGrace()

		expect(await kit.runJob(FILE_SWEEP_JOB)).toEqual({ status: 'succeeded', attempts: 1 })
		expect(store.objects.size).toBe(0)
		expect(await filesOf('attachments')).toBe(0)
	})

	test('the sweep keeps a file a column still references, however old', async () => {
		const { kit, store, api, upload } = boot()
		const note = await seedNote('a note')
		await upload('attachments', note)
		await pastGrace()
		expect(await kit.runJob(FILE_SWEEP_JOB)).toEqual({ status: 'succeeded', attempts: 1 })
		expect(store.objects.size).toBe(1)
		expect(await api.notes.attached({ id: note })).toEqual({ files: 1 })
	})
})
