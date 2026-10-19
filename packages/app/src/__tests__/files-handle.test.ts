// `ctx.files.put` and `ctx.files.open` of a kit procedure on a REAL Postgres: what a put refuses before anything is
// stored, the bound open reads within, and a reference the request does not hold. Skips cleanly without
// FABRIKA_TEST_POSTGRES_URL.

import { NotFoundError } from '@fabrika/app'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { scoped } from '@fabrika/db'
import { testDatabase } from '@fabrika/db/testing'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { app } from './stored-files-fixture/src/app-kit'
import { tables } from './stored-files-fixture/src/db/tables'
import { PNG_BYTES } from './stored-files-fixture/src/deals/endpoints'

const CATALOG_MAX_BYTES = 64
const BODIES = {
	png: new Uint8Array(PNG_BYTES),
	pdf: new TextEncoder().encode('%PDF-1.7\n%%EOF\n'),
	large: new Uint8Array([...PNG_BYTES, ...new Array<number>(CATALOG_MAX_BYTES).fill(0)]),
}

const Versioned = z.strictObject({ id: z.string(), version: z.int() })
const Opened = z.strictObject({ name: z.nullable(z.string()), type: z.string(), size: z.int(), head: z.array(z.int()) })

const handle = app.group({ callers: ['human'] }, (r) => ({
	put: r.mutation({
		input: z.strictObject({ name: z.string(), type: z.string(), body: z.enum(['png', 'pdf', 'large']) }),
		output: Versioned,
		access: { action: 'catalog.write', app: true },
	}).handle(async ({ input, ctx }) => {
		const image = await ctx.files.put('catalog', BODIES[input.body], { type: input.type, name: input.name })
		return ctx.db.app.products.insert({ name: input.name, image })
	}),
	open: r.mutation({
		input: z.strictObject({ id: z.string(), maxBytes: z.optional(z.int()) }),
		output: Opened,
		access: { action: 'catalog.write', app: true },
	}).handle(async ({ input, ctx }) => {
		const { image } = await ctx.db.app.products.get(input.id)
		if (image === null) throw new NotFoundError('no image')
		const opened = await ctx.files.open(image, input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes })
		return { name: opened.name, type: opened.type, size: opened.size, head: [...opened.bytes.subarray(0, 4)] }
	}),
	copied: r.mutation({
		input: z.strictObject({ id: z.string() }),
		output: z.strictObject({}),
		access: { action: 'catalog.write', app: true },
	}).handle(async ({ input, ctx }) => {
		const { image } = await ctx.db.app.products.get(input.id)
		if (image === null) throw new NotFoundError('no image')
		await ctx.files.open({ ...image })
		return {}
	}),
}))

const contract = app.contract((c) => ({
	api: c.rpc('/api', { handle }),
	files: {
		attachments: c.files({ types: ['application/pdf', 'image/png'], maxBytes: 1048576 }),
		catalog: c.files({ types: ['image/png'], maxBytes: CATALOG_MAX_BYTES }),
		photos: c.files({ types: ['image/png'], maxBytes: 262144 }),
	},
}))

const postgres = await testDatabase({ migrations: join(import.meta.dir, 'stored-files-fixture', 'db', 'migrations'), label: 'files-handle.test.ts' })

afterAll(async () => {
	await postgres?.close()
})

if (postgres !== null) {
	const store = new MemoryFileObjects()
	const kit = testKit(serve(contract, { database: scoped(tables) }), { database: postgres.database, files: store })
	const call = kit.browser(kit.testCaller([{ action: 'catalog.write' }]))
	const post = async (procedure: string, body: unknown): Promise<{ readonly status: number; readonly body: unknown }> => {
		const response = await call(`/api/handle.${procedure}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		})
		return { status: response.status, body: await response.json() }
	}
	const errorType = (body: unknown): unknown => z.strictObject({ error: z.looseObject({ type: z.string() }) }).safeParse(body).data?.error.type

	describe('ctx.files.put', () => {
		test('stores a file of the kind, which open reads back whole with its name and type', async () => {
			const put = await post('put', { name: 'lamp.png', type: 'image/png', body: 'png' })
			expect(put.status).toBe(200)
			const { id } = Versioned.parse(z.strictObject({ result: Versioned }).parse(put.body).result)
			const opened = await post('open', { id })
			expect(opened).toEqual({
				status: 200,
				body: { result: { name: 'lamp.png', type: 'image/png', size: PNG_BYTES.length, head: PNG_BYTES.slice(0, 4) } },
			})
		})

		test('refuses a type the kind does not admit, bytes that are not the declared type, and a file over the kind', async () => {
			const objects = store.objects.size
			const notAdmitted = await post('put', { name: 'brief.pdf', type: 'application/pdf', body: 'pdf' })
			expect([notAdmitted.status, errorType(notAdmitted.body)]).toEqual([415, 'unsupported_media_type'])
			const notItsBytes = await post('put', { name: 'fake.png', type: 'image/png', body: 'pdf' })
			expect([notItsBytes.status, errorType(notItsBytes.body)]).toEqual([415, 'unsupported_media_type'])
			const tooLarge = await post('put', { name: 'large.png', type: 'image/png', body: 'large' })
			expect([tooLarge.status, errorType(tooLarge.body)]).toEqual([413, 'too_large'])
			expect(store.objects.size).toBe(objects)
		})
	})

	describe('ctx.files.open', () => {
		test('refuses a file larger than the bound the site reads within', async () => {
			const put = await post('put', { name: 'desk.png', type: 'image/png', body: 'png' })
			const { id } = Versioned.parse(z.strictObject({ result: Versioned }).parse(put.body).result)
			const opened = await post('open', { id, maxBytes: 4 })
			expect([opened.status, errorType(opened.body)]).toEqual([413, 'too_large'])
		})

		test('refuses a copy of a reference, which the request does not hold, though its file exists', async () => {
			const put = await post('put', { name: 'chair.png', type: 'image/png', body: 'png' })
			const { id } = Versioned.parse(z.strictObject({ result: Versioned }).parse(put.body).result)
			expect((await post('open', { id })).status).toBe(200)
			expect((await post('copied', { id })).status).toBe(500)
		})
	})
}
