// `c.files` through boot's real pipeline on a REAL Postgres: the generated upload, download and remove endpoints,
// sniffing, the size bound while the body streams, the file treatment, and a file reaching only what its owner
// reaches. Runs against an in-memory object store, and against a real S3 bucket when FABRIKA_TEST_S3_* is set.
// Skips the Postgres half cleanly when FABRIKA_TEST_POSTGRES_URL is unset (see scoped-database.test.ts).

import { BootError, type ContractApp } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { ENDPOINT_HEADER, PROXY_TOKEN_HEADER } from '@fabrika/auth-core'
import { applicationSchema, Database, scoped } from '@fabrika/db'
import type { FileObjectStore, ObjectMetadata, ObjectWriteOptions, StoredObject } from '@fabrika/platform'
import { S3BlobStore } from '@fabrika/platform-node'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { openFileStorage } from '../bun'
import { defineContract } from '../contract/define'
import { boot } from '../implement/boot'
import { implement } from '../implement/implement'
import {
	bootApp,
	endpointHeaderFor,
	environment,
	errorType,
	frameworkEnvFor,
	grant,
	keySource,
	ORIGIN,
	resultOf,
	send,
	token,
} from './fixtures/implement/harness'
import { MAX_BYTES, MAX_PER_NOTE } from './fixtures/scoped-files/fabrika.contract'
import { hookedDatabase } from './fixtures/scoped-files/hooked-database'
import { migration } from './fixtures/scoped-files/migration'
import { filesApp } from './fixtures/scoped-files/src/app'
import { tables } from './fixtures/scoped-files/src/db/tables'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''

if (!hasPostgres) {
	console.warn(`files.test.ts skipped its Postgres half: set ${URL_VAR} to run it`)
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
const PDF = new TextEncoder().encode('%PDF-1.7\n%%EOF\n')
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>')

const appId = `files-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
const schema = applicationSchema(appId)
const W1 = { type: 'workspace', value: 'w1' }
const W2 = { type: 'workspace', value: 'w2' }

/** A real bucket when the S3 test backend is configured: the same variables `openFileStorage` reads, in another prefix. */
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

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

async function seedNote(workspace: string): Promise<string> {
	const id = Bun.randomUUIDv7()
	await admin((sql) =>
		sql.unsafe(`insert into ${schema}.notes (id, workspace_id, title, created_by, version) values ($1, $2, 'note', 'user-9', 1)`, [id, workspace])
	)
	return id
}

async function editorOf(...workspaces: { readonly type: string; readonly value: string }[]): Promise<string> {
	return token('user', workspaces.flatMap((scope) => [grant('notes.read', scope), grant('notes.write', scope), grant('notes.delete', scope)]))
}

/** A body of `total` bytes of `first` and then zeros, in 64 KiB chunks, counting what the reader pulled. */
function countedBody(first: Uint8Array, total: number): { readonly body: ReadableStream<Uint8Array>; pulled(): number } {
	let pulled = 0
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (pulled >= total) {
				controller.close()
				return
			}
			const chunk = new Uint8Array(65536)
			if (pulled === 0) {
				chunk.set(first)
			}
			pulled += chunk.byteLength
			controller.enqueue(chunk)
		},
	})
	return { body, pulled: () => pulled }
}

interface UploadOptions {
	readonly token: string
	readonly type: string
	readonly name?: string
	readonly headers?: Record<string, string>
}

/** The fixture's upload endpoint header, set here: re-creating a request around a streamed body hangs its reader in Bun. */
const UPLOAD_ENDPOINT = endpointHeaderFor(filesApp(scoped(tables)), 'POST', '/api/files.attachments.upload/x') ?? ''

async function upload(app: ContractApp, owner: string, body: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>, options: UploadOptions) {
	const query = options.name === undefined ? '' : `?name=${encodeURIComponent(options.name)}`
	const headers = new Headers({
		'Sec-Fetch-Site': 'same-origin',
		'Content-Type': options.type,
		[PROXY_TOKEN_HEADER]: options.token,
		[ENDPOINT_HEADER]: UPLOAD_ENDPOINT,
		...options.headers,
	})
	const response = await app.fetch(new Request(`${ORIGIN}/api/files.attachments.upload/${owner}${query}`, { method: 'POST', headers, body }))
	const parsed: unknown = await response.json()
	return { status: response.status, body: parsed }
}

function uploadedId(sent: { readonly status: number; readonly body: unknown }): string {
	const result = resultOf({ ...sent, headers: new Headers() })
	if (typeof result !== 'object' || result === null || !('id' in result) || typeof result.id !== 'string') {
		throw new Error(`expected an id, got ${JSON.stringify(result)}`)
	}
	return result.id
}

async function download(app: ContractApp, id: string, callerToken: string): Promise<Response> {
	return app.fetch(new Request(`${ORIGIN}/api/files.attachments/${id}`, { headers: { [PROXY_TOKEN_HEADER]: callerToken } }))
}

async function rows(): Promise<readonly Record<string, unknown>[]> {
	return admin((sql) =>
		sql.unsafe(
			`select id, owner_id, status, object_key, size, content_type, sha256, original_name, deleted_at from ${schema}.fabrika_files_attachments`,
		)
	)
}

describe('boot refuses a file collection it cannot serve', () => {
	const contractWith = (collection: { readonly name: string; readonly types: readonly [string, ...string[]]; readonly link?: boolean }) =>
		defineContract({
			app: 'notes',
			dimensions: { workspace: {}, note: { in: 'workspace' } },
			actions: { 'notes.read': 'Read', 'notes.write': 'Write', 'notes.delete': 'Delete' },
			roles: { editor: { grants: ['notes.read'] } },
		}, (c) => ({
			files: {
				[collection.name]: c.files({
					owner: 'notes',
					read: 'notes.read',
					write: 'notes.write',
					delete: 'notes.delete',
					maxBytes: 1024,
					types: collection.types,
					...(collection.link === undefined ? {} : { link: collection.link }),
				}),
			},
			health: c.health('/healthz'),
		}))

	function problemsOf(contract: ReturnType<typeof contractWith>, files: FileObjectStore | undefined, database = scoped(tables)): readonly string[] {
		const app = implement(contract, { database, deps: () => ({}), handlers: () => ({}) })
		try {
			boot(app, {
				environment: environment(frameworkEnvFor(app)),
				iam: keySource,
				database: Database.postgres({ url: 'postgres://x@127.0.0.1:1/x', schema }),
				files,
			})
		} catch (error) {
			return error instanceof BootError ? error.problems : [String(error)]
		}
		return []
	}

	test('without object storage', () => {
		expect(problemsOf(contractWith({ name: 'attachments', types: ['image/png'] }), undefined)).toEqual([
			'files are declared, and the runtime adapter supplies no object storage (FABRIKA_APP_STORAGE_* on Zerops)',
		])
	})

	test('with a type whose bytes the framework cannot verify, a share link, or a name that cannot name a table', () => {
		const store = new MemoryFileObjects()
		expect(problemsOf(contractWith({ name: 'attachments', types: ['image/png', 'video/mp4'] }), store)[0]).toStartWith(
			"files 'attachments' admits 'video/mp4', whose bytes the framework cannot verify",
		)
		expect(problemsOf(contractWith({ name: 'attachments', types: ['image/png'], link: true }), store)).toEqual([
			"files 'attachments' sets link: true, which this version of @fabrika/app does not serve yet",
		])
		expect(problemsOf(contractWith({ name: 'Attachments', types: ['image/png'] }), store)[0]).toStartWith("files 'Attachments' needs a lowercase")
	})

	test('a partial set of storage variables stops the boot, and none means no storage', () => {
		expect(openFileStorage({})).toBeUndefined()
		expect(() => openFileStorage({ FABRIKA_APP_STORAGE_BUCKET: 'b' })).toThrow(BootError)
	})
})

const stores: (readonly [string, FileObjectStore])[] = [['memory', new MemoryFileObjects()]]
const s3 = s3Store()
if (s3 !== undefined) {
	stores.push(['s3', s3])
}

let database: Database

beforeAll(async () => {
	if (!hasPostgres) {
		return
	}
	await admin((sql) => sql.unsafe(`create schema ${schema}; set search_path to ${schema}; ${migration}`))
	database = Database.postgres({ url, schema, max: 2 })
})

afterAll(async () => {
	if (!hasPostgres) {
		return
	}
	await database.close()
	await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
})

for (const [label, store] of stores) {
	describe.skipIf(!hasPostgres)(`c.files on Postgres with the ${label} object store`, () => {
		let app: ContractApp

		beforeAll(() => {
			if (hasPostgres) {
				app = bootApp(filesApp(scoped(tables)), { database, files: store })
			}
		})

		test('an upload is stored under a generated key with its sniffed type, and downloads with the file treatment', async () => {
			const note = await seedNote('w1')
			const id = uploadedId(await upload(app, note, PNG, { token: await editorOf(W1), type: 'image/png', name: 'chart "q3".png' }))
			const row = (await rows()).find((candidate) => candidate['id'] === id)
			expect(row).toMatchObject({
				owner_id: note,
				object_key: `attachments/${id}`,
				size: '16',
				content_type: 'image/png',
				original_name: 'chart "q3".png',
			})
			expect(row?.['sha256']).toBe(new Bun.CryptoHasher('sha256').update(PNG).digest('hex'))

			const response = await download(app, id, await editorOf(W1))
			expect(response.status).toBe(200)
			expect(response.headers.get('Content-Type')).toBe('image/png')
			expect(response.headers.get('Content-Disposition')).toBe("inline; filename*=UTF-8''chart%20%22q3%22.png")
			expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
			expect(response.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'")
			expect(response.headers.get('Cache-Control')).toBe('private, no-store')
			expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG)
		})

		test('an SVG is an attachment, whatever it contains', async () => {
			const note = await seedNote('w1')
			const id = uploadedId(await upload(app, note, SVG, { token: await editorOf(W1), type: 'image/svg+xml' }))
			const response = await download(app, id, await editorOf(W1))
			expect(response.headers.get('Content-Type')).toBe('image/svg+xml')
			expect(response.headers.get('Content-Disposition')).toBe('attachment')
			expect(response.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'")
		})

		test('bytes that are not the declared type are refused and nothing is stored', async () => {
			const note = await seedNote('w1')
			const before = (await rows()).length
			const sent = await upload(app, note, PDF, { token: await editorOf(W1), type: 'image/png' })
			expect(sent.status).toBe(415)
			const binary = await upload(app, note, PNG, { token: await editorOf(W1), type: 'text/plain' })
			expect(binary.status).toBe(415)
			expect((await rows()).length).toBe(before)
		})

		test('an upload over maxBytes stops while streaming, and nothing is stored', async () => {
			const note = await seedNote('w1')
			const before = (await rows()).length
			const source = countedBody(PDF, 64 * 1024 * 1024)
			const sent = await upload(app, note, source.body, { token: await editorOf(W1), type: 'application/pdf' })
			expect(sent.status).toBe(413)
			expect(errorType({ status: sent.status, headers: new Headers(), body: sent.body })).toBe('too_large')
			// The store reads ahead a little; a body that is read to its end would be 64 MiB.
			expect(source.pulled()).toBeLessThan(MAX_BYTES + 1024 * 1024)
			expect((await rows()).length).toBe(before)
		})

		test('a Content-Length over maxBytes is refused before the body is read', async () => {
			const note = await seedNote('w1')
			const source = countedBody(PDF, 1024 * 1024)
			const sent = await upload(app, note, source.body, {
				token: await editorOf(W1),
				type: 'application/pdf',
				headers: { 'Content-Length': String(MAX_BYTES + 1) },
			})
			expect(sent.status).toBe(413)
			expect(source.pulled()).toBeLessThanOrEqual(65536)
		})

		test('a file of another workspace is 404, and so is an upload into its note', async () => {
			const theirs = await seedNote('w2')
			const id = uploadedId(await upload(app, theirs, PNG, { token: await editorOf(W2), type: 'image/png' }))
			expect((await download(app, id, await editorOf(W1))).status).toBe(404)
			expect((await send(app, '/api/files.attachments.remove', { token: await editorOf(W1), body: { id } })).status).toBe(404)
			expect((await upload(app, theirs, PNG, { token: await editorOf(W1), type: 'image/png' })).status).toBe(404)
			expect((await download(app, id, await editorOf(W2))).status).toBe(200)
			expect((await download(app, Bun.randomUUIDv7(), await editorOf(W1, W2))).status).toBe(404)
			expect((await download(app, 'not-a-uuid', await editorOf(W1, W2))).status).toBe(404)
		})

		test('a file follows its note: after the note moves, the old workspace reaches it no more', async () => {
			const note = await seedNote('w1')
			const id = uploadedId(await upload(app, note, PNG, { token: await editorOf(W1), type: 'image/png' }))
			await admin((sql) => sql.unsafe(`update ${schema}.notes set workspace_id = 'w2' where id = $1`, [note]))
			expect((await download(app, id, await editorOf(W1))).status).toBe(404)
			expect((await download(app, id, await editorOf(W2))).status).toBe(200)
		})

		test('remove marks the file removed, deletes its object and its row, and the file is 404 afterwards', async () => {
			const note = await seedNote('w1')
			const id = uploadedId(await upload(app, note, PNG, { token: await editorOf(W1), type: 'image/png' }))
			const removed = await send(app, '/api/files.attachments.remove', { token: await editorOf(W1), body: { id } })
			expect(resultOf(removed)).toEqual({ id })
			expect((await download(app, id, await editorOf(W1))).status).toBe(404)
			expect(await store.read(`attachments/${id}`)).toBeNull()
			expect((await rows()).some((row) => row['id'] === id)).toBe(false)
			expect((await send(app, '/api/files.attachments.remove', { token: await editorOf(W1), body: { id } })).status).toBe(404)
		})

		test('a reader without the delete action cannot remove', async () => {
			const note = await seedNote('w1')
			const id = uploadedId(await upload(app, note, PNG, { token: await editorOf(W1), type: 'image/png' }))
			const reader = await token('user', [grant('notes.read', W1)])
			expect((await send(app, '/api/files.attachments.remove', { token: reader, body: { id } })).status).toBe(403)
			expect((await download(app, id, reader)).status).toBe(200)
		})

		test('the owner’s limit holds: one more file is refused', async () => {
			const note = await seedNote('w1')
			for (let index = 0; index < MAX_PER_NOTE; index++) {
				uploadedId(await upload(app, note, PNG, { token: await editorOf(W1), type: 'image/png' }))
			}
			const sent = await upload(app, note, PNG, { token: await editorOf(W1), type: 'image/png' })
			expect(sent.status).toBe(409)
		})

		test('a deleted owner orphans its files: they are 404, and the next sweep deletes their objects', async () => {
			const note = await seedNote('w1')
			const id = uploadedId(await upload(app, note, PNG, { token: await editorOf(W1), type: 'image/png' }))
			await admin((sql) => sql.unsafe(`delete from ${schema}.notes where id = $1`, [note]))
			expect((await download(app, id, await editorOf(W1))).status).toBe(404)
			const other = await seedNote('w1')
			const trigger = uploadedId(await upload(app, other, PNG, { token: await editorOf(W1), type: 'image/png' }))
			resultOf(await send(app, '/api/files.attachments.remove', { token: await editorOf(W1), body: { id: trigger } }))
			expect(await store.read(`attachments/${id}`)).toBeNull()
		})

		test('a session upload must be same-origin and of an admitted type', async () => {
			const note = await seedNote('w1')
			const crossSite = await upload(app, note, PNG, { token: await editorOf(W1), type: 'image/png', headers: { 'Sec-Fetch-Site': 'cross-site' } })
			expect(crossSite.status).toBe(403)
			const html = await upload(app, note, new TextEncoder().encode('<html>'), { token: await editorOf(W1), type: 'text/html' })
			expect(html.status).toBe(400)
		})
	})
}

const FILE_TREATMENT = { csp: "sandbox; default-src 'none'", nosniff: 'nosniff', cache: 'private, no-store' }

function expectFileTreatment(response: Response): void {
	expect(response.headers.get('Content-Security-Policy')).toBe(FILE_TREATMENT.csp)
	expect(response.headers.get('X-Content-Type-Options')).toBe(FILE_TREATMENT.nosniff)
	expect(response.headers.get('Cache-Control')).toBe(FILE_TREATMENT.cache)
}

describe.skipIf(!hasPostgres)('every answer of the download endpoint carries the file treatment', () => {
	let store: MemoryFileObjects
	let app: ContractApp

	beforeAll(() => {
		if (hasPostgres) {
			store = new MemoryFileObjects()
			app = bootApp(filesApp(scoped(tables)), { database, files: store })
		}
	})

	test('a refused credential, a missing permission and a missing file', async () => {
		const note = await seedNote('w1')
		const id = uploadedId(await upload(app, note, PNG, { token: await editorOf(W1), type: 'image/png' }))
		const unauthenticated = await app.fetch(new Request(`${ORIGIN}/api/files.attachments/${id}`))
		const forbidden = await download(app, id, await token('user', [grant('notes.write', W1)]))
		const missing = await download(app, Bun.randomUUIDv7(), await editorOf(W1))
		expect([unauthenticated.status, forbidden.status, missing.status]).toEqual([401, 403, 404])
		for (const response of [unauthenticated, forbidden, missing]) {
			expectFileTreatment(response)
			expect(response.headers.get('Content-Disposition')).toBe('attachment')
		}
	})

	test('a missing object is a 500 with the fixed envelope, the file treatment and one log line', async () => {
		const note = await seedNote('w1')
		const id = uploadedId(await upload(app, note, PNG, { token: await editorOf(W1), type: 'image/png' }))
		store.objects.delete(`attachments/${id}`)
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			const response = await download(app, id, await editorOf(W1))
			expect(response.status).toBe(500)
			expectFileTreatment(response)
			expect(response.headers.get('Content-Disposition')).toBe('attachment')
			expect(await response.json()).toEqual({ error: { type: 'internal', message: 'Internal error' } })
			expect(log.mock.calls.map((call) => String(call[0]))).toEqual([
				"fabrika: files.attachments.download: framework_fault: file_object_missing: a file's object is missing from storage",
			])
		} finally {
			log.mockRestore()
		}
	})

	test('a Range request gets the whole file, with the treatment and no ranges offered', async () => {
		const note = await seedNote('w1')
		const id = uploadedId(await upload(app, note, PNG, { token: await editorOf(W1), type: 'image/png' }))
		const response = await app.fetch(
			new Request(`${ORIGIN}/api/files.attachments/${id}`, { headers: { [PROXY_TOKEN_HEADER]: await editorOf(W1), Range: 'bytes=0-3' } }),
		)
		expect(response.status).toBe(200)
		expect(response.headers.get('Accept-Ranges')).toBe('none')
		expectFileTreatment(response)
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG)
	})
})

/** Moves a note in a committed transaction of its own, as another request would. */
async function moveNote(note: string, workspace: string): Promise<void> {
	await admin((sql) => sql.unsafe(`update ${schema}.notes set workspace_id = $2 where id = $1`, [note, workspace]))
}

describe.skipIf(!hasPostgres)('an owner that moves while a request runs takes its files along', () => {
	/** Runs once, after the next statement that `matches` returned. */
	let pending: { readonly matches: (sql: string) => boolean; readonly run: () => Promise<void> } | null = null
	let hooked: Database
	let store: MemoryFileObjects
	let app: ContractApp

	beforeAll(() => {
		if (hasPostgres) {
			hooked = hookedDatabase(url, schema, async (sql) => {
				const hook = pending
				if (hook?.matches(sql)) {
					pending = null
					await hook.run()
				}
			})
			store = new MemoryFileObjects()
			app = bootApp(filesApp(scoped(tables)), { database: hooked, files: store })
		}
	})

	afterAll(async () => {
		if (hasPostgres) {
			await hooked.close()
		}
	})

	const after = (prefix: string, run: () => Promise<void>) => {
		pending = { matches: (sql) => sql.startsWith(prefix), run }
	}
	const LOCATE_NOTE = 'select "notes"."id"'
	const LOCATE_FILE = 'select "fabrika_files_attachments"."owner_id"'

	test('upload: a move after the access check makes the pending insert match nothing', async () => {
		const note = await seedNote('w1')
		const before = (await rows()).length
		after(LOCATE_NOTE, () => moveNote(note, 'w2'))
		const sent = await upload(app, note, PNG, { token: await editorOf(W1), type: 'image/png' })
		expect(sent.status).toBe(404)
		expect((await rows()).length).toBe(before)
		expect(store.objects.size).toBe(0)
	})

	test('upload: a move that starts while the owner is locked waits for the pending insert, then fails the completion', async () => {
		const note = await seedNote('w1')
		const before = (await rows()).length
		let move: Promise<void> = Promise.resolve()
		let movedWhileLocked = true
		pending = {
			matches: (sql) => sql.startsWith('select "notes"."id" from "notes"') && sql.endsWith('for share'),
			run: async () => {
				let moved = false
				move = moveNote(note, 'w2').then(() => {
					moved = true
				})
				await Bun.sleep(200)
				movedWhileLocked = moved
			},
		}
		const sent = await upload(app, note, PNG, { token: await editorOf(W1), type: 'image/png' })
		await move
		expect(movedWhileLocked).toBe(false)
		expect(sent.status).toBe(404)
		expect((await rows()).length).toBe(before)
	})

	test('upload: a move while the object is written fails the completion, and the object and its row are cleaned up', async () => {
		const note = await seedNote('w1')
		const before = (await rows()).length
		const moving = new HookedStore(store, { afterWrite: () => moveNote(note, 'w2') })
		const moved = bootApp(filesApp(scoped(tables)), { database, files: moving })
		const sent = await upload(moved, note, PNG, { token: await editorOf(W1), type: 'image/png' })
		expect(sent.status).toBe(404)
		expect((await rows()).length).toBe(before)
		expect(moving.written.every((key) => !store.objects.has(key))).toBe(true)
	})

	test('download: a move after the access check is 404, not the file', async () => {
		const note = await seedNote('w1')
		const id = uploadedId(await upload(app, note, PNG, { token: await editorOf(W1), type: 'image/png' }))
		after(LOCATE_FILE, () => moveNote(note, 'w2'))
		const response = await download(app, id, await editorOf(W1))
		expect(response.status).toBe(404)
		expectFileTreatment(response)
	})

	test('remove: a move after the access check is 404, and the file stays live', async () => {
		const note = await seedNote('w1')
		const id = uploadedId(await upload(app, note, PNG, { token: await editorOf(W1), type: 'image/png' }))
		after(LOCATE_FILE, () => moveNote(note, 'w2'))
		const removed = await send(app, '/api/files.attachments.remove', { token: await editorOf(W1), body: { id } })
		expect(removed.status).toBe(404)
		expect((await rows()).find((row) => row['id'] === id)).toMatchObject({ status: 'live', deleted_at: null })
		expect((await download(app, id, await editorOf(W2))).status).toBe(200)
	})
})

/** An object store that a test can make fail: a write whose answer is lost, a delete that fails. */
class HookedStore implements FileObjectStore {
	readonly written: string[] = []
	readonly #inner: FileObjectStore
	readonly #faults: { afterWrite?: () => Promise<void>; loseWriteAnswer?: boolean; failDeletes?: number }

	constructor(inner: FileObjectStore, faults: { afterWrite?: () => Promise<void>; loseWriteAnswer?: boolean; failDeletes?: number }) {
		this.#inner = inner
		this.#faults = { ...faults }
	}

	async write(key: string, body: ReadableStream<Uint8Array>, options: ObjectWriteOptions): Promise<ObjectMetadata> {
		this.written.push(key)
		const written = await this.#inner.write(key, body, options)
		await this.#faults.afterWrite?.()
		if (this.#faults.loseWriteAnswer === true) {
			throw new Error('the connection reset before the answer arrived')
		}
		return written
	}

	read(key: string): Promise<StoredObject | null> {
		return this.#inner.read(key)
	}

	readVersion(key: string, version: string): Promise<StoredObject | null> {
		return this.#inner.readVersion(key, version)
	}

	async delete(key: string): Promise<void> {
		if ((this.#faults.failDeletes ?? 0) > 0) {
			this.#faults.failDeletes = (this.#faults.failDeletes ?? 0) - 1
			// A storage error's name and message are the driver's, and may quote the request.
			throw Object.assign(new Error(`the store is unavailable for ${STORAGE_SECRET}`), { name: STORAGE_SECRET })
		}
		await this.#inner.delete(key)
	}
}

const STORAGE_SECRET = 'StorageRequestSecretMarker'

/** Makes the collection's pending rows look abandoned: older than the grace period. */
async function agePendingRows(): Promise<void> {
	await admin((sql) => sql.unsafe(`update ${schema}.fabrika_files_attachments set created_at = now() - interval '2 hours' where status = 'pending'`))
}

/** A remove triggers the sweep. */
async function sweepThrough(app: ContractApp): Promise<void> {
	const note = await seedNote('w1')
	const id = uploadedId(await upload(app, note, PNG, { token: await editorOf(W1), type: 'image/png' }))
	resultOf(await send(app, '/api/files.attachments.remove', { token: await editorOf(W1), body: { id } }))
}

describe.skipIf(!hasPostgres)('the pending row is the intent to clean an object up', () => {
	test('a lost write answer followed by a failed delete leaves a pending row, and the sweep deletes both after the grace', async () => {
		const inner = new MemoryFileObjects()
		const faulty = new HookedStore(inner, { loseWriteAnswer: true, failDeletes: 1 })
		const app = bootApp(filesApp(scoped(tables)), { database, files: faulty })
		const note = await seedNote('w1')
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			expect((await upload(app, note, PNG, { token: await editorOf(W1), type: 'image/png' })).status).toBe(500)
			const lines = log.mock.calls.map((call) => String(call[0]))
			expect(lines).toContain("fabrika: files 'attachments' cleanup: object_delete_failed")
			expect(lines.join('\n')).not.toContain(STORAGE_SECRET)
		} finally {
			log.mockRestore()
		}
		const [key] = faulty.written
		const id = key?.slice('attachments/'.length) ?? ''
		expect(inner.objects.has(key ?? '')).toBe(true)
		expect((await rows()).find((row) => row['id'] === id)).toMatchObject({ status: 'pending' })

		// Not swept while it might still be an upload in progress.
		await sweepThrough(bootApp(filesApp(scoped(tables)), { database, files: inner }))
		expect(inner.objects.has(key ?? '')).toBe(true)

		await agePendingRows()
		await sweepThrough(bootApp(filesApp(scoped(tables)), { database, files: inner }))
		expect(inner.objects.has(key ?? '')).toBe(false)
		expect((await rows()).some((row) => row['id'] === id)).toBe(false)
	})

	test('a sweep whose delete fails logs its step, answers the remove, and the next sweep retries', async () => {
		const inner = new MemoryFileObjects()
		const faulty = new HookedStore(inner, { failDeletes: 1 })
		const app = bootApp(filesApp(scoped(tables)), { database, files: faulty })
		const note = await seedNote('w1')
		const id = uploadedId(await upload(app, note, PNG, { token: await editorOf(W1), type: 'image/png' }))
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			resultOf(await send(app, '/api/files.attachments.remove', { token: await editorOf(W1), body: { id } }))
			const lines = log.mock.calls.map((call) => String(call[0]))
			expect(lines).toContain("fabrika: files 'attachments' sweep: object_delete_failed")
			expect(lines.join('\n')).not.toContain(STORAGE_SECRET)
		} finally {
			log.mockRestore()
		}
		expect(inner.objects.has(`attachments/${id}`)).toBe(true)
		await sweepThrough(app)
		expect(inner.objects.has(`attachments/${id}`)).toBe(false)
	})

	test('a failure of the final metadata write deletes the object and abandons the row', async () => {
		const store = new MemoryFileObjects()
		const recording = new HookedStore(store, {})
		const app = bootApp(filesApp(scoped(tables)), { database, files: recording })
		const note = await seedNote('w1')
		const before = (await rows()).length
		await admin((sql) => sql.unsafe(`alter table ${schema}.fabrika_files_attachments add constraint no_live check (status <> 'live') not valid`))
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			expect((await upload(app, note, PNG, { token: await editorOf(W1), type: 'image/png' })).status).toBe(500)
		} finally {
			log.mockRestore()
			await admin((sql) => sql.unsafe(`alter table ${schema}.fabrika_files_attachments drop constraint no_live`))
		}
		expect(recording.written).toHaveLength(1)
		expect(store.objects.size).toBe(0)
		expect((await rows()).length).toBe(before)
	})
})

describe.skipIf(!hasPostgres)('c.files behind the production proxy decision (the test kit)', () => {
	test('a signed-in editor uploads and downloads; another workspace’s editor gets 404', async () => {
		const kit = testKit(filesApp(scoped(tables)), { database, files: new MemoryFileObjects() })
		const note = await seedNote('w1')
		const editor = kit.browser(kit.testCaller([{ role: 'editor', scope: { type: 'workspace', value: 'w1' } }]))
		const stranger = kit.browser(kit.testCaller([{ role: 'editor', scope: { type: 'workspace', value: 'w2' } }]))
		const uploaded = await editor(`/api/files.attachments.upload/${note}`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: PNG })
		expect(uploaded.status).toBe(200)
		const id = uploadedId({ status: uploaded.status, body: await uploaded.json() })
		const downloaded = await editor(`/api/files.attachments/${id}`)
		expect(downloaded.status).toBe(200)
		expect(downloaded.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'")
		expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(PNG)
		expect((await stranger(`/api/files.attachments/${id}`)).status).toBe(404)
	})
})
