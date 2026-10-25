// The producer of a dump (ADR-0070 §2–§4): the object's SQLite as bun:sqlite, the environment's bucket as Lopata's R2,
// whose multipart upload keeps a part per number and replaces one uploaded again. Lopata does not refuse parts of
// unequal size as R2 does; the fixed size is asserted on the answers and the stored bytes instead.

import {
	decodeOpsDumpLine,
	encodeOpsDumpRow,
	foldOpsTableHash,
	OPS_DATA_REFUSED_STATUS,
	OPS_DUMP_KEY,
	OPS_DUMP_PART_MAX_RAW_BYTES,
	OPS_DUMP_PART_MAX_ROWS,
	OPS_DUMP_PART_SIZE,
	OPS_EMPTY_TABLE_HASH,
	OPS_STALE_STATUS,
	type OpsDumpManifest,
	type OpsDumpValue,
	type OpsExportPartAck,
	type OpsExportRequest,
	type OpsExportScope,
	type OpsMode,
	parseOpsDataRefusal,
	parseOpsExportBeginAck,
	parseOpsExportCompleteAck,
	parseOpsExportPartAck,
	parseOpsStaleRefusal,
} from '@fabrika/auth-core'
import { SQLITE_FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations-sqlite'
import { migrateSqlite } from '@fabrika/db/sqlite-migrate'
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { createTestEnv, type TestEnv } from 'lopata/testing'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { bunSqliteStorage } from '../../../db/src/sqlite-bun'
import { method } from '../cloudflare/bindings'
import { type ExportSource, exportStep } from '../cloudflare/export'
import { MaintenanceBarrier } from '../cloudflare/maintenance'
import { r2FileObjectStore } from '../cloudflare/r2-files'

const CONTRACT_DIGEST = `sha256:${'c'.repeat(64)}`
const BOOKMARK = '0000000a-00000001-00004f6b-8a4c1f5d0e9b2a37'
const DUMP = '01920000-0000-7000-8000-000000000001'

const APP_SCHEMA = `
CREATE TABLE workspaces (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE folders (
	id INTEGER PRIMARY KEY,
	workspace_id INTEGER NOT NULL REFERENCES workspaces (id),
	parent_id INTEGER REFERENCES folders (id),
	title TEXT
);
CREATE INDEX folders_workspace ON folders (workspace_id);
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, payload BLOB);
CREATE TABLE loose (k TEXT, v);
`

/** The release's bundles, the application's with `later` migrations after its first. */
function bundles(...later: { readonly name: string; readonly sql: string }[]) {
	return [
		{ bundle: 'fabrika', migrations: SQLITE_FRAMEWORK_MIGRATIONS },
		{ bundle: 'app', migrations: [{ name: '0001_app.sql', sql: APP_SCHEMA }, ...later] },
	]
}

const envs: TestEnv[] = []
const directories: string[] = []
afterEach(() => {
	for (const env of envs.splice(0)) {
		env.dispose()
	}
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true })
	}
})

interface Harness {
	readonly database: Database
	/** A second connection that reads integers as bigints: the direct read the dump is compared with. */
	readonly reader: Database
	readonly source: ExportSource
	readonly barrier: MaintenanceBarrier
	readonly bucket: unknown
}

/** A migrated object whose barrier is `mode` at generation 1; `open` publishes nothing. */
async function harness(mode: OpsMode = 'read-only'): Promise<Harness> {
	const directory = mkdtempSync(join(tmpdir(), 'fabrika-export-'))
	directories.push(directory)
	const database = new Database(join(directory, 'object.sqlite'))
	const reader = new Database(join(directory, 'object.sqlite'), { readonly: true, safeIntegers: true })
	const storage = bunSqliteStorage(database)
	await migrateSqlite(
		{ exec: (query, ...bindings) => storage.sql.exec(query, ...bindings), transactionSync: (fn) => storage.transactionSync(fn) },
		bundles(),
	)
	// A trigger body reads as transaction control to the storage double, so the trigger is created past it.
	database.run('CREATE TRIGGER folders_touch AFTER UPDATE ON folders BEGIN SELECT 1; END')
	const testEnv = await createTestEnv({ bindings: { FILES: 'r2' } })
	envs.push(testEnv)
	const bucket = testEnv.env['FILES']
	const barrier = await MaintenanceBarrier.load({ read: () => Promise.resolve(null), put: () => Promise.resolve('v1') })
	if (mode !== 'open') {
		await barrier.transition({ generation: 1, mode })
	}
	const recovery = {
		getCurrentBookmark: () => Promise.resolve(BOOKMARK),
		getBookmarkForTime: () => Promise.reject(new Error('not called')),
		onNextSessionRestoreBookmark: () => Promise.reject(new Error('not called')),
		abort: () => {
			throw new Error('not called')
		},
	}
	return { database, reader, source: { storage, bucket, recovery, contractDigest: CONTRACT_DIGEST }, barrier, bucket }
}

const consistent: OpsExportScope = { object: 'application', generation: 1, consistent: true, dump: DUMP }
const diagnostic: OpsExportScope = { object: 'application', generation: null, consistent: false, dump: DUMP }

async function json(response: Response): Promise<unknown> {
	return JSON.parse(await response.text())
}

async function begin(target: Harness, scope: OpsExportScope): Promise<string> {
	const response = await exportStep(target.source, target.barrier, { ...scope, step: 'begin' })
	expect(response.status).toBe(200)
	const ack = parseOpsExportBeginAck(await json(response))
	if (ack === null) throw new Error('the begin answer does not parse')
	expect(ack.bookmark).toBe(BOOKMARK)
	return ack.uploadId
}

async function part(
	target: Harness,
	scope: OpsExportScope,
	uploadId: string,
	number: number,
	cursor: OpsExportPartAck['next'],
): Promise<OpsExportPartAck> {
	const response = await exportStep(target.source, target.barrier, { ...scope, step: 'part', uploadId, part: number, cursor })
	expect(response.status).toBe(200)
	const ack = parseOpsExportPartAck(await json(response))
	if (ack === null) throw new Error('the part answer does not parse')
	return ack
}

async function complete(target: Harness, scope: OpsExportScope, uploadId: string, acks: readonly OpsExportPartAck[]): Promise<OpsDumpManifest> {
	const response = await exportStep(target.source, target.barrier, {
		...scope,
		step: 'complete',
		uploadId,
		bookmark: BOOKMARK,
		parts: acks.map((ack) => ack.uploaded),
		tables: acks.flatMap((ack) => ack.tables),
	})
	expect(response.status).toBe(200)
	const ack = parseOpsExportCompleteAck(await json(response))
	if (ack === null) throw new Error('the complete answer does not parse')
	return ack.manifest
}

/** Every step as Control drives them: begin, the parts from cursor to cursor, complete. */
async function dump(target: Harness, scope: OpsExportScope): Promise<{ manifest: OpsDumpManifest; acks: OpsExportPartAck[] }> {
	const uploadId = await begin(target, scope)
	const acks: OpsExportPartAck[] = []
	let cursor: OpsExportPartAck['next'] = null
	do {
		const ack = await part(target, scope, uploadId, acks.length + 1, cursor)
		acks.push(ack)
		cursor = ack.next
	} while (cursor !== null)
	return { manifest: await complete(target, scope, uploadId, acks), acks }
}

async function stored(target: Harness, key: string): Promise<Uint8Array> {
	const object = await r2FileObjectStore(target.bucket)?.read(key)
	if (object === undefined || object === null) throw new Error(`nothing stored at ${key}`)
	return new Uint8Array(await new Response(object.body).arrayBuffer())
}

function lines(gzip: Uint8Array): string[] {
	const text = new TextDecoder().decode(gunzipSync(gzip))
	expect(text === '' || text.endsWith('\n')).toBe(true)
	return text === '' ? [] : text.slice(0, -1).split('\n')
}

function hex(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('hex').toUpperCase()
}

/** A value as bun:sqlite reads it with safe integers, encoded independently of the producer's projection. */
function directValue(value: unknown): OpsDumpValue {
	if (value === null) return null
	if (typeof value === 'bigint') return { type: 'integer', value: value.toString() }
	if (typeof value === 'number') return { type: 'real', value }
	if (typeof value === 'string') return { type: 'text', value: hex(new TextEncoder().encode(value)) }
	if (value instanceof Uint8Array) return { type: 'blob', value: hex(value) }
	throw new Error('an unexpected value')
}

/** A table read straight from the database: its rowid, then every column, in rowid order. */
function directRows(target: Harness, table: string): string[] {
	const rows = target.reader.query<Record<string, unknown>, []>(`select rowid as "__rowid", * from "${table}" order by rowid`).all()
	return rows.map((row) => encodeOpsDumpRow(Object.values(row).map(directValue)))
}

interface StoredPart {
	readonly lines: number
	/** The bytes the part decompresses to, and its longest line with the newline. */
	readonly raw: number
	readonly longest: number
}

/**
 * Dumps the object and checks the parts as stored: every one but the last exactly the fixed size, each decompressing
 * alone to whole lines, the object one gzip file, and `table` holding `rows` rows with the hash of a direct read.
 */
async function partsOf(target: Harness, table: string, rows: number): Promise<StoredPart[]> {
	const { manifest, acks } = await dump(target, consistent)
	expect(acks.slice(0, -1).map((ack) => ack.uploaded.size)).toEqual(acks.slice(0, -1).map(() => OPS_DUMP_PART_SIZE))
	expect(acks.at(-1)?.uploaded.size).toBeLessThanOrEqual(OPS_DUMP_PART_SIZE)
	const data = await stored(target, OPS_DUMP_KEY(consistent, 'data'))
	expect(data.byteLength).toBe(manifest.parts.reduce((sum, item) => sum + item.size, 0))
	const parts: StoredPart[] = []
	let offset = 0
	for (const item of manifest.parts) {
		const bytes = data.subarray(offset, offset + item.size)
		offset += item.size
		expect(createHash('sha256').update(bytes).digest('hex')).toBe(item.sha256)
		const own = lines(bytes)
		expect(own.map((line) => decodeOpsDumpLine(line))).not.toContain(null)
		parts.push({ lines: own.length, raw: gunzipSync(bytes).byteLength, longest: own.reduce((longest, line) => Math.max(longest, line.length + 1), 0) })
	}
	expect(lines(data).filter((line) => decodeOpsDumpLine(line)?.table === table)).toHaveLength(rows)
	const hash = foldOpsTableHash(OPS_EMPTY_TABLE_HASH, directRows(target, table))
	expect(manifest.tables.find((item) => item.name === table)).toEqual({ name: table, rows, hash })
	return parts
}

function seed(database: Database): void {
	database.run(`INSERT INTO workspaces (id, name) VALUES (1, 'one'), (2, 'Ünïcode ✓ 𝄞')`)
	database.run(`INSERT INTO folders (id, workspace_id, parent_id, title) VALUES (10, 1, NULL, 'root'), (11, 1, 10, 'child'), (12, 2, 11, NULL)`)
	database.run(`INSERT INTO events (payload) VALUES (x'00ff'), (NULL), (x'')`)
	database.run('DELETE FROM events WHERE id = 2')
	database.run(`INSERT INTO loose (k, v) VALUES ('int', 42), ('real', 2.5), ('text', '42'), ('blob', x'2a'), ('null', NULL)`)
}

describe('a consistent backup', () => {
	test("every table's count and hash match a direct read, and the data holds exactly those rows", async () => {
		const target = await harness()
		seed(target.database)
		const { manifest, acks } = await dump(target, consistent)

		expect(acks).toHaveLength(1)
		expect(manifest.consistent).toBe(true)
		expect(manifest.object).toBe('application')
		expect(manifest.bookmark).toBe(BOOKMARK)
		expect(manifest.contractDigest).toBe(CONTRACT_DIGEST)
		const names = manifest.tables.map((table) => table.name)
		for (const name of ['workspaces', 'folders', 'events', 'loose', 'sqlite_sequence', 'fabrika_migrations', 'fabrika_migration_bundles']) {
			expect(names).toContain(name)
		}
		expect(names.indexOf('workspaces')).toBeLessThan(names.indexOf('folders'))
		for (const table of manifest.tables) {
			const rows = directRows(target, table.name)
			expect({ name: table.name, rows: table.rows, hash: table.hash }).toEqual({
				name: table.name,
				rows: rows.length,
				hash: foldOpsTableHash(OPS_EMPTY_TABLE_HASH, rows),
			})
		}

		const data = await stored(target, OPS_DUMP_KEY(consistent, 'data'))
		expect(manifest.parts).toEqual([{ part: 1, size: data.byteLength, sha256: createHash('sha256').update(data).digest('hex') }])
		const decoded = lines(data).map((line) => decodeOpsDumpLine(line))
		for (const table of manifest.tables) {
			const rows = decoded.flatMap((line) => line !== null && line.table === table.name ? [encodeOpsDumpRow(line.row)] : [])
			expect(rows).toEqual(directRows(target, table.name))
		}
		expect(decoded).not.toContain(null)

		const ledger = target.database.query<{ bundle: string; name: string }, []>('select bundle, name from fabrika_migrations order by bundle, name')
			.all()
		expect(manifest.migrations.map(({ bundle, name }) => ({ bundle, name }))).toEqual(ledger)
		expect(manifest.ddl).toContainEqual(expect.objectContaining({ type: 'trigger', name: 'folders_touch', table: 'folders' }))
		expect(manifest.ddl).toContainEqual(expect.objectContaining({ type: 'index', name: 'folders_workspace', table: 'folders' }))
		expect(manifest.ddl.filter((entry) => entry.type === 'table').map((entry) => entry.name).sort()).toEqual([...names].sort())
		expect(JSON.parse(new TextDecoder().decode(await stored(target, OPS_DUMP_KEY(consistent, 'manifest'))))).toEqual(manifest)
	})

	test('a 2 MB row, an integer beyond 2^53 and text that is not UTF-8 survive byte for byte', async () => {
		const target = await harness()
		const large = randomBytes(2 * 1024 * 1024)
		target.database.query('INSERT INTO events (id, payload) VALUES (9007199254740993, ?)').run(large)
		target.database.run(`INSERT INTO loose (k, v) VALUES ('max', 9223372036854775807), ('min', -9223372036854775808)`)
		target.database.run(`INSERT INTO loose (k, v) VALUES ('x80', CAST(x'80' AS TEXT)), ('x81', CAST(x'81' AS TEXT))`)
		const { manifest } = await dump(target, consistent)

		const decoded = lines(await stored(target, OPS_DUMP_KEY(consistent, 'data'))).map((line) => decodeOpsDumpLine(line))
		const events = decoded.filter((line) => line?.table === 'events')
		expect(events).toEqual([{
			table: 'events',
			row: [{ type: 'integer', value: '9007199254740993' }, { type: 'integer', value: '9007199254740993' }, { type: 'blob', value: hex(large) }],
		}])
		const loose = decoded.flatMap((line) => line?.table === 'loose' ? [line.row.slice(1)] : [])
		expect(loose).toEqual([
			[{ type: 'text', value: hex(new TextEncoder().encode('max')) }, { type: 'integer', value: '9223372036854775807' }],
			[{ type: 'text', value: hex(new TextEncoder().encode('min')) }, { type: 'integer', value: '-9223372036854775808' }],
			[{ type: 'text', value: hex(new TextEncoder().encode('x80')) }, { type: 'text', value: '80' }],
			[{ type: 'text', value: hex(new TextEncoder().encode('x81')) }, { type: 'text', value: '81' }],
		])
		expect(manifest.tables.find((table) => table.name === 'events')?.rows).toBe(1)
	})

	test('a real crosses as its shortest round-trip text, never the 15 digits of cast(real as text)', async () => {
		const target = await harness()
		target.database.run(
			`INSERT INTO loose (k, v) VALUES ('a', 0.1), ('b', 0.30000000000000004), ('c', 1.7976931348623157e308), ('d', 5e-324), ('e', 9e999), ('f', -9e999), ('g', 2.0)`,
		)
		await dump(target, consistent)
		const decoded = lines(await stored(target, OPS_DUMP_KEY(consistent, 'data'))).map((line) => decodeOpsDumpLine(line))
		const reals = decoded.flatMap((line) => line?.table === 'loose' ? [line.row[2]] : [])
		expect(reals).toEqual([
			{ type: 'real', value: 0.1 },
			{ type: 'real', value: 0.30000000000000004 },
			{ type: 'real', value: 1.7976931348623157e308 },
			{ type: 'real', value: 5e-324 },
			{ type: 'real', value: Infinity },
			{ type: 'real', value: -Infinity },
			{ type: 'real', value: 2 },
		])
		const text = new TextDecoder().decode(gunzipSync(await stored(target, OPS_DUMP_KEY(consistent, 'data'))))
		expect(text).toContain('"r:0.30000000000000004"')
		expect(text).toContain('"r:5e-324"')
	})

	test('rows that do not compress: every part but the last is exactly the fixed size, the compressed bound cut the first', async () => {
		const target = await harness()
		const insert = target.database.query('INSERT INTO events (payload) VALUES (?)')
		for (let row = 0; row < 150; row++) {
			insert.run(randomBytes(64 * 1024))
		}
		const parts = await partsOf(target, 'events', 150)

		expect(parts.length).toBeGreaterThan(1)
		const [first] = parts
		if (first === undefined) throw new Error('no part')
		// Neither the uncompressed bound nor the row bound stopped the first part: one more line still fits both.
		expect(first.raw + first.longest).toBeLessThanOrEqual(OPS_DUMP_PART_MAX_RAW_BYTES)
		expect(first.lines).toBeLessThan(OPS_DUMP_PART_MAX_ROWS)
	}, 60_000)

	test('rows that compress well: a part stops at the row bound and is padded to the fixed size', async () => {
		const target = await harness()
		target.database.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 60000) INSERT INTO loose (k, v) SELECT 'k', i FROM n`)
		const parts = await partsOf(target, 'loose', 60_000)

		expect(parts.map((item) => item.lines)).toEqual([OPS_DUMP_PART_MAX_ROWS, expect.any(Number)])
		expect(parts[0]?.raw).toBeLessThan(OPS_DUMP_PART_SIZE)
	}, 60_000)

	test('a retried part step replaces its part', async () => {
		const target = await harness('open')
		seed(target.database)
		const uploadId = await begin(target, diagnostic)
		const first = await part(target, diagnostic, uploadId, 1, null)
		target.database.run(`UPDATE workspaces SET name = 'renamed' WHERE id = 1`)
		const retried = await part(target, diagnostic, uploadId, 1, null)
		expect(retried.uploaded.sha256).not.toBe(first.uploaded.sha256)
		const manifest = await complete(target, diagnostic, uploadId, [retried])

		const data = await stored(target, OPS_DUMP_KEY(diagnostic, 'data'))
		expect(manifest.parts).toEqual([{ part: 1, size: data.byteLength, sha256: retried.uploaded.sha256 }])
		const workspaces = lines(data).flatMap((line) => {
			const decoded = decodeOpsDumpLine(line)
			return decoded?.table === 'workspaces' ? [decoded.row[2]] : []
		})
		expect(workspaces).toContainEqual({ type: 'text', value: hex(new TextEncoder().encode('renamed')) })
		expect(workspaces).toHaveLength(2)
	})

	test('a retried complete, whose first answer was lost, finds the data in place and answers the manifest again', async () => {
		const target = await harness()
		seed(target.database)
		const uploadId = await begin(target, consistent)
		const ack = await part(target, consistent, uploadId, 1, null)
		const first = await complete(target, consistent, uploadId, [ack])
		const again = await complete(target, consistent, uploadId, [ack])
		expect({ ...again, createdAt: first.createdAt }).toEqual(first)
	})

	test('a row that alone breaks the uncompressed bound is refused, naming its table', async () => {
		const target = await harness()
		target.database.query('INSERT INTO events (payload) VALUES (?)').run(randomBytes(9 * 1024 * 1024))
		const uploadId = await begin(target, consistent)
		const response = await exportStep(target.source, target.barrier, { ...consistent, step: 'part', uploadId, part: 1, cursor: null })
		expect(response.status).toBe(OPS_DATA_REFUSED_STATUS)
		expect(parseOpsDataRefusal(await json(response))).toEqual({ refused: 'row_too_large', table: 'events' })
	})
})

describe('what the barrier admits', () => {
	test('an export while the object is open is a diagnostic one: marked not consistent, under exports/', async () => {
		const target = await harness('open')
		seed(target.database)
		const { manifest } = await dump(target, diagnostic)
		expect(manifest.consistent).toBe(false)
		expect(OPS_DUMP_KEY(diagnostic, 'data')).toStartWith('__fabrika/exports/')
		expect((await stored(target, OPS_DUMP_KEY(diagnostic, 'data'))).byteLength).toBe(manifest.parts[0]?.size ?? -1)
	})

	test('a consistent step is refused as wrong_mode while the object is open', async () => {
		const target = await harness('read-only')
		await target.barrier.transition({ generation: 2, mode: 'open' })
		const response = await exportStep(target.source, target.barrier, { ...consistent, generation: 2, step: 'begin' })
		expect(response.status).toBe(OPS_DATA_REFUSED_STATUS)
		expect(parseOpsDataRefusal(await json(response))).toEqual({ refused: 'wrong_mode', table: null })
	})

	test('a consistent step at another generation than the published one is stale', async () => {
		const target = await harness('inspect')
		const response = await exportStep(target.source, target.barrier, { ...consistent, generation: 2, step: 'begin' })
		expect(response.status).toBe(OPS_STALE_STATUS)
		expect(parseOpsStaleRefusal(await json(response))).toEqual({ refused: 'stale_generation', published: { generation: 1, mode: 'inspect' } })
	})

	test('an inspect object dumps consistently', async () => {
		const target = await harness('inspect')
		seed(target.database)
		const { manifest } = await dump(target, consistent)
		expect(manifest.consistent).toBe(true)
	})

	test('a schema the rule refuses is refused at begin, naming the table, before any upload', async () => {
		const target = await harness()
		target.database.run('CREATE TABLE keyed (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID')
		const response = await exportStep(target.source, target.barrier, { ...consistent, step: 'begin' })
		expect(response.status).toBe(OPS_DATA_REFUSED_STATUS)
		expect(parseOpsDataRefusal(await json(response))).toEqual({ refused: 'unsupported_schema', table: 'keyed' })
	})
})

/** Applies `sql` as the application's next migration through the barrier's migrate, at the published generation. */
async function migrateApp(target: Harness, generation: number, sql: string): Promise<void> {
	const { storage } = target.source
	const result = await target.barrier.migrate(generation, () =>
		migrateSqlite(
			{ exec: (query, ...bindings) => storage.sql.exec(query, ...bindings), transactionSync: (fn) => storage.transactionSync(fn) },
			bundles({ name: '0002_app.sql', sql }),
		))
	expect(result.kind).toBe('migrated')
}

function call(target: unknown, name: string): (...args: unknown[]) => unknown {
	const found = method(target, name)
	if (found === null) throw new Error(`the bucket has no ${name}`)
	return found
}

/** `bucket`, whose uploads signal `reached` when a part is about to be uploaded and upload it once `released` settles. */
function holdingParts(bucket: unknown, reached: () => void, released: Promise<void>): object {
	const passed = (name: string) => (...args: unknown[]) => call(bucket, name)(...args)
	return {
		get: passed('get'),
		put: passed('put'),
		head: passed('head'),
		createMultipartUpload: passed('createMultipartUpload'),
		resumeMultipartUpload: (...args: unknown[]) => {
			const upload = call(bucket, 'resumeMultipartUpload')(...args)
			return {
				uploadPart: async (...rest: unknown[]) => {
					reached()
					await released
					return await call(upload, 'uploadPart')(...rest)
				},
				complete: (...rest: unknown[]) => call(upload, 'complete')(...rest),
			}
		},
	}
}

async function refusal(response: Response): Promise<unknown> {
	expect(response.status).toBe(OPS_DATA_REFUSED_STATUS)
	return parseOpsDataRefusal(await json(response))
}

describe('a consistent dump holds one state of the database', () => {
	test('a migration between begin and the first part refuses the part', async () => {
		const target = await harness()
		seed(target.database)
		const uploadId = await begin(target, consistent)
		await migrateApp(target, 1, `UPDATE workspaces SET name = 'migrated'`)

		const response = await exportStep(target.source, target.barrier, { ...consistent, step: 'part', uploadId, part: 1, cursor: null })
		expect(await refusal(response)).toEqual({ refused: 'ledger_mismatch', table: null })
	})

	test('a migration between the last part and complete refuses complete', async () => {
		const target = await harness()
		seed(target.database)
		const uploadId = await begin(target, consistent)
		const ack = await part(target, consistent, uploadId, 1, null)
		await migrateApp(target, 1, `UPDATE folders SET title = 'migrated'`)

		const response = await exportStep(target.source, target.barrier, {
			...consistent,
			step: 'complete',
			uploadId,
			bookmark: BOOKMARK,
			parts: [ack.uploaded],
			tables: ack.tables,
		})
		expect(await refusal(response)).toEqual({ refused: 'ledger_mismatch', table: null })
	})

	test('a dump begun under another generation is refused, though no migration ran', async () => {
		const target = await harness()
		seed(target.database)
		const uploadId = await begin(target, consistent)
		await target.barrier.transition({ generation: 2, mode: 'open' })
		target.database.run(`UPDATE workspaces SET name = 'written while open'`)
		await target.barrier.transition({ generation: 3, mode: 'read-only' })

		const response = await exportStep(target.source, target.barrier, { ...consistent, generation: 3, step: 'part', uploadId, part: 1, cursor: null })
		expect(await refusal(response)).toEqual({ refused: 'ledger_mismatch', table: null })
	})

	test('a begin retried after a migration starts the dump again at the new state, which completes', async () => {
		const target = await harness()
		seed(target.database)
		await begin(target, consistent)
		await migrateApp(target, 1, `UPDATE workspaces SET name = 'migrated'`)
		const { manifest } = await dump(target, consistent)
		expect(manifest.migrations.map(({ bundle, name }) => `${bundle}/${name}`)).toContain('app/0002_app.sql')
	})
})

describe('a consistent step holds the barrier', () => {
	test('a transition waits for a consistent part under way, which answers at its own generation', async () => {
		const target = await harness()
		seed(target.database)
		const uploadId = await begin(target, consistent)
		const reached = Promise.withResolvers<void>()
		const released = Promise.withResolvers<void>()
		const source: ExportSource = { ...target.source, bucket: holdingParts(target.bucket, reached.resolve, released.promise) }
		const settled: string[] = []

		const step = exportStep(source, target.barrier, { ...consistent, step: 'part', uploadId, part: 1, cursor: null }).then((response) => {
			settled.push('part')
			return response
		})
		await reached.promise
		const transition = target.barrier.transition({ generation: 2, mode: 'open' }).then(() => settled.push('transition'))
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(settled).toEqual([])
		released.resolve()
		const response = await step
		await transition

		expect(settled).toEqual(['part', 'transition'])
		expect(response.status).toBe(200)
	})

	test.each(['begin', 'part', 'complete'] as const)(
		'a consistent %s queued behind a transition answers the published state as stale',
		async (name) => {
			const target = await harness()
			seed(target.database)
			const uploadId = await begin(target, consistent)
			const ack = await part(target, consistent, uploadId, 1, null)
			const requests: Record<typeof name, OpsExportRequest> = {
				begin: { ...consistent, step: 'begin' },
				part: { ...consistent, step: 'part', uploadId, part: 1, cursor: null },
				complete: { ...consistent, step: 'complete', uploadId, bookmark: BOOKMARK, parts: [ack.uploaded], tables: ack.tables },
			}

			const transition = target.barrier.transition({ generation: 2, mode: 'read-only' })
			const response = await exportStep(target.source, target.barrier, requests[name])
			await transition

			expect(response.status).toBe(OPS_STALE_STATUS)
			expect(parseOpsStaleRefusal(await json(response))).toEqual({ refused: 'stale_generation', published: { generation: 2, mode: 'read-only' } })
		},
	)
})

describe('reading a table', () => {
	test('a table named page, as the reading query names its own rows, dumps', async () => {
		const target = await harness()
		target.database.run(`CREATE TABLE page (id INTEGER PRIMARY KEY, k TEXT, r REAL)`)
		target.database.run(`INSERT INTO page (k, r) VALUES ('a', 1.5), ('b', NULL)`)
		const { manifest } = await dump(target, consistent)
		const rows = directRows(target, 'page')
		expect(manifest.tables.find((table) => table.name === 'page')).toEqual({
			name: 'page',
			rows: 2,
			hash: foldOpsTableHash(OPS_EMPTY_TABLE_HASH, rows),
		})
	})
})

describe('the schema rule reads clauses as the importer does', () => {
	test('a CHECK written with a comment before its parenthesis marks the table checked', async () => {
		const target = await harness()
		target.database.run('CREATE TABLE tree (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES tree (id), CHECK/*c*/(parent IS NOT NULL OR id = 1))')
		const response = await exportStep(target.source, target.barrier, { ...consistent, step: 'begin' })
		expect(await refusal(response)).toEqual({ refused: 'unsupported_schema', table: 'tree' })
	})

	test('INITIALLY DEFERRED written with a comment between its words is refused', async () => {
		const target = await harness()
		target.database.run('CREATE TABLE later (id INTEGER PRIMARY KEY, workspace INTEGER REFERENCES workspaces (id) DEFERRABLE INITIALLY/*c*/DEFERRED)')
		const response = await exportStep(target.source, target.barrier, { ...consistent, step: 'begin' })
		expect(await refusal(response)).toEqual({ refused: 'unsupported_schema', table: 'later' })
	})

	test('the words inside a literal or a comment declare nothing', async () => {
		const target = await harness()
		target.database.run(`CREATE TABLE notes (
			id INTEGER PRIMARY KEY,
			parent INTEGER REFERENCES notes (id), -- check (parent) is not declared
			workspace INTEGER REFERENCES workspaces (id),
			body TEXT DEFAULT 'initially deferred, check (x)'
		)`)
		target.database.run(`INSERT INTO notes (id, parent, workspace) VALUES (1, NULL, NULL), (2, 1, NULL)`)
		const { manifest } = await dump(target, consistent)
		expect(manifest.tables.find((table) => table.name === 'notes')?.rows).toBe(2)
	})
})
