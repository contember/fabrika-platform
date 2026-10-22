// A file kind with `scan: true` through boot's real pipeline on a REAL Postgres: an uploaded file waits `quarantined`,
// the scan job promotes it or rejects it under its lease, a download answers by state, and a list of its column shows
// each one. Every scan that does not complete with a clean verdict over the uploaded bytes — no scanner, a failed or
// timed-out run, a skipped or truncated file, a lost lease — leaves the file unserved. Runs against an in-memory object store and a real
// S3 bucket when FABRIKA_TEST_S3_* is set, with a stand-in scanner and a REAL clamscan when FABRIKA_TEST_CLAMSCAN_BIN
// names one (see clamscan.test.ts). Skips cleanly without FABRIKA_TEST_POSTGRES_URL.

import { NotFoundError } from '@fabrika/app'
import { defineApp, defineVocabulary, file } from '@fabrika/app/contract'
import {
	FILE_SCAN_JOB,
	type FileScanner,
	type JobClock,
	type OperationsReport,
	type OperationsReporter,
	SCAN_LIMITS,
	type ScanBatchResult,
	serve,
} from '@fabrika/app/implement'
import { PROXY_TOKEN_HEADER } from '@fabrika/auth-core'
import { applicationSchema, Database, scoped, type TypedColumnList } from '@fabrika/db'
import { FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'
import { openPostgres } from '@fabrika/db/postgres'
import { defineTables } from '@fabrika/db/tables'
import type { FileObjectStore, ObjectMetadata, ObjectWriteOptions, StoredObject } from '@fabrika/platform'
import { S3BlobStore } from '@fabrika/platform-node'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { SQL } from 'bun'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { clamscanScanner } from '../files/clamscan'
import type { ContractApp } from '../implement/boot'
import { bootApp, errorType, grant, ORIGIN, type Sent, token } from './fixtures/implement/harness'
import { CLEAN_PDF, damagedZip, EICAR, encryptedZip, LZMA_EICAR_ZIP, zipOf } from './fixtures/scan-samples'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''
const clamscan = process.env['FABRIKA_TEST_CLAMSCAN_BIN'] ?? ''

if (!hasPostgres) {
	console.warn(`file-scan.test.ts skipped: set ${URL_VAR} to run it`)
}

const vocabulary = defineVocabulary({
	app: 'notes',
	dimensions: { workspace: {}, note: { in: 'workspace' } },
	actions: { 'notes.read': 'Read notes', 'notes.write': 'Create and edit notes' },
	roles: { editor: { grants: ['notes.read', 'notes.write'] } },
})

interface NotesTable {
	id: string
	workspace_id: string
	title: string
	created_by: string
	version: number
}

interface FilesTable {
	id: string
	note_id: string
	workspace_id: string
	file: string
}

interface DB {
	notes: NotesTable
	note_uploads: FilesTable
	note_photos: FilesTable
}

const fileColumns = ['id', 'note_id', 'workspace_id', 'file'] as const
const ofNote = [{ columns: ['note_id', 'workspace_id'], table: 'notes', references: ['id', 'workspace_id'] }] as const
const columns: TypedColumnList<DB> = {
	notes: { columns: ['id', 'workspace_id', 'title', 'created_by', 'version'], foreignKeys: [] },
	note_uploads: { columns: fileColumns, foreignKeys: ofNote },
	note_photos: { columns: fileColumns, foreignKeys: ofNote },
}

const tables = defineTables(vocabulary, columns)({
	notes: {
		scope: { dimension: 'note', key: 'id', in: { dimension: 'workspace', column: 'workspace_id' } },
		actions: { read: 'notes.read', insert: 'notes.write' },
		insert: ['title'],
		version: 'version',
		createdBy: 'created_by',
	},
	note_uploads: { scope: { child: 'notes' }, actions: { read: 'notes.read', insert: 'notes.write' }, insert: ['file'], files: { file: 'uploads' } },
	note_photos: { scope: { child: 'notes' }, actions: { read: 'notes.read', insert: 'notes.write' }, insert: ['file'], files: { file: 'photos' } },
})

const app = defineApp(vocabulary, tables)
const Uploaded = z.strictObject({ id: z.uuid() })
const InNote = z.strictObject({ noteId: z.uuid() })

const notes = app.group({ callers: ['human'] }, (r) => ({
	upload: r.mutation({
		input: z.strictObject({ noteId: z.uuid(), file: file('uploads') }),
		output: Uploaded,
		access: { action: 'notes.write', on: 'note', from: 'noteId' },
	}).handle(async ({ input, ctx }) => {
		await ctx.db.target.note_uploads.insert({ file: input.file })
		return { id: input.file.id }
	}),
	photo: r.mutation({
		input: z.strictObject({ noteId: z.uuid(), file: file('photos') }),
		output: Uploaded,
		access: { action: 'notes.write', on: 'note', from: 'noteId' },
	}).handle(async ({ input, ctx }) => {
		await ctx.db.target.note_photos.insert({ file: input.file })
		return { id: input.file.id }
	}),
	download: r.query({
		input: z.strictObject({ noteId: z.uuid(), id: z.uuid() }),
		output: file('uploads'),
		access: { action: 'notes.read', on: 'note', from: 'noteId' },
	}).handle(async ({ input, ctx }) => {
		const row = (await ctx.db.target.note_uploads.list()).items.find((item) => item.file.id === input.id)
		if (row === undefined) throw new NotFoundError('no such upload')
		return row.file
	}),
	uploads: r.query({
		input: InNote,
		output: z.strictObject({ items: z.array(z.strictObject({ id: z.uuid(), status: z.string(), type: z.string(), size: z.int() })) }),
		access: { action: 'notes.read', on: 'note', from: 'noteId' },
	}).handle(async ({ ctx }) => ({
		items: (await ctx.db.target.note_uploads.list({ orderBy: [['id', 'asc']] })).items.map(({ file }) => ({
			id: file.id,
			status: file.status,
			type: file.type,
			size: file.size,
		})),
	})),
}))

const contract = app.contract((c) => ({
	api: c.rpc('/api', { notes }),
	files: {
		uploads: c.files({ maxBytes: 65536, types: ['application/pdf', 'text/plain', 'application/zip'], scan: true }),
		photos: c.files({ maxBytes: 65536, types: ['text/plain'], scan: true }),
	},
	health: c.health('/healthz'),
}))
const filesApp = () => serve(contract, { database: scoped(tables) })

const appId = `scan-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
const schema = applicationSchema(appId)
const W1 = { type: 'workspace', value: 'w1' }
const W2 = { type: 'workspace', value: 'w2' }
const SECOND = 1000

const fileTable = (name: string) => `
create table ${name} (
	id uuid primary key,
	note_id uuid not null,
	workspace_id text not null,
	file uuid not null references fabrika_files (id),
	foreign key (note_id, workspace_id) references notes (id, workspace_id)
);
create index ${name}_file on ${name} (file);`

const migration = `
${FRAMEWORK_MIGRATIONS.map((migrationFile) => migrationFile.sql).join('\n')}
create table notes (id uuid primary key, workspace_id text not null, title text not null, created_by text not null, version integer not null, unique (id, workspace_id));
${fileTable('note_uploads')}
${fileTable('note_photos')}
`

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

async function seedNote(workspace = 'w1'): Promise<string> {
	const id = Bun.randomUUIDv7()
	await admin((sql) =>
		sql.unsafe(`insert into ${schema}.notes (id, workspace_id, title, created_by, version) values ($1, $2, 'note', 'user-9', 1)`, [id, workspace])
	)
	return id
}

const editorOf = (...workspaces: (typeof W1)[]): Promise<string> =>
	token('user', workspaces.flatMap((scope) => [grant('notes.read', scope), grant('notes.write', scope)]))

type KindName = 'uploads' | 'photos'

const EXTENSIONS: Readonly<Record<string, string>> = { 'application/pdf': 'pdf', 'text/plain': 'txt', 'application/zip': 'zip' }

/** The note each uploaded file is attached to: a download names both. */
const noteOf = new Map<string, string>()

async function upload(
	app: ContractApp,
	note: string,
	bytes: Uint8Array<ArrayBuffer> | string,
	type: string,
	callerToken: string,
	kind: KindName = 'uploads',
): Promise<Sent> {
	const form = new FormData()
	form.append('input', JSON.stringify({ noteId: note }))
	form.append('file', new File([bytes], `upload.${EXTENSIONS[type] ?? 'bin'}`, { type }))
	const headers = new Headers({ 'Sec-Fetch-Site': 'same-origin', [PROXY_TOKEN_HEADER]: callerToken })
	const path = kind === 'uploads' ? '/api/notes.upload' : '/api/notes.photo'
	const response = await app.fetch(new Request(`${ORIGIN}${path}`, { method: 'POST', headers, body: form }))
	return { status: response.status, headers: response.headers, body: await response.json() }
}

async function uploaded(
	app: ContractApp,
	note: string,
	bytes: Uint8Array<ArrayBuffer> | string,
	type = 'text/plain',
	kind: KindName = 'uploads',
): Promise<string> {
	const sent = await upload(app, note, bytes, type, await editorOf(W1), kind)
	const id = Uploaded.parse(z.strictObject({ result: z.unknown() }).parse(sent.body).result).id
	noteOf.set(id, note)
	return id
}

async function download(app: ContractApp, id: string, callerToken?: string): Promise<Response> {
	const query = new URLSearchParams({ noteId: noteOf.get(id) ?? '', id })
	return app.fetch(new Request(`${ORIGIN}/api/notes.download?${query}`, { headers: { [PROXY_TOKEN_HEADER]: callerToken ?? (await editorOf(W1)) } }))
}

async function list(app: ContractApp, note: string): Promise<unknown> {
	const response = await app.fetch(
		new Request(`${ORIGIN}/api/notes.uploads`, {
			method: 'POST',
			headers: { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', [PROXY_TOKEN_HEADER]: await editorOf(W1) },
			body: JSON.stringify({ noteId: note }),
		}),
	)
	return z.strictObject({ result: z.unknown() }).parse(await response.json()).result
}

async function errorOf(response: Response): Promise<unknown> {
	return errorType({ status: response.status, headers: response.headers, body: await response.json() })
}

async function attemptsOf(id: string): Promise<unknown> {
	const [row] = await admin((sql) => sql.unsafe(`select scan_attempts from ${schema}.fabrika_files where id = $1`, [id]))
	return row?.scan_attempts
}

/** Every deferred retry is due now: what the passes of the next hour would see. */
async function dueNow(): Promise<void> {
	await admin((sql) => sql.unsafe(`update ${schema}.fabrika_files set scan_after = now() - interval '1 second' where scan_after > now()`))
}

/** Replaces an object outside the upload path, as an operator or another writer with the bucket's key could. */
async function replaceObject(store: FileObjectStore, key: string, text: string): Promise<void> {
	if (store instanceof MemoryFileObjects) {
		store.replace(key, new TextEncoder().encode(text))
	} else if (store instanceof S3BlobStore) {
		await store.put(key, text)
	} else {
		throw new Error('no way to replace an object of this store')
	}
}

async function statusOf(id: string): Promise<unknown> {
	const [row] = await admin((sql) => sql.unsafe(`select status from ${schema}.fabrika_files where id = $1`, [id]))
	return row?.status
}

class RecordingReporter implements OperationsReporter {
	readonly reports: OperationsReport[] = []

	report(report: OperationsReport): Promise<void> {
		this.reports.push(report)
		return Promise.resolve()
	}

	types(): string[] {
		return this.reports.map((report) => report.type)
	}
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<string> {
	const reader = body.getReader()
	const decoder = new TextDecoder()
	let text = ''
	for (let next = await reader.read(); !next.done; next = await reader.read()) {
		text += decoder.decode(next.value, { stream: true })
	}
	return text + decoder.decode()
}

type BatchOverride = (objects: Parameters<FileScanner['scan']>[0], signal: AbortSignal) => Promise<ScanBatchResult>

/**
 * Stands in for ClamAV as the real one answers: EICAR is infected, an archive whose entry carries the encryption flag
 * is `Heuristics.Encrypted.Zip`, everything else read in full is clean, and a file it could not read gets no verdict.
 */
class StandInScanner implements FileScanner {
	next: BatchOverride | null = null

	async scan(objects: Parameters<FileScanner['scan']>[0], signal: AbortSignal): Promise<ScanBatchResult> {
		const override = this.next
		this.next = null
		if (override !== null) {
			return override(objects, signal)
		}
		return judge(objects, signal)
	}
}

const joined = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => new Uint8Array(parts.flatMap((part) => [...part]))

/** An upload the stand-in, like ClamAV for some inputs, never gives a verdict. */
const UNSCANNABLE = 'UNSCANNABLE'

async function judge(objects: Parameters<FileScanner['scan']>[0], signal = new AbortController().signal): Promise<ScanBatchResult> {
	const verdicts = new Map<string, { readonly kind: 'clean' } | { readonly kind: 'infected'; readonly signature: string }>()
	for (const object of objects) {
		try {
			const text = await readAll(await object.open(signal))
			if (text.includes(UNSCANNABLE)) continue
			verdicts.set(
				object.id,
				text.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') ? { kind: 'infected', signature: 'Eicar-Test-Signature' } : { kind: 'clean' },
			)
		} catch {
			// What it could not read has no verdict.
		}
	}
	return { ok: true, verdicts }
}

/** A store whose next `failDeletes` deletes throw, as a lost connection to the bucket would. */
class FlakyDeletes implements FileObjectStore {
	failDeletes = 0
	readonly #inner: FileObjectStore

	constructor(inner: FileObjectStore) {
		this.#inner = inner
	}

	write(key: string, body: ReadableStream<Uint8Array>, options: ObjectWriteOptions): Promise<ObjectMetadata> {
		return this.#inner.write(key, body, options)
	}

	read(key: string, signal?: AbortSignal): Promise<StoredObject | null> {
		return this.#inner.read(key, signal)
	}

	readVersion(key: string, version: string, signal?: AbortSignal): Promise<StoredObject | null> {
		return this.#inner.readVersion(key, version, signal)
	}

	delete(key: string): Promise<void> {
		if (this.failDeletes > 0) {
			this.failDeletes--
			return Promise.reject(new Error('the bucket is unreachable'))
		}
		return this.#inner.delete(key)
	}
}

function s3Store(): FileObjectStore | undefined {
	const bucket = process.env['FABRIKA_TEST_S3_BUCKET'] ?? ''
	if (bucket === '') {
		return undefined
	}
	return S3BlobStore.connect({
		bucket,
		accessKeyId: process.env['FABRIKA_TEST_S3_ACCESS_KEY_ID'] ?? '',
		secretAccessKey: process.env['FABRIKA_TEST_S3_SECRET_ACCESS_KEY'] ?? '',
		endpoint: process.env['FABRIKA_TEST_S3_ENDPOINT'] ?? '',
		region: process.env['FABRIKA_TEST_S3_REGION'] ?? 'us-east-1',
		virtualHostedStyle: false,
	})
}

async function scanPass(app: ContractApp, clock?: JobClock): Promise<{ readonly reporter: RecordingReporter; readonly result: unknown }> {
	const reporter = new RecordingReporter()
	const result = await app.jobs.run(FILE_SCAN_JOB, { reporter, ...(clock === undefined ? {} : { clock }) })
	return { reporter, result }
}

let database: Database

beforeAll(async () => {
	if (!hasPostgres) {
		return
	}
	await admin((sql) => sql.unsafe(`create schema ${schema}; set search_path to ${schema}; ${migration}`))
	database = openPostgres({ url, schema, max: 4 })
})

afterAll(async () => {
	if (!hasPostgres) {
		return
	}
	await database.close()
	await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
})

/** Each test scans only its own uploads: an earlier test's leftovers are rejected first, so no pass takes them. */
async function clearBacklog(): Promise<void> {
	if (hasPostgres) {
		await admin((sql) => sql.unsafe(`update ${schema}.fabrika_files set status = 'rejected' where status = 'quarantined'`))
	}
}

const stores: (readonly [string, () => FileObjectStore])[] = [['memory', () => new MemoryFileObjects()]]
const s3 = s3Store()
if (s3 !== undefined) {
	stores.push(['s3', () => s3])
}
const scanners: (readonly [string, () => FileScanner])[] = [['a stand-in scanner', () => new StandInScanner()]]
if (clamscan !== '') {
	scanners.push(['a real clamscan', () => clamscanScanner({ binary: clamscan })])
}

for (const [storeLabel, makeStore] of stores) {
	for (const [scannerLabel, makeScanner] of scanners) {
		describe.skipIf(!hasPostgres)(`scan: true with the ${storeLabel} object store and ${scannerLabel}`, () => {
			let app: ContractApp
			let store: FileObjectStore

			beforeAll(() => {
				if (hasPostgres) {
					store = makeStore()
					app = bootApp(filesApp(), { database, files: store, scanner: makeScanner() })
				}
			})

			beforeEach(clearBacklog)

			test('EICAR is rejected and its object deleted, a clean PDF goes live, an encrypted archive is rejected; the list shows each state', async () => {
				const note = await seedNote()
				const infected = await uploaded(app, note, EICAR)
				const clean = await uploaded(app, note, CLEAN_PDF, 'application/pdf')
				const encrypted = await uploaded(app, note, encryptedZip(), 'application/zip')
				for (const id of [infected, clean, encrypted]) {
					expect(await statusOf(id)).toBe('quarantined')
					const before = await download(app, id)
					expect(before.status).toBe(409)
					expect(await errorOf(before)).toBe('file_not_ready')
				}
				expect(await list(app, note)).toMatchObject({
					items: [{ id: infected, status: 'quarantined', type: 'text/plain' }, { id: clean }, { id: encrypted }],
				})

				const { reporter, result } = await scanPass(app)
				expect(result).toEqual({ status: 'succeeded', attempts: 1 })
				expect(await statusOf(infected)).toBe('rejected')
				expect(await statusOf(encrypted)).toBe('rejected')
				expect(await statusOf(clean)).toBe('live')
				expect(await store.read(`uploads/${infected}`)).toBeNull()
				expect(await store.read(`uploads/${encrypted}`)).toBeNull()
				for (const id of [infected, encrypted]) {
					expect(await errorOf(await download(app, id))).toBe('file_rejected')
				}
				const served = await download(app, clean)
				expect(served.status).toBe(200)
				expect(await served.text()).toBe(CLEAN_PDF)
				expect(reporter.reports.filter((report) => report.type === 'FileRejected').map((report) => report.tags['file'])).toEqual(
					expect.arrayContaining([infected, encrypted]),
				)
				expect(await list(app, note)).toMatchObject({
					items: [{ id: infected, status: 'rejected' }, { id: clean, status: 'live', size: CLEAN_PDF.length }, { id: encrypted, status: 'rejected' }],
				})
			}, 120 * SECOND)

			test('an LZMA ZIP holding EICAR and a damaged ZIP, which ClamAV answers OK, are rejected and never served', async () => {
				const note = await seedNote()
				const lzma = await uploaded(app, note, LZMA_EICAR_ZIP, 'application/zip')
				const damaged = await uploaded(app, note, damagedZip(), 'application/zip')
				const { reporter } = await scanPass(app)
				for (const id of [lzma, damaged]) {
					expect(await statusOf(id)).toBe('rejected')
					expect(await store.read(`uploads/${id}`)).toBeNull()
					expect((await download(app, id)).status).toBe(409)
				}
				expect(reporter.reports.filter((report) => report.type === 'FileRejected').map((report) => report.tags['signature']).sort()).toEqual([
					'Fabrika.Archive.malformed',
					'Fabrika.Archive.unsupported_method',
				])
			}, 120 * SECOND)

			test('an object replaced after its clean verdict is never served: the download answers 409 and quarantines it again', async () => {
				const id = await uploaded(app, await seedNote(), CLEAN_PDF, 'application/pdf')
				await scanPass(app)
				expect(await statusOf(id)).toBe('live')
				await replaceObject(store, `uploads/${id}`, EICAR)
				const served = await download(app, id)
				expect(served.status).toBe(409)
				expect(await served.text()).not.toContain('EICAR')
				expect(await statusOf(id)).toBe('quarantined')
				// The stored bytes are not the upload's, so no verdict can make them live; the tries run out instead.
				await scanPass(app)
				expect(await statusOf(id)).toBe('quarantined')
				expect(await attemptsOf(id)).toBe(1)
				expect((await download(app, id)).status).toBe(409)
			}, 120 * SECOND)

			test('a ZIP after a prefix, inside a text or a PDF, and an end record hidden in a comment are rejected and never served', async () => {
				const note = await seedNote()
				// ClamAV finds a ZIP by its local header anywhere and skips an entry whose sizes are in a data descriptor.
				const streamed = zipOf([{ name: 'eicar.txt', bytes: EICAR, method: 'deflate', flags: 0x08 }])
				const inText = await uploaded(app, note, joined(new TextEncoder().encode('a'.repeat(512)), streamed))
				const inPdf = await uploaded(app, note, joined(new TextEncoder().encode(CLEAN_PDF), streamed), 'application/pdf')
				const entries = [{ name: 'eicar.txt', bytes: EICAR, method: 'deflate' as const }, { name: 'harmless.txt', bytes: 'hello' }]
				const shadow = new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 1, 0, 1, 0, 40, 0, 0, 0, 100, 0, 0, 0, 1, 0])
				const shadowed = await uploaded(app, await seedNote(), zipOf(entries, shadow), 'application/zip')
				const { reporter } = await scanPass(app)
				for (const id of [inText, inPdf, shadowed]) {
					expect(await statusOf(id)).toBe('rejected')
					expect((await download(app, id)).status).toBe(409)
				}
				expect(reporter.reports.filter((report) => report.type === 'FileRejected').map((report) => report.tags['signature']).sort()).toEqual([
					'Fabrika.Archive.ambiguous_directory',
					'Fabrika.Archive.embedded_archive',
					'Fabrika.Archive.embedded_archive',
				])
			}, 120 * SECOND)

			test('an empty upload is refused and nothing is stored', async () => {
				const note = await seedNote()
				const sent = await upload(app, note, '', 'text/plain', await editorOf(W1))
				expect(sent.status).toBe(400)
				expect(errorType(sent)).toBe('empty')
				expect(await list(app, note)).toEqual({ items: [] })
			}, 120 * SECOND)
		})
	}
}

describe.skipIf(!hasPostgres)('a scan that does not complete with a clean verdict leaves the file unserved', () => {
	let memory: MemoryFileObjects
	let store: FlakyDeletes
	let scanner: StandInScanner
	let app: ContractApp

	beforeAll(() => {
		if (hasPostgres) {
			memory = new MemoryFileObjects()
			store = new FlakyDeletes(memory)
			scanner = new StandInScanner()
			app = bootApp(filesApp(), { database, files: store, scanner })
		}
	})

	beforeEach(clearBacklog)

	test('a pass without a scanner leaves the file quarantined and reports', async () => {
		const unscanned = bootApp(filesApp(), { database, files: store })
		const id = await uploaded(unscanned, await seedNote(), CLEAN_PDF, 'application/pdf')
		const { reporter, result } = await scanPass(unscanned)
		expect(result).toEqual({ status: 'succeeded', attempts: 1 })
		expect(await statusOf(id)).toBe('quarantined')
		expect((await download(unscanned, id)).status).toBe(409)
		expect(reporter.reports).toEqual([expect.objectContaining({ type: 'FileScanFailed', tags: { code: 'scanner_missing' } })])
	})

	test('a failed batch leaves every file quarantined and reports its code; only a failure over its files counts a try', async () => {
		const id = await uploaded(app, await seedNote(), CLEAN_PDF, 'application/pdf')
		for (const [failure, attempts] of [['signatures_stale', 0], ['signatures_missing', 0], ['scanner_failed', 1], ['timeout', 2]] as const) {
			scanner.next = () => Promise.resolve({ ok: false, failure })
			const { reporter } = await scanPass(app)
			expect(reporter.reports[0]).toEqual(expect.objectContaining({ type: 'FileScanFailed', tags: { code: failure } }))
			expect(await statusOf(id)).toBe('quarantined')
			expect(await attemptsOf(id)).toBe(attempts)
			await dueNow()
		}
	})

	test('a file the scanner skipped, or gave another answer, stays quarantined and is reported', async () => {
		const note = await seedNote()
		const skipped = await uploaded(app, note, CLEAN_PDF, 'application/pdf')
		const unsure = await uploaded(app, note, CLEAN_PDF, 'application/pdf')
		scanner.next = async (objects, signal) => {
			for (const object of objects) {
				await readAll(await object.open(signal))
			}
			return { ok: true, verdicts: new Map([[unsure, { kind: 'unscanned' }]]) }
		}
		const { reporter } = await scanPass(app)
		expect(await statusOf(skipped)).toBe('quarantined')
		expect(await statusOf(unsure)).toBe('quarantined')
		expect(reporter.reports).toEqual([expect.objectContaining({ type: 'FileUnscanned', tags: { collection: 'uploads' } })])
	})

	test('a clean verdict over a truncated or altered object does not promote it', async () => {
		const note = await seedNote()
		const truncated = await uploaded(app, note, CLEAN_PDF, 'application/pdf')
		const altered = await uploaded(app, note, CLEAN_PDF, 'application/pdf')
		memory.replace(`uploads/${truncated}`, new TextEncoder().encode(CLEAN_PDF.slice(0, 10)))
		memory.replace(`uploads/${altered}`, new TextEncoder().encode(CLEAN_PDF.replace('obj', 'OBJ')))
		// A scanner that calls everything clean, whether or not it read it.
		scanner.next = async (objects, signal) => {
			for (const object of objects) {
				await object.open(signal).then(readAll, () => '')
			}
			return { ok: true, verdicts: new Map(objects.map((object) => [object.id, { kind: 'clean' }])) }
		}
		await scanPass(app)
		expect(await statusOf(truncated)).toBe('quarantined')
		expect(await statusOf(altered)).toBe('quarantined')
	})

	test('a timed-out attempt stops the scanner and writes no verdict', async () => {
		const id = await uploaded(app, await seedNote(), CLEAN_PDF, 'application/pdf')
		let aborted = false
		scanner.next = (_objects, signal) =>
			new Promise((resolve) => {
				signal.addEventListener('abort', () => {
					aborted = true
					resolve({ ok: true, verdicts: new Map([[id, { kind: 'clean' }]]) })
				}, { once: true })
			})
		const clock: JobClock = { wait: (_ms, signal) => new Promise((resolve) => setTimeout(resolve, signal.aborted ? 0 : 50)), random: () => 0 }
		const { reporter, result } = await scanPass(app, clock)
		expect(result).toEqual({ status: 'failed', attempts: 1, code: 'timeout' })
		expect(aborted).toBe(true)
		expect(await statusOf(id)).toBe('quarantined')
		expect(reporter.types()).toContain('JobFailed')
	})

	test('a verdict after the lease was lost writes nothing, and the run fails as lease_lost', async () => {
		const id = await uploaded(app, await seedNote(), CLEAN_PDF, 'application/pdf')
		scanner.next = async (objects) => {
			await admin((sql) => sql.unsafe(`update ${schema}.fabrika_job_leases set generation = generation + 1 where job = $1`, [FILE_SCAN_JOB]))
			return judge(objects)
		}
		const { result } = await scanPass(app)
		expect(result).toEqual({ status: 'failed', attempts: 1, code: 'lease_lost' })
		expect(await statusOf(id)).toBe('quarantined')
		// The lost lease stays taken until it expires; the next tests start from a free one.
		await admin((sql) => sql.unsafe(`delete from ${schema}.fabrika_job_leases where job = $1`, [FILE_SCAN_JOB]))
	})

	test('an infected file whose object delete fails stays quarantined and unserved; the next pass deletes it and rejects it', async () => {
		const id = await uploaded(app, await seedNote(), EICAR)
		store.failDeletes = 1
		const first = await scanPass(app)
		expect(await statusOf(id)).toBe('quarantined')
		expect((await download(app, id)).status).toBe(409)
		expect(first.reporter.reports).toEqual([expect.objectContaining({ type: 'FileScanFailed', tags: { code: 'delete_failed' } })])
		expect(await attemptsOf(id)).toBe(1)
		// It waits like a retry: a pass before its time leaves it alone.
		await scanPass(app)
		expect(await memory.read(`uploads/${id}`)).not.toBeNull()
		await dueNow()
		await scanPass(app)
		expect(await statusOf(id)).toBe('rejected')
		expect(await memory.read(`uploads/${id}`)).toBeNull()
	})

	test('an object replaced between its scan and the verdict is never served', async () => {
		const id = await uploaded(app, await seedNote(), CLEAN_PDF, 'application/pdf')
		scanner.next = async (objects, signal) => {
			const result = await judge(objects, signal)
			memory.replace(`uploads/${id}`, new TextEncoder().encode(EICAR.padEnd(CLEAN_PDF.length)))
			return result
		}
		await scanPass(app)
		expect(await statusOf(id)).toBe('live')
		const served = await download(app, id)
		expect(served.status).toBe(409)
		expect(await served.text()).not.toContain('EICAR')
		expect(await statusOf(id)).toBe('quarantined')
	})

	test('twenty files that get no verdict do not hold back the next upload, and each is rejected after its last try', async () => {
		const stuck = []
		for (let index = 0; index < 20; index++) stuck.push(await uploaded(app, await seedNote(), `${UNSCANNABLE} ${index}`))
		const normal = await uploaded(app, await seedNote(), CLEAN_PDF, 'application/pdf')
		await scanPass(app)
		expect(await statusOf(normal)).toBe('quarantined')
		await scanPass(app)
		expect(await statusOf(normal)).toBe('live')
		for (const id of stuck) expect(await attemptsOf(id)).toBe(1)
		// Retried alone, one per pass, until the last try rejects it.
		await clearBacklog()
		const last = await uploaded(app, await seedNote(), `${UNSCANNABLE} last`)
		for (let attempt = 1; attempt <= SCAN_LIMITS.maxAttempts; attempt++) {
			await scanPass(app)
			await dueNow()
		}
		expect(await statusOf(last)).toBe('rejected')
	})

	test('twenty infected files whose deletes keep failing do not hold back the next upload, and are never served', async () => {
		const infected = []
		for (let index = 0; index < SCAN_LIMITS.batchFiles; index++) infected.push(await uploaded(app, await seedNote(), `${EICAR} ${index}`))
		const normal = await uploaded(app, await seedNote(), CLEAN_PDF, 'application/pdf')
		store.failDeletes = Number.POSITIVE_INFINITY
		try {
			await scanPass(app)
			expect(await statusOf(normal)).toBe('quarantined')
			await scanPass(app)
			expect(await statusOf(normal)).toBe('live')
			for (const id of infected) {
				expect(await statusOf(id)).toBe('quarantined')
				expect(await attemptsOf(id)).toBe(1)
				expect((await download(app, id)).status).toBe(409)
			}
		} finally {
			store.failDeletes = 0
		}
	})

	test('a file of a quiet kind is scanned in its turn while another kind keeps receiving uploads', async () => {
		const busy = async (count: number): Promise<void> => {
			for (let index = 0; index < count; index++) await uploaded(app, await seedNote(), `busy ${index}`)
		}
		await busy(SCAN_LIMITS.batchFiles)
		const quiet = await uploaded(app, await seedNote(), 'quiet', 'text/plain', 'photos')
		await busy(SCAN_LIMITS.batchFiles)
		await scanPass(app)
		expect(await statusOf(quiet)).toBe('quarantined')
		// Newer uploads keep arriving, more than a batch of them; the older quiet file goes first.
		await busy(SCAN_LIMITS.batchFiles)
		await scanPass(app)
		expect(await statusOf(quiet)).toBe('live')
	})

	test('a quarantined file whose object is missing is rejected', async () => {
		const id = await uploaded(app, await seedNote(), CLEAN_PDF, 'application/pdf')
		await memory.delete(`uploads/${id}`)
		const { reporter } = await scanPass(app)
		expect(await statusOf(id)).toBe('rejected')
		expect(reporter.reports).toEqual([
			expect.objectContaining({ type: 'FileRejected', tags: expect.objectContaining({ signature: 'object_missing' }) }),
		])
	})

	test('an overlapping run does not start while a pass holds the lease', async () => {
		await uploaded(app, await seedNote(), CLEAN_PDF, 'application/pdf')
		let release: () => void = () => {}
		const held = new Promise<void>((resolve) => {
			release = resolve
		})
		let entered: () => void = () => {}
		const inside = new Promise<void>((resolve) => {
			entered = resolve
		})
		scanner.next = async (objects) => {
			entered()
			await held
			return judge(objects)
		}
		const first = scanPass(app)
		await inside
		expect((await scanPass(app)).result).toEqual({ status: 'skipped' })
		release()
		expect((await first).result).toEqual({ status: 'succeeded', attempts: 1 })
	})
})

describe.skipIf(!hasPostgres)('a quarantined file through the endpoints', () => {
	let app: ContractApp

	beforeAll(() => {
		if (hasPostgres) {
			app = bootApp(filesApp(), { database, files: new MemoryFileObjects(), scanner: new StandInScanner() })
		}
	})

	beforeEach(clearBacklog)

	test('the 409 is for a caller who may read the file; anyone else gets what a live file would give', async () => {
		const note = await seedNote()
		const quarantined = await uploaded(app, note, CLEAN_PDF, 'application/pdf')
		const outsider = await editorOf(W2)
		expect((await download(app, quarantined)).status).toBe(409)
		expect((await download(app, quarantined, outsider)).status).toBe(404)
		const live = await uploaded(app, note, CLEAN_PDF, 'application/pdf')
		await scanPass(app)
		expect((await download(app, live, outsider)).status).toBe(404)
	})

	test('a live file without a scanned version — live before its kind scanned — is quarantined at its download', async () => {
		const id = await uploaded(app, await seedNote(), CLEAN_PDF, 'application/pdf')
		await scanPass(app)
		await admin((sql) => sql.unsafe(`update ${schema}.fabrika_files set object_version = null where id = $1`, [id]))
		expect((await download(app, id)).status).toBe(409)
		expect(await statusOf(id)).toBe('quarantined')
		await scanPass(app)
		expect((await download(app, id)).status).toBe(200)
	})
})
