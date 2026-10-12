// How a bound Date reaches Postgres: as its ISO 8601 UTC text, whatever the process time zone, and an invalid Date
// never reaches it. The Postgres half skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset (see postgres.test.ts).

import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Within } from '../capability'
import { Database } from '../database'
import { QueryRefusedError } from '../errors'
import { fileTableSql } from '../file-table-sql'
import type { FileCollectionTable, PendingFile } from '../file-tables'
import { fileTablesOf } from '../framework'
import { defineStore } from '../store'
import { TestAuthority } from './fixtures/authority'
import { recordingLayer } from './fixtures/harness'
import { migration } from './fixtures/schema'
import { connected } from './fixtures/stores'
import { tables } from './fixtures/tables'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR]
const hasPostgres = url !== undefined && url !== ''

if (!hasPostgres) {
	console.warn(`date-binding.test.ts skipped: set ${URL_VAR} to run the Postgres-backed tests`)
}

const SPEC = {
	name: 'attachments',
	owner: 'notes',
	dimension: 'file:attachments',
	actions: { read: 'notes.read', write: 'notes.write', delete: 'notes.delete' },
	scan: true,
}
const OWNER = {
	table: 'notes',
	key: { column: 'id', type: 'text' },
	chain: [{ column: 'workspace_id', type: 'text' }, { column: 'organization_id', type: 'text' }],
} as const

/** West of UTC, so `Date#toString()` names an offset Postgres does not read as one. */
const PROCESS_TIME_ZONE = 'America/Los_Angeles'
const originalTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
const AT = new Date('2026-03-04T05:06:07.891Z')
const later = (date: Date, ms: number): Date => new Date(date.getTime() + ms)

const schema = `dates_${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
const alice = new TestAuthority('user:alice')
let database: Database
let files: FileCollectionTable
let createdBetween: (within: Within<'workspace', 'notes.read'>, from: Date, to: Date) => Promise<readonly { id: string }[]>

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

const ownerRef = (note: string) => alice.ref('note', 'notes.write', note, { workspace: 'w1', organization: 'o1' })

function pending(createdAt: Date): PendingFile {
	const id = Bun.randomUUIDv7()
	return { id, objectKey: `attachments/${id}`, contentType: 'image/png', originalName: 'a.png', createdAt }
}

beforeAll(async () => {
	process.env.TZ = PROCESS_TIME_ZONE
	if (!hasPostgres) {
		return
	}
	await admin(async (sql) => {
		await sql.unsafe(`create schema ${schema}`)
		await sql.unsafe(`set search_path to ${schema}; ${migration} ${fileTableSql('attachments', OWNER)}`)
		await sql.unsafe(`insert into ${schema}.organizations (id, name) values ('o1', 'One')`)
		await sql.unsafe(`insert into ${schema}.workspaces (id, organization_id, name, created_by) values ('w1', 'o1', 'w1', 'user:alice')`)
		await sql.unsafe(
			`insert into ${schema}.notes (id, workspace_id, organization_id, title, created_by, version) values ('n1', 'w1', 'o1', 'n1', 'user:alice', 1)`,
		)
	})
	database = Database.postgres({ url: url ?? '', schema, max: 2 })
	const layer = connected(tables, { database, capabilities: alice }).database
	files = fileTablesOf(layer).collection(SPEC)
	const notes = defineStore(layer, 'notes', (t) => ({
		createdBetween: (within: Within<'workspace', 'notes.read'>, from: Date, to: Date) =>
			t.select(within, (q) => q.columns(['id']).where('created_at', '>=', from).where('created_at', '<', to).orderBy('id')),
	}))
	createdBetween = notes.createdBetween
})

afterAll(async () => {
	process.env.TZ = originalTimeZone
	if (!hasPostgres) {
		return
	}
	await database.close()
	await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
})

describe('a bound Date', () => {
	test('the process runs west of UTC', () => {
		expect(AT.getTimezoneOffset()).toBeGreaterThan(0)
	})

	test('is bound as its ISO 8601 UTC text', async () => {
		const layer = recordingLayer()
		const notes = defineStore(layer.stores.database, 'notes', (t) => ({
			since: (within: Within<'workspace', 'notes.read'>, from: Date) => t.select(within, (q) => q.columns(['id']).where('created_at', '>=', from)),
		}))
		const outcome = await layer.attempt(() => notes.since(layer.within('notes.read'), AT))
		expect(outcome.error).toBeUndefined()
		expect(outcome.statements.map((statement) => statement.parameters)).toEqual([['2026-03-04T05:06:07.891Z', 'w1']])
	})

	test('an invalid Date is refused before any statement is sent', async () => {
		const layer = recordingLayer()
		const notes = defineStore(layer.stores.database, 'notes', (t) => ({
			since: (within: Within<'workspace', 'notes.read'>, from: Date) => t.select(within, (q) => q.columns(['id']).where('created_at', '>=', from)),
		}))
		const fromStore = await layer.attempt(() => notes.since(layer.within('notes.read'), new Date(Number.NaN)))
		expect(fromStore.error).toBeInstanceOf(QueryRefusedError)
		expect(fromStore.statements).toEqual([])
	})
})

describe.skipIf(!hasPostgres)('a bound Date on Postgres', () => {
	test('the layer stores it to the millisecond', async () => {
		const file = pending(AT)
		await files.begin(ownerRef('n1'), file)
		const [row] = await admin((sql) => sql.unsafe(`select created_at from ${schema}.fabrika_files_attachments where id = $1`, [file.id]))
		expect(row?.created_at).toEqual(AT)
	})

	test('it compares to the millisecond: the sweep takes a pending row only when it is strictly older', async () => {
		const file = pending(later(AT, 60_000))
		await files.begin(ownerRef('n1'), file)
		const removable = async (cutoff: Date) => (await files.removable(100, cutoff)).map((removed) => removed.id)
		expect(await removable(file.createdAt)).not.toContain(file.id)
		expect(await removable(later(file.createdAt, 1))).toContain(file.id)
	})

	test('an invalid Date is refused and nothing is written', async () => {
		const file = pending(AT)
		await expect(files.begin(ownerRef('n1'), pending(new Date(Number.NaN)))).rejects.toBeInstanceOf(QueryRefusedError)
		await files.begin(ownerRef('n1'), file)
		await files.complete(ownerRef('n1'), file.id, { size: 3, sha256: 'ab'.repeat(32) }, 'live')
		const fileRef = alice.ref('file:attachments', 'notes.delete', file.id, { note: 'n1', workspace: 'w1', organization: 'o1' })
		await expect(files.markRemoved(fileRef, new Date(Number.NaN))).rejects.toBeInstanceOf(QueryRefusedError)
		const [row] = await admin((sql) => sql.unsafe(`select deleted_at from ${schema}.fabrika_files_attachments where id = $1`, [file.id]))
		expect(row?.deleted_at).toBeNull()
	})

	test('a store compares it to the millisecond', async () => {
		await admin((sql) =>
			sql.unsafe(
				`insert into ${schema}.notes (id, workspace_id, organization_id, title, created_by, version, created_at)
				values ('n2', 'w1', 'o1', 'n2', 'user:alice', 1, '2026-03-04T05:06:07.891Z')`,
			)
		)
		const within = alice.within('workspace', 'notes.read', ['w1'])
		expect(await createdBetween(within, AT, later(AT, 1))).toEqual([{ id: 'n2' }])
		expect(await createdBetween(within, later(AT, 1), later(AT, 2))).toEqual([])
		expect(await createdBetween(within, later(AT, -1), AT)).toEqual([])
	})
})
