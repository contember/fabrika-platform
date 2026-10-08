// A file collection's table: its name and DDL, and the framework's rows against a REAL Postgres. Skips the Postgres
// half cleanly when FABRIKA_TEST_POSTGRES_URL is unset (see postgres.test.ts).

import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from '../database'
import { QueryRefusedError } from '../errors'
import { fileTableName, fileTableSql } from '../file-table-sql'
import type { FileTables, NewFile } from '../file-tables'
import { fileTablesOf } from '../framework'
import { TestAuthority } from './fixtures/authority'
import { RecordingDialect } from './fixtures/recording-dialect'
import { migration } from './fixtures/schema'
import { connected } from './fixtures/stores'
import { tables } from './fixtures/tables'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR]
const hasPostgres = url !== undefined && url !== ''

if (!hasPostgres) {
	console.warn(`file-tables.test.ts skipped: set ${URL_VAR} to run the Postgres-backed tests`)
}

const schema = `files_${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
let database: Database
let files: FileTables

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

function newFile(ownerId: string, overrides: Partial<NewFile> = {}): NewFile {
	const id = Bun.randomUUIDv7()
	return {
		id,
		ownerId,
		objectKey: `attachments/${id}`,
		size: 3,
		contentType: 'image/png',
		originalName: 'a.png',
		sha256: 'ab'.repeat(32),
		createdBy: 'user:alice',
		createdAt: new Date(),
		...overrides,
	}
}

async function addNote(sql: SQL, id: string): Promise<void> {
	await sql.unsafe(
		`insert into ${schema}.notes (id, workspace_id, organization_id, title, created_by, version) values ($1, 'w1', 'o1', $1, 'user:alice', 1)`,
		[id],
	)
}

beforeAll(async () => {
	if (!hasPostgres) {
		return
	}
	await admin(async (sql) => {
		await sql.unsafe(`create schema ${schema}`)
		await sql.unsafe(`set search_path to ${schema}; ${migration} ${fileTableSql('attachments', { table: 'notes', key: 'id', keyType: 'text' })}`)
		await sql.unsafe(`insert into ${schema}.organizations (id, name) values ('o1', 'One')`)
		await sql.unsafe(`insert into ${schema}.workspaces (id, organization_id, name, created_by) values ('w1', 'o1', 'w1', 'user:alice')`)
		for (const id of ['n1', 'n2', 'n3']) {
			await addNote(sql, id)
		}
	})
	database = Database.postgres({ url: url ?? '', schema, max: 2 })
	files = fileTablesOf(connected(tables, { database, capabilities: new TestAuthority('user:alice') }).database)
})

afterAll(async () => {
	if (!hasPostgres) {
		return
	}
	await database.close()
	await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
})

describe('the table of a file collection', () => {
	test('is named after the collection, which must be a short lowercase snake_case name', () => {
		expect(fileTableName('attachments')).toBe('fabrika_files_attachments')
		expect(fileTableName('note_images')).toBe('fabrika_files_note_images')
		expect(fileTableName('Attachments')).toBeNull()
		expect(fileTableName('a-b')).toBeNull()
		expect(fileTableName('a'.repeat(40))).toBeNull()
		expect(fileTableName('a'.repeat(39))).not.toBeNull()
	})

	test('its DDL refuses an owner that is not a plain identifier or whose key does not decode as a string', () => {
		expect(() => fileTableSql('attachments', { table: 'notes; drop table x', key: 'id', keyType: 'text' })).toThrow(QueryRefusedError)
		expect(() => fileTableSql('Attachments', { table: 'notes', key: 'id', keyType: 'text' })).toThrow(QueryRefusedError)
		expect(fileTableSql('attachments', { table: 'notes', key: 'id', keyType: 'uuid' })).toContain(
			'owner_id UUID REFERENCES notes (id) ON DELETE SET NULL',
		)
	})

	test('refuses a value that is not one of scoped(tables), and an operation before the layer is bound', async () => {
		expect(() => fileTablesOf({ tables: {} })).toThrow('not a data layer scoped(tables) created')
		const unbound = fileTablesOf(
			connected(tables, { database: Database.fromDialect(new RecordingDialect()), capabilities: new TestAuthority('x') }).database,
		)
		await expect(unbound.find('Attachments', 'x')).rejects.toThrow(QueryRefusedError)
	})
})

describe.skipIf(!hasPostgres)('the rows of a file collection on Postgres', () => {
	test('a file is live until it is marked removed, and only its owner’s live files count', async () => {
		const file = newFile('n1')
		await files.insert('attachments', file)
		await files.insert('attachments', newFile('n2'))
		expect(await files.find('attachments', file.id)).toEqual({
			id: file.id,
			ownerId: 'n1',
			objectKey: file.objectKey,
			size: 3,
			contentType: 'image/png',
			originalName: 'a.png',
		})
		expect(await files.countLive('attachments', 'n1')).toBe(1)
		expect(await files.markRemoved('attachments', file.id, new Date())).toBe(true)
		expect(await files.markRemoved('attachments', file.id, new Date())).toBe(false)
		expect(await files.find('attachments', file.id)).toBeNull()
		expect(await files.countLive('attachments', 'n1')).toBe(0)
		expect(await files.removable('attachments', 100)).toContainEqual({ id: file.id, objectKey: file.objectKey })
		await files.purge('attachments', file.id)
		expect(await files.removable('attachments', 100)).not.toContainEqual({ id: file.id, objectKey: file.objectKey })
	})

	test('purge never deletes a live file’s row', async () => {
		const file = newFile('n2')
		await files.insert('attachments', file)
		await files.purge('attachments', file.id)
		expect(await files.find('attachments', file.id)).not.toBeNull()
	})

	test('deleting the owner orphans its files: no longer live, and removable', async () => {
		const file = newFile('n3', { originalName: null })
		await files.insert('attachments', file)
		expect((await files.find('attachments', file.id))?.originalName).toBeNull()
		await admin((sql) => sql.unsafe(`delete from ${schema}.notes where id = 'n3'`))
		expect(await files.find('attachments', file.id)).toBeNull()
		expect(await files.removable('attachments', 100)).toContainEqual({ id: file.id, objectKey: file.objectKey })
	})

	test('a file of an owner that does not exist is refused by the foreign key', async () => {
		await expect(files.insert('attachments', newFile('missing-note'))).rejects.toThrow()
	})

	test('removable honours its limit', async () => {
		for (let index = 0; index < 3; index++) {
			const file = newFile('n1')
			await files.insert('attachments', file)
			await files.markRemoved('attachments', file.id, new Date())
		}
		expect(await files.removable('attachments', 2)).toHaveLength(2)
	})
})
