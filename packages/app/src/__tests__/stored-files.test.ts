// Files as values through the test kit, boot and a REAL Postgres: a file field on a mutation (multipart), a file column
// that takes only a reference, `ctx.files.put` and `.open`, a procedure whose output is a file (a GET query, and a
// public one), the 409 of a file that is not live, the cleanup after a rollback and the sweep. The artifact half runs
// everywhere; the requests skip cleanly when FABRIKA_TEST_POSTGRES_URL is unset. A real bucket backs the object store
// when FABRIKA_TEST_S3_* is set.

import { createClient, download, DownloadedFile } from '@fabrika/app/client'
import { compileContract, GENERATED_FILE_PREFIX, GENERATED_ROW_PREFIX } from '@fabrika/app/contract'
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
import { createHmac } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { FILE_SWEEP_JOB } from '../files/kinds'
import { FILE_SCAN_JOB, type FileScanner, type ScanBatchResult } from '../files/scan'
import { passingChallenge } from '../testing/challenge'
import { endpointAccessKit } from '../testing/endpoint-access'
import { appPolicyIsolationKit, policyIsolationKit } from '../testing/policy-isolation'
import { contract } from './stored-files-fixture/fabrika.contract'
import { tables } from './stored-files-fixture/src/db/tables'
import { FileInfo, PNG_BYTES } from './stored-files-fixture/src/deals/endpoints'

const PDF = new TextEncoder().encode('%PDF-1.7\n%%EOF\n')
const PNG = new Uint8Array(PNG_BYTES)

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
		expect(artifact.endpoints.find((row) => row.id === 'api.shop.image')).toMatchObject({
			kind: 'public',
			method: 'GET',
			response: 'file',
			cache: 'immutable',
		})
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

	describe('the typed client', () => {
		const api = createClient(contract, 'api', { fetch: call })

		test('sends a file field as a part of a multipart body, links a GET file procedure and downloads it', async () => {
			const saved = await api.attachments.upload({ dealId: 'd1', name: 'Brief', file: new File([PDF], 'brief.pdf', { type: 'application/pdf' }) })
			const url = api.attachments.download.url({ dealId: 'd1', id: saved.id })
			expect(url).toBe(`/api/attachments.download?dealId=d1&id=${saved.id}`)
			expect((await call(url)).status).toBe(200)
			const file = await download(api.attachments.download, { dealId: 'd1', id: saved.id })
			expect(file).toBeInstanceOf(DownloadedFile)
			expect(file.name).toBe('brief.pdf')
			expect(new Uint8Array(await file.blob().arrayBuffer())).toEqual(PDF)
		})

		test('sends an input whose every file is left out as JSON', async () => {
			expect(await api.catalog.addProduct({ name: 'Plain' })).toMatchObject({ version: 1 })
		})

		test('a client with a key has no URL of a file: the key never goes into one', () => {
			const keyed = createClient(contract, 'api', { fetch: call, key: 'px_secret' })
			expect(() => keyed.attachments.download.url({ dealId: 'd1', id: 'x' })).toThrow(/never goes into a URL/)
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

	describe('a mail attachment', () => {
		test('a mailer job attaches the live files it read from a column, each with its name, type and bytes', async () => {
			await json('catalog.render', { name: 'desk' })
			expect((await kit.runJob('catalogMail')).status).toBe('succeeded')
			const sent = kit.mail.accepted.at(-1)?.message
			expect(sent?.subject).toBe('The catalog')
			expect(sent?.attachments?.map((attachment) => attachment.filename)).toContain('desk.png')
			for (const attachment of sent?.attachments ?? []) {
				expect(attachment).toMatchObject({ contentType: 'image/png', content: PNG })
			}
		})

		test('refuses a photo the scan has not cleared, and sends it once the scan has', async () => {
			const registered = await kit.fetch('/api/intake.register', {
				method: 'POST',
				body: multipart({ name: 'Cy', challengeToken: crypto.randomUUID() }, [['photo', PNG, 'cy.png', 'image/png']]),
			})
			expect(registered.status).toBe(200)
			const before = kit.mail.accepted.length
			expect(await kit.runJob('intakeMail')).toMatchObject({ status: 'failed', code: 'handler_failed' })
			expect(kit.mail.accepted).toHaveLength(before)
			await kit.runJob(FILE_SCAN_JOB)
			expect((await kit.runJob('intakeMail')).status).toBe('succeeded')
			expect(kit.mail.accepted.at(-1)?.message.attachments?.map((attachment) => attachment.filename)).toContain('cy.png')
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
			expect(image.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
			const missing = await kit.fetch(`/api/shop.image?product=${id}&file=${crypto.randomUUID()}`)
			expect(missing.status).toBe(404)
			expect(missing.headers.get('Cache-Control')).toBe('private, no-store')
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

		/** A form as a browser sends it, with its length; or as a stream, without one. */
		const posted = (form: FormData, streamed: boolean): RequestInit => {
			if (!streamed) return { method: 'POST', body: form }
			const encoded = new Response(form)
			return { method: 'POST', headers: { 'Content-Type': encoded.headers.get('Content-Type') ?? '' }, body: encoded.body }
		}

		/** Empties the endpoint's buckets: its calls this minute and its bytes this hour. */
		const resetBuckets = () =>
			admin(async (sql) => {
				await sql.unsafe(`delete from ${schema}.fabrika_form_admissions where form = 'api.intake.register'`)
				await sql.unsafe(`delete from ${schema}.fabrika_form_bytes where form = 'api.intake.register'`)
			})

		test('takes an input part past 64 KiB up to the body limit, and refuses a body past it, declared or streamed', async () => {
			// The body limit is 64 KiB of input and one 256 KiB photo: 327680 bytes. Each call is charged up to it, so each
			// starts on an empty budget.
			const send = async (name: string, streamed: boolean, photo: Uint8Array<ArrayBuffer> = PNG) => {
				await resetBuckets()
				const form = multipart({ name, challengeToken: crypto.randomUUID() }, [['photo', photo, 'big.png', 'image/png']])
				return kit.fetch('/api/intake.register', posted(form, streamed))
			}
			expect((await send('a'.repeat(100 * 1024), false)).status).toBe(200)
			const [stored] = await admin((sql) =>
				sql.unsafe(`select length(name)::int as length from ${schema}.submissions order by length(name) desc limit 1`)
			)
			expect(stored?.length).toBe(100 * 1024)
			const tooLong = 'a'.repeat(400 * 1024)
			const declared = await send(tooLong, false)
			expect([declared.status, (await declared.json()).error?.type]).toEqual([413, 'too_large'])
			const streamed = await send(tooLong, true)
			expect([streamed.status, (await streamed.json()).error?.type]).toEqual([413, 'too_large'])
			// Each part within its own bound, the whole stream past the body limit.
			const photo = new Uint8Array(200 * 1024)
			photo.set(PNG)
			const parts = await send('a'.repeat(200 * 1024), true, photo)
			expect([parts.status, (await parts.json()).error?.type]).toEqual([413, 'too_large'])
		})

		test('charges bytesPerHour what an honest request sends, the body limit for a stream without a length, and refuses past the budget', async () => {
			await resetBuckets()
			const charged = async (): Promise<number> => {
				const [row] = await admin((sql) => sql.unsafe(`select bytes::int as bytes from ${schema}.fabrika_form_bytes where form = 'api.intake.register'`))
				return row?.bytes ?? 0
			}
			const register = async (streamed: boolean) => {
				const form = multipart({ name: 'Bo', challengeToken: crypto.randomUUID() }, [['photo', PNG, 'bo.png', 'image/png']])
				const length = (await new Response(form).arrayBuffer()).byteLength
				const response = await kit.fetch('/api/intake.register', posted(form, streamed))
				return { status: response.status, length }
			}
			const honest = await register(false)
			expect(honest).toMatchObject({ status: 200 })
			expect(await charged()).toBe(honest.length)
			// The body limit is 64 KiB of input and one 256 KiB photo; the budget of 1 MiB holds three such charges more.
			for (let call = 0; call < 3; call++) expect((await register(true)).status).toBe(200)
			expect(await charged()).toBe(honest.length + 3 * 327680)
			expect((await register(true)).status).toBe(429)
		})
	})

	describe('a webhook', () => {
		test("a delivery puts a file and writes it into a column, in the delivery's own transaction", async () => {
			const manager = kit.browser(kit.testCaller([{ action: 'catalog.write' }]))
			const connected = await manager('/api/catalog.connectScans', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ account: 'acct_scans' }),
			})
			const binding =
				z.strictObject({ result: z.strictObject({ id: z.string(), url: z.string(), secret: z.string() }) }).parse(await connected.json()).result
			const body = JSON.stringify({ id: `evt_${crypto.randomUUID()}`, type: 'scanned lamp' })
			const t = String(Math.floor(Date.now() / 1000))
			const signature = createHmac('sha256', binding.secret).update(`${t}.${body}`).digest('hex')
			const delivered = await kit.fetch(binding.url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${signature}` },
				body,
			})
			expect(delivered.status).toBe(200)
			const [row] = await admin((sql) => sql.unsafe(`select image::text as image from ${schema}.products where name = 'scanned lamp'`))
			expect((await files()).find((file) => file.id === row?.image)).toMatchObject({ status: 'live', kind: 'catalog' })
		})

		test("an inbound mail authenticated by a bearer token stores its attachments, past the 1 MiB default, within the webhook's limit", async () => {
			const manager = kit.browser(kit.testCaller([{ action: 'catalog.write' }]))
			const connected = await manager('/api/catalog.connectInbox', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ account: 'mail-service' }),
			})
			const binding =
				z.strictObject({ result: z.strictObject({ id: z.string(), url: z.string(), secret: z.string() }) }).parse(await connected.json()).result
			const image = new Uint8Array(200 * 1024)
			image.set(PNG)
			const content = Buffer.from(image).toString('base64')
			const mail = (subject: string, count: number) =>
				JSON.stringify({ subject, attachments: Array.from({ length: count }, (_, index) => ({ name: `scan-${index}.png`, type: 'image/png', content })) })
			const deliver = (body: string, authorization: string) =>
				kit.fetch(binding.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: authorization }, body })
			const body = mail('order 7', 5)
			expect(body.length).toBeGreaterThan(1024 * 1024)
			expect((await deliver(body, 'Bearer wrong')).status).toBe(401)
			expect((await deliver(body, `Bearer ${binding.secret}`)).status).toBe(200)
			const rows = await admin((sql) => sql.unsafe(`select image::text as image from ${schema}.products where name like 'order 7: %'`))
			expect(rows).toHaveLength(5)
			const stored = await files()
			for (const row of rows) {
				expect(stored.find((file) => file.id === row.image)).toMatchObject({ status: 'live', kind: 'catalog' })
			}
			expect((await deliver(mail('order 8', 8) + ' '.repeat(4 * 1024 * 1024), `Bearer ${binding.secret}`)).status).toBe(413)
		})
	})

	describe('the isolation fixture', () => {
		test("seeds a live file of the column's kind into a required file column", async () => {
			const worlds = await postgres.seedWorlds(tables, 'deals')
			const seeded = await postgres.seedUnder(tables, 'deal_attachments', worlds.own)
			const [row] = await admin((sql) => sql.unsafe(`select file::text as file from ${schema}.deal_attachments where id = $1`, [seeded.key]))
			expect((await files()).find((file) => file.id === row.file)).toMatchObject({ status: 'live', kind: 'attachments' })
		})

		test('lets the policy isolation probes write a seeded file into a file column, in their own scope only', async () => {
			const attachments = policyIsolationKit(contract, tables, 'deal_attachments', postgres)
			expect([(await attachments.insert('own')).status, (await attachments.insert('other')).status]).toEqual([200, 403])
			const products = appPolicyIsolationKit(contract, tables, 'products', postgres)
			expect([(await products.insert('global')).status, (await products.update('global')).status]).toEqual([200, 200])
		})

		test('lets the endpoint access kit send a generated file and download a seeded one, in its own scope only', async () => {
			const access = endpointAccessKit(serve(contract, { database: scoped(tables) }), tables, postgres)
			const upload = { name: 'generated', file: `${GENERATED_FILE_PREFIX}attachments` }
			expect([(await access.own('api.attachments.upload', upload)).status, (await access.denied('api.attachments.upload', upload)).status]).toEqual([
				200,
				404,
			])
			const many = { files: [`${GENERATED_FILE_PREFIX}attachments`, `${GENERATED_FILE_PREFIX}attachments`] }
			expect((await access.own('api.attachments.uploadMany', many)).status).toBe(200)
			const download = { id: `${GENERATED_ROW_PREFIX}deal_attachments` }
			expect([(await access.own('api.attachments.download', download)).status, (await access.denied('api.attachments.download', download)).status])
				.toEqual([200, 404])
		})
	})
}
