// An export handler cannot write, on a REAL Postgres: an export may declare no action a table writes with, its request
// is read-only, and the data layer refuses every write in a read-only request — with a capability that would allow it
// anywhere else — and runs every read `READ ONLY`. Skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset:
//
//   docker run --rm -d -p 55433:5432 -e POSTGRES_PASSWORD=postgres postgres:17
//   FABRIKA_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55433/postgres bun test packages/app
//
// The file gets its own application schema `app_<id>`. The URL is a credential: it is never logged.

import { applicationSchema, Database, type Ref, scoped, type Within } from '@fabrika/db'
import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { compileContract } from '../contract/compile'
import { defineContract } from '../contract/define'
import type { ContractApp } from '../implement/boot'
import { mintRef, RequestFrame, requestIsReadOnly, runInRequest } from '../implement/capability'
import { implement } from '../implement/implement'
import { appToken, bootApp, grant, resultOf, send, token } from './fixtures/implement/harness'
import { ById, contract as notesContract, Note, NoteList } from './fixtures/scoped-notes/fabrika.contract'
import { migration } from './fixtures/scoped-notes/migration'
import { tables } from './fixtures/scoped-notes/src/db/tables'

const exporting = defineContract(notesContract.vocabulary, (c) => ({
	exports: {
		notes: c.export({
			version: 1,
			consumers: ['digest'],
			audience: 'any consumer user',
			procedures: {
				list: c.query({ output: NoteList, access: { action: 'notes.read', over: 'workspace' } }),
				probe: c.query({ output: z.strictObject({ readOnly: z.boolean() }), access: { action: 'notes.read', over: 'workspace' } }),
			},
		}),
	},
}))

const database = scoped(tables)
const notes = database.defineStore('notes', (t) => ({
	list: (within: Within<'workspace', 'notes.read'>) => t.select(within, (q) => q.columns(['id', 'title']).orderBy('id')),
	create: (workspace: Ref<'workspace', 'notes.write'>, title: string) => t.insert(workspace, { title }),
}))

const app = implement(exporting, {
	database,
	deps: () => ({}),
	handlers: () => ({
		exports: {
			notes: {
				list: async ({ ctx }) => ({ items: await notes.list(ctx.within) }),
				probe: () => ({ readOnly: requestIsReadOnly() }),
			},
		},
	}),
})

test('an export may declare no action a table writes with', () => {
	const writing = defineContract(notesContract.vocabulary, (c) => ({
		exports: {
			notes: c.export({
				version: 1,
				consumers: ['digest'],
				audience: 'any consumer user',
				procedures: { touch: c.query({ output: NoteList, access: { action: 'notes.write', over: 'workspace' } }) },
			}),
		},
	}))
	expect(() => compileContract(writing, tables)).toThrow("'notes.write' writes table 'notes'; an export reads only (allowed: a read action)")
})

test('an export may declare no action that manages members', () => {
	const managing = defineContract(notesContract.vocabulary, (c) => ({
		exports: {
			notes: c.export({
				version: 1,
				consumers: ['digest'],
				audience: 'any consumer user',
				procedures: { members: c.query({ output: NoteList, access: { action: 'notes.admin', over: 'workspace' } }) },
			}),
		},
	}))
	expect(() => compileContract(managing, tables)).toThrow("'notes.admin' manages the members of 'workspace'; an export reads only")
})

/**
 * The same `on` endpoint as an export and as an RPC procedure, over a `notes` view whose containment column tells
 * whether the statement ran in a READ ONLY transaction: only then is a note in `w1`.
 */
const locating = defineContract(notesContract.vocabulary, (c) => ({
	api: c.rpc('/api', { callers: ['machine'] }, {
		get: c.query({ input: ById, output: Note, access: { action: 'notes.read', on: 'note', from: 'id' } }),
	}),
	exports: {
		notes: c.export({
			version: 1,
			consumers: ['digest'],
			audience: 'any consumer user',
			procedures: { get: c.query({ input: ById, output: Note, access: { action: 'notes.read', on: 'note', from: 'id' } }) },
		}),
	},
}))

const VIEW_MIGRATION = `
create table notes_data (id uuid primary key, workspace_id text not null, title text not null, created_by text not null, version integer not null);
create view notes as select id,
	case current_setting('transaction_read_only') when 'on' then workspace_id else 'outside-read-only' end as workspace_id,
	title, created_by, version
from notes_data;
`

const locatingApp = implement(locating, {
	database: scoped(tables),
	deps: () => ({}),
	handlers: () => ({
		api: { get: ({ ctx }) => ({ id: ctx.target.value, title: 'located' }) },
		exports: { notes: { get: ({ ctx }) => ({ id: ctx.target.value, title: 'located' }) } },
	}),
})

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''

if (!hasPostgres) {
	console.warn(`export-read-only.test.ts skipped its Postgres half: set ${URL_VAR} to run it`)
}

const schema = applicationSchema(`ro-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`)
let connection: Database
let booted: ContractApp
const viewSchema = applicationSchema(`rv-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`)
const viewNote = Bun.randomUUIDv7()
let viewConnection: Database
let viewBooted: ContractApp

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

async function count(): Promise<unknown> {
	const [row] = await admin((sql) => sql.unsafe(`select count(*)::int as n from ${schema}.notes`))
	return row
}

beforeAll(async () => {
	if (!hasPostgres) {
		return
	}
	await admin((sql) => sql.unsafe(`create schema ${schema}; set search_path to ${schema}; ${migration}`))
	await admin((sql) =>
		sql.unsafe(`insert into ${schema}.notes (id, workspace_id, title, created_by, version) values ($1, 'w1', 'kept', 'user-9', 1)`, [
			Bun.randomUUIDv7(),
		])
	)
	connection = Database.postgres({ url, schema, max: 2 })
	booted = bootApp(app, { database: connection })
	await admin((sql) => sql.unsafe(`create schema ${viewSchema}; set search_path to ${viewSchema}; ${VIEW_MIGRATION}`))
	await admin((sql) =>
		sql.unsafe(`insert into ${viewSchema}.notes_data (id, workspace_id, title, created_by, version) values ($1, 'w1', 'kept', 'user-9', 1)`, [viewNote])
	)
	viewConnection = Database.postgres({ url, schema: viewSchema, max: 2 })
	viewBooted = bootApp(locatingApp, { database: viewConnection })
})

afterAll(async () => {
	if (!hasPostgres) {
		return
	}
	await connection.close()
	await viewConnection.close()
	await admin((sql) => sql.unsafe(`drop schema ${schema} cascade; drop schema ${viewSchema} cascade`))
})

/** The edge's request as the proxy forwards it: the key stays in `Authorization`, the token is the proxy's. */
const keyRequest = { 'Content-Type': 'application/json', Authorization: 'Bearer px_edge_key' }

describe.skipIf(!hasPostgres)('an export handler cannot write', () => {
	test('the export reads through a READ ONLY request, to its edge key', async () => {
		const edge = await appToken('digest', [grant('notes.read', { type: 'workspace', value: 'w1' })])
		const listed = await send(booted, '/__fabrika/connect/notes.v1.list', { token: edge, body: {}, headers: keyRequest })
		expect(resultOf(listed)).toEqual({ items: [{ id: expect.any(String), title: 'kept' }] })
		const probed = await send(booted, '/__fabrika/connect/notes.v1.probe', { token: edge, body: {}, headers: keyRequest })
		expect(resultOf(probed)).toEqual({ readOnly: true })
	})

	test("the access check's locator runs READ ONLY in an export, and only there", async () => {
		const edge = await appToken('digest', [grant('notes.read', { type: 'workspace', value: 'w1' })])
		const exported = await send(viewBooted, '/__fabrika/connect/notes.v1.get', { token: edge, body: { id: viewNote }, headers: keyRequest })
		expect(resultOf(exported)).toEqual({ id: viewNote, title: 'located' })
		const machine = await token('service', [grant('notes.read', { type: 'workspace', value: 'w1' })])
		const procedure = await send(viewBooted, '/api/get', { token: machine, body: { id: viewNote }, headers: keyRequest })
		expect(procedure.status).toBe(404)
	})

	test('in a read-only request a write capability of that request is refused, and nothing is written', async () => {
		const exportFrame = new RequestFrame('export-request', { readOnly: true })
		await expect(runInRequest(exportFrame, () => {
			const workspace = mintRef(exportFrame, 'workspace', 'notes.write', 'service-1', 'w1', new Map())
			return notes.create(workspace, 'smuggled')
		})).rejects.toThrow('this request is read-only')
		expect(await count()).toEqual({ n: 1 })
		// The same write in an ordinary request goes through: the refusal is the request's, not the capability's.
		const mutationFrame = new RequestFrame('mutation-request')
		await runInRequest(mutationFrame, () => notes.create(mintRef(mutationFrame, 'workspace', 'notes.write', 'user-1', 'w1', new Map()), 'written'))
		expect(await count()).toEqual({ n: 2 })
	})
})
