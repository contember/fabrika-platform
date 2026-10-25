// One step of a dump of the object's database (ADR-0070 §2): the ops operation `export`, served before the application
// boots. It reads `sqlite_schema` and the tables directly, so it also dumps a database that cannot boot. Control's
// operation record holds the upload id, the cursor and the parts; the object keeps only a consistent dump's begun state.

import {
	encodeOpsDumpLine,
	foldOpsTableHash,
	OPS_DATA_REFUSED_STATUS,
	OPS_DUMP_FORMAT,
	OPS_DUMP_KEY,
	OPS_DUMP_PAGE_ROWS,
	OPS_DUMP_PART_MAX_RAW_BYTES,
	OPS_DUMP_PART_MAX_ROWS,
	OPS_DUMP_PART_SIZE,
	OPS_EMPTY_TABLE_HASH,
	OPS_STALE_STATUS,
	type OpsDataRefusal,
	opsDumpColumnProjection,
	type OpsDumpCursor,
	type OpsDumpSchemaEntry,
	type OpsDumpTable,
	type OpsDumpTablePlan,
	type OpsDumpValue,
	opsDumpValueBinding,
	type OpsExportBegin,
	type OpsExportComplete,
	type OpsExportPart,
	type OpsExportRequest,
	type OpsExportScope,
	type OpsPublishedState,
	type OpsStaleRefusal,
	parseOpsExportBeginAck,
	parseOpsExportCompleteAck,
	parseOpsExportPartAck,
	planOpsDump,
	readOpsDumpValue,
	sha256Hex,
} from '@fabrika/auth-core'
import type { SqliteValue } from '@fabrika/db/sqlite'
import { crc32, deflateRawSync } from 'node:zlib'
import appPackage from '../../package.json' with { type: 'json' }
import { jsonResponse } from '../errors.js'
import { method } from './bindings.js'
import { describeDumpSchema, importInProgress } from './import.js'
import type { MaintenanceBarrier } from './maintenance.js'
import type { OpsTarget } from './ops.js'

/** One step of a dump of the object's database (ADR-0070). */
export async function serveExport(target: OpsTarget, barrier: MaintenanceBarrier, step: OpsExportRequest): Promise<Response> {
	return await exportStep(target, barrier, step)
}

/** What an export step reads: the object's storage, bucket and bookmarks, and the digest of the contract it was deployed with. */
export interface ExportSource extends Pick<OpsTarget, 'storage' | 'bucket' | 'recovery'> {
	/** `FABRIKA_CONTRACT_DIGEST`, which the manifest records. */
	readonly contractDigest: string | null
}

type Storage = ExportSource['storage']

/**
 * One step of a dump. A diagnostic step runs in any mode. A consistent one runs in the barrier's turn, only at the
 * published generation, never while the object is `open` or holds an import marker, so no transition and no migration
 * falls inside it; past `begin` it refuses a database whose state is not the one its `begin` saw.
 */
export async function exportStep(source: ExportSource, barrier: MaintenanceBarrier, step: OpsExportRequest): Promise<Response> {
	if (!step.consistent) {
		return await run(source, step)
	}
	const { generation } = step
	if (generation === null) {
		throw new Error('a consistent export step carries its generation; the wire parser requires it')
	}
	const result = await barrier.step(generation, async (mode) => ({
		value: mode === 'open' ? dataRefusal({ refused: 'wrong_mode', table: null }) : await runConsistent(source, step, generation),
		holdUntil: null,
	}))
	return result.kind === 'ran' ? result.value : staleRefusal(result.published)
}

/** Runs `step`; `state` is what a consistent dump's first `begin` records, `null` for a diagnostic one. */
async function run(source: ExportSource, step: OpsExportRequest, state: string | null = null): Promise<Response> {
	switch (step.step) {
		case 'begin':
			return await begin(source, step, state)
		case 'part':
			return await part(source, step)
		case 'complete':
			return await complete(source, step)
	}
}

/**
 * The first `begin` of a dump records the state it saw with its upload and bookmark, once; a retried one replays that
 * record, and every later step must carry its upload at that state. A migration runs at the published generation, so
 * the generation alone would not show one between two steps. A storage without the synchronous KV holds no import.
 */
async function runConsistent(source: ExportSource, step: OpsExportRequest, generation: number): Promise<Response> {
	const { kv } = source.storage
	if (kv !== undefined && importInProgress({ kv })) {
		return dataRefusal({ refused: 'wrong_mode', table: null })
	}
	const state = dumpState(source.storage, generation)
	const begun = await readBegun(source.bucket, step)
	if (step.step === 'begin') {
		return begun === null ? await run(source, step, state) : replayed(begun, state)
	}
	if (begun?.state !== state || begun.uploadId !== step.uploadId || (step.step === 'complete' && step.bookmark !== begun.bookmark)) {
		return dataRefusal({ refused: 'ledger_mismatch', table: null })
	}
	return await run(source, step)
}

/** A retried `begin`: the first one's answer at the state it recorded, refused at any other. */
function replayed(begun: Begun, state: string): Response {
	if (begun.state !== state) {
		return dataRefusal({ refused: 'ledger_mismatch', table: null })
	}
	return answer(parseOpsExportBeginAck({ step: 'begin', uploadId: begun.uploadId, bookmark: begun.bookmark }), 'begin')
}

function staleRefusal(published: OpsPublishedState | null): Response {
	const stale: OpsStaleRefusal = { refused: 'stale_generation', published }
	return jsonResponse(stale, OPS_STALE_STATUS)
}

function dataRefusal(refusal: OpsDataRefusal): Response {
	return jsonResponse(refusal, OPS_DATA_REFUSED_STATUS)
}

/**
 * Plans the dump, starts the multipart upload of its data and answers the object's bookmark. A consistent dump records
 * its `state` with both, only if nothing is recorded yet.
 */
async function begin(source: ExportSource, step: OpsExportBegin, state: string | null): Promise<Response> {
	const plan = planOpsDump(describeDumpSchema(source.storage))
	if ('refused' in plan) {
		return dataRefusal(plan)
	}
	if (source.recovery === null) {
		throw new Error("the object's storage has no bookmarks; a Durable Object's storage has them")
	}
	const bookmark = await source.recovery.getCurrentBookmark()
	const upload: unknown = await call(source.bucket, 'createMultipartUpload')(dataKey(step), { httpMetadata: { contentType: 'application/gzip' } })
	const ack = parseOpsExportBeginAck({
		step: 'begin',
		uploadId: typeof upload === 'object' && upload !== null ? Reflect.get(upload, 'uploadId') : undefined,
		bookmark,
	})
	if (ack === null || state === null) {
		return answer(ack, 'begin')
	}
	const begun: Begun = { state, uploadId: ack.uploadId, bookmark: ack.bookmark }
	const options = { httpMetadata: { contentType: 'application/json' }, onlyIf: { etagDoesNotMatch: '*' } }
	if ((await call(source.bucket, 'put')(begunKey(step), JSON.stringify(begun), options)) === null) {
		// Another begin recorded the dump first; its upload is the dump's, and this one is left to the lifecycle.
		const recorded = await readBegun(source.bucket, step)
		if (recorded === null) {
			throw new Error("R2 refused to record a dump's begin, yet holds no record of it")
		}
		return replayed(recorded, state)
	}
	return answer(ack, 'begin')
}

/** Fills part `n` from its cursor: whole rows while every bound holds, one gzip member padded to the fixed size but the last. */
async function part(source: ExportSource, step: OpsExportPart): Promise<Response> {
	const plan = planOpsDump(describeDumpSchema(source.storage))
	if ('refused' in plan) {
		return dataRefusal(plan)
	}
	const [first] = plan.tables
	const start = step.cursor ?? (first === undefined ? null : fresh(first.name))
	const index = start === null ? plan.tables.length : plan.tables.findIndex((table) => table.name === start.table)
	if (start !== null && index < 0) {
		return dataRefusal({ refused: 'schema_mismatch', table: start.table })
	}
	const collected = collect(source.storage, plan.tables.slice(index), start)
	if ('refused' in collected) {
		return dataRefusal(collected)
	}
	const filled = fill(collected)
	if ('refused' in filled) {
		return dataRefusal(filled)
	}
	return await uploadPart(source, step, filled, start === null ? { finished: [], next: null } : settle(start, collected, filled.rows))
}

/** Completes the upload with the parts Control recorded, writes the manifest beside the data and answers it. */
async function complete(source: ExportSource, step: OpsExportComplete): Promise<Response> {
	const { storage } = source
	const plan = planOpsDump(describeDumpSchema(storage))
	if ('refused' in plan) {
		return dataRefusal(plan)
	}
	const mismatch = plan.tables.find((table, index) => step.tables[index]?.name !== table.name)
	if (mismatch !== undefined || step.tables.length !== plan.tables.length) {
		return dataRefusal({ refused: 'schema_mismatch', table: mismatch?.name ?? null })
	}
	const ddl = schemaEntries(storage)
	const migrations = migrationLedger(storage)
	const key = dataKey(step)
	const upload: unknown = await call(source.bucket, 'resumeMultipartUpload')(key, step.uploadId)
	try {
		await call(upload, 'complete')(step.parts.map((uploaded) => ({ partNumber: uploaded.part, etag: uploaded.etag })))
	} catch (error) {
		// A retried complete whose first answer was lost finds the upload gone and the data in place.
		const head: unknown = await call(source.bucket, 'head')(key)
		const size = typeof head === 'object' && head !== null ? Reflect.get(head, 'size') : undefined
		if (size !== step.parts.reduce((sum, uploaded) => sum + uploaded.size, 0)) {
			throw error
		}
	}
	const manifest = {
		format: OPS_DUMP_FORMAT,
		dump: step.dump,
		object: step.object,
		consistent: step.consistent,
		createdAt: new Date().toISOString(),
		bookmark: step.bookmark,
		release: appPackage.version,
		contractDigest: source.contractDigest,
		ddl,
		migrations,
		tables: step.tables,
		parts: step.parts.map(({ part, size, sha256 }) => ({ part, size, sha256 })),
	}
	const ack = parseOpsExportCompleteAck({ step: 'complete', manifest })
	if (ack === null) {
		throw new Error("the dump's manifest does not parse as the wire's manifest")
	}
	await call(source.bucket, 'put')(OPS_DUMP_KEY(step, 'manifest'), JSON.stringify(ack.manifest), { httpMetadata: { contentType: 'application/json' } })
	return jsonResponse(ack, 200)
}

async function uploadPart(source: ExportSource, step: OpsExportPart, part: Filled, settled: Settled): Promise<Response> {
	const member = gzipMember(part)
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', member))
	const sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
	const upload: unknown = await call(source.bucket, 'resumeMultipartUpload')(dataKey(step), step.uploadId)
	// R2 keeps one part per number, so a retried step replaces the part it uploaded before.
	const uploaded: unknown = await call(upload, 'uploadPart')(step.part, member)
	const etag = typeof uploaded === 'object' && uploaded !== null ? Reflect.get(uploaded, 'etag') : undefined
	return answer(
		parseOpsExportPartAck({
			step: 'part',
			uploaded: { part: step.part, size: member.byteLength, sha256, etag },
			tables: settled.finished,
			next: settled.next,
		}),
		'part',
	)
}

function dataKey(scope: OpsExportScope): string {
	return OPS_DUMP_KEY(scope, 'data')
}

/** What a consistent dump's first `begin` saw and answered: the digest of the database's state, its upload and bookmark. */
interface Begun {
	readonly state: string
	readonly uploadId: string
	readonly bookmark: string
}

/** `begun` in the dump's own prefix, which the bucket's lifecycle expires with the dump. */
function begunKey(scope: OpsExportScope): string {
	const manifest = OPS_DUMP_KEY(scope, 'manifest')
	return `${manifest.slice(0, manifest.lastIndexOf('/'))}/begun`
}

/** What the dump's first `begin` recorded, `null` when nothing is recorded; a record that does not parse fails the step. */
async function readBegun(bucket: unknown, scope: OpsExportScope): Promise<Begun | null> {
	const stored: unknown = await call(bucket, 'get')(begunKey(scope))
	if (stored === null) {
		return null
	}
	const body: unknown = await call(stored, 'text')()
	const begun = typeof body === 'string' ? parseBegun(body) : null
	if (begun === null) {
		throw new Error("the dump's begin record does not parse")
	}
	return begun
}

function parseBegun(text: string): Begun | null {
	let value: unknown
	try {
		value = JSON.parse(text)
	} catch {
		return null
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length !== 3) {
		return null
	}
	const state: unknown = Reflect.get(value, 'state')
	const uploadId: unknown = Reflect.get(value, 'uploadId')
	const bookmark: unknown = Reflect.get(value, 'bookmark')
	return typeof state === 'string' && typeof uploadId === 'string' && typeof bookmark === 'string' ? { state, uploadId, bookmark } : null
}

function answer<T>(ack: T | null, step: string): Response {
	if (ack === null) {
		throw new Error(`the export ${step} answer does not parse as the wire's answer`)
	}
	return jsonResponse(ack, 200)
}

function call(target: unknown, name: string): (...args: unknown[]) => unknown {
	const found = method(target, name)
	if (found === null) {
		throw new Error(`the FABRIKA_FILES binding has no ${name}; dumps live in the environment's bucket`)
	}
	return found
}

// Reading: keyset pages of whole rows within the part's bounds.

function fresh(table: string): OpsDumpCursor {
	return { table, after: null, rows: 0, hash: OPS_EMPTY_TABLE_HASH }
}

/** A row read for the part: its table, its rowid, and its line with the newline, where its canonical encoding starts at `rowStart`. */
interface ReadRow {
	readonly kind: 'row'
	readonly table: string
	readonly rowid: string
	readonly line: Uint8Array
	readonly rowStart: number
}

/** A table read to its end. */
interface TableEnd {
	readonly kind: 'end'
	readonly table: string
}

interface Collected {
	/** Rows and table ends in reading order: a table's end follows its last row. */
	readonly items: readonly (ReadRow | TableEnd)[]
	/** The table of the row the part could not take, `null` once every table was read. */
	readonly breaker: string | null
}

/** `JSON.stringify` adds at most this to a value's text: the quotes, the tag and the separator. */
const VALUE_OVERHEAD = 8
/** A value that is no text or blob is at most this long: `-1.7976931348623157e+308`, `-9223372036854775808`, `null`. */
const SCALAR_BYTES = 32

/**
 * Reads whole rows of `tables`, from the cursor's position in the first, while the part holds at most
 * `OPS_DUMP_PART_MAX_ROWS` rows and its lines at most `OPS_DUMP_PART_MAX_RAW_BYTES`. A page first asks how long each
 * row's line is at most, then reads the rows that fit and the one after them, so a page of large rows never sits in
 * memory whole.
 */
function collect(storage: Storage, tables: readonly OpsDumpTablePlan[], start: OpsDumpCursor | null): Collected | OpsDataRefusal {
	const items: (ReadRow | TableEnd)[] = []
	const encoder = new TextEncoder()
	let rows = 0
	let raw = 0
	for (const table of tables) {
		// A line is `{"table":"<name>","row":<row>}` (ADR-0070 §3), all ASCII: its row starts where an empty row's `[]}` does.
		const rowStart = encodeOpsDumpLine({ table: table.name, row: [] }).length - '[]}'.length
		let after = table.name === start?.table ? start.after : null
		for (;;) {
			const bounds = rowBounds(storage, table, after)
			let fitting = 0
			let budget = OPS_DUMP_PART_MAX_RAW_BYTES - raw
			for (const bound of bounds) {
				if (rows + fitting >= OPS_DUMP_PART_MAX_ROWS || bound > budget) {
					break
				}
				budget -= bound
				fitting++
			}
			const page = bounds.length === 0 ? [] : readRows(storage, table, after, Math.min(fitting + 1, bounds.length))
			for (const { rowid, values } of page) {
				const line = encoder.encode(`${encodeOpsDumpLine({ table: table.name, row: values })}\n`)
				if (rows + 1 > OPS_DUMP_PART_MAX_ROWS || raw + line.byteLength > OPS_DUMP_PART_MAX_RAW_BYTES) {
					return rows === 0 ? { refused: 'row_too_large', table: table.name } : { items, breaker: table.name }
				}
				items.push({ kind: 'row', table: table.name, rowid, line, rowStart })
				after = rowid
				rows++
				raw += line.byteLength
			}
			if (page.length === bounds.length && bounds.length < OPS_DUMP_PAGE_ROWS) {
				items.push({ kind: 'end', table: table.name })
				break
			}
		}
	}
	return { items, breaker: null }
}

/** The keyset condition: the rowid after the cursor's, written back as the integer it was read as. */
function keysetCondition(table: OpsDumpTablePlan, after: string | null): { readonly sql: string; readonly bindings: SqliteValue[] } {
	if (after === null) {
		return { sql: '', bindings: [] }
	}
	const binding = opsDumpValueBinding({ type: 'integer', value: after })
	if (typeof binding.param !== 'string') {
		throw new Error('a rowid binds as its decimal text')
	}
	return { sql: `WHERE ${quoted(table.keyset)} > ${binding.sql}`, bindings: [binding.param] }
}

/** For each of the next rows of a page, at most how many bytes its line takes. */
function rowBounds(storage: Storage, table: OpsDumpTablePlan, after: string | null): number[] {
	const sizes = table.columns.map((column) => {
		const c = quoted(column)
		return `CASE typeof(${c}) WHEN 'text' THEN 2 * length(CAST(${c} AS BLOB)) WHEN 'blob' THEN 2 * length(${c}) ELSE ${SCALAR_BYTES} END`
	})
	const fixed = `{"table":"${table.name}","row":[]}\n`.length + (table.columns.length + 1) * VALUE_OVERHEAD + SCALAR_BYTES
	const condition = keysetCondition(table, after)
	const query = `SELECT ${[String(fixed), ...sizes].join(' + ')} AS bound FROM ${source(table)} ${condition.sql}
		ORDER BY ${quoted(table.keyset)} LIMIT ${OPS_DUMP_PAGE_ROWS}`
	return storage.sql.exec(query, ...condition.bindings).toArray().map((row) => {
		const bound = row['bound']
		if (typeof bound !== 'number') {
			throw new Error("a row's bound reads as a number")
		}
		return bound
	})
}

interface ReadValues {
	readonly rowid: string
	readonly values: readonly OpsDumpValue[]
}

/**
 * The next `limit` rows: each its rowid as decimal text, then the rowid and every column through the wire's projection.
 * The column-name list of the common table expression names every result column, which an expression alone does not.
 */
function readRows(storage: Storage, table: OpsDumpTablePlan, after: string | null, limit: number): ReadValues[] {
	const keyset = quoted(table.keyset)
	const names = ['k', 'r', ...table.columns.flatMap((_, index) => [`t${index}`, `v${index}`])]
	const projections = [keyset, `CAST(${keyset} AS TEXT)`, ...table.columns.map(opsDumpColumnProjection)]
	const condition = keysetCondition(table, after)
	const query = `WITH page(${names.join(', ')}) AS (SELECT ${projections.join(', ')} FROM ${source(table)} ${condition.sql}
		ORDER BY ${keyset} LIMIT ${limit}) SELECT ${names.slice(1).join(', ')} FROM page ORDER BY k`
	return storage.sql.exec(query, ...condition.bindings).toArray().map((row) => {
		const rowid = readOpsDumpValue('integer', row['r'])
		if (rowid === null || rowid.type !== 'integer') {
			throw new Error('a rowid reads as an integer')
		}
		return { rowid: rowid.value, values: [rowid, ...table.columns.map((_, index) => readOpsDumpValue(row[`t${index}`], row[`v${index}`]))] }
	})
}

/** The tables a part finished, with their counts and hashes, and the cursor where the next part starts. */
interface Settled {
	readonly finished: readonly OpsDumpTable[]
	readonly next: OpsDumpCursor | null
}

/** Folds the part's first `count` rows into their tables' hashes from `start`; only the rows the part keeps are hashed. */
function settle(start: OpsDumpCursor, collected: Collected, count: number): Settled {
	const decoder = new TextDecoder()
	const finished: OpsDumpTable[] = []
	const at = (cursor: OpsDumpCursor, table: string) => cursor.table === table ? cursor : fresh(table)
	let cursor = start
	let kept = 0
	for (const item of collected.items) {
		if (item.kind === 'end') {
			const { rows, hash } = at(cursor, item.table)
			finished.push({ name: item.table, rows, hash })
		} else if (kept === count) {
			return { finished, next: at(cursor, item.table) }
		} else {
			const row = decoder.decode(item.line.subarray(item.rowStart, item.line.byteLength - '}\n'.length))
			const before = at(cursor, item.table)
			cursor = { table: item.table, after: item.rowid, rows: before.rows + 1, hash: foldOpsTableHash(before.hash, [row]) }
			kept++
		}
	}
	return { finished, next: collected.breaker === null ? null : at(cursor, collected.breaker) }
}

// Writing: one gzip member per part.

/** The first `rows` lines of a part and their deflate stream; `last` when nothing follows them. */
interface Filled {
	readonly rows: number
	readonly raw: Uint8Array
	readonly deflate: Uint8Array
	readonly last: boolean
}

/**
 * The rows that fit one part compressed: all of them when they do, else the longest prefix that does. A row that does
 * not fit alone is refused.
 */
function fill(collected: Collected): Filled | OpsDataRefusal {
	const lines = collected.items.flatMap((item) => item.kind === 'row' ? [item.line] : [])
	const all = compressed(lines, lines.length, collected.breaker === null)
	if (memberSize(all) <= OPS_DUMP_PART_SIZE) {
		return all
	}
	// The compressed size grows with the prefix: the longest prefix that fits is found by interpolation and halving.
	const target = OPS_DUMP_PART_SIZE - PADDED_OVERHEAD
	let fits: Filled | null = null
	let breaksRows = lines.length
	let breaksSize = all.deflate.byteLength
	let halve = false
	while (breaksRows - (fits?.rows ?? 0) > 1) {
		const fitsRows = fits?.rows ?? 0
		const fitsSize = fits?.deflate.byteLength ?? 0
		const width = breaksRows - fitsRows
		const interpolated = fitsRows + Math.floor((width * (target - fitsSize)) / Math.max(1, breaksSize - fitsSize))
		const guess = halve ? fitsRows + Math.floor(width / 2) : Math.min(breaksRows - 1, Math.max(fitsRows + 1, interpolated))
		const candidate = compressed(lines, guess, false)
		if (candidate.deflate.byteLength <= target) {
			fits = candidate
		} else {
			breaksRows = guess
			breaksSize = candidate.deflate.byteLength
		}
		halve = breaksRows - (fits?.rows ?? 0) > width / 2
	}
	if (fits === null) {
		const first = collected.items.find((item) => item.kind === 'row')
		return { refused: 'row_too_large', table: first?.table ?? null }
	}
	return fits
}

function compressed(lines: readonly Uint8Array[], rows: number, last: boolean): Filled {
	const raw = new Uint8Array(lines.slice(0, rows).reduce((sum, line) => sum + line.byteLength, 0))
	let offset = 0
	for (const line of lines.slice(0, rows)) {
		raw.set(line, offset)
		offset += line.byteLength
	}
	return { rows, raw, deflate: deflateRawSync(raw), last }
}

/** The gzip header (RFC 1952) without a name or a time, and the trailer; a padded member adds its comment's terminator. */
const GZIP_HEADER_BYTES = 10
const GZIP_TRAILER_BYTES = 8
const PADDED_OVERHEAD = GZIP_HEADER_BYTES + 1 + GZIP_TRAILER_BYTES
const FCOMMENT = 0x10

function memberSize(part: Filled): number {
	return (part.last ? GZIP_HEADER_BYTES + GZIP_TRAILER_BYTES : PADDED_OVERHEAD) + part.deflate.byteLength
}

/** One gzip member of the part; every part but the last is padded to exactly the part size with spaces in its comment. */
function gzipMember(part: Filled): Uint8Array<ArrayBuffer> {
	const member = new Uint8Array(part.last ? memberSize(part) : OPS_DUMP_PART_SIZE)
	member.set([0x1F, 0x8B, 0x08, part.last ? 0 : FCOMMENT, 0, 0, 0, 0, 0, 0xFF])
	let offset = GZIP_HEADER_BYTES
	if (!part.last) {
		const comment = OPS_DUMP_PART_SIZE - memberSize(part)
		member.fill(0x20, offset, offset + comment)
		offset += comment + 1
	}
	member.set(part.deflate, offset)
	offset += part.deflate.byteLength
	const trailer = new DataView(member.buffer, offset, GZIP_TRAILER_BYTES)
	trailer.setUint32(0, crc32(part.raw), true)
	trailer.setUint32(4, part.raw.byteLength >>> 0, true)
	return member
}

// The schema and the migration ledger: what `sqlite_schema` and the ledger's two tables say, for the manifest and for
// the state a consistent dump begins at. The wire's schema rule reads the importer's description of the PRAGMAs.

/** SQLite's own tables but `sqlite_sequence`, and Cloudflare's `_cf_` tables, are no table of the dump. */
function dumped(name: string): boolean {
	return name === 'sqlite_sequence' || !(name.startsWith('sqlite_') || name.startsWith('_cf_'))
}

function rowsOf(storage: Storage, query: string, ...bindings: SqliteValue[]): Record<string, SqliteValue>[] {
	return storage.sql.exec(query, ...bindings).toArray()
}

function text(value: SqliteValue | undefined): string {
	if (typeof value !== 'string') {
		throw new Error('the schema answered a value that is not text')
	}
	return value
}

const SCHEMA_TYPES: readonly OpsDumpSchemaEntry['type'][] = ['table', 'index', 'trigger', 'view']

/** Every `sqlite_schema` entry with SQL of a dumped table, ordered by type and name, which no history changes. */
function schemaEntries(storage: Storage): OpsDumpSchemaEntry[] {
	const entries: OpsDumpSchemaEntry[] = []
	for (const row of rowsOf(storage, 'SELECT type, name, tbl_name, sql FROM main.sqlite_schema WHERE sql IS NOT NULL')) {
		const type = SCHEMA_TYPES.find((candidate) => candidate === row['type'])
		const name = text(row['name'])
		const table = text(row['tbl_name'])
		if (type !== undefined && dumped(name) && dumped(table)) {
			entries.push({ type, name, table, sql: text(row['sql']) })
		}
	}
	const order = (entry: OpsDumpSchemaEntry) => `${entry.type}\n${entry.name}`
	return entries.sort((left, right) => order(left) < order(right) ? -1 : order(left) > order(right) ? 1 : 0)
}

/** The ledger `@fabrika/db/sqlite-migrate` keeps for both bundles; none in a database restored to before it existed. */
function migrationLedger(storage: Storage): Record<string, SqliteValue>[] {
	return holdsTable(storage, 'fabrika_migrations')
		? rowsOf(storage, 'SELECT bundle, name, checksum, applied_at AS appliedAt FROM main.fabrika_migrations ORDER BY bundle, name')
		: []
}

/** The digest each bundle's last applied file recorded, which the runner may write without applying a file. */
function bundleDigests(storage: Storage): Record<string, SqliteValue>[] {
	return holdsTable(storage, 'fabrika_migration_bundles')
		? rowsOf(storage, 'SELECT bundle, digest FROM main.fabrika_migration_bundles ORDER BY bundle')
		: []
}

function holdsTable(storage: Storage, name: string): boolean {
	return rowsOf(storage, `SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = ?`, name).length > 0
}

/**
 * The digest of what a consistent dump's steps must all see: the generation, the DDL and both ledger tables. At one
 * generation outside `open` a migration is what writes, and the runner records each of its writes in one of them.
 */
function dumpState(storage: Storage, generation: number): string {
	return sha256Hex(JSON.stringify([generation, schemaEntries(storage), migrationLedger(storage), bundleDigests(storage)]))
}

/** A table as a query reads it: qualified, so no common table expression of the query shadows it. */
function source(table: OpsDumpTablePlan): string {
	return `main.${quoted(table.name)}`
}

function quoted(name: string): string {
	return `"${name.replaceAll('"', '""')}"`
}
