// The typed client's file collections against the test kit on a REAL Postgres: a link holder uploads, lists and
// downloads its object's files, a signed-in caller does the same for an owner it names and removes one, and every
// answer is parsed. Skips cleanly without FABRIKA_TEST_POSTGRES_URL.

import { createClient, type InputOf, type ResultOf, RpcError } from '@fabrika/app/client'
import { FILE_SCAN_JOB, type FileScanner, type ScanBatchResult, type ScanVerdict } from '@fabrika/app/implement'
import { type TestKit, testKit } from '@fabrika/app/testing'
import { applicationSchema, Database } from '@fabrika/db'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { contract } from './fixtures/kit-files/fabrika.contract'
import { migration } from './fixtures/kit-files/migration'
import { filesApp } from './fixtures/kit-files/src/app'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''
if (!hasPostgres) {
	console.warn(`files-client.test.ts skipped its Postgres half: set ${URL_VAR} to run it`)
}

const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n')
const TEXT = new TextEncoder().encode('a plain note\n')
const schema = applicationSchema(`fclient-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`)
let database: Database

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

class CleanScanner implements FileScanner {
	async scan(objects: Parameters<FileScanner['scan']>[0], signal: AbortSignal): Promise<ScanBatchResult> {
		const verdicts = new Map<string, ScanVerdict>()
		for (const object of objects) {
			await new Response(await object.open(signal)).arrayBuffer()
			verdicts.set(object.id, { kind: 'clean' })
		}
		return { ok: true, verdicts }
	}
}

beforeAll(async () => {
	if (!hasPostgres) return
	await admin((sql) => sql.unsafe(`create schema ${schema}; set search_path to ${schema}; ${migration}`))
	database = Database.postgres({ url, schema, max: 4 })
})

afterAll(async () => {
	if (!hasPostgres) return
	await database.close()
	await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
})

async function seedNote(): Promise<string> {
	const id = Bun.randomUUIDv7()
	await admin((sql) =>
		sql.unsafe(`insert into ${schema}.notes (id, workspace_id, title, created_by, version) values ($1, 'w1', 'a note', 'user-1', 1)`, [id])
	)
	return id
}

function boot(): TestKit<typeof contract> {
	const app = filesApp({ sent: [], refusals: [], removed: [], failErase: false })
	return testKit(app.implementation, { database, files: new MemoryFileObjects(), scanner: new CleanScanner(), env: app.variables })
}

function holderClient(kit: TestKit<typeof contract>, note: string) {
	const scope = kit.scope('note', note)
	const holder = kit.testCaller([{ action: 'notes.read', scope }, { action: 'notes.write', scope }], {
		kind: 'link',
		link: { mount: 'share', chain: [scope, kit.scope('workspace', 'w1')] },
	})
	if (holder.key === null) throw new Error('a link holder presents a key')
	return createClient(contract, 'share', { key: holder.key, fetch: kit.fetch })
}

async function refusal(call: Promise<unknown>): Promise<unknown> {
	return await call.then(() => null, (error: unknown) => error)
}

test('a link client has the link: true collections only, and a session client every collection', () => {
	const share = createClient(contract, 'share', { key: 'px_unused' })
	const api = createClient(contract, 'api')
	expect(Object.keys(share.files)).toEqual(['documents'])
	expect(Object.keys(api.files)).toEqual(['documents', 'attachments'])
})

test('ResultOf and InputOf name what a procedure answers and takes', () => {
	const api = createClient(contract, 'api')
	const share = createClient(contract, 'share', { key: 'px_unused' })
	const answer: ResultOf<typeof api.notes.submit> = { id: Bun.randomUUIDv7(), version: 2 }
	const input: InputOf<typeof api.notes.submit> = { id: answer.id, expectVersion: 1 }
	const none: InputOf<typeof share.note> = undefined
	const title: ResultOf<typeof share.note> = { title: 'a note' }
	expect([answer.version, input.expectVersion, none, title.title]).toEqual([2, 1, undefined, 'a note'])
})

describe.skipIf(!hasPostgres)('the file collections of the typed client', () => {
	test("a link holder uploads, lists and downloads its object's file, served once the scan called it clean", async () => {
		const kit = boot()
		const note = await seedNote()
		const share = holderClient(kit, note)
		const { id } = await share.files.documents.upload(new File([PDF], 'cv.pdf', { type: 'application/pdf' }))
		const listed = await share.files.documents.list()
		expect(listed.items.map((file) => [file.id, file.name, file.status])).toEqual([[id, 'cv.pdf', 'quarantined']])
		expect(await refusal(share.files.documents.download(id))).toMatchObject({ httpStatus: 409, type: 'quarantined' })

		await kit.runJob(FILE_SCAN_JOB)
		const file = await share.files.documents.download(id)
		expect([file.name, file.type]).toEqual(['cv.pdf', 'application/pdf'])
		expect(new Uint8Array(await file.arrayBuffer())).toEqual(PDF)
	})

	test("a link holder reaches no other object's file", async () => {
		const kit = boot()
		const mine = await seedNote()
		const theirs = await seedNote()
		const { id } = await holderClient(kit, theirs).files.documents.upload(new File([PDF], 'cv.pdf', { type: 'application/pdf' }))
		const share = holderClient(kit, mine)
		expect((await share.files.documents.list()).items).toEqual([])
		expect(await refusal(share.files.documents.download(id))).toMatchObject({ httpStatus: 404 })
	})

	test('a signed-in caller uploads to the owner it names, lists, downloads and removes', async () => {
		const kit = boot()
		const note = await seedNote()
		const api = createClient(contract, 'api', { fetch: kit.browser(kit.testCaller([{ role: 'editor', scope: kit.scope('workspace', 'w1') }])) })
		const { id } = await api.files.attachments.upload(note, new Blob([TEXT], { type: 'text/plain' }), { name: 'notes.txt' })
		expect((await api.files.attachments.list({ owner: note })).items.map((file) => [file.id, file.name, file.size])).toEqual([[
			id,
			'notes.txt',
			TEXT.byteLength,
		]])
		const file = await api.files.attachments.download(id)
		expect(file.name).toBe('notes.txt')
		expect(new Uint8Array(await file.arrayBuffer())).toEqual(TEXT)
		expect(await api.files.attachments.remove({ id })).toEqual({ id })
		expect((await api.files.attachments.list({ owner: note })).items).toEqual([])
	})

	test('an upload of a type the collection does not declare is an RpcError: the proxy refuses it (400)', async () => {
		const kit = boot()
		const note = await seedNote()
		const api = createClient(contract, 'api', { fetch: kit.browser(kit.testCaller([{ role: 'editor', scope: kit.scope('workspace', 'w1') }])) })
		const refused = await refusal(api.files.documents.upload(note, new Blob([TEXT], { type: 'text/plain' })))
		expect(refused).toBeInstanceOf(RpcError)
		expect(refused).toMatchObject({ httpStatus: 400 })
	})
})
