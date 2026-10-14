// `ctx.files` of a kit application on a REAL Postgres: a job that mails a note's clean documents read whole, a
// mutation that requires a document, and every refusal of a capability that does not take the collection's action.
// Skips cleanly without FABRIKA_TEST_POSTGRES_URL.

import { createClient, RpcError } from '@fabrika/app/client'
import { FILE_SCAN_JOB, type FileScanner, type ScanBatchResult, type ScanVerdict } from '@fabrika/app/implement'
import { type TestKit, testKit } from '@fabrika/app/testing'
import { applicationSchema, Database } from '@fabrika/db'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { SQL } from 'bun'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { CapabilityRefusedError } from '../implement/capability'
import { ServerFault } from '../implement/faults'
import { contract } from './fixtures/kit-files/fabrika.contract'
import { migration } from './fixtures/kit-files/migration'
import { filesApp } from './fixtures/kit-files/src/app'
import type { FilesWorld } from './fixtures/kit-files/src/world'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''
if (!hasPostgres) {
	console.warn(`files-handle.test.ts skipped: set ${URL_VAR} to run it (the file rows and the jobs' leases live in @fabrika/db)`)
}

const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n')
const schema = applicationSchema(`fhandle-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`)
let database: Database

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

/** Calls every file it was handed clean, after reading it whole. */
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

async function seedNote(title = 'a note'): Promise<string> {
	const id = Bun.randomUUIDv7()
	await admin((sql) =>
		sql.unsafe(`insert into ${schema}.notes (id, workspace_id, title, created_by, version) values ($1, 'w1', $2, 'user-1', 1)`, [id, title])
	)
	return id
}

interface Booted {
	readonly kit: TestKit<typeof contract>
	readonly world: FilesWorld
	readonly store: MemoryFileObjects
	upload(collection: 'documents' | 'attachments', note: string, name?: string): Promise<string>
}

function boot(): Booted {
	const world: FilesWorld = { sent: [], refusals: [], removed: [], failErase: false }
	const app = filesApp(world)
	const store = new MemoryFileObjects()
	const kit = testKit(app.implementation, { database, files: store, scanner: new CleanScanner(), env: app.variables })
	const editor = kit.browser(kit.testCaller([{ role: 'editor', scope: kit.scope('workspace', 'w1') }]))
	return {
		kit,
		world,
		store,
		async upload(collection, note, name = 'brief.pdf') {
			const response = await editor(`/api/files.${collection}.upload/${note}?name=${name}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/pdf' },
				body: PDF,
			})
			const body: unknown = await response.json()
			const result = typeof body === 'object' && body !== null && 'result' in body ? body.result : null
			const id = typeof result === 'object' && result !== null && 'id' in result ? result.id : null
			if (response.status !== 200 || typeof id !== 'string') throw new Error(`expected an upload, got ${response.status}`)
			return id
		},
	}
}

function api(kit: TestKit<typeof contract>) {
	return createClient(contract, 'api', { fetch: kit.browser(kit.testCaller([{ role: 'editor', scope: kit.scope('workspace', 'w1') }])) })
}

describe.skipIf(!hasPostgres)('ctx.files of a job', () => {
	test("mails a note's document read whole once its scan called it clean, and nothing while it is quarantined", async () => {
		const { kit, world, upload } = boot()
		const note = await seedNote()
		await seedNote()
		await upload('documents', note)

		expect(await kit.runJob('mail')).toEqual({ status: 'succeeded', attempts: 1 })
		expect(world.sent).toEqual([])

		expect(await kit.runJob(FILE_SCAN_JOB)).toEqual({ status: 'succeeded', attempts: 1 })
		expect(await kit.runJob('mail')).toEqual({ status: 'succeeded', attempts: 1 })
		expect(world.sent).toEqual([{ note, attachments: [{ name: 'brief.pdf', type: 'application/pdf', bytes: PDF }] }])
	})

	test("refuses a capability of another action than the collection's, another note's file, a quarantined or too large one", async () => {
		const { kit, world, upload } = boot()
		const first = await seedNote()
		const second = await seedNote()
		await upload('documents', first)
		await upload('attachments', second, 'notes.pdf')

		expect(await kit.runJob('peek')).toEqual({ status: 'succeeded', attempts: 1 })
		const steps = world.refusals.map(({ step, error }) => [step, refusalOf(error)])
		expect(steps).toEqual([
			['list with notes.delete', 'CapabilityRefusedError wrong_capability'],
			['open with notes.read', 'CapabilityRefusedError wrong_capability'],
			['open quarantined', 'HttpError 409 quarantined'],
			['list with the write action only', 'CapabilityRefusedError wrong_capability'],
			['list with notes.delete', 'CapabilityRefusedError wrong_capability'],
			['open of another note', 'NotFoundError 404 not_found'],
			['list with the write action only', 'CapabilityRefusedError wrong_capability'],
			['open over maxBytes', 'HttpError 413 too_large'],
			['an unknown collection', 'ServerFault file_collection_unknown'],
		])
	})
})

function refusalOf(error: unknown): string {
	if (error instanceof CapabilityRefusedError) return `CapabilityRefusedError ${error.reason}`
	if (error instanceof ServerFault) return `ServerFault ${error.reason}`
	if (error instanceof Error && 'httpStatus' in error && 'type' in error) return `${error.name} ${String(error.httpStatus)} ${String(error.type)}`
	return 'unexpected'
}

describe.skipIf(!hasPostgres)('ctx.files of an endpoint', () => {
	test('a mutation refuses while its note has no live or quarantined document, and passes once one is uploaded', async () => {
		const { kit, upload } = boot()
		const note = await seedNote()
		const client = api(kit)
		const refused = await client.notes.submit({ id: note, expectVersion: 1 }).then(() => null, (error: unknown) => error)
		expect(refused).toBeInstanceOf(RpcError)
		expect(refused).toMatchObject({ httpStatus: 409 })
		await upload('documents', note)
		expect(await client.notes.submit({ id: note, expectVersion: 1 })).toEqual({ id: note, version: 2 })
	})

	test('a query lists the files its capability reaches, and fails with a capability of another action than the read one', async () => {
		const { kit, upload } = boot()
		const note = await seedNote()
		await upload('attachments', note)
		const client = api(kit)
		expect(await client.notes.attached({ id: note })).toEqual({ files: 1 })
		const refused = await client.notes.peek({ id: note }).then(() => null, (error: unknown) => error)
		expect(refused).toMatchObject({ httpStatus: 500 })
	})
})
