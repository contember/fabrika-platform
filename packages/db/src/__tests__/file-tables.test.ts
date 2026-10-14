// A file collection's table: its name and DDL, and the framework's rows against a REAL Postgres, every request-made
// operation scoped by the capability's whole chain. Skips the Postgres half cleanly when FABRIKA_TEST_POSTGRES_URL is
// unset (see postgres.test.ts).

import { classifyMigration } from '@fabrika/platform-node/sql'
import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from '../database'
import { CapabilityError, LeaseLostError, NotFoundError, PolicyError, QueryRefusedError } from '../errors'
import { fileScanSql, fileTableName, fileTableSql, legacyStatusCheckName } from '../file-table-sql'
import type { FileCollectionTable, PendingFile } from '../file-tables'
import { type DataAccess, dataAccessOf, fileTablesOf, frameworkTablesOf, type JobLeases } from '../framework'
import { FRAMEWORK_MIGRATIONS } from '../migrations'
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
	scan: true,
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
let leases: JobLeases
let access: DataAccess
const SHA = 'ab'.repeat(32)
const VERSION = '"v1"'
/** A moment just after now: every file whose retry is not deferred is due. */
const soon = (): Date => new Date(Date.now() + 1000)

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

/** A file of `note` in `w1` whose upload ended `quarantined`, as in a scanning collection. */
async function quarantinedFile(note: string): Promise<string> {
	const file = pending()
	await files.begin(ownerRef(note), file)
	await files.complete(ownerRef(note), file.id, { size: 3, sha256: SHA }, 'quarantined')
	return file.id
}

/** Runs `work` as a job attempt that holds the scan job's lease, as the scan pass does. */
async function inLease<T>(work: () => Promise<T>): Promise<T> {
	const job = `scan-${Bun.randomUUIDv7()}`
	await leases.register(job)
	const fence = await leases.acquire(job, Bun.randomUUIDv7(), 60_000, 120_000)
	if (fence === null) {
		throw new Error('the test lease is taken')
	}
	alice.lease = fence
	try {
		return await work()
	} finally {
		alice.lease = null
		await leases.finish(fence, 'succeeded')
	}
}

/** A file that is live under `note` in `w1`. */
async function liveFile(note: string): Promise<string> {
	const file = pending()
	await files.begin(ownerRef(note), file)
	await files.complete(ownerRef(note), file.id, { size: 3, sha256: 'ab'.repeat(32) }, 'live')
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
		const framework = FRAMEWORK_MIGRATIONS.map((file) => file.sql).join('\n')
		await sql.unsafe(`set search_path to ${schema}; ${framework} ${migration} ${fileTableSql('attachments', OWNER)}`)
		await sql.unsafe(`insert into ${schema}.organizations (id, name) values ('o1', 'One')`)
		for (const workspace of ['w1', 'w2']) {
			await sql.unsafe(`insert into ${schema}.workspaces (id, organization_id, name, created_by) values ($1, 'o1', $1, 'user:alice')`, [workspace])
		}
	})
	database = Database.postgres({ url: url ?? '', schema, max: 2 })
	const layer = connected(tables, { database, capabilities: alice }).database
	files = fileTablesOf(layer).collection(SPEC)
	leases = frameworkTablesOf(layer).jobs
	access = dataAccessOf(layer)
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
		await files.complete(ownerRef('n1'), file.id, { size: 3, sha256: 'ab'.repeat(32) }, 'live')
		expect(await files.locate(file.id)).toEqual(new Map([['note', 'n1'], ['workspace', 'w1'], ['organization', 'o1']]))
		expect(await files.find(fileRef('notes.read', file.id, 'n1'))).toEqual({
			id: file.id,
			objectKey: file.objectKey,
			size: 3,
			contentType: 'image/png',
			originalName: 'a.png',
			status: 'live',
			objectVersion: null,
		})
		expect(await files.countHeld(ownerRef('n1'))).toBe(1)
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
		await expect(files.complete(ownerRef('n3'), file.id, { size: 3, sha256: 'ab'.repeat(32) }, 'live')).rejects.toBeInstanceOf(NotFoundError)
		expect(await statusOf(file.id)).toBe('pending')
	})

	test('find, markRemoved and countHeld carry the whole chain: a Ref from before the owner moved reaches nothing', async () => {
		await addNote('n4')
		const id = await liveFile('n4')
		await moveNote('n4', 'w2')
		await expect(files.find(fileRef('notes.read', id, 'n4'))).rejects.toBeInstanceOf(NotFoundError)
		await expect(files.markRemoved(fileRef('notes.delete', id, 'n4'), new Date())).rejects.toBeInstanceOf(NotFoundError)
		expect(await files.countHeld(ownerRef('n4'))).toBe(0)
		expect((await files.find(fileRef('notes.read', id, 'n4', 'w2'))).id).toBe(id)
	})

	test('a capability of the wrong dimension or action is refused before any query', async () => {
		await addNote('n5')
		const id = await liveFile('n5')
		await expect(files.markRemoved(fileRef('notes.read', id, 'n5'), new Date())).rejects.toBeInstanceOf(CapabilityError)
		await expect(files.find(ownerRef('n5'))).rejects.toBeInstanceOf(CapabilityError)
		await expect(files.list(ownerRef('n5'), { after: null, limit: 10 })).rejects.toBeInstanceOf(CapabilityError)
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

	test("removeOwned marks every held file of the owner removed in the site's transaction, scoped by the owner's whole chain", async () => {
		await addNote('n10')
		await addNote('n11')
		const first = await liveFile('n10')
		const second = await quarantinedFile('n10')
		const other = await liveFile('n11')
		const owner = () => alice.ref('note', 'notes.delete', 'n10', { workspace: 'w1', organization: 'o1' })

		const rolledBack = access.invocation(false)
		expect(await files.removeOwned(owner(), new Date(), await rolledBack.session())).toBe(2)
		await rolledBack.rollback()
		expect((await files.list(alice.ref('note', 'notes.read', 'n10', { workspace: 'w1', organization: 'o1' }), { after: null, limit: 10 })).items)
			.toHaveLength(2)

		const invocation = access.invocation(false)
		const session = await invocation.session()
		expect(await files.removeOwned(owner(), new Date(), session)).toBe(2)
		const listed = await files.list(
			alice.ref('note', 'notes.read', 'n10', { workspace: 'w1', organization: 'o1' }),
			{ after: null, limit: 10 },
			session,
		)
		expect(listed.items).toEqual([])
		await invocation.commit()
		const ids = (await files.removable(100, new Date(Date.now() - HOUR))).map((file) => file.id)
		expect(ids).toEqual(expect.arrayContaining([first, second]))
		expect(ids).not.toContain(other)
		expect(await statusOf(other)).toBe('live')
	})

	test('removeOwned marks a pending upload removed too: its completion after the commit fails, after a rollback it lands', async () => {
		await addNote('n13')
		const remover = () => alice.ref('note', 'notes.delete', 'n13', { workspace: 'w1', organization: 'o1' })
		const reader = () => alice.ref('note', 'notes.read', 'n13', { workspace: 'w1', organization: 'o1' })
		const kept = pending()
		await files.begin(ownerRef('n13'), kept)
		const rolledBack = access.invocation(false)
		expect(await files.removeOwned(remover(), new Date(), await rolledBack.session())).toBe(1)
		await rolledBack.rollback()
		await files.complete(ownerRef('n13'), kept.id, { size: 3, sha256: SHA }, 'live')
		expect((await files.list(reader(), { after: null, limit: 10 })).items.map((file) => file.id)).toEqual([kept.id])

		const racing = pending()
		await files.begin(ownerRef('n13'), racing)
		const erasure = access.invocation(false)
		expect(await files.removeOwned(remover(), new Date(), await erasure.session())).toBe(2)
		// The completion waits on the erasure's row lock, and finds the row removed once the erasure commits.
		const completion = files.complete(ownerRef('n13'), racing.id, { size: 3, sha256: SHA }, 'live').then(() => 'completed', (error: unknown) => error)
		const early = await Promise.race([completion, Bun.sleep(200).then(() => 'waiting')])
		expect(early).toBe('waiting')
		await erasure.commit()
		expect(await completion).toBeInstanceOf(NotFoundError)
		expect(await statusOf(racing.id)).toBe('pending')
		await files.abandon(racing.id)
		expect(await statusOf(racing.id)).toBeUndefined()
		expect((await files.list(reader(), { after: null, limit: 10 })).items).toEqual([])
	})

	test('removeOwned needs a Ref of the owner for the delete action, and one from before the owner moved removes nothing', async () => {
		await addNote('n12')
		const id = await liveFile('n12')
		const session = access.direct()
		await expect(files.removeOwned(ownerRef('n12'), new Date(), session)).rejects.toBeInstanceOf(CapabilityError)
		await expect(files.removeOwned(fileRef('notes.delete', id, 'n12'), new Date(), session)).rejects.toBeInstanceOf(CapabilityError)
		const before = alice.ref('note', 'notes.delete', 'n12', { workspace: 'w1', organization: 'o1' })
		await moveNote('n12', 'w2')
		expect(await files.removeOwned(before, new Date(), session)).toBe(0)
		expect(await statusOf(id)).toBe('live')
	})

	test('removable honours its limit', async () => {
		await addNote('n9')
		for (let index = 0; index < 3; index++) {
			await files.markRemoved(fileRef('notes.delete', await liveFile('n9'), 'n9'), new Date())
		}
		expect(await files.removable(2, new Date(Date.now() - HOUR))).toHaveLength(2)
	})
})

describe('the status check of a scanning collection', () => {
	test('the DDL admits every state under a named check; the scan migration replaces the check an earlier DDL created', () => {
		expect(fileTableSql('attachments', OWNER)).toContain(
			"status TEXT NOT NULL CONSTRAINT fabrika_files_attachments_status CHECK (status IN ('pending', 'live', 'quarantined', 'rejected'))",
		)
		expect(fileScanSql('attachments')).toStartWith(
			'ALTER TABLE fabrika_files_attachments DROP CONSTRAINT IF EXISTS fabrika_files_attachments_status_check, ADD CONSTRAINT fabrika_files_attachments_status',
		)
		expect(legacyStatusCheckName(`fabrika_files_${'a'.repeat(39)}`)).toBe(`fabrika_files_${'a'.repeat(36)}_status_check`)
	})

	test("the migration classifier admits the DDL and the scan migration as an application's own migration writes them", () => {
		const sql = `CREATE TABLE notes (id text PRIMARY KEY);\n${fileTableSql('attachments', { ...OWNER, chain: [] })}${fileScanSql('attachments')}`
		expect(classifyMigration(sql, 'app_x', { file: 'db/migrations/20261012000000_files.sql' }).refused).toEqual([])
	})

	test.skipIf(!hasPostgres)('on Postgres, the scan migration widens a table of the earlier DDL, a 39-character name included', async () => {
		const legacy = `legacy_${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
		const names = ['attachments', 'a'.repeat(39)]
		await admin(async (sql) => {
			await sql.unsafe(`create schema ${legacy}; set search_path to ${legacy}; create table notes (id text primary key)`)
			for (const name of names) {
				// The DDL as an earlier fileTableSql wrote it: an unnamed check of two states and no scan index.
				const earlier = fileTableSql(name, { table: 'notes', key: { column: 'id', type: 'text' }, chain: [] })
					.replace(/CONSTRAINT \S+ CHECK \(status IN \([^)]*\)\)/, "CHECK (status IN ('pending', 'live'))")
					.replace(/^CREATE INDEX \S+_scan .*$/m, '')
					.replace(/^\t(object_version|scan_attempts|scan_after) .*\n/gm, '')
				await sql.unsafe(`set search_path to ${legacy}; ${earlier}`)
			}
		})
		try {
			for (const name of names) {
				const table = `fabrika_files_${name}`
				const quarantine =
					`insert into ${legacy}.${table} (id, status, object_key, content_type, created_by, created_at) values ('${Bun.randomUUIDv7()}', 'quarantined', '${Bun.randomUUIDv7()}', 'image/png', 'u', now())`
				await expect(admin((sql) => sql.unsafe(quarantine))).rejects.toThrow('violates check constraint')
				await admin((sql) => sql.unsafe(`set search_path to ${legacy}; ${fileScanSql(name)}`))
				await admin((sql) => sql.unsafe(quarantine))
				await expect(admin((sql) => sql.unsafe(quarantine.replace("'quarantined'", "'other'")))).rejects.toThrow('violates check constraint')
			}
		} finally {
			await admin((sql) => sql.unsafe(`drop schema ${legacy} cascade`))
		}
	})
})

describe.skipIf(!hasPostgres)('the scan states of a file collection on Postgres', () => {
	test('a quarantined file is located, found with its state and listed, but holds no live status until promoted', async () => {
		await addNote('s1')
		const id = await quarantinedFile('s1')
		expect(await statusOf(id)).toBe('quarantined')
		expect(await files.locate(id)).toEqual(new Map([['note', 's1'], ['workspace', 'w1'], ['organization', 'o1']]))
		expect((await files.find(fileRef('notes.read', id, 's1'))).status).toBe('quarantined')
		expect(await files.quarantined(100, soon())).toContainEqual({
			id,
			objectKey: `attachments/${id}`,
			size: 3,
			sha256: SHA,
			contentType: 'image/png',
			scanAttempts: 0,
			dueSince: expect.any(Date),
		})
		expect(await inLease(() => files.promote(id, SHA, VERSION))).toBe(true)
		expect((await files.find(fileRef('notes.read', id, 's1'))).status).toBe('live')
		expect((await files.quarantined(100, soon())).map((file) => file.id)).not.toContain(id)
	})

	test('a verdict outside a lease is refused, and one whose lease was lost writes nothing', async () => {
		await addNote('s2')
		const id = await quarantinedFile('s2')
		await expect(files.promote(id, SHA, VERSION)).rejects.toBeInstanceOf(QueryRefusedError)
		await expect(files.reject(id)).rejects.toBeInstanceOf(QueryRefusedError)
		await expect(
			inLease(async () => {
				const fence = alice.lease
				if (fence === null) throw new Error('no lease')
				// Another run takes the lease over: a newer generation is granted, so the old attempt commits nothing.
				await admin((sql) => sql.unsafe(`update ${schema}.fabrika_job_leases set generation = generation + 1 where job = $1`, [fence.job]))
				return files.promote(id, SHA, VERSION)
			}),
		).rejects.toBeInstanceOf(LeaseLostError)
		expect(await statusOf(id)).toBe('quarantined')
	})

	test('promotion is fenced against a concurrent remove, an orphaning owner delete and another digest', async () => {
		await addNote('s3')
		await addNote('s4')
		const removed = await quarantinedFile('s3')
		const changed = await quarantinedFile('s3')
		const orphaned = await quarantinedFile('s4')
		await files.markRemoved(fileRef('notes.delete', removed, 's3'), new Date())
		await admin((sql) => sql.unsafe(`delete from ${schema}.notes where id = 's4'`))
		expect(await inLease(() => files.promote(removed, SHA, VERSION))).toBe(false)
		expect(await inLease(() => files.promote(orphaned, SHA, VERSION))).toBe(false)
		expect(await inLease(() => files.promote(changed, 'cd'.repeat(32), VERSION))).toBe(false)
		expect(await statusOf(removed)).toBe('quarantined')
		expect(await statusOf(orphaned)).toBe('quarantined')
		expect(await statusOf(changed)).toBe('quarantined')
		const batch = (await files.quarantined(100, soon())).map((file) => file.id)
		expect(batch).toContain(changed)
		expect(batch).not.toContain(removed)
		expect(batch).not.toContain(orphaned)
	})

	test('a rejected file is found as rejected, never promoted, counted, removable once removed, and swept in every state', async () => {
		await addNote('s5')
		await addNote('s6')
		const rejected = await quarantinedFile('s5')
		expect(await inLease(() => files.reject(rejected))).toBe(true)
		expect(await inLease(() => files.promote(rejected, SHA, VERSION))).toBe(false)
		expect((await files.find(fileRef('notes.read', rejected, 's5'))).status).toBe('rejected')
		const quarantined = await quarantinedFile('s5')
		await liveFile('s5')
		expect(await files.countHeld(ownerRef('s5'))).toBe(3)
		const cutoff = new Date(Date.now() - HOUR)
		expect((await files.removable(100, cutoff)).map((file) => file.id)).not.toEqual(expect.arrayContaining([rejected]))
		await files.markRemoved(fileRef('notes.delete', rejected, 's5'), new Date())
		await files.markRemoved(fileRef('notes.delete', quarantined, 's5'), new Date())
		expect(await files.countHeld(ownerRef('s5'))).toBe(1)
		const orphanedRejected = await quarantinedFile('s6')
		await inLease(() => files.reject(orphanedRejected))
		await admin((sql) => sql.unsafe(`delete from ${schema}.notes where id = 's6'`))
		const removable = (await files.removable(100, cutoff)).map((file) => file.id)
		expect(removable).toEqual(expect.arrayContaining([rejected, quarantined, orphanedRejected]))
		for (const id of [rejected, quarantined, orphanedRejected]) {
			await files.purge(id, cutoff)
			expect(await statusOf(id)).toBeUndefined()
		}
	})

	test("the list is an owner's held files, oldest first, in bounded keyset pages, for the read action only, scoped by the owner's whole chain", async () => {
		await addNote('s7')
		const live = await liveFile('s7')
		const quarantined = await quarantinedFile('s7')
		const rejected = await quarantinedFile('s7')
		await inLease(() => files.reject(rejected))
		const removed = await liveFile('s7')
		await files.markRemoved(fileRef('notes.delete', removed, 's7'), new Date())
		await files.begin(ownerRef('s7'), pending())
		const reader = alice.ref('note', 'notes.read', 's7', { workspace: 'w1', organization: 'o1' })
		const first = await files.list(reader, { after: null, limit: 2 })
		expect(first.items.map((file) => [file.id, file.status])).toEqual([[live, 'live'], [quarantined, 'quarantined']])
		expect(first.items[0]).toMatchObject({ name: 'a.png', type: 'image/png', size: 3 })
		expect(first.items[0]?.createdAt).toBeInstanceOf(Date)
		expect(first.next).toBe(quarantined)
		const second = await files.list(reader, { after: first.next, limit: 2 })
		expect(second.items.map((file) => [file.id, file.status])).toEqual([[rejected, 'rejected']])
		expect(second.next).toBeNull()
		await expect(files.list(ownerRef('s7'), { after: null, limit: 2 })).rejects.toBeInstanceOf(CapabilityError)
		await expect(files.list(reader, { after: null, limit: 0 })).rejects.toBeInstanceOf(QueryRefusedError)
		await moveNote('s7', 'w2')
		expect((await files.list(reader, { after: null, limit: 10 })).items).toEqual([])
	})

	test('a deferred retry waits until its time, and the longest waiting file comes first', async () => {
		await addNote('s8')
		const failing = await quarantinedFile('s8')
		await inLease(() => files.deferScan(failing, 1, new Date(Date.now() + HOUR)))
		const fresh = await quarantinedFile('s8')
		const ids = (await files.quarantined(1000, soon())).map((file) => file.id)
		expect(ids).toContain(fresh)
		expect(ids).not.toContain(failing)
		const later = await files.quarantined(1000, new Date(Date.now() + 2 * HOUR))
		expect(later.findIndex((file) => file.id === fresh)).toBeLessThan(later.findIndex((file) => file.id === failing))
		expect(later.find((file) => file.id === failing)?.scanAttempts).toBe(1)
		// A retry recorded twice for the same try changes nothing the second time.
		expect(await inLease(() => files.deferScan(failing, 1, new Date()))).toBe(false)
	})

	test('a live file is quarantined again only by the download that saw another version than the scanned one', async () => {
		await addNote('s9')
		const id = await quarantinedFile('s9')
		await inLease(() => files.promote(id, SHA, VERSION))
		const reader = fileRef('notes.read', id, 's9')
		expect((await files.find(reader)).objectVersion).toBe(VERSION)
		await files.requarantine(reader, '"another"')
		expect(await statusOf(id)).toBe('live')
		await files.requarantine(reader, VERSION)
		expect(await statusOf(id)).toBe('quarantined')
		expect((await files.find(reader)).objectVersion).toBeNull()
	})

	test('a collection that does not scan has no scan batch, verdict, retry or quarantine', async () => {
		const plain = fileTablesOf(connected(tables, { database, capabilities: alice }).database).collection({ ...SPEC, scan: false })
		await expect(plain.quarantined(1, soon())).rejects.toBeInstanceOf(QueryRefusedError)
		await expect(plain.promote(Bun.randomUUIDv7(), SHA, VERSION)).rejects.toBeInstanceOf(QueryRefusedError)
		await expect(plain.deferScan(Bun.randomUUIDv7(), 1, new Date())).rejects.toBeInstanceOf(QueryRefusedError)
	})
})
