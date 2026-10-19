// Files as values through the test kit, boot and a REAL Postgres: a file field on a mutation (multipart), a file column
// that takes only a reference, `ctx.files.put` and `.open`, a procedure whose output is a file (a GET query, and a
// public one), the 409 of a file that is not live, the cleanup after a rollback and the sweep. The artifact half runs
// everywhere; the requests skip cleanly when FABRIKA_TEST_POSTGRES_URL is unset. A real bucket backs the object store
// when FABRIKA_TEST_S3_* is set.

import { compileContract } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { scoped } from '@fabrika/db'
import { testDatabase } from '@fabrika/db/testing'
import type { FileObjectStore } from '@fabrika/platform'
import { S3BlobStore } from '@fabrika/platform-node'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { contractProxyTable } from '@fabrika/proxy-core/manifest'
import { SQL } from 'bun'
import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { FILE_SWEEP_JOB } from '../files/collections'
import { FILE_SCAN_JOB, type FileScanner, type ScanBatchResult } from '../files/scan'
import { passingChallenge } from '../testing/challenge'
import { contract } from './stored-files-fixture/fabrika.contract'
import { tables } from './stored-files-fixture/src/db/tables'
import { FileInfo, PNG } from './stored-files-fixture/src/deals/endpoints'

const PDF = new TextEncoder().encode('%PDF-1.7\n%%EOF\n')

describe('the artifact of files as values', () => {
	const artifact = compileContract(contract, tables)

	test('declares the kinds, the file columns, a multipart body sized by its files, and a file output as a GET', () => {
		expect(artifact.fileKinds).toEqual({
			attachments: { types: ['application/pdf', 'image/png'], maxBytes: 1048576 },
			catalog: { types: ['image/png'], maxBytes: 262144 },
			photos: { types: ['image/png'], maxBytes: 262144, scan: true },
		})
		expect(artifact.tables['deal_attachments']?.files).toEqual({ file: 'attachments' })
		expect(artifact.endpoints.find((row) => row.id === 'api.attachments.upload')).toMatchObject({
			method: 'POST',
			admission: { contentTypes: ['multipart/form-data'], maxBytes: 65536 + 1048576 },
			input: { type: 'object', fields: { file: { type: 'file', kind: 'attachments' } } },
		})
		expect(artifact.endpoints.find((row) => row.id === 'api.attachments.uploadMany')?.admission?.maxBytes).toBe(65536 + 3 * 1048576)
		// Every file optional: the same procedure also takes a JSON body.
		expect(artifact.endpoints.find((row) => row.id === 'api.catalog.addProduct')?.admission?.contentTypes).toEqual([
			'application/json',
			'multipart/form-data',
		])
		expect(artifact.endpoints.find((row) => row.id === 'api.attachments.download')).toMatchObject({
			method: 'GET',
			admission: null,
			output: { type: 'file', kind: 'attachments' },
			response: 'file',
		})
		expect(artifact.endpoints.find((row) => row.id === 'api.shop.image')).toMatchObject({ kind: 'public', method: 'GET', response: 'file' })
		expect(artifact.procedures?.['api.intake.register']?.rate.bytesPerHour).toBe(1048576)
	})

	test('compiles the file-response profile into the proxy row', () => {
		const table = contractProxyTable(artifact)
		expect(table.endpoints.find((row) => row.id === 'api.attachments.download')).toMatchObject({ response: 'file' })
		expect(table.endpoints.find((row) => row.id === 'api.attachments.list')).not.toHaveProperty('response')
	})
})

/** A real bucket when the S3 test backend is configured; the in-memory store otherwise. */
function objectStore(): FileObjectStore {
	const bucket = process.env['FABRIKA_TEST_S3_BUCKET'] ?? ''
	if (bucket === '') {
		return new MemoryFileObjects()
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

/** Every file it is handed is clean. */
class CleanScanner implements FileScanner {
	async scan(objects: Parameters<FileScanner['scan']>[0], signal: AbortSignal): Promise<ScanBatchResult> {
		for (const object of objects) {
			await (await object.open(signal)).cancel()
		}
		return { ok: true, verdicts: new Map(objects.map((object) => [object.id, { kind: 'clean' }])) }
	}
}

const postgres = await testDatabase({ migrations: join(import.meta.dir, 'stored-files-fixture', 'db', 'migrations'), label: 'stored-files.test.ts' })
const url = process.env['FABRIKA_TEST_POSTGRES_URL'] ?? ''

afterAll(async () => {
	await postgres?.close()
})

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

/** A multipart body: the JSON input part first, then each file under its field's name. */
function multipart(input: unknown, files: readonly (readonly [string, Uint8Array<ArrayBuffer>, string, string])[]): FormData {
	const form = new FormData()
	form.append('input', JSON.stringify(input))
	for (const [field, bytes, name, type] of files) {
		form.append(field, new File([bytes], name, { type }))
	}
	return form
}

if (postgres !== null) {
	const schema = postgres.schema
	const store = objectStore()
	const kit = testKit(serve(contract, { database: scoped(tables) }), {
		database: postgres.database,
		files: store,
		scanner: new CleanScanner(),
		challengeFetch: passingChallenge,
		env: { TURNSTILE_SECRET: 'secret', TURNSTILE_SITE_KEY: 'site-key' },
	})
	await admin((sql) => sql.unsafe(`insert into ${schema}.deals (id, org_id, name) values ('d1', 'o1', 'One'), ('d2', 'o2', 'Two')`))
	const staff = kit.testCaller([
		{ action: 'crm.read', scope: { type: 'org', value: 'o1' } },
		{ action: 'deals.write', scope: { type: 'org', value: 'o1' } },
		{ action: 'catalog.write' },
	])
	const call = kit.browser(staff)
	const json = (path: string, body: unknown) =>
		call(`/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
	const files = async (): Promise<{ id: string; status: string; kind: string; scope: string | null }[]> =>
		admin((sql) => sql.unsafe(`select id::text as id, status, kind, scope from ${schema}.fabrika_files order by created_at`))

	describe('a file field and a file column', () => {
		test('an upload stages the file and the insert claims it; a list answers its reference; a GET serves it', async () => {
			const uploaded = await call('/api/attachments.upload', {
				method: 'POST',
				body: multipart({ dealId: 'd1', name: 'Offer' }, [['file', PDF, 'offer.pdf', 'application/pdf']]),
			})
			expect(uploaded.status).toBe(200)
			const listed = await json('attachments.list', { dealId: 'd1' })
			const [item] = z.strictObject({ items: z.array(z.strictObject({ id: z.string(), name: z.string(), file: FileInfo })) }).parse(
				(await listed.json()).result,
			).items
			expect(item?.file).toMatchObject({ name: 'offer.pdf', type: 'application/pdf', size: PDF.byteLength, status: 'live' })
			const stored = (await files()).find((row) => row.id === item?.file.id)
			expect(stored).toMatchObject({ status: 'live', kind: 'attachments', scope: 'org:o1' })
			const download = await call(`/api/attachments.download?dealId=d1&id=${item?.id}`)
			expect(download.status).toBe(200)
			expect(download.headers.get('Content-Type')).toBe('application/pdf')
			expect(download.headers.get('Content-Disposition')).toStartWith('attachment')
			expect(new Uint8Array(await download.arrayBuffer())).toEqual(PDF)
		})

		test('several files arrive as parts of one field, each within the field bound', async () => {
			const three = multipart({ dealId: 'd1' }, [
				['files', PDF, 'a.pdf', 'application/pdf'],
				['files', PNG, 'b.png', 'image/png'],
				['files', PDF, 'c.pdf', 'application/pdf'],
			])
			const response = await call('/api/attachments.uploadMany', { method: 'POST', body: three })
			expect(await response.json()).toEqual({ result: { count: 3 } })
			const four = multipart({ dealId: 'd1' }, [
				['files', PDF, 'a.pdf', 'application/pdf'],
				['files', PDF, 'b.pdf', 'application/pdf'],
				['files', PDF, 'c.pdf', 'application/pdf'],
				['files', PDF, 'd.pdf', 'application/pdf'],
			])
			expect((await call('/api/attachments.uploadMany', { method: 'POST', body: four })).status).toBe(400)
		})

		test('refuses a file whose bytes are not its type, a type the kind does not admit, and a file field inside the JSON', async () => {
			const lying = multipart({ dealId: 'd1', name: 'x' }, [['file', PNG, 'x.pdf', 'application/pdf']])
			expect((await call('/api/attachments.upload', { method: 'POST', body: lying })).status).toBe(415)
			const text = multipart({ dealId: 'd1', name: 'x' }, [['file', PDF, 'x.txt', 'text/plain']])
			expect((await call('/api/attachments.upload', { method: 'POST', body: text })).status).toBe(415)
			const smuggled = multipart({ dealId: 'd1', name: 'x', file: { id: crypto.randomUUID() } }, [])
			expect((await call('/api/attachments.upload', { method: 'POST', body: smuggled })).status).toBe(400)
		})

		test('a rollback deletes the files the request staged: no row, and no object', async () => {
			const before = (await files()).length
			const response = await call('/api/attachments.failing', {
				method: 'POST',
				body: multipart({ dealId: 'd1' }, [['file', PDF, 'gone.pdf', 'application/pdf']]),
			})
			expect(response.status).toBe(404)
			expect((await files()).length).toBe(before)
		})

		test('a deal of another organization is not found, and the file the refused request staged is gone', async () => {
			const before = (await files()).length
			const response = await call('/api/attachments.upload', {
				method: 'POST',
				body: multipart({ dealId: 'd2', name: 'x' }, [['file', PDF, 'x.pdf', 'application/pdf']]),
			})
			expect(response.status).toBe(404)
			expect((await files()).length).toBe(before)
		})
	})

	describe('ctx.files.put and .open', () => {
		test('a put becomes live with its first reference, and open reads its bytes', async () => {
			const rendered = await json('catalog.render', { name: 'lamp' })
			const { id } = z.strictObject({ id: z.string(), version: z.int() }).parse((await rendered.json()).result)
			const measured = await json('catalog.measure', { id })
			expect((await measured.json()).result).toEqual({ size: PNG.byteLength, name: 'lamp.png' })
		})

		test('a put nothing references stays pending for the sweep, which deletes it once past the grace', async () => {
			await json('catalog.putOnly', { name: 'orphan.png' })
			const orphan = (await files()).filter((row) => row.status === 'pending').at(-1)
			expect(orphan).toBeDefined()
			await kit.runJob(FILE_SWEEP_JOB)
			expect((await files()).map((row) => row.id)).toContain(orphan?.id ?? '')
			await admin((sql) => sql.unsafe(`update ${schema}.fabrika_files set created_at = now() - interval '2 hours' where id = $1`, [orphan?.id]))
			expect((await kit.runJob(FILE_SWEEP_JOB)).status).toBe('succeeded')
			expect((await files()).map((row) => row.id)).not.toContain(orphan?.id ?? '')
		})
	})

	describe('a public procedure', () => {
		test('serves a catalog image to anyone by a GET whose input names the file', async () => {
			const rendered = await json('catalog.render', { name: 'chair' })
			const { id } = z.strictObject({ id: z.string(), version: z.int() }).parse((await rendered.json()).result)
			const [row] = await admin((sql) => sql.unsafe(`select image::text as image from ${schema}.products where id = $1`, [id]))
			const image = await kit.fetch(`/api/shop.image?product=${id}&file=${row.image}`)
			expect(image.status).toBe(200)
			expect(image.headers.get('Content-Disposition')).toStartWith('inline')
			expect((await kit.fetch(`/api/shop.image?product=${id}&file=${crypto.randomUUID()}`)).status).toBe(404)
		})

		test('takes a photo after its challenge, quarantined until the scan job gives it a clean verdict', async () => {
			const response = await kit.fetch('/api/intake.register', {
				method: 'POST',
				body: multipart({ name: 'Ann', challengeToken: 'token' }, [['photo', PNG, 'me.png', 'image/png']]),
			})
			expect(response.status).toBe(200)
			const photo = (await files()).filter((row) => row.kind === 'photos').at(-1)
			expect(photo).toMatchObject({ status: 'quarantined', scope: null })
			await kit.runJob(FILE_SCAN_JOB)
			expect((await files()).find((row) => row.id === photo?.id)?.status).toBe('live')
		})
	})
}
