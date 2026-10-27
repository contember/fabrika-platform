// The importer (ADR-0070 §6): a consistent backup, written here with the wire's own encoders, loaded into a fresh object
// step by step as Control drives it. The object is bun:sqlite with workerd's synchronous KV kept in its `_cf_KV` table,
// so a step's marker commits or rolls back with its rows; the bucket is an in-memory R2 double that honours ranges.

import {
	encodeOpsDumpLine,
	encodeOpsDumpRow,
	ENDPOINT_HEADER,
	FABRIKA_APPLICATION_OBJECT,
	FABRIKA_APPLICATION_OBJECTS,
	FABRIKA_OPS_KEY_DIGESTS,
	foldOpsTableHash,
	formatOpsKeyDigests,
	OPS_DATA_REFUSED_STATUS,
	OPS_DUMP_KEY,
	OPS_DUMP_PART_MAX_RAW_BYTES,
	OPS_DUMP_PART_SIZE,
	OPS_EMPTY_TABLE_HASH,
	OPS_STALE_STATUS,
	opsDumpColumnProjection,
	type OpsDumpCursor,
	type OpsDumpLine,
	type OpsDumpManifest,
	type OpsDumpPart,
	type OpsDumpSchemaEntry,
	type OpsDumpSource,
	type OpsDumpTable,
	type OpsDumpTablePlan,
	type OpsDumpValue,
	type OpsExportPartAck,
	type OpsExportScope,
	type OpsImportRequest,
	opsKeyDigest,
	type OpsPublishedState,
	parseOpsDataRefusal,
	parseOpsDumpManifest,
	parseOpsExportBeginAck,
	parseOpsExportCompleteAck,
	parseOpsExportPartAck,
	parseOpsImportBeginAck,
	parseOpsImportCompleteAck,
	parseOpsImportDiscardAck,
	parseOpsImportLinkAck,
	parseOpsImportPartAck,
	parseOpsImportVerifyAck,
	parseOpsStaleRefusal,
	planOpsDump,
	PROXY_SECRET_HEADER,
	readOpsDumpValue,
} from '@fabrika/auth-core'
import { SQLITE_FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations-sqlite'
import type { SqliteStorage } from '@fabrika/db/sqlite'
import { migrateSqlite, type SqliteMigrationBundle } from '@fabrika/db/sqlite-migrate'
import { Database as BunDatabase } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { createTestEnv, type TestEnv } from 'lopata/testing'
import { join } from 'node:path'
import { bunSqliteStorage } from '../../../db/src/sqlite-bun'
import { applicationMigrations } from '../build'
import { type ApplicationState, createContractWorker, FabrikaApplication } from '../cloudflare'
import { TICK_HEADER } from '../cloudflare/application'
import { exportStep } from '../cloudflare/export'
import { describeDumpSchema, IMPORT_MARKER_KEY, importStep, type ImportStorage, type ImportTarget, serveImport } from '../cloudflare/import'
import { MaintenanceBarrier } from '../cloudflare/maintenance'
import { CLOUDFLARE_FILES_BINDING } from '../cloudflare/names'
import { OPS_ENDPOINT, type OpsTarget } from '../cloudflare/ops'
import { notesApp as fixtureApp } from './cloudflare-fixture/src/app'
import type { NotesWorld } from './cloudflare-fixture/src/world'
import { frameworkEnvFor, keepingProcessEnvironment, keySource, ORIGIN, PROXY_SECRET, workloadTokensFor } from './fixtures/implement/harness'

const FIXTURE_ROOT = join(import.meta.dir, 'cloudflare-fixture')

const SOURCE: OpsDumpSource = { object: 'application', dump: '0193f1c2-7a4b-7c3d-8e9f-0123456789ab' }
const TARGET = 'clone'
const GENERATION = 3
const INSPECT: OpsPublishedState = { generation: GENERATION, mode: 'inspect' }
const INT64_MAX = '9223372036854775807'
/** 2^53 + 1, the first integer a double cannot hold. */
const BEYOND_DOUBLE = '9007199254740993'

/** A self-referencing table, a cycle of two, a trigger, an index and an AUTOINCREMENT counter that sorts after its table. */
const APP_MIGRATIONS = [
	{
		name: '0001_people.sql',
		sql: `CREATE TABLE employees (id INTEGER PRIMARY KEY, name TEXT NOT NULL, manager_id INTEGER REFERENCES employees (id));
CREATE TABLE teams (id INTEGER PRIMARY KEY, lead_id INTEGER REFERENCES members (id));
CREATE TABLE members (id INTEGER PRIMARY KEY, team_id INTEGER REFERENCES teams (id));`,
	},
	{
		name: '0002_notes.sql',
		sql: `CREATE TABLE notes (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	employee_id INTEGER NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
	body TEXT,
	big INTEGER,
	ratio REAL,
	payload BLOB
);
CREATE INDEX notes_employee ON notes (employee_id);
CREATE TABLE audit (at TEXT NOT NULL, what TEXT NOT NULL);`,
	},
	{ name: '0003_audit.sql', sql: `CREATE TRIGGER notes_audit AFTER INSERT ON notes BEGIN INSERT INTO audit (at, what) VALUES ('now', 'note'); END;` },
]

function release(app: readonly { readonly name: string; readonly sql: string }[] = APP_MIGRATIONS): readonly SqliteMigrationBundle[] {
	return [
		{ bundle: 'fabrika', migrations: SQLITE_FRAMEWORK_MIGRATIONS },
		{ bundle: 'app', migrations: app },
	]
}

/** The source object: migrated by the runner the object boots with, then filled with rows the load order cannot satisfy. */
async function sourceDatabase(): Promise<{ readonly storage: SqliteStorage; readonly database: BunDatabase }> {
	const object = objectStorage()
	const { storage } = object
	await migrateSqlite(
		{ exec: (query, ...bindings) => storage.sql.exec(query, ...bindings), transactionSync: (fn) => storage.transactionSync(fn) },
		release(),
	)
	const database = object.database()
	database.run(`INSERT INTO employees (id, name, manager_id) VALUES (3, 'c', NULL)`)
	database.run(`INSERT INTO employees (id, name, manager_id) VALUES (1, 'a', 3)`)
	database.run(`INSERT INTO employees (id, name, manager_id) VALUES (2, 'b', 1)`)
	database.run(`UPDATE employees SET manager_id = 2 WHERE id = 3`)
	database.run(`INSERT INTO teams (id, lead_id) VALUES (1, NULL), (2, NULL)`)
	database.run(`INSERT INTO members (id, team_id) VALUES (1, 2), (2, 1)`)
	database.run(`UPDATE teams SET lead_id = 2 WHERE id = 1`)
	database.run(`INSERT INTO notes (id, employee_id, body, big, ratio, payload) VALUES (1, 1, 'hello', ${INT64_MAX}, 0.1, x'00FF10')`)
	database.run(`INSERT INTO notes (id, employee_id, body, big, ratio, payload) VALUES (4, 3, CAST(x'80' AS TEXT), ${BEYOND_DOUBLE}, -2.5e300, x'')`)
	database.run(`INSERT INTO notes (id, employee_id, body, big, ratio, payload) VALUES (12, 2, NULL, -${INT64_MAX}, 1, NULL)`)
	database.run(`DELETE FROM notes WHERE id = 12`)
	return { storage, database }
}

/** Every `sqlite_schema` entry a dump's DDL lists: those with SQL, but SQLite's internal ones (`sqlite_sequence` kept) and `_cf_`'s. */
function ddlOf(storage: SqliteStorage): OpsDumpSchemaEntry[] {
	const dumped = (name: string) => !name.startsWith('_cf_') && (!name.startsWith('sqlite_') || name === 'sqlite_sequence')
	return storage.sql.exec('SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type, name').toArray().flatMap((row) => {
		const { type, name, tbl_name: table, sql } = row
		if (typeof name !== 'string' || typeof table !== 'string' || typeof sql !== 'string' || !dumped(name) || !dumped(table)) return []
		if (type !== 'table' && type !== 'index' && type !== 'trigger' && type !== 'view') return []
		return [{ type, name, table, sql }]
	})
}

/**
 * A table's rows in keyset order, each its rowid then its columns, read with the producer's projection one column at a
 * time, so a table at workerd's column limit reads too, independently of how the producer splits its statements.
 */
function tableRows(storage: SqliteStorage, table: OpsDumpTablePlan): (readonly OpsDumpValue[])[] {
	const keyset = `"${table.keyset}"`
	// Qualified, so a table named `page` is not the CTE itself.
	const source = `main."${table.name}"`
	const read = (projection: string, names: string) =>
		storage.sql.exec(`WITH page(${names}) AS (SELECT ${projection} FROM ${source} ORDER BY ${keyset}) SELECT * FROM page`).toArray()
	const columns = table.columns.map((column) => read(opsDumpColumnProjection(column), 't, v'))
	return read(`CAST(${keyset} AS TEXT)`, 'k').map((row, index) => [
		readOpsDumpValue('integer', row['k']),
		...columns.map((rows) => readOpsDumpValue(rows[index]?.['t'], rows[index]?.['v'])),
	])
}

function planOf(storage: SqliteStorage): readonly OpsDumpTablePlan[] {
	const plan = planOpsDump(describeDumpSchema(storage))
	if ('refused' in plan) throw new Error(`the test schema is refused: ${plan.table}`)
	return plan.tables
}

/** Each table's exact row count and hash, in load order. */
function tablesOf(storage: SqliteStorage): OpsDumpTable[] {
	return planOf(storage).map((table) => {
		const rows = tableRows(storage, table).map((row) => encodeOpsDumpRow(row))
		return { name: table.name, rows: rows.length, hash: foldOpsTableHash(OPS_EMPTY_TABLE_HASH, rows) }
	})
}

function linesOf(storage: SqliteStorage): OpsDumpLine[] {
	return planOf(storage).flatMap((table) => tableRows(storage, table).map((row) => ({ table: table.name, row })))
}

/** One gzip member of `lines`, each with its newline; `size` pads it to that many bytes in the header's comment field. */
function member(lines: readonly string[], size: number | null = null): Uint8Array {
	const raw = new TextEncoder().encode(lines.map((line) => `${line}\n`).join(''))
	return pad(Bun.gzipSync(raw), size)
}

function pad(gzip: Uint8Array, size: number | null): Uint8Array {
	if (size === null) return gzip
	// Bun writes a ten-byte header with no flag; FCOMMENT (0x10) puts a NUL-terminated comment right after it.
	const out = new Uint8Array(size)
	out.set(gzip.subarray(0, 10))
	out[3] = 0x10
	const comment = size - gzip.length - 1
	out.fill(0x20, 10, 10 + comment)
	out[10 + comment] = 0
	out.set(gzip.subarray(10), 11 + comment)
	return out
}

function sha256(bytes: Uint8Array): string {
	return new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
	let offset = 0
	for (const part of parts) {
		out.set(part, offset)
		offset += part.length
	}
	return out
}

interface DumpOptions {
	readonly source?: OpsDumpSource
	readonly consistent?: boolean
	/** How many lines the first part holds; the rest go to a second part. All in one part by default. */
	readonly split?: number
	readonly edit?: (manifest: OpsDumpManifest) => OpsDumpManifest
	/** Rewrites the lines the parts hold; the manifest's tables stay the source's. */
	readonly lines?: (lines: OpsDumpLine[]) => OpsDumpLine[]
}

/** The backup of `storage` under `__fabrika/backups/`, as the producer writes it, into `objects`. */
function writeDump(objects: Map<string, Uint8Array>, storage: SqliteStorage, options: DumpOptions = {}): OpsDumpManifest {
	const consistent = options.consistent ?? true
	const source = options.source ?? SOURCE
	const read = linesOf(storage)
	const lines = (options.lines?.(read) ?? read).map((line) => encodeOpsDumpLine(line))
	const groups = options.split === undefined ? [lines] : [lines.slice(0, options.split), lines.slice(options.split)]
	const members = groups.map((group, index) => member(group, index < groups.length - 1 ? OPS_DUMP_PART_SIZE : null))
	const parts: OpsDumpPart[] = members.map((bytes, index) => ({ part: index + 1, size: bytes.length, sha256: sha256(bytes) }))
	const migrations = storage.sql.exec('SELECT bundle, name, checksum, applied_at AS appliedAt FROM fabrika_migrations ORDER BY bundle, name').toArray()
	const manifest = parseOpsDumpManifest({
		format: 1,
		dump: source.dump,
		object: source.object,
		consistent,
		createdAt: '2026-10-25T08:00:00.000Z',
		bookmark: 'bookmark-0001',
		release: '0.9.0',
		contractDigest: `sha256:${'a'.repeat(64)}`,
		ddl: ddlOf(storage),
		migrations,
		tables: tablesOf(storage),
		parts,
	})
	if (manifest === null) throw new Error('the test manifest does not parse')
	const written = options.edit?.(manifest) ?? manifest
	const ref = { ...source, consistent }
	objects.set(OPS_DUMP_KEY(ref, 'data'), concat(members))
	objects.set(OPS_DUMP_KEY(ref, 'manifest'), new TextEncoder().encode(JSON.stringify(written)))
	return written
}

/** R2's `get`, with a byte range, over `objects`. */
function r2(objects: Map<string, Uint8Array>) {
	return {
		get(key: string, options?: { readonly range?: { readonly offset: number; readonly length: number } }) {
			const bytes = objects.get(key)
			if (bytes === undefined) return Promise.resolve(null)
			const range = options?.range
			const body = range === undefined ? bytes : bytes.slice(range.offset, range.offset + range.length)
			return Promise.resolve({
				size: bytes.length,
				text: () => Promise.resolve(new TextDecoder().decode(body)),
				arrayBuffer: () => Promise.resolve(body.slice().buffer),
			})
		},
	}
}

/** An object's storage: bun:sqlite with workerd's synchronous KV in its `_cf_KV` table, and a `deleteAll` that wipes the file. */
function objectStorage(): { readonly storage: ImportStorage; readonly database: () => BunDatabase } {
	let database = new BunDatabase(':memory:')
	let inner = bunSqliteStorage(database)
	const hasKv = () => inner.sql.exec(`SELECT 1 AS present FROM sqlite_schema WHERE name = '_cf_KV'`).toArray().length > 0
	const storage: ImportStorage = {
		sql: {
			exec(query, ...bindings) {
				// The shared double reads a trigger body's `; END` as transaction control, which workerd's authorizer does not.
				if (/^\s*CREATE\s+TRIGGER\s/i.test(query) && bindings.length === 0) {
					database.run(query)
					return { toArray: () => [], rowsWritten: 0 }
				}
				return inner.sql.exec(query, ...bindings)
			},
		},
		transaction: (closure) => inner.transaction(closure),
		transactionSync: (closure) => inner.transactionSync(closure),
		kv: {
			get(key) {
				if (!hasKv()) return undefined
				const value = inner.sql.exec('SELECT value FROM _cf_KV WHERE key = ?', key).toArray()[0]?.['value']
				return typeof value === 'string' ? JSON.parse(value) : undefined
			},
			put(key, value) {
				inner.sql.exec('CREATE TABLE IF NOT EXISTS _cf_KV (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID')
				inner.sql.exec('INSERT OR REPLACE INTO _cf_KV (key, value) VALUES (?, ?)', key, JSON.stringify(value))
			},
			delete(key) {
				return hasKv() && inner.sql.exec('DELETE FROM _cf_KV WHERE key = ?', key).rowsWritten > 0
			},
		},
		deleteAll() {
			database.close()
			database = new BunDatabase(':memory:')
			inner = bunSqliteStorage(database)
			return Promise.resolve()
		},
	}
	return { storage, database: () => database }
}

interface Target extends ImportTarget {
	readonly database: () => BunDatabase
}

/** A fresh object over the bucket `objects`. */
function freshTarget(
	objects: Map<string, Uint8Array>,
	options: { readonly migrations?: readonly SqliteMigrationBundle[]; readonly serving?: string } = {},
): Target {
	const { storage, database } = objectStorage()
	return { storage, bucket: r2(objects), migrations: options.migrations ?? release(), serving: options.serving ?? SOURCE.object, database }
}

function barrier(state: OpsPublishedState | null = INSPECT): Promise<MaintenanceBarrier> {
	return MaintenanceBarrier.load({ read: () => Promise.resolve(state === null ? null : { state, version: 'v1' }), put: () => Promise.resolve('v2') })
}

function scope(source: OpsDumpSource = SOURCE) {
	return { object: TARGET, generation: GENERATION, source }
}

async function step(
	target: Target,
	request: OpsImportRequest,
	state: OpsPublishedState | null = INSPECT,
): Promise<{ status: number; body: unknown }> {
	const response = await importStep(target, await barrier(state), request)
	return { status: response.status, body: await response.json() }
}

async function refusal(target: Target, request: OpsImportRequest): Promise<unknown> {
	const { status, body } = await step(target, request)
	expect(status).toBe(OPS_DATA_REFUSED_STATUS)
	return parseOpsDataRefusal(body)
}

/** Every step Control drives, each answer parsed by the wire's parser; the tables `verify` reported. */
async function importAll(target: Target): Promise<OpsDumpTable[]> {
	const begun = parseOpsImportBeginAck((await step(target, { ...scope(), step: 'begin' })).body)
	if (begun === null) throw new Error('begin did not answer its acknowledgement')
	const linked: number[] = []
	for (let part = 1; part <= begun.parts; part++) {
		const loaded = parseOpsImportPartAck((await step(target, { ...scope(), step: 'part', part })).body)
		expect(loaded).not.toBeNull()
		if ((loaded?.deferred ?? 0) > 0) linked.push(part)
	}
	for (const part of linked) {
		expect(parseOpsImportLinkAck((await step(target, { ...scope(), step: 'link', part })).body)).not.toBeNull()
	}
	const verified: OpsDumpTable[] = []
	let cursor: OpsDumpCursor | null = null
	do {
		const answer = parseOpsImportVerifyAck((await step(target, { ...scope(), step: 'verify', cursor })).body)
		if (answer === null) throw new Error('verify did not answer its acknowledgement')
		verified.push(...answer.tables)
		cursor = answer.next
	} while (cursor !== null)
	expect(parseOpsImportCompleteAck((await step(target, { ...scope(), step: 'complete' })).body)).toEqual({ step: 'complete', source: SOURCE })
	return verified
}

function one(storage: SqliteStorage, query: string): unknown {
	return Object.values(storage.sql.exec(query).toArray()[0] ?? {})[0]
}

describe('a consistent backup', () => {
	test('imports into a fresh object and verifies equal to its source, values, counters and triggers included', async () => {
		const objects = new Map<string, Uint8Array>()
		const source = await sourceDatabase()
		const manifest = writeDump(objects, source.storage)
		const target = freshTarget(objects)

		const verified = await importAll(target)

		expect(verified).toEqual([...manifest.tables])
		expect(tablesOf(target.storage)).toEqual(tablesOf(source.storage))
		expect(ddlOf(target.storage)).toEqual(ddlOf(source.storage))
		expect(target.storage.kv.get(IMPORT_MARKER_KEY)).toBeUndefined()
		// A 64-bit integer, a blob, text that is not UTF-8 and a real cross byte for byte.
		expect(one(target.storage, `SELECT CAST(big AS TEXT) FROM notes WHERE id = 1`)).toBe(INT64_MAX)
		expect(one(target.storage, `SELECT CAST(big AS TEXT) FROM notes WHERE id = 4`)).toBe(BEYOND_DOUBLE)
		expect(one(target.storage, `SELECT hex(payload) FROM notes WHERE id = 1`)).toBe('00FF10')
		expect(one(target.storage, `SELECT typeof(payload) || hex(payload) FROM notes WHERE id = 4`)).toBe('blob')
		expect(one(target.storage, `SELECT typeof(body) || hex(body) FROM notes WHERE id = 4`)).toBe('text80')
		expect(one(target.storage, `SELECT ratio FROM notes WHERE id = 4`)).toBe(-2.5e300)
		// The counter is the source's, past the deleted row, and the trigger fired for no loaded row.
		expect(one(target.storage, `SELECT seq FROM sqlite_sequence WHERE name = 'notes'`)).toBe(12)
		expect(one(target.storage, `SELECT count(*) FROM audit`)).toBe(3)
		// The self-reference and the cycle were linked once every row was in.
		expect(target.storage.sql.exec('SELECT id, manager_id FROM employees ORDER BY id').toArray()).toEqual([
			{ id: 1, manager_id: 3 },
			{ id: 2, manager_id: 1 },
			{ id: 3, manager_id: 2 },
		])
		expect(target.storage.sql.exec('SELECT id, lead_id FROM teams ORDER BY id').toArray()).toEqual([{ id: 1, lead_id: 2 }, { id: 2, lead_id: null }])
		expect(target.storage.sql.exec('SELECT id, team_id FROM members ORDER BY id').toArray()).toEqual([{ id: 1, team_id: 2 }, { id: 2, team_id: 1 }])
		// The recreated trigger fires again.
		target.storage.sql.exec(`INSERT INTO notes (employee_id, body) VALUES (1, 'after')`)
		expect(one(target.storage, `SELECT count(*) FROM audit`)).toBe(4)
		expect(one(target.storage, `SELECT max(id) FROM notes`)).toBe(13)
	})

	test('loads a part by its byte range: the first exactly the fixed size, a self-reference linked across parts', async () => {
		const objects = new Map<string, Uint8Array>()
		const source = await sourceDatabase()
		const lines = linesOf(source.storage)
		const firstEmployee = lines.findIndex((line) => line.table === 'employees')
		// employees 1 → 3 in part 1, employees 3 in part 2.
		const manifest = writeDump(objects, source.storage, { split: firstEmployee + 1 })
		expect(manifest.parts.map((part) => part.size === OPS_DUMP_PART_SIZE)).toEqual([true, false])
		const target = freshTarget(objects)

		expect(await importAll(target)).toEqual([...manifest.tables])
		expect(tablesOf(target.storage)).toEqual(tablesOf(source.storage))
	})

	test('a retried part loads nothing twice and answers what it loaded', async () => {
		const objects = new Map<string, Uint8Array>()
		writeDump(objects, (await sourceDatabase()).storage)
		const target = freshTarget(objects)
		await step(target, { ...scope(), step: 'begin' })

		const first = await step(target, { ...scope(), step: 'part', part: 1 })
		const again = await step(target, { ...scope(), step: 'part', part: 1 })

		expect(again).toEqual(first)
		expect(parseOpsImportPartAck(first.body)).toMatchObject({ part: 1, deferred: 6 })
		expect(one(target.storage, 'SELECT count(*) FROM employees')).toBe(3)
	})

	test('a retried begin answers again once it cleared the target, and the parts load after it', async () => {
		const objects = new Map<string, Uint8Array>()
		const source = await sourceDatabase()
		writeDump(objects, source.storage)
		const target = freshTarget(objects)

		expect(parseOpsImportBeginAck((await step(target, { ...scope(), step: 'begin' })).body)).toEqual({ step: 'begin', parts: 1 })
		expect(parseOpsImportBeginAck((await step(target, { ...scope(), step: 'begin' })).body)).toEqual({ step: 'begin', parts: 1 })
		// The migrations' rows and the trigger are gone; the ledger is the source's once loaded.
		expect(one(target.storage, 'SELECT count(*) FROM fabrika_migrations')).toBe(0)
		expect(one(target.storage, `SELECT count(*) FROM sqlite_schema WHERE type = 'trigger'`)).toBe(0)
		expect(await importAll(target)).toHaveLength(tablesOf(source.storage).length)
	})
})

describe('the importer refuses', () => {
	test('a diagnostic export, which is fuzzy', async () => {
		const objects = new Map<string, Uint8Array>()
		writeDump(objects, (await sourceDatabase()).storage, { edit: (manifest) => ({ ...manifest, consistent: false }) })
		const target = freshTarget(objects)

		expect(await refusal(target, { ...scope(), step: 'begin' })).toEqual({ refused: 'fuzzy_dump', table: null })
		expect(target.storage.kv.get(IMPORT_MARKER_KEY)).toBeUndefined()
	})

	test('a manifest that is missing, does not parse or names another dump', async () => {
		const objects = new Map<string, Uint8Array>()
		const target = freshTarget(objects)
		expect(await refusal(target, { ...scope(), step: 'begin' })).toEqual({ refused: 'invalid_manifest', table: null })

		objects.set(OPS_DUMP_KEY({ ...SOURCE, consistent: true }, 'manifest'), new TextEncoder().encode('{"format":1}'))
		expect(await refusal(target, { ...scope(), step: 'begin' })).toEqual({ refused: 'invalid_manifest', table: null })

		writeDump(objects, (await sourceDatabase()).storage, { edit: (manifest) => ({ ...manifest, dump: '0193f1c2-7a4b-7c3d-8e9f-000000000000' }) })
		expect(await refusal(target, { ...scope(), step: 'begin' })).toEqual({ refused: 'invalid_manifest', table: null })
	})

	test('a ledger that differs from the release: a changed file, a file the release lacks, a bundle it lacks', async () => {
		const objects = new Map<string, Uint8Array>()
		writeDump(objects, (await sourceDatabase()).storage)
		const changed = APP_MIGRATIONS.map((migration, index) => index === 0 ? { ...migration, sql: `${migration.sql}\n-- changed` } : migration)
		const releases = [
			release(changed),
			release(APP_MIGRATIONS.slice(0, 1)),
			[{ bundle: 'fabrika', migrations: SQLITE_FRAMEWORK_MIGRATIONS }],
		]
		for (const migrations of releases) {
			const target = freshTarget(objects, { migrations })
			expect(await refusal(target, { ...scope(), step: 'begin' })).toEqual({ refused: 'ledger_mismatch', table: null })
			expect(one(target.storage, `SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE '\\_cf\\_%' ESCAPE '\\'`)).toBe(0)
		}
	})

	test("applies no file after the manifest's ledger, so a release ahead of the backup imports it", async () => {
		const objects = new Map<string, Uint8Array>()
		const source = await sourceDatabase()
		writeDump(objects, source.storage)
		const ahead = [...APP_MIGRATIONS, { name: '0004_later.sql', sql: 'CREATE TABLE later (id INTEGER PRIMARY KEY);' }]
		const target = freshTarget(objects, { migrations: release(ahead) })

		await importAll(target)

		expect(one(target.storage, `SELECT count(*) FROM sqlite_schema WHERE name = 'later'`)).toBe(0)
		expect(tablesOf(target.storage)).toEqual(tablesOf(source.storage))
	})

	test('a schema the migrations do not reproduce', async () => {
		const objects = new Map<string, Uint8Array>()
		writeDump(objects, (await sourceDatabase()).storage, {
			edit: (manifest) => ({
				...manifest,
				ddl: manifest.ddl.map((entry) => entry.name === 'notes_employee' ? { ...entry, sql: `${entry.sql} WHERE body IS NOT NULL` } : entry),
			}),
		})
		expect(await refusal(freshTarget(objects), { ...scope(), step: 'begin' })).toEqual({ refused: 'schema_mismatch', table: null })
	})

	test('a part whose bytes do not match the manifest, and one that decompresses past the bound', async () => {
		const objects = new Map<string, Uint8Array>()
		writeDump(objects, (await sourceDatabase()).storage)
		const target = freshTarget(objects)
		await step(target, { ...scope(), step: 'begin' })
		const key = OPS_DUMP_KEY({ ...SOURCE, consistent: true }, 'data')
		const data = objects.get(key) ?? new Uint8Array()
		const flipped = data.slice()
		flipped[20] = (flipped[20] ?? 0) ^ 0xff
		objects.set(key, flipped)

		expect(await refusal(target, { ...scope(), step: 'part', part: 1 })).toEqual({ refused: 'part_mismatch', table: null })
		expect(await refusal(target, { ...scope(), step: 'part', part: 2 })).toEqual({ refused: 'part_mismatch', table: null })
		expect(one(target.storage, 'SELECT count(*) FROM employees')).toBe(0)

		const bomb = Bun.gzipSync(new Uint8Array(OPS_DUMP_PART_MAX_RAW_BYTES + 1).fill(0x0a))
		objects.set(key, bomb)
		const manifestKey = OPS_DUMP_KEY({ ...SOURCE, consistent: true }, 'manifest')
		const manifest = parseOpsDumpManifest(JSON.parse(new TextDecoder().decode(objects.get(manifestKey))))
		if (manifest === null) throw new Error('the stored manifest does not parse')
		objects.set(manifestKey, new TextEncoder().encode(JSON.stringify({ ...manifest, parts: [{ part: 1, size: bomb.length, sha256: sha256(bomb) }] })))
		expect(await refusal(target, { ...scope(), step: 'part', part: 1 })).toEqual({ refused: 'part_mismatch', table: null })
	})

	test('an object that holds a table, or an import of another backup', async () => {
		const objects = new Map<string, Uint8Array>()
		writeDump(objects, (await sourceDatabase()).storage)
		const holding = freshTarget(objects)
		holding.storage.sql.exec('CREATE TABLE leftover (id INTEGER PRIMARY KEY)')
		expect(await refusal(holding, { ...scope(), step: 'begin' })).toEqual({ refused: 'not_fresh', table: null })
		expect(holding.storage.kv.get(IMPORT_MARKER_KEY)).toBeUndefined()

		const importing = freshTarget(objects)
		await step(importing, { ...scope(), step: 'begin' })
		const other = { object: SOURCE.object, dump: '0193f1c2-7a4b-7c3d-8e9f-111111111111' }
		writeDump(objects, (await sourceDatabase()).storage, { source: other })
		expect(await refusal(importing, { ...scope(other), step: 'begin' })).toEqual({ refused: 'not_fresh', table: null })
	})

	test('a step before begin, and a link before every part is loaded', async () => {
		const objects = new Map<string, Uint8Array>()
		writeDump(objects, (await sourceDatabase()).storage)
		const target = freshTarget(objects)
		expect(await refusal(target, { ...scope(), step: 'part', part: 1 })).toEqual({ refused: 'no_import', table: null })
		expect(await refusal(target, { ...scope(), step: 'verify', cursor: null })).toEqual({ refused: 'no_import', table: null })
		expect(await refusal(target, { ...scope(), step: 'complete' })).toEqual({ refused: 'no_import', table: null })

		await step(target, { ...scope(), step: 'begin' })
		expect(await refusal(target, { ...scope(), step: 'link', part: 1 })).toEqual({ refused: 'part_mismatch', table: null })
	})

	test('a table whose rows differ from the manifest, naming it', async () => {
		const objects = new Map<string, Uint8Array>()
		writeDump(objects, (await sourceDatabase()).storage)
		const target = freshTarget(objects)
		await step(target, { ...scope(), step: 'begin' })
		await step(target, { ...scope(), step: 'part', part: 1 })
		await step(target, { ...scope(), step: 'link', part: 1 })
		target.storage.sql.exec(`UPDATE employees SET name = 'z' WHERE id = 2`)

		let cursor: OpsDumpCursor | null = null
		for (;;) {
			const { status, body } = await step(target, { ...scope(), step: 'verify', cursor })
			if (status !== 200) {
				expect(status).toBe(OPS_DATA_REFUSED_STATUS)
				expect(parseOpsDataRefusal(body)).toEqual({ refused: 'verify_mismatch', table: 'employees' })
				break
			}
			cursor = parseOpsImportVerifyAck(body)?.next ?? null
			if (cursor === null) throw new Error('verify accepted a changed table')
		}
	})

	test('every step outside inspect, and every step under another generation', async () => {
		const objects = new Map<string, Uint8Array>()
		writeDump(objects, (await sourceDatabase()).storage)
		const target = freshTarget(objects)

		const open = await step(target, { ...scope(), step: 'begin' }, { generation: GENERATION, mode: 'open' })
		expect(open.status).toBe(OPS_DATA_REFUSED_STATUS)
		expect(parseOpsDataRefusal(open.body)).toEqual({ refused: 'wrong_mode', table: null })

		const stale = await step(target, { ...scope(), step: 'begin' }, { generation: GENERATION + 1, mode: 'inspect' })
		expect(stale.status).toBe(OPS_STALE_STATUS)
		expect(parseOpsStaleRefusal(stale.body)).toEqual({ refused: 'stale_generation', published: { generation: GENERATION + 1, mode: 'inspect' } })

		const never = await step(target, { step: 'discard', object: TARGET, generation: GENERATION }, null)
		expect(never.status).toBe(OPS_STALE_STATUS)
		expect(parseOpsStaleRefusal(never.body)).toEqual({ refused: 'stale_generation', published: null })
		expect(target.storage.kv.get(IMPORT_MARKER_KEY)).toBeUndefined()
	})
})

describe('discard', () => {
	test('wipes an object that holds an import marker', async () => {
		const objects = new Map<string, Uint8Array>()
		writeDump(objects, (await sourceDatabase()).storage)
		const target = freshTarget(objects)
		await step(target, { ...scope(), step: 'begin' })
		await step(target, { ...scope(), step: 'part', part: 1 })

		const { status, body } = await step(target, { step: 'discard', object: TARGET, generation: GENERATION })

		expect(status).toBe(200)
		expect(parseOpsImportDiscardAck(body)).toEqual({ step: 'discard' })
		expect(target.database().query('SELECT count(*) AS count FROM sqlite_schema').get()).toEqual({ count: 0 })
		// The wiped object takes the backup again.
		expect(parseOpsImportBeginAck((await step(target, { ...scope(), step: 'begin' })).body)).toEqual({ step: 'begin', parts: 1 })
	})

	test('refuses an object without an import marker, and the object of ordinary traffic', async () => {
		const objects = new Map<string, Uint8Array>()
		writeDump(objects, (await sourceDatabase()).storage)
		const unmarked = freshTarget(objects)
		unmarked.storage.sql.exec('CREATE TABLE kept (id INTEGER PRIMARY KEY)')
		expect(await refusal(unmarked, { step: 'discard', object: TARGET, generation: GENERATION })).toEqual({ refused: 'no_import', table: null })
		expect(one(unmarked.storage, `SELECT count(*) FROM sqlite_schema WHERE name = 'kept'`)).toBe(1)

		const marked = freshTarget(objects)
		await step(marked, { ...scope(), step: 'begin' })
		const serving: Target = { ...marked, serving: TARGET }
		expect(await refusal(serving, { step: 'discard', object: TARGET, generation: GENERATION })).toEqual({ refused: 'serving_object', table: null })
		expect(serving.storage.kv.get(IMPORT_MARKER_KEY)).toBeDefined()
	})
})

/** Every step Control may send, under `scope()`. */
function everyStep(): OpsImportRequest[] {
	return [
		{ ...scope(), step: 'begin' },
		{ ...scope(), step: 'part', part: 1 },
		{ ...scope(), step: 'link', part: 1 },
		{ ...scope(), step: 'verify', cursor: null },
		{ ...scope(), step: 'complete' },
		{ step: 'discard', object: TARGET, generation: GENERATION },
	]
}

/** Every verify step from the start, as Control chains them; the last answer. */
async function verifyAll(target: Target, gate?: MaintenanceBarrier): Promise<{ status: number; body: unknown }> {
	let cursor: OpsDumpCursor | null = null
	for (;;) {
		const answer = await stepOn(target, gate ?? (await barrier()), { ...scope(), step: 'verify', cursor })
		const next = answer.status === 200 ? parseOpsImportVerifyAck(answer.body)?.next ?? null : null
		if (next === null) return answer
		cursor = next
	}
}

async function stepOn(target: Target, gate: MaintenanceBarrier, request: OpsImportRequest): Promise<{ status: number; body: unknown }> {
	const response = await importStep(target, gate, request)
	return { status: response.status, body: await response.json() }
}

/** Whether `promise` settles within a few turns of the event loop. */
async function settles(promise: Promise<unknown>): Promise<boolean> {
	const settled = promise.then(() => true, () => true)
	return await Promise.race([settled, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20))])
}

/** `objects` as R2, every ranged read held from the moment it starts until `release`. */
function heldRanges(objects: Map<string, Uint8Array>) {
	const inner = r2(objects)
	const started = Promise.withResolvers<void>()
	const gate = Promise.withResolvers<void>()
	return {
		bucket: {
			async get(key: string, options?: { readonly range?: { readonly offset: number; readonly length: number } }) {
				if (options?.range !== undefined) {
					started.resolve()
					await gate.promise
				}
				return await inner.get(key, options)
			},
		},
		started: started.promise,
		release: () => gate.resolve(),
	}
}

describe('complete', () => {
	test('is refused before every part loaded, before the link pass, and before a full verification, and keeps the marker', async () => {
		const objects = new Map<string, Uint8Array>()
		writeDump(objects, (await sourceDatabase()).storage)
		const target = freshTarget(objects)
		await step(target, { ...scope(), step: 'begin' })

		expect(await refusal(target, { ...scope(), step: 'complete' })).toEqual({ refused: 'part_mismatch', table: null })
		expect(parseOpsImportPartAck((await step(target, { ...scope(), step: 'part', part: 1 })).body)).toMatchObject({ deferred: 6 })
		expect(await refusal(target, { ...scope(), step: 'complete' })).toEqual({ refused: 'part_mismatch', table: null })
		await step(target, { ...scope(), step: 'link', part: 1 })
		expect(await refusal(target, { ...scope(), step: 'complete' })).toEqual({ refused: 'verify_mismatch', table: null })
		expect(target.storage.kv.get(IMPORT_MARKER_KEY)).toBeDefined()

		expect((await verifyAll(target)).status).toBe(200)
		expect((await step(target, { ...scope(), step: 'complete' })).status).toBe(200)
		expect(target.storage.kv.get(IMPORT_MARKER_KEY)).toBeUndefined()
	})

	test('is refused after a verification that failed', async () => {
		const objects = new Map<string, Uint8Array>()
		writeDump(objects, (await sourceDatabase()).storage)
		const target = freshTarget(objects)
		await step(target, { ...scope(), step: 'begin' })
		await step(target, { ...scope(), step: 'part', part: 1 })
		await step(target, { ...scope(), step: 'link', part: 1 })
		expect((await verifyAll(target)).status).toBe(200)
		target.storage.sql.exec(`UPDATE employees SET name = 'z' WHERE id = 2`)

		expect(parseOpsDataRefusal((await verifyAll(target)).body)).toEqual({ refused: 'verify_mismatch', table: 'employees' })
		expect(await refusal(target, { ...scope(), step: 'complete' })).toEqual({ refused: 'verify_mismatch', table: null })
		expect(target.storage.kv.get(IMPORT_MARKER_KEY)).toBeDefined()
	})

	/** A load with more rows than one verify step reads, every part in and linked; `unlinked` is a part with no deferred row. */
	async function largeLoad(): Promise<{ readonly target: Target; readonly unlinked: number }> {
		const objects = new Map<string, Uint8Array>()
		const source = await sourceDatabase()
		source.database.run(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50005) INSERT INTO audit (at, what) SELECT 'then', 'row ' || i FROM n`,
		)
		writeDump(objects, source.storage, { split: 40_000 })
		const target = freshTarget(objects)
		await step(target, { ...scope(), step: 'begin' })
		let unlinked: number | null = null
		for (const part of [1, 2]) {
			const loaded = parseOpsImportPartAck((await step(target, { ...scope(), step: 'part', part })).body)
			if ((loaded?.deferred ?? 0) > 0) {
				await step(target, { ...scope(), step: 'link', part })
			} else {
				unlinked = part
			}
		}
		if (unlinked === null) throw new Error('every part of the test dump has a deferred row')
		return { target, unlinked }
	}

	/** The first verify step, and the cursor it handed out; the verification takes more than one step. */
	async function firstVerify(target: Target): Promise<OpsDumpCursor> {
		const first = await step(target, { ...scope(), step: 'verify', cursor: null })
		const cursor = parseOpsImportVerifyAck(first.body)?.next ?? null
		if (cursor === null) throw new Error('the verification finished in one step')
		return cursor
	}

	test('follows a verify whose answer was lost: a retried page, the last one included, answers the same', async () => {
		const { target } = await largeLoad()
		const cursor = await firstVerify(target)
		const last = await step(target, { ...scope(), step: 'verify', cursor })
		expect(parseOpsImportVerifyAck(last.body)?.next).toBeNull()

		// The answer was lost: Control sends the same cursor again.
		expect(await step(target, { ...scope(), step: 'verify', cursor })).toEqual(last)
		expect(await step(target, { ...scope(), step: 'verify', cursor })).toEqual(last)
		expect((await step(target, { ...scope(), step: 'complete' })).status).toBe(200)
	})

	test('replays no verify answer once a later write reset the verification', async () => {
		const { target, unlinked } = await largeLoad()
		const cursor = await firstVerify(target)
		expect((await step(target, { ...scope(), step: 'verify', cursor })).status).toBe(200)

		expect(parseOpsImportLinkAck((await step(target, { ...scope(), step: 'link', part: unlinked })).body)).toMatchObject({ rows: 0 })

		expect(await refusal(target, { ...scope(), step: 'verify', cursor })).toEqual({ refused: 'verify_mismatch', table: cursor.table })
		expect(await refusal(target, { ...scope(), step: 'complete' })).toEqual({ refused: 'verify_mismatch', table: null })
	})

	test('is refused after a verify that skipped ahead with a cursor the object never handed out', async () => {
		const objects = new Map<string, Uint8Array>()
		const manifest = writeDump(objects, (await sourceDatabase()).storage)
		const target = freshTarget(objects)
		await step(target, { ...scope(), step: 'begin' })
		await step(target, { ...scope(), step: 'part', part: 1 })
		await step(target, { ...scope(), step: 'link', part: 1 })
		const last = manifest.tables.at(-1)?.name ?? ''
		const skipped: OpsDumpCursor = { table: last, after: null, rows: 0, hash: OPS_EMPTY_TABLE_HASH }

		expect(await refusal(target, { ...scope(), step: 'verify', cursor: skipped })).toEqual({ refused: 'verify_mismatch', table: last })
		expect(await refusal(target, { ...scope(), step: 'complete' })).toEqual({ refused: 'verify_mismatch', table: null })
	})

	test('needs a new verification after a link pass that ran once the last one finished', async () => {
		const objects = new Map<string, Uint8Array>()
		const source = await sourceDatabase()
		// The last line, sqlite_sequence's, alone in part 2, which has no deferred key.
		writeDump(objects, source.storage, { split: linesOf(source.storage).length - 1 })
		const target = freshTarget(objects)
		await step(target, { ...scope(), step: 'begin' })
		await step(target, { ...scope(), step: 'part', part: 1 })
		expect(parseOpsImportPartAck((await step(target, { ...scope(), step: 'part', part: 2 })).body)).toMatchObject({ deferred: 0 })
		await step(target, { ...scope(), step: 'link', part: 1 })
		expect((await verifyAll(target)).status).toBe(200)

		expect(parseOpsImportLinkAck((await step(target, { ...scope(), step: 'link', part: 2 })).body)).toEqual({ step: 'link', part: 2, rows: 0 })

		expect(await refusal(target, { ...scope(), step: 'complete' })).toEqual({ refused: 'verify_mismatch', table: null })
		expect((await verifyAll(target)).status).toBe(200)
		expect((await step(target, { ...scope(), step: 'complete' })).status).toBe(200)
	})

	test('retried after it succeeded answers the same acknowledgement, and holds no marker', async () => {
		const objects = new Map<string, Uint8Array>()
		writeDump(objects, (await sourceDatabase()).storage)
		const target = freshTarget(objects)
		await importAll(target)

		const again = await step(target, { ...scope(), step: 'complete' })

		expect(again.status).toBe(200)
		expect(parseOpsImportCompleteAck(again.body)).toEqual({ step: 'complete', source: SOURCE })
		expect(target.storage.kv.get(IMPORT_MARKER_KEY)).toBeUndefined()
		const other = { object: SOURCE.object, dump: '0193f1c2-7a4b-7c3d-8e9f-111111111111' }
		expect(await refusal(target, { ...scope(other), step: 'complete' })).toEqual({ refused: 'no_import', table: null })
		expect(await refusal(target, { ...scope(), step: 'part', part: 1 })).toEqual({ refused: 'no_import', table: null })
	})
})

describe("each step in the barrier's turn", () => {
	test('a transition waits for a part reading its range; the next step under the old generation is stale', async () => {
		const objects = new Map<string, Uint8Array>()
		writeDump(objects, (await sourceDatabase()).storage)
		const held = heldRanges(objects)
		const target: Target = { ...freshTarget(objects), bucket: held.bucket }
		const gate = await barrier()
		await stepOn(target, gate, { ...scope(), step: 'begin' })

		const loading = stepOn(target, gate, { ...scope(), step: 'part', part: 1 })
		await held.started
		const next = gate.transition({ generation: GENERATION + 1, mode: 'inspect' })

		expect(await settles(next)).toBe(false)
		held.release()
		expect((await loading).status).toBe(200)
		expect((await next).kind).toBe('acknowledged')
		const stale = await stepOn(target, gate, { ...scope(), step: 'link', part: 1 })
		expect(stale.status).toBe(OPS_STALE_STATUS)
		expect(parseOpsStaleRefusal(stale.body)).toEqual({ refused: 'stale_generation', published: { generation: GENERATION + 1, mode: 'inspect' } })
	})

	test('a transition waits for a discard to finish its wipe', async () => {
		const objects = new Map<string, Uint8Array>()
		writeDump(objects, (await sourceDatabase()).storage)
		const plain = freshTarget(objects)
		const wiping = Promise.withResolvers<void>()
		const started = Promise.withResolvers<void>()
		const target: Target = {
			...plain,
			storage: {
				...plain.storage,
				async deleteAll() {
					started.resolve()
					await wiping.promise
					await plain.storage.deleteAll()
				},
			},
		}
		const gate = await barrier()
		await stepOn(target, gate, { ...scope(), step: 'begin' })

		const discarding = stepOn(target, gate, { step: 'discard', object: TARGET, generation: GENERATION })
		await started.promise
		const next = gate.transition({ generation: GENERATION + 1, mode: 'inspect' })

		expect(await settles(next)).toBe(false)
		wiping.resolve()
		expect((await discarding).status).toBe(200)
		expect((await next).kind).toBe('acknowledged')
	})

	test('overlapping retries of a part load it once; concurrent parts each count, so the link pass may run', async () => {
		const objects = new Map<string, Uint8Array>()
		const source = await sourceDatabase()
		writeDump(objects, source.storage)
		const target = freshTarget(objects)
		const gate = await barrier()
		await stepOn(target, gate, { ...scope(), step: 'begin' })

		const [first, again] = await Promise.all([1, 1].map((part) => stepOn(target, gate, { ...scope(), step: 'part', part })))

		expect(again).toEqual(first)
		expect(first?.status).toBe(200)
		expect(one(target.storage, 'SELECT count(*) FROM employees')).toBe(3)

		const split = new Map<string, Uint8Array>()
		writeDump(split, source.storage, { split: linesOf(source.storage).length - 1 })
		const two = freshTarget(split)
		const twoGate = await barrier()
		await stepOn(two, twoGate, { ...scope(), step: 'begin' })
		const parts = await Promise.all([1, 2].map((part) => stepOn(two, twoGate, { ...scope(), step: 'part', part })))
		expect(parts.map((answer) => answer.status)).toEqual([200, 200])
		expect((await stepOn(two, twoGate, { ...scope(), step: 'link', part: 1 })).status).toBe(200)
	})

	test('a part that fails mid-way rolls back its rows and records nothing, so it loads whole once fixed', async () => {
		const objects = new Map<string, Uint8Array>()
		const source = await sourceDatabase()
		// A note twice: its rowid collides after every employee before it went in.
		writeDump(objects, source.storage, {
			lines: (lines) => {
				const note = lines.findIndex((line) => line.table === 'notes')
				return [...lines.slice(0, note + 1), ...lines.slice(note)]
			},
		})
		const target = freshTarget(objects)
		await step(target, { ...scope(), step: 'begin' })

		await expect(step(target, { ...scope(), step: 'part', part: 1 })).rejects.toThrow()
		expect(one(target.storage, 'SELECT count(*) FROM employees')).toBe(0)
		expect(one(target.storage, 'SELECT count(*) FROM notes')).toBe(0)

		writeDump(objects, source.storage)
		const loaded = parseOpsImportPartAck((await step(target, { ...scope(), step: 'part', part: 1 })).body)
		expect(loaded?.rows).toBe(linesOf(source.storage).length)
		expect(await importAll(target)).toHaveLength(tablesOf(source.storage).length)
	})
})

describe('the object of ordinary traffic', () => {
	test('refuses every step before it reads storage or R2', async () => {
		const reads: string[] = []
		const { storage } = objectStorage()
		const bucket = {
			get(key: string) {
				reads.push(key)
				return Promise.reject(new Error('R2 is not read for the object of ordinary traffic'))
			},
		}
		const target: Target = { storage, bucket, migrations: release(), serving: TARGET, database: () => new BunDatabase(':memory:') }

		for (const request of everyStep()) {
			expect(await refusal(target, request)).toEqual({ refused: 'serving_object', table: null })
		}

		expect(reads).toEqual([])
		expect(storage.kv.get(IMPORT_MARKER_KEY)).toBeUndefined()
		expect(one(storage, 'SELECT count(*) FROM sqlite_schema')).toBe(0)
	})
})

describe('values and ranges', () => {
	test('a retained NULL blob stays NULL, an empty one stays a blob, and edge reals round-trip', async () => {
		const objects = new Map<string, Uint8Array>()
		const source = await sourceDatabase()
		source.database.run(`INSERT INTO notes (id, employee_id, body, big, ratio, payload) VALUES (8, 2, NULL, NULL, 5e-324, NULL)`)
		source.database.run(`INSERT INTO notes (id, employee_id, body, big, ratio, payload) VALUES (9, 2, '', 0, 1.7976931348623157e308, x'')`)
		writeDump(objects, source.storage)
		const target = freshTarget(objects)

		await importAll(target)

		expect(tablesOf(target.storage)).toEqual(tablesOf(source.storage))
		expect(one(target.storage, `SELECT typeof(payload) FROM notes WHERE id = 8`)).toBe('null')
		expect(one(target.storage, `SELECT typeof(payload) || length(payload) FROM notes WHERE id = 9`)).toBe('blob0')
		expect(one(target.storage, `SELECT ratio FROM notes WHERE id = 8`)).toBe(5e-324)
		expect(one(target.storage, `SELECT ratio FROM notes WHERE id = 9`)).toBe(1.7976931348623157e308)
	})

	test("a table named page, the name of the verification's own CTE", async () => {
		const migrations = release([...APP_MIGRATIONS, { name: '0004_page.sql', sql: 'CREATE TABLE page (id INTEGER PRIMARY KEY, title TEXT NOT NULL);' }])
		const { storage } = objectStorage()
		await migrateSqlite(
			{ exec: (query, ...bindings) => storage.sql.exec(query, ...bindings), transactionSync: (fn) => storage.transactionSync(fn) },
			migrations,
		)
		storage.sql.exec(`INSERT INTO page (id, title) VALUES (1, 'a'), (2, 'b')`)
		const objects = new Map<string, Uint8Array>()
		const manifest = writeDump(objects, storage)
		const target = freshTarget(objects, { migrations })

		expect(await importAll(target)).toEqual([...manifest.tables])
		expect(one(target.storage, 'SELECT count(*) FROM page')).toBe(2)
	})

	test("a table at workerd's 100 columns without an INTEGER PRIMARY KEY: read in several statements, loaded by its rowid", async () => {
		// Each column reads as two result columns, and a row loads with its rowid beside every column: both past the limit.
		const columns = Array.from({ length: 100 }, (_, index) => `c${index}`)
		const migrations = release([...APP_MIGRATIONS, { name: '0004_wide.sql', sql: `CREATE TABLE wide (${columns.join(', ')});` }])
		const { storage } = objectStorage()
		await migrateSqlite(
			{ exec: (query, ...bindings) => storage.sql.exec(query, ...bindings), transactionSync: (fn) => storage.transactionSync(fn) },
			migrations,
		)
		const values = columns.map((_, index) => [`${index}`, `'t${index}'`, `${index}.5`, `x'0${index % 10}'`][index % 4])
		storage.sql.exec(`INSERT INTO wide (rowid, ${columns.join(', ')}) VALUES (5, ${values.join(', ')})`)
		storage.sql.exec(`INSERT INTO wide (rowid, c99) VALUES (9, 'last')`)
		const objects = new Map<string, Uint8Array>()
		const manifest = writeDump(objects, storage)
		const target = freshTarget(objects, { migrations })

		expect(await importAll(target)).toEqual([...manifest.tables])
		expect(tablesOf(target.storage)).toEqual(tablesOf(storage))
		expect(target.storage.sql.exec('SELECT rowid, c0, c49, c50, c98, c99 FROM wide ORDER BY rowid').toArray()).toEqual([
			{ rowid: 5, c0: 0, c49: 't49', c50: 50.5, c98: 98.5, c99: new Uint8Array([9]).buffer },
			{ rowid: 9, c0: null, c49: null, c50: null, c98: null, c99: 'last' },
		])
	})

	test('a range R2 answers short is refused', async () => {
		const objects = new Map<string, Uint8Array>()
		writeDump(objects, (await sourceDatabase()).storage)
		const target = freshTarget(objects)
		await step(target, { ...scope(), step: 'begin' })
		const key = OPS_DUMP_KEY({ ...SOURCE, consistent: true }, 'data')
		objects.set(key, (objects.get(key) ?? new Uint8Array()).slice(0, -1))

		expect(await refusal(target, { ...scope(), step: 'part', part: 1 })).toEqual({ refused: 'part_mismatch', table: null })
		expect(one(target.storage, 'SELECT count(*) FROM employees')).toBe(0)
	})
})

describe('the schema description', () => {
	test('a self-reference in a table whose CHECKs read other columns is dumped and linked again', async () => {
		const migrations = release([...APP_MIGRATIONS, {
			name: '0004_invoices.sql',
			sql: `CREATE TABLE invoices (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('invoice', 'proforma')),
				status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'paid')));
				ALTER TABLE invoices ADD COLUMN proforma_id TEXT REFERENCES invoices (id) ON DELETE SET NULL;
				ALTER TABLE invoices ADD COLUMN final_invoice_id TEXT REFERENCES invoices (id) ON DELETE SET NULL;`,
		}])
		const { storage } = objectStorage()
		await migrateSqlite(
			{ exec: (query, ...bindings) => storage.sql.exec(query, ...bindings), transactionSync: (fn) => storage.transactionSync(fn) },
			migrations,
		)
		storage.sql.exec(`INSERT INTO invoices (id, kind) VALUES ('p1', 'proforma'), ('i1', 'invoice')`)
		storage.sql.exec(`UPDATE invoices SET final_invoice_id = 'i1' WHERE id = 'p1'`)
		storage.sql.exec(`UPDATE invoices SET proforma_id = 'p1' WHERE id = 'i1'`)
		expect(planOf(storage).find((table) => table.name === 'invoices')?.deferred).toEqual(['proforma_id', 'final_invoice_id'])
		const objects = new Map<string, Uint8Array>()
		const manifest = writeDump(objects, storage)
		const target = freshTarget(objects, { migrations })

		expect(await importAll(target)).toEqual([...manifest.tables])
		expect(target.storage.sql.exec('SELECT id, proforma_id, final_invoice_id FROM invoices ORDER BY id').toArray()).toEqual([
			{ id: 'i1', proforma_id: 'p1', final_invoice_id: null },
			{ id: 'p1', proforma_id: null, final_invoice_id: 'i1' },
		])
	})

	test('plans the self-reference and the cycle as deferred, and the rowid of a table without an INTEGER PRIMARY KEY', async () => {
		const { storage } = await sourceDatabase()
		const plan = planOf(storage)
		const byName = new Map(plan.map((table) => [table.name, table]))

		expect(byName.get('employees')).toEqual({ name: 'employees', keyset: 'id', columns: ['id', 'name', 'manager_id'], deferred: ['manager_id'] })
		expect(byName.get('teams')?.deferred).toEqual(['lead_id'])
		expect(byName.get('members')?.deferred).toEqual(['team_id'])
		expect(byName.get('audit')).toEqual({ name: 'audit', keyset: 'rowid', columns: ['at', 'what'], deferred: [] })
		expect(byName.get('notes')?.deferred).toEqual([])
		expect(plan.map((table) => table.name).indexOf('notes')).toBeLessThan(plan.map((table) => table.name).indexOf('sqlite_sequence'))
	})

	test('reads a CHECK and an INITIALLY DEFERRED key from the SQL, outside quotes and comments only', () => {
		const storage = bunSqliteStorage()
		storage.sql.exec(`CREATE TABLE "check" (id INTEGER PRIMARY KEY, "initially deferred" TEXT DEFAULT 'check') -- check`)
		storage.sql.exec('CREATE TABLE checked (id INTEGER PRIMARY KEY, n INTEGER CHECK (n > 0))')
		storage.sql.exec('CREATE TABLE later (id INTEGER PRIMARY KEY, p INTEGER REFERENCES later (id) DEFERRABLE INITIALLY DEFERRED)')
		const tables = new Map(describeDumpSchema(storage).tables.map((table) => [table.name, table]))

		expect(tables.get('check')?.checkNames).toEqual([])
		expect(tables.get('checked')?.checkNames).toEqual(['n', '0'])
		expect(tables.get('later')?.foreignKeys.map((key) => key.initiallyDeferred)).toEqual([true])
		expect(planOpsDump(describeDumpSchema(storage))).toEqual({ refused: 'unsupported_schema', table: 'later' })
	})
})

describe('the ops seam', () => {
	function opsTarget(storage: OpsTarget['storage'], bucket: unknown): OpsTarget {
		return {
			storage,
			bucket,
			recovery: null,
			migrations: release(),
			contractDigest: null,
			bootFailure: () => Promise.resolve(null),
			maintenance: () => Promise.reject(new Error('not called')),
			migrate: () => Promise.reject(new Error('not called')),
		}
	}

	test('serves begin through the storage of the object it reaches', async () => {
		const objects = new Map<string, Uint8Array>()
		writeDump(objects, (await sourceDatabase()).storage)
		const { storage } = objectStorage()

		const response = await serveImport(opsTarget(storage, r2(objects)), await barrier(), { ...scope(), step: 'begin' }, SOURCE.object)

		expect(response.status).toBe(200)
		expect(parseOpsImportBeginAck(await response.json())).toEqual({ step: 'begin', parts: 1 })
		expect(storage.kv.get(IMPORT_MARKER_KEY)).toBeDefined()
	})

	test('a storage without the synchronous KV or deleteAll does not serve it', async () => {
		const storage = bunSqliteStorage(new BunDatabase(':memory:'))

		const response = await serveImport(opsTarget(storage, r2(new Map())), await barrier(), { ...scope(), step: 'begin' }, SOURCE.object)

		expect(response.status).toBe(501)
		expect(storage.sql.exec('SELECT count(*) AS count FROM sqlite_schema').toArray()).toEqual([{ count: 0 }])
	})
})

describe('a dump the producer wrote', () => {
	const envs: TestEnv[] = []
	afterEach(() => {
		for (const env of envs.splice(0)) {
			env.dispose()
		}
	})

	async function answer(response: Response): Promise<unknown> {
		expect(response.status).toBe(200)
		return await response.json()
	}

	/** Every export step as Control drives them, into `bucket`: begin, the parts from cursor to cursor, complete. */
	async function exportAll(storage: SqliteStorage, bucket: unknown): Promise<OpsDumpManifest> {
		const scope: OpsExportScope = { object: SOURCE.object, generation: GENERATION, consistent: true, dump: SOURCE.dump }
		const recovery = {
			getCurrentBookmark: () => Promise.resolve('bookmark-0001'),
			getBookmarkForTime: () => Promise.reject(new Error('not called')),
			onNextSessionRestoreBookmark: () => Promise.reject(new Error('not called')),
			abort: () => {
				throw new Error('not called')
			},
		}
		const source = { storage, bucket, recovery, contractDigest: `sha256:${'a'.repeat(64)}` }
		const gate = await barrier()
		const begun = parseOpsExportBeginAck(await answer(await exportStep(source, gate, { ...scope, step: 'begin' })))
		if (begun === null) throw new Error('begin did not answer its acknowledgement')
		const acks: OpsExportPartAck[] = []
		let cursor: OpsExportPartAck['next'] = null
		do {
			const request = { ...scope, step: 'part' as const, uploadId: begun.uploadId, part: acks.length + 1, cursor }
			const ack = parseOpsExportPartAck(await answer(await exportStep(source, gate, request)))
			if (ack === null) throw new Error('part did not answer its acknowledgement')
			acks.push(ack)
			cursor = ack.next
		} while (cursor !== null)
		const completed = parseOpsExportCompleteAck(
			await answer(
				await exportStep(source, gate, {
					...scope,
					step: 'complete',
					uploadId: begun.uploadId,
					bookmark: begun.bookmark,
					parts: acks.map((ack) => ack.uploaded),
					tables: acks.flatMap((ack) => ack.tables),
				}),
			),
		)
		if (completed === null) throw new Error('complete did not answer its acknowledgement')
		return completed.manifest
	}

	test('imports what the export wrote and verifies equal to its source', async () => {
		const testEnv = await createTestEnv({ bindings: { FILES: 'r2' } })
		envs.push(testEnv)
		const bucket = testEnv.env['FILES']
		const source = await sourceDatabase()
		const manifest = await exportAll(source.storage, bucket)
		const target: Target = { ...freshTarget(new Map()), bucket }

		const verified = await importAll(target)

		expect(verified).toEqual([...manifest.tables])
		expect(tablesOf(target.storage)).toEqual(tablesOf(source.storage))
		expect(ddlOf(target.storage)).toEqual(ddlOf(source.storage))
		expect(one(target.storage, `SELECT CAST(big AS TEXT) FROM notes WHERE id = 4`)).toBe(BEYOND_DOUBLE)
		expect(one(target.storage, `SELECT typeof(body) || hex(body) FROM notes WHERE id = 4`)).toBe('text80')
		expect(one(target.storage, `SELECT seq FROM sqlite_sequence WHERE name = 'notes'`)).toBe(12)
	})
})

describe('an object that holds an import marker', () => {
	const OPS_KEY = 'ops-key-of-the-environment-0123456789abcdef'
	const SERVING = 'application'
	/** Published `open`, so only the marker refuses what follows. */
	const OPEN: OpsPublishedState = { generation: 2, mode: 'open' }

	/** The environment's bucket: the published state of the serving object, no file. */
	function stateBucket() {
		const unused = () => Promise.reject(new Error('not called'))
		const state = { etag: 'v2', text: () => Promise.resolve(JSON.stringify(OPEN)) }
		return { head: unused, get: (key: string) => Promise.resolve(key === `__fabrika/ops/${SERVING}.json` ? state : null), put: unused, delete: unused }
	}

	function health(): Request {
		return new Request(`${ORIGIN}/healthz`, { headers: { [PROXY_SECRET_HEADER]: PROXY_SECRET } })
	}

	function tick(): Request {
		return new Request(`${ORIGIN}/`, { method: 'POST', headers: { [TICK_HEADER]: String(Date.now()), [PROXY_SECRET_HEADER]: PROXY_SECRET } })
	}

	function opsMigrate(): Request {
		return new Request(`${ORIGIN}/__fabrika/ops/migrate`, {
			method: 'POST',
			headers: {
				[PROXY_SECRET_HEADER]: PROXY_SECRET,
				[ENDPOINT_HEADER]: OPS_ENDPOINT,
				Authorization: `Bearer ${OPS_KEY}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ object: SERVING, generation: OPEN.generation }),
		})
	}

	interface Marked {
		readonly target: Target
		readonly object: FabrikaApplication
		readonly loads: { count: number }
		readonly runs: NotesWorld['runs']
		readonly alarms: (number | null)[]
	}

	/**
	 * The serving object of the fixture application, holding a backup of the same release half-loaded by the importer:
	 * `begin` and its one part, no verification. The dump holds a note.
	 */
	async function marked(): Promise<Marked> {
		const migrations = await applicationMigrations(FIXTURE_ROOT)
		const runs: NotesWorld['runs'] = []
		const served = fixtureApp({ runs })
		const loads = { count: 0 }
		createContractWorker(() => {
			loads.count++
			return Promise.resolve({ default: served.implementation })
		}, { migrations })
		const bundles = release(migrations)
		const objects = new Map<string, Uint8Array>()
		const source = objectStorage()
		await migrateSqlite(
			{ exec: (query, ...bindings) => source.storage.sql.exec(query, ...bindings), transactionSync: (fn) => source.storage.transactionSync(fn) },
			bundles,
		)
		source.database().run(`INSERT INTO notes (id, workspace_id, title, created_by, version) VALUES ('n1', 'w1', 'kept', 'u1', 1)`)
		writeDump(objects, source.storage)
		const target = freshTarget(objects, { migrations: bundles })
		await step(target, { ...scope(), step: 'begin' })
		expect((await step(target, { ...scope(), step: 'part', part: 1 })).status).toBe(200)

		const tokens = workloadTokensFor(served.implementation)
		const alarms: (number | null)[] = []
		const state: ApplicationState = {
			storage: {
				...target.storage,
				getAlarm: () => Promise.resolve(alarms.at(-1) ?? null),
				setAlarm: (time) => Promise.resolve(void alarms.push(time)),
				deleteAlarm: () => Promise.resolve(void alarms.push(null)),
			},
			blockConcurrencyWhile: (callback) => callback(),
			waitUntil: () => {},
		}
		const object = new FabrikaApplication(state, {
			...frameworkEnvFor(served.implementation),
			...served.variables,
			FABRIKA_PROXY_SECRET: PROXY_SECRET,
			IAM: { getJwks: () => keySource.getJwks(), mintFromKey: (input: { app: string; key: string }) => tokens.exchange(input) },
			[CLOUDFLARE_FILES_BINDING]: stateBucket(),
			[FABRIKA_OPS_KEY_DIGESTS]: formatOpsKeyDigests([opsKeyDigest(OPS_KEY)]),
			[FABRIKA_APPLICATION_OBJECT]: SERVING,
			[FABRIKA_APPLICATION_OBJECTS]: SERVING,
		})
		return { target, object, loads, runs, alarms }
	}

	/** Neither boots nor migrates: no request, tick, alarm or ops migrate loads the application or applies a file. */
	async function refusesEverything({ target, object, loads, runs, alarms }: Marked): Promise<void> {
		const ledger = () => one(target.storage, 'SELECT count(*) FROM fabrika_migrations')
		const before = ledger()

		const request = await object.fetch(health())
		expect(request.status).toBe(503)
		expect(request.headers.get('Retry-After')).not.toBeNull()
		expect((await object.fetch(tick())).status).toBe(204)
		await object.alarm()
		expect((await object.fetch(opsMigrate())).status).toBe(500)

		expect(loads.count).toBe(0)
		expect(runs).toEqual([])
		expect(alarms).toEqual([])
		expect(ledger()).toBe(before)
	}

	test('refuses a request, a tick, the alarm and a migration; once complete, ordinary traffic boots it', async () => {
		await keepingProcessEnvironment(async () => {
			const loaded = await marked()
			const { target, object, loads } = loaded
			await refusesEverything(loaded)

			expect((await verifyAll(target)).status).toBe(200)
			expect((await step(target, { ...scope(), step: 'complete' })).status).toBe(200)

			expect((await object.fetch(health())).status).toBe(200)
			expect(loads.count).toBe(1)
			expect(one(target.storage, 'SELECT title FROM notes')).toBe('kept')
		})
	})

	test('once discarded, ordinary traffic boots it from scratch', async () => {
		await keepingProcessEnvironment(async () => {
			const loaded = await marked()
			const { target, object, loads } = loaded
			await refusesEverything(loaded)

			expect((await step(target, { step: 'discard', object: TARGET, generation: GENERATION })).status).toBe(200)

			expect((await object.fetch(health())).status).toBe(200)
			expect(loads.count).toBe(1)
			expect(one(target.storage, 'SELECT count(*) FROM notes')).toBe(0)
		})
	})
})
