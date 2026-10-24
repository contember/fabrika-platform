// Stored files on SQLite (a bun:sqlite stand-in for a Durable Object's storage): a file's row from pending to live or
// quarantined, a claim that rolls back with its write, the scan's fenced verdicts, and the sweep's deletion protocol,
// where the foreign key of a file column keeps a referenced file. The fixed statements are called directly here; the
// handles that call them are the mini-ORM's.

import { beforeEach, describe, expect, test } from 'bun:test'
import { sessionOf } from '../database'
import { QueryRefusedError } from '../errors'
import { storedRowScope } from '../file-columns'
import { jobLeases } from '../job-leases'
import { modelOf, readTables, tableModels } from '../policy'
import { claimStoredFile, lockStoredFile, stampStoredFile, type StoredFiles, storedFiles, storedFilesMetadata } from '../stored-files'
import { TestAuthority } from './fixtures/authority'
import { type SqliteFramework, sqliteFramework } from './fixtures/sqlite-framework'

const GRACE = 3_600_000
const HOUR = 3_600_000
const RETENTION = 30 * 24 * HOUR

const APP = `
CREATE TABLE deals (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, UNIQUE (id, org_id)) STRICT;
CREATE TABLE deal_attachments (
	id TEXT PRIMARY KEY,
	deal_id TEXT NOT NULL,
	org_id TEXT NOT NULL,
	file TEXT NOT NULL REFERENCES fabrika_files (id),
	name TEXT NOT NULL,
	FOREIGN KEY (deal_id, org_id) REFERENCES deals (id, org_id)
) STRICT;
CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT NOT NULL, image TEXT REFERENCES fabrika_files (id)) STRICT;
INSERT INTO deals (id, org_id, name) VALUES ('d1', 'o1', 'One');
`

const authority = new TestAuthority('u1')
let db: SqliteFramework
let files: StoredFiles

beforeEach(async () => {
	db = await sqliteFramework(APP)
	authority.lease = null
	files = storedFiles(() => ({ database: db.database, capabilities: authority }))
})

const session = () => sessionOf({ database: db.database })

async function staged(kind: string, request = 'request-1'): Promise<string> {
	const id = Bun.randomUUIDv7()
	await files.stage({ id, kind, objectKey: `${kind}/${id}`, contentType: 'application/pdf', name: 'a.pdf', request })
	await files.written(id, { size: 3, sha256: 'c'.repeat(64) })
	return id
}

function fileRow(id: string): Record<string, unknown> | undefined {
	return db.exec('select status, scope, legacy, size from fabrika_files where id = ?', id)[0]
}

/** The reference write's part: lock, claim and stamp, in `session`'s transaction, as `referenceFiles` runs them. */
async function claim(id: string, ended: 'live' | 'quarantined', scope: string | null, fail = false): Promise<void> {
	await session().transaction(async (transaction) => {
		const locked = await lockStoredFile(transaction, id, GRACE)
		expect(locked).toEqual({ kind: expect.any(String), status: 'pending', request: 'request-1', scope: null, fresh: true })
		await claimStoredFile(transaction, id, ended)
		if (scope !== null) {
			expect(await stampStoredFile(transaction, id, scope)).toBe(true)
		}
		if (fail) {
			throw new Error('the handler failed')
		}
	})
}

function backdate(id: string, hours: number): void {
	db.exec(`update fabrika_files set created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) where id = ?`, `-${hours} hours`, id)
}

function backdateDeletion(key: string, days: number): void {
	db.exec(`update fabrika_file_deletions set recorded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) where object_key = ?`, `-${days} days`, key)
}

function recordedAt(key: string, at: Date): void {
	db.exec(`update fabrika_file_deletions set recorded_at = ? where object_key = ?`, at.toISOString(), key)
}

/** The keys due under a window of `windowMs` now, as the sweep asks for them. */
function due(limit: number, windowMs: number): Promise<readonly string[]> {
	return files.dueDeletions(limit, new Date(Date.now() - windowMs))
}

/** An unreferenced file past the grace whose row the sweep removed: its key is queued, its object kept. */
async function removed(objectKey?: string): Promise<string> {
	const id = Bun.randomUUIDv7()
	await files.stage({ id, kind: 'attachments', objectKey: objectKey ?? `attachments/${id}`, contentType: 'application/pdf', name: null, request: 'r' })
	backdate(id, 2)
	const key = await files.remove(id, GRACE)
	if (key === null) {
		throw new Error('the sweep kept an unreferenced file')
	}
	return key
}

describe('a stored file on SQLite', () => {
	test('a staged file is pending with its size; its first reference claims it live or quarantined and stamps its scope', async () => {
		const live = await staged('catalog')
		expect(fileRow(live)).toEqual({ status: 'pending', scope: null, legacy: null, size: 3 })
		expect(await files.find(live)).toEqual({
			id: live,
			kind: 'catalog',
			name: 'a.pdf',
			type: 'application/pdf',
			size: 3,
			status: 'pending',
			objectKey: `catalog/${live}`,
			objectVersion: null,
		})
		await claim(live, 'live', null)
		const scanned = await staged('attachments')
		await claim(scanned, 'quarantined', 'org:o1')
		expect(fileRow(live)).toMatchObject({ status: 'live', scope: null })
		expect(fileRow(scanned)).toMatchObject({ status: 'quarantined', scope: 'org:o1' })
		expect(await stampStoredFile(session(), scanned, 'org:o1')).toBe(true)
		expect(await stampStoredFile(session(), scanned, 'org:o2')).toBe(false)
		const metadata = await storedFilesMetadata(session(), [live, scanned, live])
		expect([...metadata.keys()].sort()).toEqual([live, scanned].sort())
		expect(metadata.get(scanned)).toEqual({ id: scanned, kind: 'attachments', name: 'a.pdf', type: 'application/pdf', size: 3, status: 'quarantined' })
		expect(await files.find(Bun.randomUUIDv7())).toBeNull()
		expect(await files.find('not-a-uuid')).toBeNull()
	})

	test('a claim rolls back with the write that made it: the file stays pending', async () => {
		const id = await staged('catalog')
		await expect(claim(id, 'live', 'org:o1', true)).rejects.toThrow('the handler failed')
		expect(fileRow(id)).toEqual({ status: 'pending', scope: null, legacy: null, size: 3 })
	})

	test('a lock tells a file past its pending grace, and a claimed file is no longer pending', async () => {
		const id = await staged('catalog')
		backdate(id, 2)
		expect(await lockStoredFile(session(), id, GRACE)).toMatchObject({ status: 'pending', fresh: false })
		expect(await lockStoredFile(session(), Bun.randomUUIDv7(), GRACE)).toBeNull()
		db.exec(`update fabrika_files set status = 'live' where id = ?`, id)
		await expect(claimStoredFile(session(), id, 'live')).rejects.toThrow('a pending file changed under its lock')
		await expect(files.written(id, { size: 4, sha256: 'd'.repeat(64) })).rejects.toThrow('no longer pending')
	})

	test('only the request that staged a pending file abandons it, and its object is recorded for deletion', async () => {
		const id = await staged('catalog')
		expect(await files.abandon(id, 'request-2')).toBeNull()
		expect(await files.abandon(id, 'request-1')).toBe(`catalog/${id}`)
		expect(fileRow(id)).toBeUndefined()
		expect(await due(10, 0)).toEqual([`catalog/${id}`])
		const claimed = await staged('catalog')
		await claim(claimed, 'live', null)
		expect(await files.abandon(claimed, 'request-1')).toBeNull()
		expect(fileRow(claimed)).toMatchObject({ status: 'live' })
	})

	test("a scan's verdicts are written only under the scan job's lease", async () => {
		const id = await staged('attachments')
		await claim(id, 'quarantined', null)
		await expect(files.promote(id, 'c'.repeat(64), 'v1')).rejects.toThrow("only inside the scan job's lease")
		const before = new Date()
		const [due] = await files.quarantined(['attachments', 'other'], 10, new Date(Date.now() + 1000))
		expect(due).toEqual({
			id,
			objectKey: `attachments/${id}`,
			size: 3,
			sha256: 'c'.repeat(64),
			contentType: 'application/pdf',
			scanAttempts: 0,
			dueSince: expect.any(Date),
		})
		expect(due?.dueSince.getTime()).toBeLessThanOrEqual(before.getTime() + 5)
		expect(await files.quarantined(['catalog'], 10, new Date())).toEqual([])
		const jobs = jobLeases(() => ({ database: db.database, capabilities: authority }), async () => {})
		authority.lease = await jobs.acquire('scan', 'scan-1', HOUR, HOUR)
		const later = new Date(Date.now() + 60_000)
		expect(await files.deferScan(id, 1, later)).toBe(true)
		expect(await files.deferScan(id, 1, later)).toBe(false)
		expect(await files.quarantined(['attachments'], 10, new Date())).toEqual([])
		expect((await files.quarantined(['attachments'], 10, new Date(later.getTime() + 1)))[0]?.dueSince).toEqual(later)
		expect(await files.promote(id, 'd'.repeat(64), 'v1')).toBe(false)
		expect(await files.promote(id, 'c'.repeat(64), 'v1')).toBe(true)
		expect((await files.find(id))?.objectVersion).toBe('v1')
		await files.requarantine(id, 'v2')
		expect(fileRow(id)?.['status']).toBe('live')
		await files.requarantine(id, 'v1')
		expect(fileRow(id)?.['status']).toBe('quarantined')
		expect(await files.reject(id)).toBe(true)
		expect(fileRow(id)?.['status']).toBe('rejected')
	})

	test('a live file without a scanned version is quarantined again when its version is null', async () => {
		const id = await staged('catalog')
		await claim(id, 'live', null)
		await files.requarantine(id, null)
		expect(fileRow(id)?.['status']).toBe('quarantined')
	})

	test("the top-level scope of a stored row is read by its key, as its column's text", async () => {
		const tables = readTables(
			{
				deals: { columns: ['id', 'org_id', 'name'], foreignKeys: [] },
				deal_attachments: {
					columns: ['id', 'deal_id', 'org_id', 'file', 'name'],
					foreignKeys: [{ columns: ['deal_id', 'org_id'], table: 'deals', references: ['id', 'org_id'] }],
				},
			},
			{
				deals: { scope: { dimension: 'deal' }, actions: { read: 'crm.read', insert: 'deals.write' }, insert: ['name'] },
				deal_attachments: {
					scope: { child: 'deals' },
					actions: { read: 'crm.read', insert: 'deals.write' },
					insert: ['file', 'name'],
					files: { file: 'attachments' },
				},
			},
			{ dimensions: { org: {}, deal: { in: 'org' } }, actions: { 'crm.read': 'Read', 'deals.write': 'Write deals' } },
		)
		const model = modelOf(tableModels(tables), 'deals')
		if (model === undefined) throw new Error('no model')
		expect(await storedRowScope(model, session(), 'id', 'd1')).toBe('org:o1')
		await expect(storedRowScope(model, session(), 'id', 'missing')).rejects.toThrow('deals not found')
	})
})

describe('the sweep on SQLite', () => {
	test('deletes an unreferenced file past the grace in three steps, and keeps a referenced, a fresh and a legacy one', async () => {
		const kept = await staged('attachments')
		await claim(kept, 'quarantined', 'org:o1')
		db.exec(`insert into deal_attachments (id, deal_id, org_id, file, name) values ('a1', 'd1', 'o1', ?, 'a')`, kept)
		const orphan = await staged('attachments')
		const fresh = await staged('attachments')
		const legacy = await staged('attachments')
		db.exec(`update fabrika_files set legacy = 'attachments' where id = ?`, legacy)
		for (const id of [kept, orphan, legacy]) backdate(id, 2)
		const columns = [{ table: 'deal_attachments', column: 'file' }, { table: 'products', column: 'image' }]
		expect(await files.unreferenced(columns, 10, GRACE)).toEqual([orphan])
		// The foreign key keeps a referenced file even when the sweep reaches it.
		expect(await files.remove(kept, GRACE)).toBeNull()
		expect(fileRow(kept)).toMatchObject({ status: 'quarantined' })
		expect(await files.remove(fresh, GRACE)).toBeNull()
		expect(await files.remove(legacy, GRACE)).toBeNull()
		expect(await due(10, 0)).toEqual([])
		expect(await files.remove(orphan, GRACE)).toBe(`attachments/${orphan}`)
		expect(await due(10, 0)).toEqual([`attachments/${orphan}`])
		await files.forgetDeletion(`attachments/${orphan}`)
		expect(await due(10, 0)).toEqual([])
		expect(fileRow(orphan)).toBeUndefined()
	})

	test('adopts a legacy file a declared column references, and only that one', async () => {
		const referenced = await staged('catalog')
		const unreferenced = await staged('catalog')
		db.exec(`update fabrika_files set legacy = 'catalog', status = 'live'`)
		db.exec(`insert into products (id, name, image) values ('p1', 'P', ?)`, referenced)
		expect(await files.adoptReferenced([])).toBe(0)
		expect(await files.adoptReferenced([{ table: 'products', column: 'image' }])).toBe(1)
		expect(fileRow(referenced)?.['legacy']).toBeNull()
		expect(fileRow(unreferenced)?.['legacy']).toBe('catalog')
		await expect(files.adoptReferenced([{ table: 'products; drop', column: 'image' }])).rejects.toBeInstanceOf(QueryRefusedError)
	})

	test('a queued key inside the retention window survives; past it, it is due, oldest first', async () => {
		const inside = await removed()
		const past = await removed()
		const older = await removed()
		backdateDeletion(inside, 29)
		backdateDeletion(past, 31)
		backdateDeletion(older, 40)
		expect(await due(10, RETENTION)).toEqual([older, past])
		expect(await due(1, RETENTION)).toEqual([older])
		await expect(files.dueDeletions(10, new Date(Number.NaN))).rejects.toBeInstanceOf(QueryRefusedError)
	})

	test('a key is due from exactly the end of its window: not 1 ms before, at it and 1 ms after', async () => {
		const key = await removed()
		const recorded = new Date('2026-01-01T00:00:00.000Z')
		recordedAt(key, recorded)
		const cutoff = (now: number) => new Date(now - RETENTION)
		const end = recorded.getTime() + RETENTION
		expect(await files.dueDeletions(10, cutoff(end - 1))).toEqual([])
		expect(await files.dueDeletions(10, cutoff(end))).toEqual([key])
		expect(await files.dueDeletions(10, cutoff(end + 1))).toEqual([key])
		expect(await files.claimDeletion(key, cutoff(end - 1))).toBe(false)
		expect(await files.claimDeletion(key, cutoff(end))).toBe(true)
		expect(await due(10, 0)).toEqual([])
	})

	test('with a zero window, as on Bun, a key queued now is due at once', async () => {
		const key = await removed()
		expect(await due(10, RETENTION)).toEqual([])
		expect(await due(10, 0)).toEqual([key])
	})

	test('a cancelled tombstone is never due nor claimed, and the others stay queued', async () => {
		const cancelled = await removed()
		const other = await removed()
		backdateDeletion(cancelled, 31)
		backdateDeletion(other, 31)
		expect(await files.cancelDeletions([cancelled, `attachments/${Bun.randomUUIDv7()}`])).toBe(1)
		expect(await files.cancelDeletions([])).toBe(0)
		expect(await due(10, RETENTION)).toEqual([other])
		expect(await files.claimDeletion(cancelled, new Date())).toBe(false)
		expect(await due(10, 0)).toEqual([other])
	})

	test('a key queued again does not fail and restarts its window', async () => {
		const key = await removed()
		backdateDeletion(key, 31)
		expect(await removed(key)).toBe(key)
		expect(await due(10, RETENTION)).toEqual([])
		expect(await due(10, 0)).toEqual([key])
	})

	test('the due keys are read through the recorded_at index, in its order', () => {
		// The statement of `dueDeletions` on SQLite.
		const plan = db.exec(
			'explain query plan select object_key from fabrika_file_deletions where recorded_at <= ?2 order by recorded_at limit ?1',
			10,
			'',
		)
		const details = plan.map((row) => String(row['detail']))
		expect(details.some((detail) => detail.includes('INDEX fabrika_file_deletions_recorded_at'))).toBe(true)
		expect(details.some((detail) => detail.includes('TEMP B-TREE'))).toBe(false)
	})
})
