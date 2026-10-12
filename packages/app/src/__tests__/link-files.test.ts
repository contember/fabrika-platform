// Link-holder file collections (WU15): a `link: true` collection gets upload, list and download routes under the API prefix
// of every link mount bound to its owner's dimension, caller `link`. The owner is the link's object, never a parameter:
// each route checks the key's mount and the object's current chain as a link procedure does, and a download resolves
// its file beneath that object. On a REAL Postgres; skips cleanly without FABRIKA_TEST_POSTGRES_URL.

import { compileContract, ContractError, defineContract } from '@fabrika/app/contract'
import type { ContractApp } from '@fabrika/app/implement'
import { ENDPOINT_HEADER, type LinkTokenClaims, PROXY_TOKEN_HEADER } from '@fabrika/auth-core'
import { applicationSchema, Database, scoped } from '@fabrika/db'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { implement } from '../implement/implement'
import { bootApp, endpointHeaderFor, grant, linkToken, ORIGIN, resultOf, send, token } from './fixtures/implement/harness'
import { migration } from './fixtures/scoped-files/migration'
import { tables } from './fixtures/scoped-files/src/db/tables'
import { vocabulary } from './fixtures/scoped-files/src/vocabulary'
import { record } from './helpers'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''
if (!hasPostgres) {
	console.warn(`link-files.test.ts skipped its Postgres half: set ${URL_VAR} to run it`)
}

const PDF = new TextEncoder().encode('%PDF-1.7\n%%EOF\n')
const Title = z.strictObject({ title: z.string() })

const linked = (shared: { readonly grants: readonly ['notes.read', ...('notes.read' | 'notes.write')[]] }) =>
	defineContract(vocabulary, (c) => ({
		api: c.rpc('/api', { callers: ['human'] }, {
			notes: { get: c.query({ input: z.strictObject({ id: z.uuid() }), output: Title, access: { action: 'notes.read', on: 'note', from: 'id' } }) },
		}),
		shared: c.link('/s', {
			spa: 'dist/share',
			dimension: 'note',
			grants: [...shared.grants],
			issuedBy: 'notes.write',
			maxDays: 7,
			procedures: (l) => ({ note: l.query({ output: Title, access: { action: 'notes.read' } }) }),
		}),
		other: c.link('/o', {
			spa: 'dist/other',
			dimension: 'note',
			grants: ['notes.read', 'notes.write'],
			issuedBy: 'notes.write',
			maxDays: 7,
			procedures: (l) => ({ note: l.query({ output: Title, access: { action: 'notes.read' } }) }),
		}),
		files: {
			attachments: c.files({
				owner: 'notes',
				read: 'notes.read',
				write: 'notes.write',
				delete: 'notes.delete',
				maxBytes: 4096,
				types: ['application/pdf'],
				maxPerOwner: 2,
				link: true,
			}),
		},
	}))

const contract = linked({ grants: ['notes.read', 'notes.write'] })

function linkedApp() {
	return implement(contract, {
		database: scoped(tables),
		deps: () => ({}),
		handlers: () => ({
			api: { notes: { get: () => ({ title: 'a note' }) } },
			shared: { note: () => ({ title: 'a note' }) },
			other: { note: () => ({ title: 'a note' }) },
		}),
	})
}

describe('a link: true collection in the artifact', () => {
	test('has upload and download rows under each link mount bound to its owner, for the link caller, on the link object', () => {
		const rows = compileContract(contract, tables).endpoints.filter((row) => row.id.includes('.files.'))
		expect(rows.map((row) => [row.id, row.method, row.path, row.kind === 'public-spa' ? null : row.callers])).toEqual([
			['other.files.attachments.download', 'GET', '/o/api/files.attachments/:fileId', ['link']],
			['other.files.attachments.list', 'POST', '/o/api/files.attachments.list', ['link']],
			['other.files.attachments.upload', 'POST', '/o/api/files.attachments.upload', ['link']],
			['shared.files.attachments.download', 'GET', '/s/api/files.attachments/:fileId', ['link']],
			['shared.files.attachments.list', 'POST', '/s/api/files.attachments.list', ['link']],
			['shared.files.attachments.upload', 'POST', '/s/api/files.attachments.upload', ['link']],
		])
		const upload = rows.find((row) => row.id === 'shared.files.attachments.upload')
		expect(upload?.requirement).toEqual({ kind: 'action', action: 'notes.write', access: { form: 'on', dimension: 'note', from: null } })
	})

	test('is refused when a mount bound to its owner does not grant its write action', () => {
		let problems: readonly string[] = []
		try {
			compileContract(linked({ grants: ['notes.read'] }), tables)
		} catch (error) {
			if (error instanceof ContractError) problems = error.problems
		}
		expect(problems).toEqual([
			"files 'attachments': sets link: true, and link mount 'shared' grants no 'notes.write' (allowed: grants: ['notes.read', 'notes.write'])",
		])
	})
})

const schema = applicationSchema(`linkfiles-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`)
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
	database = Database.postgres({ url, schema, max: 2 })
})

afterAll(async () => {
	if (!hasPostgres) return
	await database.close()
	await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
})

async function seedNote(workspace = 'w1'): Promise<string> {
	const id = Bun.randomUUIDv7()
	await admin((sql) =>
		sql.unsafe(`insert into ${schema}.notes (id, workspace_id, title, created_by, version) values ($1, $2, 'note', 'user-9', 1)`, [id, workspace])
	)
	return id
}

/** A key of `mount` for `note`, as IAM mints it: the mount's grants frozen on the note, its chain the note's workspace. */
function holderOf(note: string, mount = 'shared', workspace = 'w1'): Promise<string> {
	const object = { type: 'note', value: note }
	const link: LinkTokenClaims = { mount, chain: [object, { type: 'workspace', value: workspace }] }
	return linkToken([grant('notes.read', object), grant('notes.write', object)], link)
}

async function upload(app: ContractApp, holder: string, prefix = '/s'): Promise<{ readonly status: number; readonly body: unknown }> {
	const path = `${prefix}/api/files.attachments.upload`
	const headers = new Headers({
		'Sec-Fetch-Site': 'same-origin',
		'Content-Type': 'application/pdf',
		[PROXY_TOKEN_HEADER]: holder,
		[ENDPOINT_HEADER]: endpointHeaderFor(linkedApp(), 'POST', path) ?? '',
	})
	const response = await app.fetch(new Request(`${ORIGIN}${path}`, { method: 'POST', headers, body: PDF }))
	return { status: response.status, body: await response.json() }
}

function idOf(sent: { readonly status: number; readonly body: unknown }): string {
	const body = sent.body
	const result = typeof body === 'object' && body !== null && 'result' in body ? body.result : null
	const id = typeof result === 'object' && result !== null && 'id' in result ? result.id : null
	if (sent.status !== 200 || typeof id !== 'string') throw new Error(`expected an upload, got ${sent.status} ${JSON.stringify(body)}`)
	return id
}

function download(app: ContractApp, holder: string, id: string, prefix = '/s'): Promise<Response> {
	return app.fetch(new Request(`${ORIGIN}${prefix}/api/files.attachments/${id}`, { headers: { [PROXY_TOKEN_HEADER]: holder } }))
}

describe.skipIf(!hasPostgres)('a link holder and its object’s files', () => {
	let app: ContractApp
	beforeAll(() => {
		if (hasPostgres) app = bootApp(linkedApp(), { database, files: new MemoryFileObjects() })
	})

	test('uploads to the object its key is bound to and downloads that file', async () => {
		const note = await seedNote()
		const holder = await holderOf(note)
		const id = idOf(await upload(app, holder))
		const [row] = await admin((sql) => sql.unsafe(`select owner_id from ${schema}.fabrika_files_attachments where id = $1`, [id]))
		expect(row?.owner_id).toBe(note)
		const response = await download(app, holder, id)
		expect(response.status).toBe(200)
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(PDF)
	})

	test("lists its object's files only, and takes no owner", async () => {
		const mine = await seedNote()
		const theirs = await seedNote()
		const holder = await holderOf(mine)
		const own = idOf(await upload(app, holder))
		idOf(await upload(app, await holderOf(theirs)))
		const listed = await send(app, '/s/api/files.attachments.list', { token: holder, body: {} })
		const items = record(resultOf(listed))['items']
		expect(Array.isArray(items) ? items.map((item: unknown) => record(item)['id']) : items).toEqual([own])
		expect((await send(app, '/s/api/files.attachments.list', { token: holder, body: { owner: theirs } })).status).toBe(400)
		expect((await send(app, '/s/api/files.attachments.list', { token: await holderOf(mine, 'other'), body: {} })).status).toBe(403)
	})

	test("another object's file is 404, and so is an id that names no file", async () => {
		const mine = await seedNote()
		const theirs = await seedNote()
		const theirFile = idOf(await upload(app, await holderOf(theirs)))
		const holder = await holderOf(mine)
		for (const id of [theirFile, Bun.randomUUIDv7(), 'not-a-uuid']) {
			expect((await download(app, holder, id)).status).toBe(404)
		}
		// A holder of the other object uploads into that object only: nothing lands on mine.
		const [count] = await admin((sql) => sql.unsafe(`select count(*)::int as n from ${schema}.fabrika_files_attachments where owner_id = $1`, [mine]))
		expect(count?.n).toBe(0)
	})

	test("a key of another mount on the same dimension reaches only its own mount's routes", async () => {
		const note = await seedNote()
		const shared = idOf(await upload(app, await holderOf(note)))
		const other = await holderOf(note, 'other')
		expect((await upload(app, other)).status).toBe(403)
		expect((await download(app, other, shared)).status).toBe(403)
		expect((await download(app, other, shared, '/o')).status).toBe(200)
		expect(idOf(await upload(app, other, '/o'))).toBeString()
	})

	test('once the object moves, its link reaches none of its files and uploads nothing', async () => {
		const note = await seedNote()
		const holder = await holderOf(note)
		const id = idOf(await upload(app, holder))
		await admin((sql) => sql.unsafe(`update ${schema}.notes set workspace_id = 'w2' where id = $1`, [note]))
		expect((await download(app, holder, id)).status).toBe(404)
		expect(await upload(app, holder)).toMatchObject({ status: 404 })
		// The key issued for where the note lies now reaches it again.
		expect((await download(app, await holderOf(note, 'shared', 'w2'), id)).status).toBe(200)
	})

	test("an upload keeps the collection's limits, and a person's token is no link caller", async () => {
		const note = await seedNote()
		const holder = await holderOf(note)
		idOf(await upload(app, holder))
		idOf(await upload(app, holder))
		expect(await upload(app, holder)).toMatchObject({ status: 409 })
		const person = await token('user', [
			grant('notes.read', { type: 'workspace', value: 'w1' }),
			grant('notes.write', { type: 'workspace', value: 'w1' }),
		])
		expect((await upload(app, person)).status).toBe(403)
	})
})
