// The file fixtures and the refusals of the endpoint access kit: a handler that inspects an upload's content refuses
// the kit's sample file (400), which the kit reports as an input it could not build; it reaches its own object with the
// file the author names, typed by its bytes; and a refusal the author declares is the handler's answer in the own case
// only, which gets it as a 400, while a leak case still throws on it and the denial still proves the access form. Over `kit-files`' tables, with one attach endpoint that reads the upload,
// on the SQLite test database: an upload is live once a row of the request's transaction holds it, as on Cloudflare.

import { HttpError } from '@fabrika/app'
import { defineApp, file } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { endpointAccessKit } from '@fabrika/app/testing/isolation'
import { scoped } from '@fabrika/db'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod/v4'
import { migration } from './fixtures/kit-files/migration'
import { tables } from './fixtures/kit-files/src/db/tables'
import { vocabulary } from './fixtures/kit-files/src/vocabulary'

const directory = mkdtempSync(join(tmpdir(), 'fabrika-endpoint-access-files-'))
const migrations = join(directory, 'migrations')
mkdirSync(migrations)
// The fixture's migration holds the framework's tables first, which the test database applies itself.
writeFileSync(join(migrations, '20261009120000_files.sql'), migration.slice(migration.indexOf('create table notes')))
const database = await testDatabase({ migrations, label: 'endpoint-access-files.test.ts' })

afterAll(async () => {
	await database.close()
	rmSync(directory, { recursive: true, force: true })
})

/** What the handler accepts: a PDF whose text says it is a valid document. */
const VALID = '%PDF-1.7\nvalid document\n'

function packagesApp() {
	const app = defineApp(vocabulary, tables)
	const notes = app.group({ callers: ['human'] }, (r) => ({
		attach: r.mutation({
			input: z.strictObject({ id: z.uuid(), file: file('attachments') }),
			output: z.strictObject({ id: z.uuid() }),
			access: { action: 'notes.write', on: 'note', from: 'id' },
		}).handle(async ({ input, ctx }) => {
			// An upload is live once a row holds it; a refusal rolls the row back.
			const added = await ctx.db.target.note_attachments.insert({ file: input.file })
			const opened = await ctx.files.open(input.file)
			if (new TextDecoder().decode(opened.bytes) !== VALID) {
				throw new HttpError(400, 'document_invalid', 'the document is not a valid one')
			}
			return added
		}),
	}))
	const contract = app.contract((c) => ({
		api: c.rpc('/api', { notes }),
		files: {
			documents: c.files({ maxBytes: 4096, types: ['application/pdf'] }),
			attachments: c.files({ maxBytes: 4096, types: ['text/plain', 'application/pdf'] }),
		},
	}))
	return serve(contract, { database: scoped(tables) })
}

const INPUT = { id: '00000000-0000-4000-8000-000000000000', file: 'fabrika:file:attachments' }

describe('the file fixtures of the endpoint access kit', () => {
	test("a handler that inspects the content refuses the kit's sample, and the case says the fixtures give a file", async () => {
		const kit = endpointAccessKit(packagesApp(), tables, database)
		expect(await kit.denied('api.notes.attach', INPUT)).toEqual({ status: 404 })
		await expect(kit.own('api.notes.attach', INPUT)).rejects.toThrow('a file it accepts in files')
	})

	test('the file the fixtures name reaches the handler, typed by its bytes', async () => {
		const path = join(directory, 'valid.pdf')
		writeFileSync(path, VALID)
		const kit = endpointAccessKit(packagesApp(), tables, database, { files: { 'api.notes.attach': { file: pathToFileURL(path) } } })
		expect(await kit.own('api.notes.attach', INPUT)).toEqual({ status: 200 })
		expect(await kit.leaked('api.notes.attach', INPUT)).toEqual({ answered: true, leaked: [] })
		expect(await kit.denied('api.notes.attach', INPUT)).toEqual({ status: 404 })
	})

	test("a declared refusal is the own case's answer only: a leak case throws on it, and the denial is still 404", async () => {
		const kit = endpointAccessKit(packagesApp(), tables, database, { refusals: { 'api.notes.attach': ['document_invalid'] } })
		expect(await kit.own('api.notes.attach', INPUT)).toEqual({ status: 400 })
		await expect(kit.leaked('api.notes.attach', INPUT)).rejects.toThrow('its declared refusal (400 document_invalid), which only the own case takes')
		expect(await kit.denied('api.notes.attach', INPUT)).toEqual({ status: 404 })
		const other = endpointAccessKit(packagesApp(), tables, database, { refusals: { 'api.notes.attach': ['package_invalid'] } })
		await expect(other.own('api.notes.attach', INPUT)).rejects.toThrow("the handler refused the case's input (400 document_invalid)")
	})

	test('a file the kit cannot read, or of none of the kind’s types, throws and names the file', async () => {
		const missing = join(directory, 'missing.pdf')
		const absent = endpointAccessKit(packagesApp(), tables, database, { files: { 'api.notes.attach': { file: pathToFileURL(missing) } } })
		await expect(absent.own('api.notes.attach', INPUT)).rejects.toThrow(`the file of file in the fixtures, ${missing}, cannot be read`)
		const binary = join(directory, 'image.png')
		writeFileSync(binary, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))
		const untyped = endpointAccessKit(packagesApp(), tables, database, { files: { 'api.notes.attach': { file: pathToFileURL(binary) } } })
		await expect(untyped.own('api.notes.attach', INPUT)).rejects.toThrow(
			`${binary}, is none of the types of files.attachments (application/pdf, text/plain)`,
		)
	})
})
