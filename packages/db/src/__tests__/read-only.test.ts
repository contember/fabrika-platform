// A read-only request (an export's): the layer refuses every write and lock before any statement, and runs every
// read in a `READ ONLY` transaction. The Postgres half skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset:
//
//   docker run --rm -d -p 55433:5432 -e POSTGRES_PASSWORD=postgres postgres:17
//   FABRIKA_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55433/postgres bun test packages/db
//
// The URL is a credential: it is never logged.

import { openPostgres } from '@fabrika/db/postgres'
import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from '../database'
import { QueryRefusedError } from '../errors'
import { TestAuthority } from './fixtures/authority'
import { RecordingDialect } from './fixtures/recording-dialect'
import { migration } from './fixtures/schema'
import { connected, defineStores } from './fixtures/stores'
import { tables } from './fixtures/tables'

const alice = new TestAuthority('user:alice')
const chain = { workspace: 'w1', organization: 'o1' }

describe('a read-only request, over a recording connection', () => {
	const dialect = new RecordingDialect()
	let readOnly = true
	const { notes, comments } = defineStores({ database: Database.fromDialect(dialect), capabilities: alice, readOnly: () => readOnly })

	test('a read runs in a READ ONLY transaction', async () => {
		dialect.log.length = 0
		dialect.transactions.length = 0
		await notes.list(alice.within('workspace', 'notes.read', ['w1']), { limit: 10, offset: 0 })
		expect(dialect.transactions).toEqual([{ accessMode: 'read only' }])
		expect(dialect.log.map((statement) => statement.sql)).toHaveLength(1)
	})

	test('every write is refused before a statement, whatever capability it carries', async () => {
		dialect.log.length = 0
		const workspace = alice.ref('workspace', 'notes.write', 'w1', { organization: 'o1' })
		const writes = [
			() => notes.create(workspace, { title: 'x', body: null }),
			() => notes.update(alice.ref('note', 'notes.write', 'n1', chain), { title: 'y' }, 1),
			() => notes.remove(alice.ref('note', 'notes.delete', 'n1', chain)),
			() => notes.move(alice.ref('note', 'notes.delete', 'n1', chain), workspace),
			() => comments.add(alice.ref('note', 'notes.write', 'n1', chain), 'hi'),
		]
		for (const write of writes) {
			await expect(write()).rejects.toThrow(QueryRefusedError)
		}
		expect(dialect.log).toEqual([])
	})

	test("the framework's locator reads in a READ ONLY transaction too", async () => {
		const locating = new RecordingDialect()
		const { locate } = connected(tables, { database: Database.fromDialect(locating), capabilities: alice, readOnly: () => true })
		expect(await locate('note', 'n1')).toBeNull()
		expect(locating.transactions).toEqual([{ accessMode: 'read only' }])
		expect(locating.log).toHaveLength(1)
	})

	test('outside a read-only request a read opens no transaction', async () => {
		readOnly = false
		dialect.transactions.length = 0
		await notes.list(alice.within('workspace', 'notes.read', ['w1']), { limit: 10, offset: 0 })
		expect(dialect.transactions).toEqual([])
		readOnly = true
	})
})

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''

if (!hasPostgres) {
	console.warn(`read-only.test.ts skipped its Postgres half: set ${URL_VAR} to run it`)
}

const schema = `ro_${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
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
	if (!hasPostgres) {
		return
	}
	await admin(async (sql) => {
		await sql.unsafe(`create schema ${schema}`)
		await sql.unsafe(`set search_path to ${schema}; ${migration}`)
		await sql.unsafe(`insert into ${schema}.organizations (id, name) values ('o1', 'One')`)
		await sql.unsafe(`insert into ${schema}.workspaces (id, organization_id, name, created_by) values ('w1', 'o1', 'w1', 'user:alice')`)
	})
	database = openPostgres({ url, schema, max: 2 })
})

afterAll(async () => {
	if (!hasPostgres) {
		return
	}
	await database.close()
	await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
})

describe.skipIf(!hasPostgres)('a read-only request, on Postgres', () => {
	test('reads in a READ ONLY transaction, and a write with an authentic capability changes nothing', async () => {
		let readOnly = false
		const { notes } = defineStores({ database, capabilities: alice, readOnly: () => readOnly })
		const workspace = alice.ref('workspace', 'notes.write', 'w1', { organization: 'o1' })
		await notes.create(workspace, { title: 'before', body: null })
		readOnly = true
		const listed = await notes.list(alice.within('workspace', 'notes.read', ['w1']), { limit: 10, offset: 0 })
		expect(listed.map((note) => note.title)).toEqual(['before'])
		await expect(notes.create(workspace, { title: 'during', body: null })).rejects.toThrow('this request is read-only')
		const [count] = await admin((sql) => sql.unsafe(`select count(*)::int as n from ${schema}.notes`))
		expect(count).toEqual({ n: 1 })
	})
})
