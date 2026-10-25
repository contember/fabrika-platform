// The importer (ADR-0070 §6): a consistent backup, written here with the wire's own encoders, loaded into a fresh object
// step by step as Control drives it. The object is bun:sqlite with workerd's synchronous KV kept in its `_cf_KV` table,
// so a step's marker commits or rolls back with its rows; the bucket is an in-memory R2 double that honours ranges.

import {
	encodeOpsDumpLine,
	encodeOpsDumpRow,
	foldOpsTableHash,
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
	type OpsImportRequest,
	type OpsPublishedState,
	parseOpsDataRefusal,
	parseOpsDumpManifest,
	parseOpsImportBeginAck,
	parseOpsImportCompleteAck,
	parseOpsImportDiscardAck,
	parseOpsImportLinkAck,
	parseOpsImportPartAck,
	parseOpsImportVerifyAck,
	parseOpsStaleRefusal,
	planOpsDump,
	readOpsDumpValue,
} from '@fabrika/auth-core'
import { SQLITE_FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations-sqlite'
import type { SqliteStorage } from '@fabrika/db/sqlite'
import { migrateSqlite, type SqliteMigrationBundle } from '@fabrika/db/sqlite-migrate'
import { Database as BunDatabase } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { bunSqliteStorage } from '../../../db/src/sqlite-bun'
import { describeDumpSchema, IMPORT_MARKER_KEY, importStep, type ImportStorage, type ImportTarget, serveImport } from '../cloudflare/import'
import { MaintenanceBarrier } from '../cloudflare/maintenance'
import type { OpsTarget } from '../cloudflare/ops'

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

/** A table's rows in keyset order, each its rowid then its columns, read with the producer's projection. */
function tableRows(storage: SqliteStorage, table: OpsDumpTablePlan): (readonly OpsDumpValue[])[] {
	const keyset = `"${table.keyset}"`
	const projections = table.columns.map((column) => opsDumpColumnProjection(column)).join(', ')
	const names = table.columns.flatMap((_, index) => [`t${index}`, `v${index}`])
	return storage.sql.exec(
		`WITH page(k, ${names.join(', ')}) AS (SELECT CAST(${keyset} AS TEXT), ${projections} FROM "${table.name}" ORDER BY ${keyset}) SELECT * FROM page`,
	).toArray().map((
		row,
	) => [readOpsDumpValue('integer', row['k']), ...table.columns.map((_, index) => readOpsDumpValue(row[`t${index}`], row[`v${index}`]))])
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
}

/** The backup of `storage` under `__fabrika/backups/`, as the producer writes it, into `objects`. */
function writeDump(objects: Map<string, Uint8Array>, storage: SqliteStorage, options: DumpOptions = {}): OpsDumpManifest {
	const consistent = options.consistent ?? true
	const source = options.source ?? SOURCE
	const lines = linesOf(storage).map((line) => encodeOpsDumpLine(line))
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

		const serving = freshTarget(objects, { serving: TARGET })
		await step(serving, { ...scope(), step: 'begin' })
		expect(await refusal(serving, { step: 'discard', object: TARGET, generation: GENERATION })).toEqual({ refused: 'serving_object', table: null })
		expect(serving.storage.kv.get(IMPORT_MARKER_KEY)).toBeDefined()
	})
})

describe('the schema description', () => {
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

		expect(tables.get('check')?.checked).toBe(false)
		expect(tables.get('checked')?.checked).toBe(true)
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
