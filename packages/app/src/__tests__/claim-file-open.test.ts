// A job opens the file of a row it claimed when it also holds the table's read action: the claim runs under the update
// action, and the job's read action would reach the same file by a re-read of the row. A job that holds only the update
// action is still refused. On the SQLite test database, so it never skips.

import { defineApp, defineVocabulary } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { scoped, type TypedColumnList } from '@fabrika/db'
import { defineTables } from '@fabrika/db/tables'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import type { ColumnType, Generated } from 'kysely'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

interface UploadsTable {
	id: string
	file: string
	result: string | null
	attempts: Generated<number>
	next_attempt_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>
	version: number
}

const columns: TypedColumnList<{ uploads: UploadsTable }> = {
	uploads: {
		columns: ['id', 'file', 'result', 'attempts', 'next_attempt_at', 'version'],
		foreignKeys: [],
		timestamps: ['next_attempt_at'],
	},
}

const vocabulary = defineVocabulary({
	app: 'uploads',
	dimensions: {},
	actions: { 'uploads.read': 'Read uploads', 'uploads.write': 'Upload documents', 'uploads.process': 'Process uploads' },
	roles: { uploader: { grants: ['uploads.read', 'uploads.write'] } },
})

const tables = defineTables(vocabulary, columns)({
	uploads: {
		scope: { app: 'one inbox per application' },
		actions: { read: 'uploads.read', insert: 'uploads.write', update: 'uploads.process' },
		insert: ['file'],
		update: ['result'],
		files: { file: 'documents' },
		queue: { attempts: 'attempts', due: 'next_attempt_at' },
		version: 'version',
	},
})

const PDF = '%PDF-1.7\n%%EOF\n'

const app = defineApp(vocabulary, tables)

const uploads = app.group({ callers: ['human'] }, (r) => ({
	upload: r.mutation({
		input: z.strictObject({}),
		output: z.strictObject({ id: z.string(), version: z.int() }),
		access: { action: 'uploads.write', app: true },
	}).handle(async ({ ctx }) => {
		const file = await ctx.files.put('documents', new TextEncoder().encode(PDF), { type: 'application/pdf', name: 'brief.pdf' })
		return ctx.db.app.uploads.insert({ file })
	}),
}))

/** What each run of a job did with the file of each row it claimed: its text, or the refusal. */
const seen: string[] = []

/** Records the text of an opened file, or the refusal of its open. */
async function record(open: () => Promise<{ readonly bytes: Uint8Array }>): Promise<void> {
	try {
		seen.push(new TextDecoder().decode((await open()).bytes))
	} catch (error) {
		seen.push(error instanceof Error ? error.message : String(error))
	}
}

const reading = app.cron('*/5 * * * *', { actions: ['uploads.read', 'uploads.process'] }).handle(async ({ ctx }) => {
	for (const row of await ctx.db.app('uploads.process').uploads.claim({ limit: 5 })) {
		await record(() => ctx.files.open(row.file))
		await ctx.transaction((tx) => tx.db.on(row.ref).update({ result: 'processed' }, { expectVersion: row.version, done: true }))
	}
})

const blind = app.cron('*/5 * * * *', { actions: ['uploads.process'] }).handle(async ({ ctx }) => {
	for (const row of await ctx.db.app('uploads.process').uploads.claim({ limit: 5 })) {
		await record(() => ctx.files.open(row.file))
		await ctx.transaction((tx) => tx.db.on(row.ref).update({ result: 'processed' }, { expectVersion: row.version, done: true }))
	}
})

const contract = app.contract((c) => ({
	api: c.rpc('/api', { uploads }),
	files: { documents: c.files({ types: ['application/pdf'], maxBytes: 1048576 }) },
	jobs: { reading, blind },
}))

const directory = mkdtempSync(join(tmpdir(), 'fabrika-claim-file-open-'))
mkdirSync(join(directory, 'migrations'))
writeFileSync(
	join(directory, 'migrations', '20261103120000_uploads.sql'),
	`CREATE TABLE uploads (
	id TEXT PRIMARY KEY,
	file TEXT NOT NULL REFERENCES fabrika_files (id),
	result TEXT,
	attempts INTEGER NOT NULL DEFAULT 0,
	next_attempt_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	version INTEGER NOT NULL
) STRICT;
CREATE INDEX uploads_file ON uploads (file);
`,
)
const database = await testDatabase({ migrations: join(directory, 'migrations'), label: 'claim-file-open.test.ts' })
const kit = testKit(serve(contract, { database: scoped(tables) }), { database: database.database, files: new MemoryFileObjects() })
const call = kit.browser(kit.testCaller([{ action: 'uploads.write' }]))

afterAll(async () => {
	await database.close()
	rmSync(directory, { recursive: true, force: true })
})

beforeEach(() => {
	seen.length = 0
})

async function upload(): Promise<void> {
	const response = await call('/api/uploads.upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
	expect(response.status).toBe(200)
}

describe('the file of a claimed row', () => {
	test('opens in a job that also holds the table read action', async () => {
		await upload()
		expect(await kit.runJob('reading')).toMatchObject({ status: 'succeeded' })
		expect(seen).toEqual([PDF])
	})

	test('is refused to a job that holds only the update action', async () => {
		await upload()
		expect(await kit.runJob('blind')).toMatchObject({ status: 'succeeded' })
		expect(seen).toEqual([expect.stringContaining('a file reference this request holds and may read')])
	})
})
