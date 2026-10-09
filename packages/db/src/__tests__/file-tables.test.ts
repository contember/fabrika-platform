// A file collection's table: its name and DDL, and the framework's rows against a REAL Postgres, every request-made
// operation scoped by the capability's whole chain. Skips the Postgres half cleanly when FABRIKA_TEST_POSTGRES_URL is
// unset (see postgres.test.ts).

import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from '../database'
import { CapabilityError, NotFoundError, PolicyError, QueryRefusedError } from '../errors'
import { fileTableName, fileTableSql } from '../file-table-sql'
import type { FileCollectionTable, PendingFile } from '../file-tables'
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

const SPEC = {
	name: 'attachments',
	owner: 'notes',
	dimension: 'file:attachments',
	actions: { read: 'notes.read', write: 'notes.write', delete: 'notes.delete' },
}
const OWNER = {
	table: 'notes',
	key: { column: 'id', type: 'text' },
	chain: [{ column: 'workspace_id', type: 'text' }, { column: 'organization_id', type: 'text' }],
} as const

const schema = `files_${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
const alice = new TestAuthority('user:alice')
const HOUR = 60 * 60 * 1000
let database: Database
let files: FileCollectionTable

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

const ownerRef = (note: string, workspace = 'w1') => alice.ref('note', 'notes.write', note, { workspace, organization: 'o1' })
const fileRef = <const A extends string>(action: A, id: string, note: string, workspace = 'w1') =>
	alice.ref('file:attachments', action, id, { note, workspace, organization: 'o1' })

function pending(): PendingFile {
	const id = Bun.randomUUIDv7()
	return { id, objectKey: `attachments/${id}`, contentType: 'image/png', originalName: 'a.png', createdAt: new Date() }
}

/** A file that is live under `note` in `w1`. */
async function liveFile(note: string): Promise<string> {
	const file = pending()
	await files.begin(ownerRef(note), file)
	await files.complete(ownerRef(note), file.id, { size: 3, sha256: 'ab'.repeat(32) })
	return file.id
}

async function addNote(id: string, workspace = 'w1'): Promise<void> {
	await admin((sql) =>
		sql.unsafe(
			`insert into ${schema}.notes (id, workspace_id, organization_id, title, created_by, version) values ($1, $2, 'o1', $1, 'user:alice', 1)`,
			[id, workspace],
		)
	)
}

async function moveNote(id: string, workspace: string): Promise<void> {
	await admin((sql) => sql.unsafe(`update ${schema}.notes set workspace_id = $2 where id = $1`, [id, workspace]))
}

async function statusOf(id: string): Promise<unknown> {
	const [row] = await admin((sql) => sql.unsafe(`select status from ${schema}.fabrika_files_attachments where id = $1`, [id]))
	return row?.status
}

beforeAll(async () => {
	if (!hasPostgres) {
		return
	}
	await admin(async (sql) => {
		await sql.unsafe(`create schema ${schema}`)
		await sql.unsafe(`set search_path to ${schema}; ${migration} ${fileTableSql('attachments', OWNER)}`)
		await sql.unsafe(`insert into ${schema}.organizations (id, name) values ('o1', 'One')`)
		for (const workspace of ['w1', 'w2']) {
			await sql.unsafe(`insert into ${schema}.workspaces (id, organization_id, name, created_by) values ($1, 'o1', $1, 'user:alice')`, [workspace])
		}
	})
	database = Database.postgres({ url: url ?? '', schema, max: 2 })
	files = fileTablesOf(connected(tables, { database, capabilities: alice }).database).collection(SPEC)
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

	test('its DDL carries the owner’s chain under a composite foreign key that cascades a move', () => {
		expect(fileTableSql('attachments', OWNER)).toContain(
			'FOREIGN KEY (owner_id, workspace_id, organization_id) REFERENCES notes (id, workspace_id, organization_id) ON UPDATE CASCADE ON DELETE SET NULL',
		)
	})

	test('its DDL refuses an owner that is not a plain identifier, a key that does not decode as a string, and a clashing column', () => {
		expect(() => fileTableSql('attachments', { ...OWNER, table: 'notes; drop table x' })).toThrow(QueryRefusedError)
		expect(() => fileTableSql('Attachments', OWNER)).toThrow(QueryRefusedError)
		expect(() => fileTableSql('attachments', { ...OWNER, chain: [{ column: 'status', type: 'text' }] })).toThrow(QueryRefusedError)
	})

	test('a collection needs an owner that is a dimension table, and the layer itself', () => {
		const layer = connected(tables, { database: Database.fromDialect(new RecordingDialect()), capabilities: new TestAuthority('x') }).database
		expect(() => fileTablesOf(layer).collection({ ...SPEC, owner: 'note_comments' })).toThrow(PolicyError)
		expect(() => fileTablesOf({ tables: {} })).toThrow('not a data layer scoped(tables) created')
	})
})

describe.skipIf(!hasPostgres)('the rows of a file collection on Postgres', () => {
	test('a pending file is neither found nor located; a completed one is, with its owner’s chain', async () => {
		await addNote('n1')
		const file = pending()
		await files.begin(ownerRef('n1'), file)
		expect(await statusOf(file.id)).toBe('pending')
		expect(await files.locate(file.id)).toBeNull()
		await expect(files.find(fileRef('notes.read', file.id, 'n1'))).rejects.toBeInstanceOf(NotFoundError)
		await files.complete(ownerRef('n1'), file.id, { size: 3, sha256: 'ab'.repeat(32) })
		expect(await files.locate(file.id)).toEqual(new Map([['note', 'n1'], ['workspace', 'w1'], ['organization', 'o1']]))
		expect(await files.find(fileRef('notes.read', file.id, 'n1'))).toEqual({
			id: file.id,
			objectKey: file.objectKey,
			size: 3,
			contentType: 'image/png',
			originalName: 'a.png',
		})
		expect(await files.countLive(ownerRef('n1'))).toBe(1)
	})

	test('a begin with a Ref minted before the owner moved writes nothing', async () => {
		await addNote('n2', 'w2')
		const file = pending()
		await expect(files.begin(ownerRef('n2', 'w1'), file)).rejects.toBeInstanceOf(NotFoundError)
		expect(await statusOf(file.id)).toBeUndefined()
	})

	test('a complete after the owner moved fails, and the pending row moved with its owner', async () => {
		await addNote('n3')
		const file = pending()
		await files.begin(ownerRef('n3'), file)
		await moveNote('n3', 'w2')
		await expect(files.complete(ownerRef('n3'), file.id, { size: 3, sha256: 'ab'.repeat(32) })).rejects.toBeInstanceOf(NotFoundError)
		expect(await statusOf(file.id)).toBe('pending')
	})

	test('find, markRemoved and countLive carry the whole chain: a Ref from before the owner moved reaches nothing', async () => {
		await addNote('n4')
		const id = await liveFile('n4')
		await moveNote('n4', 'w2')
		await expect(files.find(fileRef('notes.read', id, 'n4'))).rejects.toBeInstanceOf(NotFoundError)
		await expect(files.markRemoved(fileRef('notes.delete', id, 'n4'), new Date())).rejects.toBeInstanceOf(NotFoundError)
		expect(await files.countLive(ownerRef('n4'))).toBe(0)
		expect((await files.find(fileRef('notes.read', id, 'n4', 'w2'))).id).toBe(id)
	})

	test('a capability of the wrong dimension or action is refused before any query', async () => {
		await addNote('n5')
		const id = await liveFile('n5')
		await expect(files.markRemoved(fileRef('notes.read', id, 'n5'), new Date())).rejects.toBeInstanceOf(CapabilityError)
		await expect(files.find(ownerRef('n5'))).rejects.toBeInstanceOf(CapabilityError)
		await expect(files.begin(alice.ref('note', 'notes.read', 'n5', { workspace: 'w1', organization: 'o1' }), pending())).rejects.toBeInstanceOf(
			CapabilityError,
		)
	})

	test('the sweep sees removed, orphaned and stale pending files, never live ones or uploads in progress', async () => {
		await addNote('n6')
		await addNote('n7')
		const removed = await liveFile('n6')
		await files.markRemoved(fileRef('notes.delete', removed, 'n6'), new Date())
		const kept = await liveFile('n6')
		const orphaned = await liveFile('n7')
		const inProgress = pending()
		await files.begin(ownerRef('n6'), inProgress)
		const stale = { ...pending(), createdAt: new Date(Date.now() - 2 * HOUR) }
		await files.begin(ownerRef('n6'), stale)
		await admin((sql) => sql.unsafe(`delete from ${schema}.notes where id = 'n7'`))

		const cutoff = new Date(Date.now() - HOUR)
		const ids = (await files.removable(100, cutoff)).map((file) => file.id)
		expect(ids).toEqual(expect.arrayContaining([removed, orphaned, stale.id]))
		expect(ids).not.toContain(kept)
		expect(ids).not.toContain(inProgress.id)

		await files.purge(kept, cutoff)
		await files.purge(inProgress.id, cutoff)
		expect(await statusOf(kept)).toBe('live')
		expect(await statusOf(inProgress.id)).toBe('pending')
		for (const id of [removed, orphaned, stale.id]) {
			await files.purge(id, cutoff)
			expect(await statusOf(id)).toBeUndefined()
		}
	})

	test('abandon deletes only a pending row', async () => {
		await addNote('n8')
		const id = await liveFile('n8')
		await files.abandon(id)
		expect(await statusOf(id)).toBe('live')
		const file = pending()
		await files.begin(ownerRef('n8'), file)
		await files.abandon(file.id)
		expect(await statusOf(file.id)).toBeUndefined()
	})

	test('removable honours its limit', async () => {
		await addNote('n9')
		for (let index = 0; index < 3; index++) {
			await files.markRemoved(fileRef('notes.delete', await liveFile('n9'), 'n9'), new Date())
		}
		expect(await files.removable(2, new Date(Date.now() - HOUR))).toHaveLength(2)
	})
})
