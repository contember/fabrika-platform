// One step of a dump of the object's database (ADR-0070 §2): the ops operation `export`, served before the application
// boots. It reads `sqlite_schema` and the tables directly, so it also dumps a database that cannot boot, and it keeps
// nothing between steps: Control's operation record holds the upload id, the cursor and the parts.

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
	type OpsDumpSchema,
	type OpsDumpSchemaEntry,
	type OpsDumpSchemaForeignKey,
	type OpsDumpSchemaIndex,
	type OpsDumpSchemaTable,
	type OpsDumpTable,
	type OpsDumpTablePlan,
	type OpsDumpValue,
	opsDumpValueBinding,
	type OpsExportBegin,
	type OpsExportComplete,
	type OpsExportPart,
	type OpsExportRequest,
	type OpsExportScope,
	type OpsStaleRefusal,
	parseOpsExportBeginAck,
	parseOpsExportCompleteAck,
	parseOpsExportPartAck,
	planOpsDump,
	readOpsDumpValue,
} from '@fabrika/auth-core'
import type { SqliteValue } from '@fabrika/db/sqlite'
import { crc32, deflateRawSync } from 'node:zlib'
import appPackage from '../../package.json' with { type: 'json' }
import { jsonResponse } from '../errors.js'
import { method } from './bindings.js'
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
 * One step of a dump. A consistent step runs only at the published generation and never while the object is `open`;
 * each step checks that and reads the database before its first await, so no transition falls between the two.
 */
export async function exportStep(source: ExportSource, barrier: MaintenanceBarrier, step: OpsExportRequest): Promise<Response> {
	const refused = scopeRefusal(barrier, step)
	if (refused !== null) {
		return refused
	}
	switch (step.step) {
		case 'begin':
			return await begin(source, step)
		case 'part':
			return await part(source, step)
		case 'complete':
			return await complete(source, step)
	}
}

/** A diagnostic step runs in any mode; a consistent one at the published generation, in a mode that writes nothing. */
function scopeRefusal(barrier: MaintenanceBarrier, scope: OpsExportScope): Response | null {
	if (!scope.consistent) {
		return null
	}
	const view = barrier.view()
	if (!view.published || view.generation !== scope.generation) {
		const published = view.published && view.generation !== null ? { generation: view.generation, mode: view.mode } : null
		const stale: OpsStaleRefusal = { refused: 'stale_generation', published }
		return jsonResponse(stale, OPS_STALE_STATUS)
	}
	return view.mode === 'open' ? dataRefusal({ refused: 'wrong_mode', table: null }) : null
}

function dataRefusal(refusal: OpsDataRefusal): Response {
	return jsonResponse(refusal, OPS_DATA_REFUSED_STATUS)
}

/** Plans the dump, starts the multipart upload of its data and answers the object's bookmark. */
async function begin(source: ExportSource, step: OpsExportBegin): Promise<Response> {
	const plan = planOpsDump(describeSchema(source.storage))
	if ('refused' in plan) {
		return dataRefusal(plan)
	}
	if (source.recovery === null) {
		throw new Error("the object's storage has no bookmarks; a Durable Object's storage has them")
	}
	const bookmark = await source.recovery.getCurrentBookmark()
	const upload: unknown = await call(source.bucket, 'createMultipartUpload')(dataKey(step), { httpMetadata: { contentType: 'application/gzip' } })
	const uploadId = typeof upload === 'object' && upload !== null ? Reflect.get(upload, 'uploadId') : undefined
	return answer(parseOpsExportBeginAck({ step: 'begin', uploadId, bookmark }), 'begin')
}

/** Fills part `n` from its cursor: whole rows while every bound holds, one gzip member padded to the fixed size but the last. */
async function part(source: ExportSource, step: OpsExportPart): Promise<Response> {
	const plan = planOpsDump(describeSchema(source.storage))
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
	const plan = planOpsDump(describeSchema(storage))
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
	const query = `SELECT ${[String(fixed), ...sizes].join(' + ')} AS bound FROM ${quoted(table.name)} ${condition.sql}
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
	const query = `WITH page(${names.join(', ')}) AS (SELECT ${projections.join(', ')} FROM ${quoted(table.name)} ${condition.sql}
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

// The schema: what the PRAGMAs and `sqlite_schema` say, for the wire's one schema rule and for the manifest.

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

/** Every table of the main schema, as `table_list`, `table_xinfo`, `index_list`, `index_xinfo` and `foreign_key_list` describe it. */
function describeSchema(storage: Storage): OpsDumpSchema {
	const tables: OpsDumpSchemaTable[] = []
	for (const listed of rowsOf(storage, 'PRAGMA main.table_list')) {
		const name = text(listed['name'])
		const type = text(listed['type'])
		if (type === 'view' || !dumped(name)) {
			continue
		}
		const sql = rowsOf(storage, `SELECT sql FROM main.sqlite_schema WHERE type = 'table' AND name = ?`, name)[0]?.['sql']
		const declared = typeof sql === 'string' ? sql : ''
		tables.push({
			name,
			virtual: type === 'virtual',
			withoutRowid: listed['wr'] === 1,
			// No PRAGMA reports a CHECK or an INITIALLY DEFERRED key: either is assumed wherever the SQL might declare it.
			checked: /\bcheck\s*\(/i.test(declared),
			columns: rowsOf(storage, `PRAGMA main.table_xinfo(${quoted(name)})`).map((column) => ({
				name: text(column['name']),
				type: text(column['type']),
				notNull: column['notnull'] === 1,
				primaryKey: typeof column['pk'] === 'number' ? column['pk'] : 0,
				generated: column['hidden'] === 2 || column['hidden'] === 3,
			})),
			indexes: describeIndexes(storage, name),
			foreignKeys: describeForeignKeys(storage, name, /\binitially\s+deferred\b/i.test(declared)),
		})
	}
	return { tables }
}

function describeIndexes(storage: Storage, table: string): OpsDumpSchemaIndex[] {
	return rowsOf(storage, `PRAGMA main.index_list(${quoted(table)})`).map((index) => {
		const origin = index['origin']
		return {
			unique: index['unique'] === 1,
			origin: origin === 'u' || origin === 'pk' ? origin : 'c',
			partial: index['partial'] === 1,
			columns: rowsOf(storage, `PRAGMA main.index_xinfo(${quoted(text(index['name']))})`)
				.filter((column) => column['key'] === 1)
				.map((column) => typeof column['name'] === 'string' ? column['name'] : null),
		}
	})
}

/** A key's rows grouped by `id`, which `foreign_key_list` answers in `seq` order. */
function describeForeignKeys(storage: Storage, table: string, initiallyDeferred: boolean): OpsDumpSchemaForeignKey[] {
	const keys = new Map<SqliteValue | undefined, { parent: string; columns: string[]; references: (string | null)[] }>()
	for (const row of rowsOf(storage, `PRAGMA main.foreign_key_list(${quoted(table)})`)) {
		const key = keys.get(row['id']) ?? { parent: text(row['table']), columns: [], references: [] }
		keys.set(row['id'], key)
		key.columns.push(text(row['from']))
		key.references.push(typeof row['to'] === 'string' ? row['to'] : null)
	}
	return [...keys.values()].map((key) => {
		const references = key.references.flatMap((column) => column === null ? [] : [column])
		return { parent: key.parent, columns: key.columns, references: references.length === key.columns.length ? references : null, initiallyDeferred }
	})
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
	const exists = rowsOf(storage, `SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = 'fabrika_migrations'`).length > 0
	return exists ? rowsOf(storage, 'SELECT bundle, name, checksum, applied_at AS appliedAt FROM fabrika_migrations ORDER BY bundle, name') : []
}

function quoted(name: string): string {
	return `"${name.replaceAll('"', '""')}"`
}
