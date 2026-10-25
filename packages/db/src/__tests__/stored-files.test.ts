// Files as values on a REAL Postgres: `fabrika_files`, a file column's reads and writes through the mini-ORM, the
// sweep's deletion protocol and the migration of a collection's files. Skips cleanly when FABRIKA_TEST_POSTGRES_URL is
// unset (see postgres.test.ts). The handles are untyped here: the framework builds them, `orm-types.ts` types them.

import { openPostgres } from '@fabrika/db/postgres'
import { SQL } from 'bun'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Database, type Session } from '../database'
import { QueryRefusedError } from '../errors'
import type { FileBinding } from '../file-columns'
import { fileReference } from '../file-references'
import { bindScopedDatabase, type DataAccess, dataAccessOf, type DataSite, type StoredFiles } from '../framework'
import { FRAMEWORK_MIGRATIONS } from '../migrations'
import type { DataKind } from '../orm-types'
import { readTables } from '../policy'
import { frameworkSideOf } from '../registry'
import { scoped } from '../store'
import { TestAuthority } from './fixtures/authority'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR]
const hasPostgres = url !== undefined && url !== ''

if (!hasPostgres) {
	console.warn(`stored-files.test.ts skipped: set ${URL_VAR} to run the Postgres-backed tests`)
}

const schema = `files_${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
const GRACE = 3_600_000
const RETENTION = 30 * 24 * 3_600_000

/** A collection table as an earlier `fileTableSql` created it, with one live, one removed and one pending file. */
const legacyCollection = `
create table fabrika_files_attachments (
	id uuid primary key, owner_id text, org_id text, status text not null, object_key text not null unique, size bigint,
	content_type text not null, sha256 text, original_name text, created_by text not null, created_at timestamptz not null,
	deleted_at timestamptz
);
insert into fabrika_files_attachments values
	('01900000-0000-7000-8000-000000000001', 'd1', 'o1', 'live', 'attachments/01900000-0000-7000-8000-000000000001', 3, 'application/pdf', '${
	'a'.repeat(64)
}', 'old.pdf', 'u1', now() - interval '30 days', null),
	('01900000-0000-7000-8000-000000000002', 'd1', 'o1', 'live', 'attachments/01900000-0000-7000-8000-000000000002', 3, 'application/pdf', '${
	'b'.repeat(64)
}', 'gone.pdf', 'u1', now() - interval '30 days', now()),
	('01900000-0000-7000-8000-000000000003', 'd1', 'o1', 'pending', 'attachments/01900000-0000-7000-8000-000000000003', null, 'application/pdf', null, null, 'u1', now(), null),
	('01900000-0000-7000-8000-000000000006', null, 'o1', 'live', 'attachments/01900000-0000-7000-8000-000000000006', 3, 'application/pdf', '${
	'c'.repeat(64)
}', 'orphan.pdf', 'u1', now() - interval '30 days', null);
insert into fabrika_form_files (id, form, collection, status, object_key, size, sha256, content_type, original_name, created_at, held_until) values
	('01900000-0000-7000-8000-000000000004', 'join', 'photos', 'held', 'photos/01900000-0000-7000-8000-000000000004', 3, '${
	'd'.repeat(64)
}', 'image/png', 'me.png', now(), now() + interval '7 days'),
	('01900000-0000-7000-8000-000000000005', 'join', 'photos', 'pending', 'photos/01900000-0000-7000-8000-000000000005', null, null, 'image/png', null, now(), null);
`

const migration = `
create table deals (id text primary key, org_id text not null, name text not null, unique (id, org_id));
create table deal_attachments (
	id text primary key,
	deal_id text not null,
	org_id text not null,
	file uuid not null references fabrika_files (id),
	name text not null,
	foreign key (deal_id, org_id) references deals (id, org_id)
);
create index deal_attachments_file on deal_attachments (file);
create table products (id text primary key, name text not null, image uuid references fabrika_files (id), version integer not null);
create index products_image on products (image);
`

const vocabulary = {
	dimensions: { org: {}, deal: { in: 'org' } },
	actions: {
		'crm.read': 'Read',
		'deals.write': 'Write deals',
		'deals.edit': 'Edit attachments',
		'catalog.write': 'Write the catalog',
		'catalog.read': 'Read the catalog',
	},
}

const columns = {
	deals: { columns: ['id', 'org_id', 'name'], foreignKeys: [] },
	deal_attachments: {
		columns: ['id', 'deal_id', 'org_id', 'file', 'name'],
		foreignKeys: [{ columns: ['deal_id', 'org_id'], table: 'deals', references: ['id', 'org_id'] }],
	},
	products: { columns: ['id', 'name', 'image', 'version'], foreignKeys: [] },
}

const policies = {
	deals: { scope: { dimension: 'deal' }, actions: { read: 'crm.read', insert: 'deals.write' }, insert: ['name'] },
	deal_attachments: {
		scope: { child: 'deals' },
		actions: { read: 'crm.read', insert: 'deals.write', update: 'deals.edit' },
		insert: ['file', 'name'],
		update: ['name'],
		files: { file: 'attachments' },
	},
	products: {
		scope: { app: 'one catalog' },
		actions: { read: 'catalog.read', insert: 'catalog.write', update: 'catalog.write' },
		insert: ['name', 'image'],
		update: ['name', 'image'],
		files: { image: 'catalog' },
		version: 'version',
	},
}

const authority = new TestAuthority('u1')
let database: Database
let data: DataAccess
let files: StoredFiles

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
		// A collection's table exists before the framework migration that copies it, as in an installation.
		const before = FRAMEWORK_MIGRATIONS.filter((file) => file.name < '0008').map((file) => file.sql).join('\n')
		const after = FRAMEWORK_MIGRATIONS.filter((file) => file.name >= '0008').map((file) => file.sql).join('\n')
		await sql.unsafe(`set search_path to ${schema}; ${before} ${legacyCollection} ${after} ${migration}`)
		await sql.unsafe(`insert into ${schema}.deals (id, org_id, name) values ('d1', 'o1', 'One'), ('d2', 'o2', 'Two')`)
	})
	database = openPostgres({ url: url ?? '', schema, max: 6 })
	const layer = scoped(readTables(columns, policies, vocabulary))
	bindScopedDatabase(layer, { database, capabilities: authority })
	data = dataAccessOf(layer)
	const side = frameworkSideOf(layer)
	if (side === undefined) {
		throw new Error('no framework side')
	}
	files = side.framework.files
})

afterAll(async () => {
	if (!hasPostgres) {
		return
	}
	await database.close()
	await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
})

beforeEach(async () => {
	if (!hasPostgres) {
		return
	}
	await admin((sql) =>
		sql.unsafe(
			`delete from ${schema}.deal_attachments; delete from ${schema}.products; delete from ${schema}.fabrika_files where id::text not like '01900000-%';
			delete from ${schema}.fabrika_file_deletions`,
		)
	)
})

/** One request's work: its holder and the binding its handles carry. */
function request(id = Bun.randomUUIDv7()): { readonly holder: object; readonly binding: FileBinding } {
	const holder = {}
	return { holder, binding: { holder, request: id, graceMs: GRACE, scans: (kind) => kind === 'attachments' } }
}

function handlesIn(kind: DataKind, session: Session, binding: FileBinding) {
	const site: DataSite = { kind, unscoped: {}, principal: 'u1', files: binding, check: () => undefined, session: async () => session }
	return data.handles(site)
}

function inTransaction<T>(binding: FileBinding, work: (tx: ReturnType<typeof handlesIn>) => Promise<T>): Promise<T> {
	return data.transaction((session) => work(handlesIn('mutation', session, binding)))
}

async function call(handle: unknown, path: string, ...args: unknown[]): Promise<unknown> {
	const parts = path.split('.')
	const name = parts.pop() ?? ''
	const target = parts.reduce<unknown>((node, part) => (typeof node === 'object' && node !== null ? Reflect.get(node, part) : undefined), handle)
	const method: unknown = typeof target === 'object' && target !== null ? Reflect.get(target, name) : undefined
	if (typeof method !== 'function') {
		throw new TypeError(`${path} is not a method of the handle`)
	}
	return Reflect.apply(method, target, args)
}

/** Stages a file of `kind` for `work`, records it written, and answers the reference the request holds. */
async function staged(work: { readonly holder: object; readonly binding: FileBinding }, kind: string): Promise<object> {
	const id = Bun.randomUUIDv7()
	await files.stage({ id, kind, objectKey: `${kind}/${id}`, contentType: 'application/pdf', name: 'a.pdf', request: work.binding.request })
	await files.written(id, { size: 3, sha256: 'c'.repeat(64) })
	return fileReference({ id, kind, name: 'a.pdf', type: 'application/pdf', size: 3, status: 'pending' }, work.holder, true)
}

async function fileRow(id: string): Promise<{ status: string; scope: string | null; legacy: string | null } | undefined> {
	const rows: { status: string; scope: string | null; legacy: string | null }[] = await admin((sql) =>
		sql.unsafe(`select status, scope, legacy from ${schema}.fabrika_files where id = $1`, [id])
	)
	return rows[0]
}

function idOf(reference: unknown): string {
	const id: unknown = typeof reference === 'object' && reference !== null ? Reflect.get(reference, 'id') : undefined
	if (typeof id !== 'string') {
		throw new TypeError('no file reference')
	}
	return id
}

/** The keys due under a window of `windowMs` now, as the sweep asks for them. */
function due(limit: number, windowMs: number): Promise<readonly string[]> {
	return files.dueDeletions(limit, new Date(Date.now() - windowMs))
}

const describeDb = hasPostgres ? describe : describe.skip

describeDb('a file column', () => {
	test('an insert claims the pending file it references, stamps its scope, and a read answers its reference', async () => {
		const work = request()
		const file = await staged(work, 'attachments')
		await inTransaction(
			work.binding,
			(tx) => call(tx.target(authority.ref('deal', 'deals.write', 'd1', { org: 'o1' }), 'on'), 'deal_attachments.insert', { file, name: 'Offer' }),
		)
		expect(await fileRow(idOf(file))).toEqual({ status: 'quarantined', scope: 'org:o1', legacy: null })
		const reader = request()
		const page = await call(
			handlesIn('query', data.direct(), reader.binding).target(authority.ref('deal', 'crm.read', 'd1', { org: 'o1' }), 'on'),
			'deal_attachments.list',
		)
		const items = Reflect.get(Object(page), 'items')
		expect(items).toHaveLength(1)
		expect(items[0].file).toEqual({ id: idOf(file), name: 'a.pdf', type: 'application/pdf', size: 3, status: 'quarantined' })
	})

	test('refuses a string id, a reference of another request, of another kind, and a pending file another request staged', async () => {
		const work = request()
		const insert = (binding: FileBinding, file: unknown) =>
			inTransaction(
				binding,
				(tx) => call(tx.target(authority.ref('deal', 'deals.write', 'd1', { org: 'o1' }), 'on'), 'deal_attachments.insert', { file, name: 'x' }),
			)
		const file = await staged(work, 'attachments')
		await expect(insert(work.binding, idOf(file))).rejects.toThrow(QueryRefusedError)
		await expect(insert(request().binding, file)).rejects.toThrow(/holds no reference/)
		await expect(insert(work.binding, await staged(work, 'catalog'))).rejects.toThrow(/kind 'attachments'/)
		// The same file under another holder that also holds a reference, but did not stage it.
		const other = request()
		const copy = fileReference(
			{ id: idOf(file), kind: 'attachments', name: null, type: 'application/pdf', size: 3, status: 'pending' },
			other.holder,
			true,
		)
		await expect(insert(other.binding, copy)).rejects.toThrow(/claimed only by the request that wrote it/)
		expect((await fileRow(idOf(file)))?.status).toBe('pending')
	})

	test('a reference from another top-level scope is refused; an application table sets no scope', async () => {
		const work = request()
		const file = await staged(work, 'attachments')
		await inTransaction(
			work.binding,
			(tx) => call(tx.target(authority.ref('deal', 'deals.write', 'd1', { org: 'o1' }), 'on'), 'deal_attachments.insert', { file, name: 'a' }),
		)
		const reader = request()
		const [row] = Reflect.get(
			Object(
				await call(
					handlesIn('query', data.direct(), reader.binding).target(authority.ref('deal', 'crm.read', 'd1', { org: 'o1' }), 'on'),
					'deal_attachments.list',
				),
			),
			'items',
		)
		await expect(
			inTransaction(
				reader.binding,
				(tx) =>
					call(tx.target(authority.ref('deal', 'deals.write', 'd2', { org: 'o2' }), 'on'), 'deal_attachments.insert', { file: row.file, name: 'b' }),
			),
		).rejects.toThrow(/another top-level scope/)
		await inTransaction(
			reader.binding,
			(tx) => call(tx.target(authority.ref('deal', 'deals.write', 'd1', { org: 'o1' }), 'on'), 'deal_attachments.insert', { file: row.file, name: 'c' }),
		)
		const image = await staged(work, 'catalog')
		await inTransaction(work.binding, (tx) => call(tx.app(authority.app('catalog.write')), 'products.insert', { name: 'P', image }))
		expect(await fileRow(idOf(image))).toEqual({ status: 'live', scope: null, legacy: null })
	})

	test('a reference read under an action that does not read the file carries its metadata and is not written', async () => {
		const work = request()
		const image = await staged(work, 'catalog')
		const saved = await inTransaction(work.binding, (tx) => call(tx.app(authority.app('catalog.write')), 'products.insert', { name: 'P', image }))
		const editor = request()
		await expect(inTransaction(editor.binding, async (tx) => {
			const row = await call(tx.app(authority.app('catalog.write')), 'products.getForUpdate', idOf(saved))
			expect(Reflect.get(Object(row), 'image')).toEqual({ id: idOf(image), name: 'a.pdf', type: 'application/pdf', size: 3, status: 'live' })
			return call(tx.app(authority.app('catalog.write')), 'products.update', idOf(saved), { image: Reflect.get(Object(row), 'image') }, {
				expectVersion: 1,
			})
		})).rejects.toThrow(/holds no reference/)
	})
})

describeDb('the sweep', () => {
	test('deletes an unreferenced file past the grace in three steps, and keeps a referenced, a fresh and a legacy one', async () => {
		const work = request()
		const kept = await staged(work, 'attachments')
		await inTransaction(
			work.binding,
			(tx) => call(tx.target(authority.ref('deal', 'deals.write', 'd1', { org: 'o1' }), 'on'), 'deal_attachments.insert', { file: kept, name: 'a' }),
		)
		const orphan = await staged(work, 'attachments')
		const fresh = await staged(work, 'attachments')
		await admin((sql) =>
			sql.unsafe(`update ${schema}.fabrika_files set created_at = now() - interval '2 hours' where id <> $1 and id::text not like '01900000-%'`, [
				idOf(fresh),
			])
		)
		const columns = [{ table: 'deal_attachments', column: 'file' }, { table: 'products', column: 'image' }]
		expect(await files.unreferenced(columns, 10, GRACE)).toEqual([idOf(orphan)])
		// The foreign key keeps a referenced file even when the sweep reaches it.
		expect(await files.remove(idOf(kept), GRACE)).toBeNull()
		expect(await files.remove(idOf(fresh), GRACE)).toBeNull()
		expect(await files.remove('01900000-0000-7000-8000-000000000001', GRACE)).toBeNull()
		expect(await files.remove(idOf(orphan), GRACE)).toBe(`attachments/${idOf(orphan)}`)
		expect(await due(10, 0)).toEqual([`attachments/${idOf(orphan)}`])
		await files.forgetDeletion(`attachments/${idOf(orphan)}`)
		expect(await due(10, 0)).toEqual([])
		expect(await fileRow(idOf(orphan))).toBeUndefined()
	})

	/** An unreferenced file past the grace whose row the sweep removed: its key is queued, its object kept. */
	async function removed(objectKey?: string): Promise<string> {
		const id = Bun.randomUUIDv7()
		await files.stage({
			id,
			kind: 'attachments',
			objectKey: objectKey ?? `attachments/${id}`,
			contentType: 'application/pdf',
			name: null,
			request: 'r',
		})
		await admin((sql) => sql.unsafe(`update ${schema}.fabrika_files set created_at = now() - interval '2 hours' where id = $1`, [id]))
		const key = await files.remove(id, GRACE)
		if (key === null) {
			throw new Error('the sweep kept an unreferenced file')
		}
		return key
	}

	async function recordedAt(key: string, at: Date): Promise<void> {
		await admin((sql) =>
			sql.unsafe(`update ${schema}.fabrika_file_deletions set recorded_at = $2::timestamptz where object_key = $1`, [key, at.toISOString()])
		)
	}

	async function backdateDeletion(key: string, days: number): Promise<void> {
		await admin((sql) =>
			sql.unsafe(`update ${schema}.fabrika_file_deletions set recorded_at = now() - $2::int * interval '1 day' where object_key = $1`, [key, days])
		)
	}

	test('a queued key inside the retention window survives; past it, it is due, oldest first', async () => {
		const inside = await removed()
		const past = await removed()
		const older = await removed()
		await backdateDeletion(inside, 29)
		await backdateDeletion(past, 31)
		await backdateDeletion(older, 40)
		expect(await due(10, RETENTION)).toEqual([older, past])
		expect(await due(1, RETENTION)).toEqual([older])
		await expect(files.dueDeletions(10, new Date(Number.NaN))).rejects.toBeInstanceOf(QueryRefusedError)
	})

	test('a key is due from exactly the end of its window: not 1 ms before, at it and 1 ms after', async () => {
		const key = await removed()
		const recorded = new Date('2026-01-01T00:00:00.000Z')
		await recordedAt(key, recorded)
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
		await backdateDeletion(cancelled, 31)
		await backdateDeletion(other, 31)
		expect(await files.cancelDeletions([cancelled, `attachments/${Bun.randomUUIDv7()}`])).toBe(1)
		expect(await files.cancelDeletions([])).toBe(0)
		expect(await due(10, RETENTION)).toEqual([other])
		expect(await files.claimDeletion(cancelled, new Date())).toBe(false)
		expect(await due(10, 0)).toEqual([other])
	})

	test('a key queued again does not fail and restarts its window', async () => {
		const key = await removed()
		await backdateDeletion(key, 31)
		expect(await removed(key)).toBe(key)
		expect(await due(10, RETENTION)).toEqual([])
		expect(await due(10, 0)).toEqual([key])
	})
})

describeDb('the migration of a collection', () => {
	test("moves a form's held file into fabrika_files, quarantined, whose grace counts from the end of its hold", async () => {
		expect(await fileRow('01900000-0000-7000-8000-000000000004')).toEqual({ status: 'quarantined', scope: null, legacy: null })
		const left: { id: string; status: string }[] = await admin((sql) => sql.unsafe(`select id::text as id, status from ${schema}.fabrika_form_files`))
		expect(left).toEqual([{ id: '01900000-0000-7000-8000-000000000005', status: 'pending' }])
		expect(await files.unreferenced([{ table: 'deal_attachments', column: 'file' }], 10, GRACE)).not.toContain('01900000-0000-7000-8000-000000000004')
	})

	test("copies a collection's held files as legacy, and the release adopts them, records the rest and drops the table", async () => {
		expect(await fileRow('01900000-0000-7000-8000-000000000001')).toEqual({ status: 'live', scope: null, legacy: 'attachments' })
		expect(await fileRow('01900000-0000-7000-8000-000000000002')).toBeUndefined()
		expect(await fileRow('01900000-0000-7000-8000-000000000003')).toBeUndefined()
		// An orphan, whose owner was deleted, is not copied: no application could adopt it.
		expect(await fileRow('01900000-0000-7000-8000-000000000006')).toBeUndefined()
		const run = (statements: string) => admin((sql) => sql.unsafe(`set search_path to ${schema}; ${statements}`))
		const release = () => run(`select fabrika_files_release('attachments')`)
		const lateRow = (id: string) =>
			run(
				`insert into fabrika_files_attachments values ('${id}', 'd1', 'o1', 'live', 'attachments/${id}', 3, 'application/pdf', '${
					'd'.repeat(64)
				}', 'late.pdf', 'u1', now(), null)`,
			)
		// What an adoption migration runs: the copy of what an older instance wrote since 0008, then the insert.
		const adoption = `select fabrika_files_copy_legacy('attachments');
			insert into deal_attachments (id, deal_id, org_id, file, name)
			select gen_random_uuid()::text, owner_id, org_id, id, coalesce(original_name, '') from fabrika_files_attachments
			where deleted_at is null and status <> 'pending' and owner_id is not null and id not in (select file from deal_attachments)`
		await expect(release()).rejects.toThrow(/referenced by no file column/)
		// An older instance, still serving during the rollout, uploads after 0008 copied the collection.
		await lateRow('01900000-0000-7000-8000-000000000007')
		expect(await fileRow('01900000-0000-7000-8000-000000000007')).toBeUndefined()
		// Without the copy, the adoption's insert names a file fabrika_files does not hold.
		await expect(run(adoption.slice(adoption.indexOf('insert')))).rejects.toThrow(/foreign key/)
		await run(adoption)
		expect(await fileRow('01900000-0000-7000-8000-000000000007')).toEqual({ status: 'live', scope: null, legacy: 'attachments' })
		// A row written after the adoption: the release copies it, refuses while it is unreferenced, and one more
		// adoption takes it.
		await lateRow('01900000-0000-7000-8000-000000000008')
		await expect(release()).rejects.toThrow(/1 files of the collection are referenced by no file column/)
		await run(adoption)
		// The sweep adopts a migrated file a declared column references: it is an ordinary file from then on.
		expect(await files.adoptReferenced([{ table: 'deal_attachments', column: 'file' }])).toBe(3)
		expect(await fileRow('01900000-0000-7000-8000-000000000001')).toEqual({ status: 'live', scope: null, legacy: null })
		await release()
		const deletions: { object_key: string }[] = await admin((sql) =>
			sql.unsafe(`select object_key from ${schema}.fabrika_file_deletions order by object_key`)
		)
		expect(deletions.map((row) => row.object_key)).toEqual([
			'attachments/01900000-0000-7000-8000-000000000002',
			'attachments/01900000-0000-7000-8000-000000000003',
			'attachments/01900000-0000-7000-8000-000000000006',
		])
		const tables: { name: string | null }[] = await admin((sql) =>
			sql.unsafe(`select to_regclass('${schema}.fabrika_files_attachments')::text as name`)
		)
		expect(tables[0]?.name).toBeNull()
	})
})
