// The migrating boot's steps over bun:sqlite and a record store in memory (ADR-0069 §3): the record before the one
// transaction, its outcome after it, the reconciliation of a record a reset left without one, and the faults of each
// put. The object's own answers (`migrate`, ordinary traffic) are in `cloudflare-maintenance.test.ts`.

import type { OpsMigrationRecord } from '@fabrika/auth-core'
import { SQLITE_FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations-sqlite'
import { readSqliteLedger, type SqliteMigrationBundle, type SqliteMigrationTarget } from '@fabrika/db/sqlite-migrate'
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { execStatements } from '../../../db/src/sqlite-bun'
import { markBooted, migratingBoot, type MigratingBootInput, MigrationFailed, reconciledOutcome, RecordPending } from '../cloudflare/migration-record'
import { memoryRecords } from './fixtures/migration-records'

const NOTES = { name: '20260101000000_notes.sql', sql: 'CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL);' }
const TAGS = { name: '20260102000000_tags.sql', sql: 'CREATE TABLE tags (id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES notes (id));' }
const BROKEN = { name: '20260103000000_broken.sql', sql: 'CREATE TABLE broken (id TEXT PRIMARY KEY);\nSELECT * FROM no_such_table;' }
const VERSION = '5a1c3f0e-1111-4c2d-9e3a-0123456789ab'
const NOW = new Date('2026-11-26T20:00:00.000Z')

function target(db: Database): SqliteMigrationTarget {
	return {
		exec(query, ...bindings) {
			const rows = execStatements(db, query, bindings)
			return { toArray: () => rows }
		},
		transactionSync: (fn) => db.transaction(fn)(),
	}
}

function open(): Database {
	const db = new Database(':memory:')
	db.run('PRAGMA foreign_keys = ON')
	return db
}

const bundles = (...app: SqliteMigrationBundle['migrations']): readonly SqliteMigrationBundle[] => [
	{ bundle: 'fabrika', migrations: SQLITE_FRAMEWORK_MIGRATIONS },
	{ bundle: 'app', migrations: app },
]

/** Bookmarks that move with every call, in lexical order, as Cloudflare's do. */
function bookmarks(): () => Promise<string | null> {
	let position = 0
	return () => Promise.resolve(`bm-${String(++position).padStart(4, '0')}`)
}

function input(db: Database, store: MigratingBootInput['store'], overrides: Partial<MigratingBootInput> = {}): MigratingBootInput {
	return { target: target(db), store, bundles: bundles(NOTES), version: VERSION, bookmark: bookmarks(), apply: true, now: () => NOW, ...overrides }
}

function tables(db: Database): string[] {
	return db.query<{ name: string }, []>(`SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name`).all().map((row) => row.name)
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise
	} catch (error) {
		return error
	}
	throw new Error('expected a rejection')
}

describe('the migrating boot', () => {
	test('writes the record before the transaction, then the outcome with the bookmark after the commit', async () => {
		const db = open()
		const store = memoryRecords()
		const result = await migratingBoot(input(db, store))
		expect(result.kind).toBe('ready')
		const [before, after] = store.written
		expect(before).toMatchObject({ version: VERSION, bookmark: 'bm-0001', at: NOW.toISOString(), outcome: null, committedBookmark: null, booted: null })
		expect(before?.files.map((file) => `${file.bundle}/${file.name}`)).toEqual([
			...SQLITE_FRAMEWORK_MIGRATIONS.map((migration) => `fabrika/${migration.name}`),
			`app/${NOTES.name}`,
		])
		expect(before?.startDigest).toBe((await readSqliteLedger(target(open()))).digest)
		if (before === undefined) throw new Error('expected the record')
		expect(after).toEqual({ ...before, outcome: 'committed', committedBookmark: 'bm-0002' })
		expect(tables(db)).toContain('notes')
	})

	test('step 5 marks the record booted once, and a later boot with nothing pending writes nothing', async () => {
		const db = open()
		const store = memoryRecords()
		const result = await migratingBoot(input(db, store))
		if (result.kind !== 'ready') throw new Error('expected ready')
		const booted = await markBooted(store, result.held, () => NOW)
		expect(booted?.booted).toBe(NOW.toISOString())
		const again = await migratingBoot(input(db, store))
		if (again.kind !== 'ready') throw new Error('expected ready')
		expect(await markBooted(store, again.held)).toEqual(booted)
		expect(store.written).toHaveLength(3)
	})

	test('a boot that migrates nothing marks a record a reset left without booted', async () => {
		const db = open()
		const store = memoryRecords()
		await migratingBoot(input(db, store))
		const next = await migratingBoot(input(db, store))
		if (next.kind !== 'ready') throw new Error('expected ready')
		expect(next.held?.record.booted).toBeNull()
		expect((await markBooted(store, next.held, () => NOW))?.booted).toBe(NOW.toISOString())
	})

	test('a failed put of the record migrates nothing and is record_unwritable, with the record it tried to write', async () => {
		const db = open()
		const store = memoryRecords()
		store.failPuts(1)
		const error = await rejection(migratingBoot(input(db, store)))
		expect(error).toBeInstanceOf(MigrationFailed)
		if (!(error instanceof MigrationFailed)) throw error
		expect(error.reason).toBe('record_unwritable')
		expect(error.record.outcome).toBeNull()
		expect(tables(db)).not.toContain('notes')
		expect(store.current).toBeNull()
		// The next event tries again.
		expect((await migratingBoot(input(db, store))).kind).toBe('ready')
		expect(tables(db)).toContain('notes')
	})

	test('a failing file rolls the whole set back and records rolled_back', async () => {
		const db = open()
		const store = memoryRecords()
		const error = await rejection(migratingBoot(input(db, store, { bundles: bundles(NOTES, TAGS, BROKEN) })))
		expect(error).toBeInstanceOf(MigrationFailed)
		if (!(error instanceof MigrationFailed)) throw error
		expect(error.reason).toBe('rolled_back')
		expect(store.current?.record.outcome).toBe('rolled_back')
		expect(tables(db)).toEqual([])
	})

	test('a row the foreign key check returns rolls back and records rolled_back', async () => {
		const db = open()
		const store = memoryRecords()
		const orphan = {
			name: '20260103000000_orphan.sql',
			sql: "PRAGMA defer_foreign_keys = ON;\nINSERT INTO tags (id, note_id) VALUES ('t', 'no-such-note');",
		}
		const error = await rejection(migratingBoot(input(db, store, { bundles: bundles(NOTES, TAGS, orphan) })))
		expect(error).toBeInstanceOf(MigrationFailed)
		expect(store.current?.record.outcome).toBe('rolled_back')
		expect(tables(db)).not.toContain('tags')
	})

	test('a rolled_back record is replaced by the next attempt under a new id', async () => {
		const db = open()
		const store = memoryRecords()
		await rejection(migratingBoot(input(db, store, { bundles: bundles(NOTES, BROKEN) })))
		const failed = store.current?.record
		expect((await migratingBoot(input(db, store))).kind).toBe('ready')
		expect(store.current?.record.id).not.toBe(failed?.id)
		expect(store.current?.record.outcome).toBe('committed')
	})

	test('a commit whose outcome put fails holds the boot back; the next boot reconciles committed and migrates nothing again', async () => {
		const db = open()
		const store = memoryRecords()
		// The put of the record lands; the outcome's fails, as a reset after the commit leaves it.
		let puts = 0
		const flaky: MigratingBootInput['store'] = {
			read: () => store.read(),
			put: (record, version) => (++puts === 2 ? Promise.reject(new Error('reset')) : store.put(record, version)),
		}
		expect(await rejection(migratingBoot(input(db, flaky)))).toBeInstanceOf(RecordPending)
		expect(store.current?.record.outcome).toBeNull()
		const ledger = await readSqliteLedger(target(db))
		const next = await migratingBoot(input(db, store, { bookmark: () => Promise.resolve('bm-0042') }))
		if (next.kind !== 'ready') throw new Error('expected ready')
		expect(next.held?.record).toMatchObject({ outcome: 'committed', committedBookmark: 'bm-0042', booted: null })
		expect(await readSqliteLedger(target(db))).toEqual(ledger)
	})

	test('a record without an outcome whose rows the ledger lacks is reconciled rolled_back, then replaced', async () => {
		const db = open()
		const store = memoryRecords()
		// The put of the outcome after a rolled-back transaction failed.
		let puts = 0
		const flaky: MigratingBootInput['store'] = {
			read: () => store.read(),
			put: (record, version) => (++puts === 2 ? Promise.reject(new Error('reset')) : store.put(record, version)),
		}
		expect(await rejection(migratingBoot(input(db, flaky, { bundles: bundles(NOTES, BROKEN) })))).toBeInstanceOf(RecordPending)
		const left = store.current?.record
		expect(left?.outcome).toBeNull()
		expect((await migratingBoot(input(db, store))).kind).toBe('ready')
		expect(store.written.find((record) => record.id === left?.id && record.outcome !== null)?.outcome).toBe('rolled_back')
		expect(store.current?.record).toMatchObject({ outcome: 'committed' })
		expect(store.current?.record.id).not.toBe(left?.id)
	})

	test('a failed put of booted is held back, and the next boot writes it without migrating', async () => {
		const db = open()
		const store = memoryRecords()
		const result = await migratingBoot(input(db, store))
		if (result.kind !== 'ready') throw new Error('expected ready')
		store.failPuts(1)
		expect(await rejection(markBooted(store, result.held))).toBeInstanceOf(RecordPending)
		const next = await migratingBoot(input(db, store))
		if (next.kind !== 'ready') throw new Error('expected ready')
		expect((await markBooted(store, next.held, () => NOW))?.booted).toBe(NOW.toISOString())
		expect(store.written.filter((record) => record.outcome === null)).toHaveLength(1)
	})

	test('a put that conflicts with a record of another id drops its update and holds the boot back', async () => {
		const db = open()
		const store = memoryRecords()
		const result = await migratingBoot(input(db, store))
		if (result.kind !== 'ready' || result.held === null) throw new Error('expected a record')
		const other: OpsMigrationRecord = { ...result.held.record, id: '0192f0c4-7a1e-7c3b-9d2a-5e6f7a8b9c0d' }
		store.replace(other)
		expect(await rejection(markBooted(store, result.held))).toBeInstanceOf(RecordPending)
		expect(store.current?.record).toEqual(other)
	})

	test('an unreadable record holds the boot back before anything runs', async () => {
		const db = open()
		const store = memoryRecords()
		store.failRead()
		expect(await rejection(migratingBoot(input(db, store)))).toBeInstanceOf(RecordPending)
		expect(tables(db)).toEqual([])
	})

	test('a restricted cold start finds the migration pending and writes nothing', async () => {
		const db = open()
		const store = memoryRecords()
		expect(await migratingBoot(input(db, store, { apply: false }))).toEqual({ kind: 'pending' })
		expect(store.written).toEqual([])
		expect(tables(db)).toEqual([])
	})

	test('without version metadata the record names no version', async () => {
		const db = open()
		const store = memoryRecords()
		await migratingBoot(input(db, store, { version: null, bookmark: () => Promise.resolve(null) }))
		expect(store.current?.record).toMatchObject({ version: null, bookmark: null, outcome: 'committed', committedBookmark: null })
	})

	test('a rewound record is never marked booted', async () => {
		const db = open()
		const store = memoryRecords()
		const result = await migratingBoot(input(db, store))
		if (result.kind !== 'ready' || result.held === null) throw new Error('expected a record')
		const rewound: OpsMigrationRecord = { ...result.held.record, outcome: 'rewound' }
		const version = await store.put(rewound, result.held.version)
		if (version === null) throw new Error('expected the put to land')
		expect(await markBooted(store, { record: rewound, version })).toEqual(rewound)
		expect(store.current?.record.booted).toBeNull()
	})
})

describe('the reconciliation of a record without an outcome', () => {
	const record = (files: OpsMigrationRecord['files']): OpsMigrationRecord => ({
		id: '0192f0c4-7a1e-7c3b-9d2a-5e6f7a8b9c0d',
		version: VERSION,
		bookmark: 'bm-0001',
		startDigest: '0'.repeat(64),
		files,
		at: NOW.toISOString(),
		outcome: null,
		committedBookmark: null,
		booted: null,
	})
	const a = { bundle: 'app', name: NOTES.name, checksum: 'a'.repeat(64) }
	const b = { bundle: 'app', name: TAGS.name, checksum: 'b'.repeat(64) }
	const other = { bundle: 'app', name: '20250101000000_older.sql', checksum: 'c'.repeat(64) }
	const ledger = (...entries: OpsMigrationRecord['files']) => ({ entries, digest: 'd'.repeat(64) })

	test("none of the record's rows is rolled_back, whatever else the ledger holds", () => {
		expect(reconciledOutcome(record([a, b]), ledger(other))).toBe('rolled_back')
	})

	test('every row with its checksum is committed, and rows the record does not name are ignored', () => {
		expect(reconciledOutcome(record([a, b]), ledger(other, a, b))).toBe('committed')
	})

	test('some of the rows, or one with another checksum, is diverged', () => {
		expect(reconciledOutcome(record([a, b]), ledger(a))).toBe('diverged')
		expect(reconciledOutcome(record([a, b]), ledger(a, { ...b, checksum: 'e'.repeat(64) }))).toBe('diverged')
	})

	test('a diverged record is never rewound, and the boot goes on by the ledger rules', async () => {
		const db = open()
		const store = memoryRecords()
		await migratingBoot(input(db, store))
		const migrated = store.current?.record
		if (migrated === undefined) throw new Error('expected a record')
		// A record the ledger holds only part of, without an outcome, as a release before the gate leaves it.
		const [applied] = (await readSqliteLedger(target(db))).entries
		if (applied === undefined) throw new Error('expected a ledger row')
		const half: OpsMigrationRecord = {
			...migrated,
			id: '0192f0c4-0000-7c3b-9d2a-5e6f7a8b9c0d',
			outcome: null,
			committedBookmark: null,
			files: [applied, b],
		}
		store.replace(half)
		const result = await migratingBoot(input(db, store, { bundles: bundles(NOTES, TAGS) }))
		expect(result.kind).toBe('ready')
		expect(store.written.find((record) => record.id === half.id)?.outcome).toBe('diverged')
		expect(store.current?.record).toMatchObject({ outcome: 'committed', files: [{ bundle: 'app', name: TAGS.name }] })
		expect(tables(db)).toContain('tags')
	})
})
