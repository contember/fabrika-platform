// The ops wire (ADR-0069): the one platform-composed row through which Control reaches an application environment's
// object on Cloudflare, the requests it sends there and the answers the object gives. Control and the framework both
// import it, so the two sides parse one shape. Every parser is strict: an unknown key, a missing field or a wrong type
// refuses the whole value.

import { isDigest } from './endpoint-digest'
import { FRAMEWORK_RELEASE_PATTERN } from './framework-release'
import { prop } from './json'
import { sha256Hex } from './sha256'
import { WORKLOAD_NAME } from './workloads'

/** Every ops request's path lies under this prefix, on the environment's own domain. */
export const OPS_PREFIX = '/__fabrika/ops/'

/**
 * The fixed id of the composed row. An authored endpoint id starts with a letter, so no contract can take it. The row's
 * digest is not a constant: proxy-core computes it where every row is digested, from these fields.
 */
export const OPS_ROW_ID = '__fabrika.ops'

/** The composed row's path. */
export const OPS_ROW_PATH = `${OPS_PREFIX}*`

/** The composed row's method. */
export const OPS_METHOD = 'POST'

/** The one content type the composed row admits. */
export const OPS_CONTENT_TYPE = 'application/json'

/** The operations the object serves, each at `opsPath(operation)`. */
export const OPS_OPERATIONS = ['inspect', 'state', 'migrate', 'export', 'import', 'restore', 'timers'] as const

export type OpsOperation = (typeof OPS_OPERATIONS)[number]

export function opsPath(operation: OpsOperation): string {
	return `${OPS_PREFIX}${operation}`
}

/** The operation a request path names, or `null` for any other path, which gets `opsRefusal()`. */
export function parseOpsOperation(path: string): OpsOperation | null {
	return OPS_OPERATIONS.find((operation) => opsPath(operation) === path) ?? null
}

/**
 * The one answer inside the prefix to a missing or wrong key, a wrong endpoint header, an unknown operation and a
 * refused object name: the same status, no body and no headers, so none of them tells the caller which it was.
 */
export const OPS_REFUSAL_STATUS = 404

export function opsRefusal(): Response {
	return new Response(null, { status: OPS_REFUSAL_STATUS })
}

/** Ops key digests: `sha256:<64 hex>` of each key, joined by `,`; one, or two while a rotation reconciles. */
export type OpsKeyDigests = readonly [string] | readonly [string, string]

/** The digest of an ops key, the only form the object holds (`FABRIKA_OPS_KEY_DIGESTS`). */
export function opsKeyDigest(key: string): string {
	return `sha256:${sha256Hex(key)}`
}

/** The value of `FABRIKA_OPS_KEY_DIGESTS`, or `null` unless it holds one or two distinct digests. */
export function parseOpsKeyDigests(value: string): OpsKeyDigests | null {
	const [first, second, ...rest] = value.split(',')
	if (first === undefined || !isDigest(first) || rest.length > 0) return null
	if (second === undefined) return [first]
	return isDigest(second) && second !== first ? [first, second] : null
}

/** The value Control writes into `FABRIKA_OPS_KEY_DIGESTS`; throws on a list `parseOpsKeyDigests` would refuse. */
export function formatOpsKeyDigests(digests: OpsKeyDigests): string {
	const value = digests.join(',')
	if (parseOpsKeyDigests(value) === null) throw new Error('ops key digests must be one or two distinct sha256 digests')
	return value
}

/** The object of ordinary traffic without `FABRIKA_APPLICATION_OBJECT`, and the only one an ops request may name then. */
export const DEFAULT_APPLICATION_OBJECT = 'application'

/** The most names `FABRIKA_APPLICATION_OBJECTS` holds. */
export const MAX_APPLICATION_OBJECTS = 16

/** An object name: lowercase, at most 63 characters, safe as one segment of an R2 key. */
const APPLICATION_OBJECT_NAME = /^[a-z][a-z0-9-]{0,62}$/

export function parseApplicationObjectName(value: unknown): string | null {
	return typeof value === 'string' && APPLICATION_OBJECT_NAME.test(value) ? value : null
}

/** The object of ordinary traffic, and the objects an ops request may name, which include it. */
export interface ApplicationObjects {
	readonly object: string
	readonly objects: readonly string[]
}

/**
 * `FABRIKA_APPLICATION_OBJECT` and `FABRIKA_APPLICATION_OBJECTS` (distinct names joined by `,`, 1 to 16, holding the
 * first), or `null`. Without either the object is `application`; a deploy writes both, so one alone is refused.
 */
export function parseApplicationObjects(object: string | undefined, objects: string | undefined): ApplicationObjects | null {
	if (object === undefined && objects === undefined) return { object: DEFAULT_APPLICATION_OBJECT, objects: [DEFAULT_APPLICATION_OBJECT] }
	if (object === undefined || objects === undefined || parseApplicationObjectName(object) === null) return null
	const names = objects.split(',')
	const valid = names.length <= MAX_APPLICATION_OBJECTS && names.every((name) => parseApplicationObjectName(name) !== null)
	return valid && new Set(names).size === names.length && names.includes(object) ? { object, objects: names } : null
}

/** The R2 key, in the environment's bucket, of the maintenance state of `object`. */
export function OPS_STATE_KEY(object: string): string {
	if (parseApplicationObjectName(object) === null) throw new Error('an ops state key needs a valid object name')
	return `__fabrika/ops/${object}.json`
}

/** The maintenance modes, from the most permissive. */
export const OPS_MODES = ['open', 'read-only', 'closed', 'inspect'] as const

export type OpsMode = (typeof OPS_MODES)[number]

/** A table's row count is capped here: a full count bills every row read. A count at the cap means at least the cap. */
export const OPS_ROW_COUNT_CAP = 100_000

/** `POST /__fabrika/ops/inspect`: the projection, or with `content` the content-bearing view (`data.content.read`). */
export interface OpsInspectRequest {
	readonly object: string
	readonly content: boolean
}

/** `POST /__fabrika/ops/state`: a maintenance transition under a generation Control allocated. */
export interface OpsStateRequest {
	readonly object: string
	readonly generation: number
	readonly mode: OpsMode
}

/** Sent once the state is published and the drain is over; `stillRunning` counts what ran past the drain's bound. */
export interface OpsStateAck {
	readonly generation: number
	readonly mode: OpsMode
	readonly stillRunning: number
}

/** `POST /__fabrika/ops/migrate`: run the pending migrations under the published generation. */
export interface OpsMigrateRequest {
	readonly object: string
	readonly generation: number
}

/** The state a transition is judged against: the object's current generation and mode, `null` before the first. */
export interface OpsPublishedState {
	readonly generation: number
	readonly mode: OpsMode
}

/**
 * Whether a transition is stale: a lower generation, or the same with another mode. The same generation and mode is a
 * retry, which the object replays.
 */
export function opsTransitionRefused(current: OpsPublishedState | null, request: OpsPublishedState): boolean {
	if (current === null) return false
	return request.generation < current.generation || (request.generation === current.generation && request.mode !== current.mode)
}

/** The status of a stale refusal. It is answered only after authentication, so it may say what is published. */
export const OPS_STALE_STATUS = 409

/** The body of a stale refusal of a transition or a migration. */
export interface OpsStaleRefusal {
	readonly refused: 'stale_generation'
	readonly published: OpsPublishedState | null
}

/** One row of the object's migration ledger. */
export interface OpsMigration {
	readonly bundle: string
	readonly name: string
	readonly checksum: string
	readonly appliedAt: string
}

/** Sent once the migrations ran and the application booted, with the new ledger. */
export interface OpsMigrateAck {
	readonly generation: number
	readonly migrations: readonly OpsMigration[]
}

export interface OpsMaintenance {
	readonly mode: OpsMode
	/** `null` while no transition was ever published: the object is `open`. */
	readonly generation: number | null
	/** Whether R2 holds this state; `false` while its put is pending. */
	readonly published: boolean
}

export interface OpsTableCount {
	readonly name: string
	/** At most `OPS_ROW_COUNT_CAP`. */
	readonly rows: number
}

export interface OpsDatabase {
	readonly sizeBytes: number
	readonly tables: readonly OpsTableCount[]
}

export interface OpsScheduler {
	/** The current alarm, or `null` when none is set. */
	readonly alarm: string | null
}

/** A job's last run and its outcome: a contract job, or a framework job such as `fabrika-file-sweep`. */
export interface OpsJob {
	readonly job: string
	readonly lastStatus: 'succeeded' | 'failed' | null
	readonly lastStartedAt: string | null
	readonly lastFinishedAt: string | null
	readonly lastDurationMs: number | null
}

export type OpsFileStatus = 'pending' | 'quarantined' | 'live' | 'rejected'

export interface OpsFileCount {
	readonly kind: string
	readonly status: OpsFileStatus
	readonly count: number
}

/** A delivery is `claimed` while it holds a lease, `completed` once its handler's transaction cleared it. */
export interface OpsWebhookCount {
	readonly webhook: string
	readonly state: 'claimed' | 'completed'
	readonly count: number
}

export interface OpsBootFailure {
	readonly at: string
}

/** The boot failure with the application's error text, which is content. */
export interface OpsBootFailureContent extends OpsBootFailure {
	readonly message: string
	readonly stack: string | null
}

/**
 * The allowlisted projection (`data.read`): counts, sizes, timestamps, the identifiers the platform or the contract
 * names, and status codes. Every timestamp is ISO 8601 in UTC with milliseconds.
 */
export interface OpsView {
	readonly release: string
	readonly maintenance: OpsMaintenance
	readonly database: OpsDatabase
	readonly migrations: readonly OpsMigration[]
	readonly scheduler: OpsScheduler
	readonly jobs: readonly OpsJob[]
	readonly files: readonly OpsFileCount[]
	readonly webhooks: readonly OpsWebhookCount[]
	readonly bootFailure: OpsBootFailure | null
}

/** The view a `data.content.read` caller gets: the projection, with the application's error text. */
export interface OpsContentView extends Omit<OpsView, 'bootFailure'> {
	readonly bootFailure: OpsBootFailureContent | null
}

// A request's `object` is only well-formed here; the handler refuses a name its list does not hold with `opsRefusal()`.
export function parseOpsInspectRequest(body: unknown): OpsInspectRequest | null {
	const object = parseApplicationObjectName(prop(body, 'object'))
	const content = prop(body, 'content')
	return exactKeys(body, ['object', 'content']) && object !== null && typeof content === 'boolean' ? { object, content } : null
}

export function parseOpsStateRequest(body: unknown): OpsStateRequest | null {
	if (!exactKeys(body, ['object', 'generation', 'mode'])) return null
	const object = parseApplicationObjectName(prop(body, 'object'))
	const generation = readGeneration(prop(body, 'generation'))
	const mode = readMode(prop(body, 'mode'))
	return object === null || generation === null || mode === null ? null : { object, generation, mode }
}

export function parseOpsStateAck(body: unknown): OpsStateAck | null {
	if (!exactKeys(body, ['generation', 'mode', 'stillRunning'])) return null
	const generation = readGeneration(prop(body, 'generation'))
	const mode = readMode(prop(body, 'mode'))
	const stillRunning = readCount(prop(body, 'stillRunning'))
	return generation === null || mode === null || stillRunning === null ? null : { generation, mode, stillRunning }
}

export function parseOpsMigrateRequest(body: unknown): OpsMigrateRequest | null {
	const object = parseApplicationObjectName(prop(body, 'object'))
	const generation = readGeneration(prop(body, 'generation'))
	return exactKeys(body, ['object', 'generation']) && object !== null && generation !== null ? { object, generation } : null
}

export function parseOpsStaleRefusal(body: unknown): OpsStaleRefusal | null {
	if (!exactKeys(body, ['refused', 'published']) || prop(body, 'refused') !== 'stale_generation') return null
	const raw = prop(body, 'published')
	if (raw === null) return { refused: 'stale_generation', published: null }
	if (!exactKeys(raw, ['generation', 'mode'])) return null
	const generation = readGeneration(prop(raw, 'generation'))
	const mode = readMode(prop(raw, 'mode'))
	return generation === null || mode === null ? null : { refused: 'stale_generation', published: { generation, mode } }
}

export function parseOpsMigrateAck(body: unknown): OpsMigrateAck | null {
	if (!exactKeys(body, ['generation', 'migrations'])) return null
	const generation = readGeneration(prop(body, 'generation'))
	const migrations = readList(prop(body, 'migrations'), readMigration)
	return generation === null || migrations === null ? null : { generation, migrations }
}

export function parseOpsView(body: unknown): OpsView | null {
	const failure = prop(body, 'bootFailure')
	const bootFailure = failure === null ? null : readBootFailure(failure)
	if (bootFailure === undefined) return null
	const view = readViewFields(body)
	return view === null ? null : { ...view, bootFailure }
}

export function parseOpsContentView(body: unknown): OpsContentView | null {
	const failure = prop(body, 'bootFailure')
	const bootFailure = failure === null ? null : readBootFailureContent(failure)
	if (bootFailure === undefined) return null
	const view = readViewFields(body)
	return view === null ? null : { ...view, bootFailure }
}

// Dumps (ADR-0070): a consistent backup or a diagnostic export of an object's SQLite, which Control writes step by step
// into the environment's bucket, and the importer that loads a consistent one into a fresh object. No type here carries
// a row's values or a file's bytes, except the line and row encodings, which only the object and a download read.

/** The version of the dump format: the value, row and line encodings, the table hash and the manifest. */
export const OPS_DUMP_FORMAT = 1

/** The most rows one keyset page reads. */
export const OPS_DUMP_PAGE_ROWS = 1000

/**
 * The size of every part of a dump's data object but the last, which is at most this. R2 refuses a multipart upload
 * whose parts differ in size, and a part below 5 MiB; a 2 MB row, its text and blobs as hex, fits one part uncompressed.
 */
export const OPS_DUMP_PART_SIZE = 8 * 1024 * 1024

/**
 * The most bytes one part decompresses to: its lines, each with its newline. An import step holds a part's every form
 * at once (compressed, decompressed, the lines, the values, the bound bytes), so this bounds its memory well inside an
 * isolate's 128 MB.
 */
export const OPS_DUMP_PART_MAX_RAW_BYTES = 16 * 1024 * 1024

/** The most rows one part holds, which bounds the inserts, and the link updates, of one import step. */
export const OPS_DUMP_PART_MAX_ROWS = 50_000

/** R2's most parts in one multipart upload. */
export const OPS_DUMP_MAX_PARTS = 10_000

/** The largest manifest a reader accepts, in UTF-8 bytes. */
export const OPS_DUMP_MANIFEST_MAX_BYTES = 4 * 1024 * 1024

/** The object a scheduled backup is rehearsed in. Every deploy at a gated release lists it; nothing serves from it. */
export const OPS_REHEARSAL_OBJECT = 'rehearsal'

/** A dump: the object it was taken from, the id Control gave it (a UUID), and whether it is a consistent backup. */
export interface OpsDumpRef {
	readonly object: string
	readonly dump: string
	readonly consistent: boolean
}

/** The R2 key of a dump's data or manifest: a consistent backup under `__fabrika/backups/`, a diagnostic export under `__fabrika/exports/`. */
export function OPS_DUMP_KEY(ref: OpsDumpRef, file: 'data' | 'manifest'): string {
	if (parseApplicationObjectName(ref.object) === null || !UUID.test(ref.dump)) throw new Error('a dump key needs a valid object name and dump id')
	return `__fabrika/${ref.consistent ? 'backups' : 'exports'}/${ref.object}/${ref.dump}/${file === 'data' ? 'data.ndjson.gz' : 'manifest.json'}`
}

/**
 * One stored value, as `typeof()` names it. An integer travels as its decimal text, because workerd reads an int64 into
 * a double; a real travels as the double workerd reads exactly. Text and a blob travel as the upper-case hex of their
 * bytes, so text that is not valid UTF-8 keeps every byte.
 */
export type OpsDumpValue =
	| null
	| { readonly type: 'integer'; readonly value: string }
	| { readonly type: 'real'; readonly value: number }
	| { readonly type: 'text'; readonly value: string }
	| { readonly type: 'blob'; readonly value: string }

/**
 * The two result columns a dump reads for `column`: `typeof()` and the value in the form `readOpsDumpValue` takes, an
 * integer as `CAST(c AS TEXT)`, a real as itself, text as `hex(CAST(c AS BLOB))` and a blob as `hex(c)`.
 */
export function opsDumpColumnProjection(column: string): string {
	const c = quoteIdentifier(column)
	return `typeof(${c}), CASE typeof(${c}) WHEN 'integer' THEN CAST(${c} AS TEXT) WHEN 'real' THEN ${c} WHEN 'text' THEN hex(CAST(${c} AS BLOB)) WHEN 'blob' THEN hex(${c}) END`
}

/** The value `opsDumpColumnProjection` read. Throws, naming no value, on a pair it would not produce. */
export function readOpsDumpValue(type: unknown, value: unknown): OpsDumpValue {
	if (type === 'null' && value === null) return null
	if (type === 'integer' && typeof value === 'string' && isInt64Text(value)) return { type, value }
	if (type === 'real' && typeof value === 'number' && !Number.isNaN(value)) return { type, value }
	if ((type === 'text' || type === 'blob') && typeof value === 'string' && isBytesHex(value)) return { type, value }
	throw new Error('a projected dump value does not match its type')
}

/**
 * The most result columns, and the most parameters, one statement of workerd's SQLite takes; a table holds at most as
 * many columns.
 */
export const OPS_SQLITE_MAX_COLUMNS = 100

/** The most columns of a table one statement of a page read projects: two result columns each, beside the rowid twice. */
export const OPS_DUMP_READ_COLUMNS = (OPS_SQLITE_MAX_COLUMNS - 2) / 2

/** One row of a keyset page: its rowid as decimal text, then the rowid and every column as the dump writes them. */
export interface OpsDumpPageRow {
	readonly rowid: string
	readonly values: readonly OpsDumpValue[]
}

/** Runs one statement of a page read, with the parameters of the read's condition, and answers its rows. */
export type OpsDumpPageQuery = (sql: string) => readonly Readonly<Record<string, unknown>>[]

/**
 * One keyset page of `table`: the first `limit` rows by rowid that `condition` (`WHERE …`, or empty) admits, read the
 * way the producer and the importer's verification both read them. Each column reads as two result columns, so a table
 * wider than `OPS_DUMP_READ_COLUMNS` reads in several statements over the same rows, which the caller runs in one
 * synchronous turn, so no write falls between them. The common table expression names every result column, which an
 * expression alone does not.
 */
export function readOpsDumpPage(query: OpsDumpPageQuery, table: OpsDumpTablePlan, condition: string, limit: number): OpsDumpPageRow[] {
	if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('a dump page reads at least one row')
	const keyset = quoteIdentifier(table.keyset)
	const reads: { readonly start: number; readonly count: number; readonly rows: readonly Readonly<Record<string, unknown>>[] }[] = []
	for (let start = 0; start === 0 || start < table.columns.length; start += OPS_DUMP_READ_COLUMNS) {
		const columns = table.columns.slice(start, start + OPS_DUMP_READ_COLUMNS)
		const names = columns.flatMap((_, offset) => [`t${start + offset}`, `v${start + offset}`])
		const projections = [keyset, `CAST(${keyset} AS TEXT)`, ...columns.map(opsDumpColumnProjection)]
		const rows = query(
			`WITH page(${['k', 'r', ...names].join(', ')}) AS (SELECT ${projections.join(', ')} FROM main.${quoteIdentifier(table.name)} ${condition}
		ORDER BY ${keyset} LIMIT ${limit}) SELECT ${['r', ...names].join(', ')} FROM page ORDER BY k`,
		)
		reads.push({ start, count: columns.length, rows })
	}
	const first = reads[0]?.rows ?? []
	if (reads.some(({ rows }) => rows.length !== first.length)) throw new Error('the reads of one dump page disagree on its rows')
	return first.map((row, index) => {
		const rowid = readOpsDumpValue('integer', row['r'])
		if (rowid === null || rowid.type !== 'integer') throw new Error('a rowid reads as an integer')
		const values: OpsDumpValue[] = [rowid]
		for (const { start, count, rows } of reads) {
			const read = rows[index]
			if (read?.['r'] !== rowid.value) throw new Error('the reads of one dump page disagree on its rows')
			for (let column = start; column < start + count; column++) {
				values.push(readOpsDumpValue(read[`t${column}`], read[`v${column}`]))
			}
		}
		return { rowid: rowid.value, values }
	})
}

/**
 * The SQL that names a dump's rowid inline, so a row of a table at `OPS_SQLITE_MAX_COLUMNS` binds no more parameters
 * than it has columns. It is the checked decimal text in a string literal, cast as `opsDumpValueBinding` casts it.
 */
export function opsDumpRowidSql(rowid: OpsDumpValue): string {
	if (rowid === null || rowid.type !== 'integer' || !isInt64Text(rowid.value)) throw new Error('a dump rowid must be an integer')
	return `CAST('${rowid.value}' AS INTEGER)`
}

/** What a statement binds for one value of a dump. */
export type OpsDumpParam = string | number | Uint8Array | null

/** The SQL expression that writes a value back and the parameter its `?` binds. */
export interface OpsDumpBinding {
	readonly sql: string
	readonly param: OpsDumpParam
}

/**
 * How the importer writes a value back, a rowid included, without a double or a JavaScript string in between: an
 * integer as its decimal text through `CAST(? AS INTEGER)`, a real through `CAST(? AS REAL)` (a binder may bind an
 * integral double as an integer), text as its bytes through `CAST(? AS TEXT)`, and a blob as its bytes.
 */
export function opsDumpValueBinding(value: OpsDumpValue): OpsDumpBinding {
	if (value === null) return { sql: '?', param: null }
	switch (value.type) {
		case 'integer':
			return { sql: 'CAST(? AS INTEGER)', param: value.value }
		case 'real':
			return { sql: 'CAST(? AS REAL)', param: value.value }
		case 'text':
			return { sql: 'CAST(? AS TEXT)', param: hexBytes(value.value) }
		case 'blob':
			return { sql: '?', param: hexBytes(value.value) }
	}
}

/**
 * The canonical encoding of a row, the text a table hash is computed over: a JSON array (`JSON.stringify`, so no
 * whitespace) of `null` or a tagged string per value, `i:<decimal>`, `r:<shortest round-trip double>`, `t:<HEX>` or
 * `b:<HEX>`. A real keeps `-0`, `Infinity` and `-Infinity`; NaN is never stored. Throws, naming no value, on a value
 * outside these rules.
 */
export function encodeOpsDumpRow(values: readonly OpsDumpValue[]): string {
	return JSON.stringify(values.map(encodeValue))
}

/** The values of a row's canonical encoding, or `null` for any other text, a different spelling of the same row included. */
export function decodeOpsDumpRow(text: string): readonly OpsDumpValue[] | null {
	const values = readRowValues(parseJson(text))
	return values !== null && encodeOpsDumpRow(values) === text ? values : null
}

/** One line of a dump's NDJSON: a table's row, which is its rowid, then every column that is not generated. */
export interface OpsDumpLine {
	readonly table: string
	readonly row: readonly OpsDumpValue[]
}

/** The line `{"table":"<name>","row":<canonical row>}`. Throws on a table name outside the data layer's identifier rule. */
export function encodeOpsDumpLine(line: OpsDumpLine): string {
	if (!TABLE_NAME.test(line.table)) throw new Error('a dump line needs a plain table name')
	return `{"table":${JSON.stringify(line.table)},"row":${encodeOpsDumpRow(line.row)}}`
}

/** A line, or `null` for anything `encodeOpsDumpLine` would not write. */
export function decodeOpsDumpLine(text: string): OpsDumpLine | null {
	const parsed = parseJson(text)
	if (!exactKeys(parsed, ['table', 'row'])) return null
	const table = readMatch(prop(parsed, 'table'), TABLE_NAME)
	const row = readRowValues(prop(parsed, 'row'))
	if (table === null || row === null) return null
	return encodeOpsDumpLine({ table, row }) === text ? { table, row } : null
}

/** The hash of a table without rows: the SHA-256 of the empty string. */
export const OPS_EMPTY_TABLE_HASH = sha256Hex('')

/**
 * Folds rows, each in its canonical encoding and in keyset order, into a table's hash. Each row's step is the SHA-256 of
 * the previous hash's hex, a newline and the row, so a table read page by page, across steps, folds to one value.
 */
export function foldOpsTableHash(hash: string, rows: Iterable<string>): string {
	if (!SHA256_HEX.test(hash)) throw new Error('a table hash is 64 lower-case hex digits')
	let current = hash
	for (const row of rows) current = sha256Hex(`${current}\n${row}`)
	return current
}

/** A column as `PRAGMA table_xinfo` describes it. */
export interface OpsDumpSchemaColumn {
	readonly name: string
	/** The declared type, as written. */
	readonly type: string
	readonly notNull: boolean
	/** The column's position in the primary key from 1, `0` outside it. */
	readonly primaryKey: number
	/** A generated column (`hidden` 2 or 3), which a dump does not carry. */
	readonly generated: boolean
}

/** An index as `PRAGMA index_list` and `PRAGMA index_xinfo` (its key columns) describe it. */
export interface OpsDumpSchemaIndex {
	readonly unique: boolean
	readonly origin: 'c' | 'u' | 'pk'
	readonly partial: boolean
	/** The key columns in order, `null` for an expression. */
	readonly columns: readonly (string | null)[]
}

/** A foreign key as `PRAGMA foreign_key_list` describes it, its rows grouped by `id` and ordered by `seq`. */
export interface OpsDumpSchemaForeignKey {
	readonly parent: string
	readonly columns: readonly string[]
	/** The parent's columns (`to`), or `null` when the key names the parent's primary key implicitly. */
	readonly references: readonly string[] | null
	/**
	 * Whether the key is `DEFERRABLE INITIALLY DEFERRED`. No PRAGMA reports it: a reader takes it from the table's SQL,
	 * and one that cannot tell which key a clause belongs to marks every key of that table.
	 */
	readonly initiallyDeferred: boolean
}

/** A table as `PRAGMA table_list` (`type`, `wr`) and the PRAGMAs above describe it. */
export interface OpsDumpSchemaTable {
	readonly name: string
	readonly virtual: boolean
	readonly withoutRowid: boolean
	/** Whether the table's SQL declares a `CHECK` constraint; a reader that cannot tell answers `true`. */
	readonly checked: boolean
	readonly columns: readonly OpsDumpSchemaColumn[]
	readonly indexes: readonly OpsDumpSchemaIndex[]
	readonly foreignKeys: readonly OpsDumpSchemaForeignKey[]
}

/** Every table a dump holds: `sqlite_schema`'s tables but SQLite's internal ones, `sqlite_sequence` excepted, and `_cf_`'s. */
export interface OpsDumpSchema {
	readonly tables: readonly OpsDumpSchemaTable[]
}

/** How one table is dumped and loaded. */
export interface OpsDumpTablePlan {
	readonly name: string
	/** The name that reads the rowid: the `INTEGER PRIMARY KEY` column, else the first of `rowid`, `_rowid_`, `oid` no column takes. */
	readonly keyset: string
	/** Every column that is not generated, in declaration order: a row is the rowid, then these. */
	readonly columns: readonly string[]
	/** The columns of the foreign keys inside a cycle, which a part writes `NULL` and the link pass sets, in declaration order. */
	readonly deferred: readonly string[]
}

/** The tables of a dump in load order: every parent outside a table's own cycle comes before it. */
export interface OpsDumpPlan {
	readonly tables: readonly OpsDumpTablePlan[]
}

/**
 * The one rule both the producer, at export `begin`, and the importer, at import `begin`, apply to a schema: the plan
 * a dump is written and loaded by, or an `unsupported_schema` refusal naming the table. A foreign key whose parent lies
 * in its own table's cycle (the table itself included) is loaded `NULL` and linked once every row is in, so each of its
 * columns must take a temporary `NULL`: nullable, outside the primary key, referenced by no foreign key, in a table
 * without a `CHECK`, a `NOT NULL` generated column, or a partial or expression unique index. A `WITHOUT ROWID` or
 * virtual table, a table without a name that reads its rowid, a foreign key to a table outside the dump or without the
 * named key, and a foreign key checked only at commit are refused.
 */
export function planOpsDump(schema: OpsDumpSchema): OpsDumpPlan | OpsDataRefusal {
	const sorted = [...schema.tables].sort((left, right) => compareNames(left.name, right.name))
	if (!sorted.every((table) => TABLE_NAME.test(table.name)) || !distinct(sorted.map((table) => table.name))) return unsupported(null)
	const byName = new Map(sorted.map((table) => [table.name, table]))
	const tables: DescribedTable[] = []
	for (const table of sorted) {
		const keyset = table.virtual || table.withoutRowid ? null : rowidName(table)
		const parents = resolveForeignKeys(table, byName)
		if (keyset === null || parents === null) return unsupported(table.name)
		tables.push({ table, keyset, parents })
	}
	const cycle = cycleIds(tables)
	const referenced = new Set(tables.flatMap(({ parents }) => parents.flatMap((key) => key.references.map((column) => columnKey(key.parent, column)))))
	const plans: OpsDumpTablePlan[] = []
	for (const { table, keyset, parents } of loadOrder(tables, cycle)) {
		const inCycle = parents.filter((key) => cycle.get(key.parent) === cycle.get(table.name))
		const deferredNames = new Set(inCycle.flatMap((key) => key.columns.map(asciiLower)))
		const deferred = table.columns.filter((column) => deferredNames.has(asciiLower(column.name)))
		if (deferred.length > 0 && !takesTemporaryNull(table, deferred, referenced)) return unsupported(table.name)
		plans.push({
			name: table.name,
			keyset,
			columns: table.columns.filter((column) => !column.generated).map((column) => column.name),
			deferred: deferred.map((column) => column.name),
		})
	}
	return { tables: plans }
}

/** Where a dump or a verification stands in a table: the last rowid read, and the count and hash folded so far. */
export interface OpsDumpCursor {
	readonly table: string
	/** The rowid of the last row read, as decimal text; `null` before the table's first row. */
	readonly after: string | null
	readonly rows: number
	readonly hash: string
}

/** A table a dump holds, with its exact row count and its hash. */
export interface OpsDumpTable {
	readonly name: string
	readonly rows: number
	readonly hash: string
}

/** A part of a dump's data object: its number from 1, its size in bytes and the SHA-256 hex of its bytes. */
export interface OpsDumpPart {
	readonly part: number
	readonly size: number
	readonly sha256: string
}

/** A part as R2 accepted it; Control completes the upload with the ETags. */
export interface OpsUploadedPart extends OpsDumpPart {
	readonly etag: string
}

/** One `sqlite_schema` entry with SQL: an automatic index has none and is not listed. */
export interface OpsDumpSchemaEntry {
	readonly type: 'table' | 'index' | 'trigger' | 'view'
	readonly name: string
	readonly table: string
	readonly sql: string
}

/** `manifest.json`, written beside the data once its upload completed. `tables` is in load order. */
export interface OpsDumpManifest {
	readonly format: typeof OPS_DUMP_FORMAT
	readonly dump: string
	readonly object: string
	readonly consistent: boolean
	readonly createdAt: string
	/** The object's bookmark when the dump began. */
	readonly bookmark: string
	readonly release: string
	readonly contractDigest: string
	readonly ddl: readonly OpsDumpSchemaEntry[]
	readonly migrations: readonly OpsMigration[]
	readonly tables: readonly OpsDumpTable[]
	readonly parts: readonly OpsDumpPart[]
}

/**
 * A manifest Control holds or an answer carries; every table's DDL lists it, its parts are whole, and its
 * `JSON.stringify` is at most `OPS_DUMP_MANIFEST_MAX_BYTES` in UTF-8, wherever it came from.
 */
export function parseOpsDumpManifest(body: unknown): OpsDumpManifest | null {
	if (!exactKeys(body, MANIFEST_KEYS) || prop(body, 'format') !== OPS_DUMP_FORMAT) return null
	const dump = readMatch(prop(body, 'dump'), UUID)
	const object = parseApplicationObjectName(prop(body, 'object'))
	const consistent = prop(body, 'consistent')
	const createdAt = readTimestamp(prop(body, 'createdAt'))
	const bookmark = readMatch(prop(body, 'bookmark'), OPAQUE_TOKEN)
	const release = readMatch(prop(body, 'release'), FRAMEWORK_RELEASE_PATTERN)
	const contractDigest = prop(body, 'contractDigest')
	const ddl = readList(prop(body, 'ddl'), readSchemaEntry)
	const migrations = readList(prop(body, 'migrations'), readMigration)
	const tables = readTables(prop(body, 'tables'))
	const parts = readWholeParts(prop(body, 'parts'), readDumpPart)
	if (
		dump === null || object === null || typeof consistent !== 'boolean' || createdAt === null || bookmark === null || release === null
		|| typeof contractDigest !== 'string' || !isDigest(contractDigest) || ddl === null || migrations === null || tables === null || parts === null
	) {
		return null
	}
	const declared = ddl.filter((entry) => entry.type === 'table').map((entry) => entry.name)
	if (!distinct(ddl.map((entry) => `${entry.type} ${entry.name}`)) || !sameNames(declared, tables.map((table) => table.name))) return null
	const manifest: OpsDumpManifest = {
		format: OPS_DUMP_FORMAT,
		dump,
		object,
		consistent,
		createdAt,
		bookmark,
		release,
		contractDigest,
		ddl,
		migrations,
		tables,
		parts,
	}
	return utf8Length(JSON.stringify(manifest)) <= OPS_DUMP_MANIFEST_MAX_BYTES ? manifest : null
}

/** A manifest's text as R2 holds it, refused above `OPS_DUMP_MANIFEST_MAX_BYTES` before it is parsed. */
export function readOpsDumpManifest(text: string): OpsDumpManifest | null {
	if (utf8Length(text) > OPS_DUMP_MANIFEST_MAX_BYTES) return null
	return parseOpsDumpManifest(parseJson(text))
}

/** What every export step names: a consistent backup carries the published generation, a diagnostic export none. */
export interface OpsExportScope {
	readonly object: string
	readonly generation: number | null
	readonly consistent: boolean
	readonly dump: string
}

/** Starts the multipart upload of the dump's data. */
export interface OpsExportBegin extends OpsExportScope {
	readonly step: 'begin'
}

/** Fills part `part` from `cursor`, `null` only for the first part; a retry replaces the part. */
export interface OpsExportPart extends OpsExportScope {
	readonly step: 'part'
	readonly uploadId: string
	readonly part: number
	readonly cursor: OpsDumpCursor | null
}

/** Completes the upload from the parts and tables Control recorded, and writes the manifest. */
export interface OpsExportComplete extends OpsExportScope {
	readonly step: 'complete'
	readonly uploadId: string
	readonly bookmark: string
	readonly parts: readonly OpsUploadedPart[]
	readonly tables: readonly OpsDumpTable[]
}

/** `POST /__fabrika/ops/export`: one step of a dump. */
export type OpsExportRequest = OpsExportBegin | OpsExportPart | OpsExportComplete

export interface OpsExportBeginAck {
	readonly step: 'begin'
	readonly uploadId: string
	readonly bookmark: string
}

/** The part written, the tables it finished in load order, and where the next part starts: `null` once all is read. */
export interface OpsExportPartAck {
	readonly step: 'part'
	readonly uploaded: OpsUploadedPart
	readonly tables: readonly OpsDumpTable[]
	readonly next: OpsDumpCursor | null
}

export interface OpsExportCompleteAck {
	readonly step: 'complete'
	readonly manifest: OpsDumpManifest
}

export function parseOpsExportRequest(body: unknown): OpsExportRequest | null {
	const scope = readExportScope(body)
	if (scope === null) return null
	switch (prop(body, 'step')) {
		case 'begin':
			return exactKeys(body, [...EXPORT_SCOPE_KEYS, 'step']) ? { ...scope, step: 'begin' } : null
		case 'part': {
			if (!exactKeys(body, [...EXPORT_SCOPE_KEYS, 'step', 'uploadId', 'part', 'cursor'])) return null
			const uploadId = readMatch(prop(body, 'uploadId'), OPAQUE_TOKEN)
			const part = readPartNumber(prop(body, 'part'))
			const cursor = readNullable(prop(body, 'cursor'), readCursor)
			if (uploadId === null || part === null || cursor === undefined || (part === 1) !== (cursor === null)) return null
			return { ...scope, step: 'part', uploadId, part, cursor }
		}
		case 'complete': {
			if (!exactKeys(body, [...EXPORT_SCOPE_KEYS, 'step', 'uploadId', 'bookmark', 'parts', 'tables'])) return null
			const uploadId = readMatch(prop(body, 'uploadId'), OPAQUE_TOKEN)
			const bookmark = readMatch(prop(body, 'bookmark'), OPAQUE_TOKEN)
			const parts = readWholeParts(prop(body, 'parts'), readUploadedPart)
			const tables = readTables(prop(body, 'tables'))
			if (uploadId === null || bookmark === null || parts === null || tables === null) return null
			return { ...scope, step: 'complete', uploadId, bookmark, parts, tables }
		}
		default:
			return null
	}
}

export function parseOpsExportBeginAck(body: unknown): OpsExportBeginAck | null {
	if (!exactKeys(body, ['step', 'uploadId', 'bookmark']) || prop(body, 'step') !== 'begin') return null
	const uploadId = readMatch(prop(body, 'uploadId'), OPAQUE_TOKEN)
	const bookmark = readMatch(prop(body, 'bookmark'), OPAQUE_TOKEN)
	return uploadId === null || bookmark === null ? null : { step: 'begin', uploadId, bookmark }
}

export function parseOpsExportPartAck(body: unknown): OpsExportPartAck | null {
	if (!exactKeys(body, ['step', 'uploaded', 'tables', 'next']) || prop(body, 'step') !== 'part') return null
	const uploaded = readUploadedPart(prop(body, 'uploaded'))
	const tables = readTables(prop(body, 'tables'))
	const next = readNullable(prop(body, 'next'), readCursor)
	if (uploaded === null || tables === null || next === undefined || continuesFinished(tables, next)) return null
	// Only the last part may be short: R2 refuses an upload whose other parts differ in size.
	if (next !== null && uploaded.size !== OPS_DUMP_PART_SIZE) return null
	return { step: 'part', uploaded, tables, next }
}

export function parseOpsExportCompleteAck(body: unknown): OpsExportCompleteAck | null {
	if (!exactKeys(body, ['step', 'manifest']) || prop(body, 'step') !== 'complete') return null
	const manifest = parseOpsDumpManifest(prop(body, 'manifest'))
	return manifest === null ? null : { step: 'complete', manifest }
}

/** The consistent backup an import loads: always under `__fabrika/backups/`. */
export interface OpsDumpSource {
	readonly object: string
	readonly dump: string
}

/** What every import step names: the fresh target, published `inspect` under the operation's generation, and the backup. */
export interface OpsImportScope {
	readonly object: string
	readonly generation: number
	readonly source: OpsDumpSource
}

/** Verifies the manifest, checks the target is fresh, and migrates it to the manifest's ledger. */
export interface OpsImportBegin extends OpsImportScope {
	readonly step: 'begin'
}

/** Loads part `part`, writing a foreign key the load order cannot satisfy as `NULL`. */
export interface OpsImportPart extends OpsImportScope {
	readonly step: 'part'
	readonly part: number
}

/** Sets the foreign keys part `part` wrote as `NULL`, once every part is loaded. */
export interface OpsImportLink extends OpsImportScope {
	readonly step: 'link'
	readonly part: number
}

/** Reads the loaded tables back from `cursor`, `null` at the start, and compares counts and hashes with the manifest. */
export interface OpsImportVerify extends OpsImportScope {
	readonly step: 'verify'
	readonly cursor: OpsDumpCursor | null
}

/** Clears the import marker once every table verified, so Control may open the object. */
export interface OpsImportComplete extends OpsImportScope {
	readonly step: 'complete'
}

/** Wipes an `inspect` object that holds an import marker and serves no traffic, with `deleteAll()`. */
export interface OpsImportDiscard {
	readonly step: 'discard'
	readonly object: string
	readonly generation: number
}

/** `POST /__fabrika/ops/import`: one step of loading a consistent backup into a fresh object. */
export type OpsImportRequest = OpsImportBegin | OpsImportPart | OpsImportLink | OpsImportVerify | OpsImportComplete | OpsImportDiscard

export interface OpsImportBeginAck {
	readonly step: 'begin'
	readonly parts: number
}

/** `deferred` counts the loaded rows whose deferred foreign keys wait for the link pass. */
export interface OpsImportPartAck {
	readonly step: 'part'
	readonly part: number
	readonly rows: number
	readonly deferred: number
}

export interface OpsImportLinkAck {
	readonly step: 'link'
	readonly part: number
	readonly rows: number
}

/** The tables verified in this step, each matching the manifest, and where the next step starts: `null` once all match. */
export interface OpsImportVerifyAck {
	readonly step: 'verify'
	readonly tables: readonly OpsDumpTable[]
	readonly next: OpsDumpCursor | null
}

export interface OpsImportCompleteAck {
	readonly step: 'complete'
	readonly source: OpsDumpSource
}

export interface OpsImportDiscardAck {
	readonly step: 'discard'
}

export function parseOpsImportRequest(body: unknown): OpsImportRequest | null {
	const step = prop(body, 'step')
	const object = parseApplicationObjectName(prop(body, 'object'))
	const generation = readGeneration(prop(body, 'generation'))
	if (object === null || generation === null) return null
	if (step === 'discard') return exactKeys(body, ['step', 'object', 'generation']) ? { step, object, generation } : null
	const source = readSource(prop(body, 'source'))
	if (source === null) return null
	const scope = { object, generation, source }
	switch (step) {
		case 'begin':
		case 'complete':
			return exactKeys(body, [...IMPORT_SCOPE_KEYS, 'step']) ? { ...scope, step } : null
		case 'part':
		case 'link': {
			const part = readPartNumber(prop(body, 'part'))
			return exactKeys(body, [...IMPORT_SCOPE_KEYS, 'step', 'part']) && part !== null ? { ...scope, step, part } : null
		}
		case 'verify': {
			const cursor = readNullable(prop(body, 'cursor'), readCursor)
			return exactKeys(body, [...IMPORT_SCOPE_KEYS, 'step', 'cursor']) && cursor !== undefined ? { ...scope, step, cursor } : null
		}
		default:
			return null
	}
}

export function parseOpsImportBeginAck(body: unknown): OpsImportBeginAck | null {
	const parts = readPartNumber(prop(body, 'parts'))
	return exactKeys(body, ['step', 'parts']) && prop(body, 'step') === 'begin' && parts !== null ? { step: 'begin', parts } : null
}

export function parseOpsImportPartAck(body: unknown): OpsImportPartAck | null {
	if (!exactKeys(body, ['step', 'part', 'rows', 'deferred']) || prop(body, 'step') !== 'part') return null
	const part = readPartNumber(prop(body, 'part'))
	const rows = readCount(prop(body, 'rows'))
	const deferred = readCount(prop(body, 'deferred'))
	return part === null || rows === null || deferred === null ? null : { step: 'part', part, rows, deferred }
}

export function parseOpsImportLinkAck(body: unknown): OpsImportLinkAck | null {
	if (!exactKeys(body, ['step', 'part', 'rows']) || prop(body, 'step') !== 'link') return null
	const part = readPartNumber(prop(body, 'part'))
	const rows = readCount(prop(body, 'rows'))
	return part === null || rows === null ? null : { step: 'link', part, rows }
}

export function parseOpsImportVerifyAck(body: unknown): OpsImportVerifyAck | null {
	if (!exactKeys(body, ['step', 'tables', 'next']) || prop(body, 'step') !== 'verify') return null
	const tables = readTables(prop(body, 'tables'))
	const next = readNullable(prop(body, 'next'), readCursor)
	if (tables === null || next === undefined || continuesFinished(tables, next)) return null
	return { step: 'verify', tables, next }
}

export function parseOpsImportCompleteAck(body: unknown): OpsImportCompleteAck | null {
	const source = readSource(prop(body, 'source'))
	return exactKeys(body, ['step', 'source']) && prop(body, 'step') === 'complete' && source !== null ? { step: 'complete', source } : null
}

export function parseOpsImportDiscardAck(body: unknown): OpsImportDiscardAck | null {
	return exactKeys(body, ['step']) && prop(body, 'step') === 'discard' ? { step: 'discard' } : null
}

/**
 * Writes the sentinel (the operation's id) into the object's KV storage, and answers the current bookmark and the
 * bookmark of `at`, which Control records before it arms anything.
 */
export interface OpsRestorePrepare {
	readonly step: 'prepare'
	readonly object: string
	readonly generation: number
	readonly sentinel: string
	readonly at: string
}

/** Arms the restore of `target` for the next session, answers, then resets the object. */
export interface OpsRestoreArm {
	readonly step: 'arm'
	readonly object: string
	readonly generation: number
	readonly sentinel: string
	readonly target: string
}

/** Reads, after the reset, whether the sentinel is still there. It writes nothing, so it carries no generation. */
export interface OpsRestoreVerify {
	readonly step: 'verify'
	readonly object: string
	readonly sentinel: string
}

/** `POST /__fabrika/ops/restore`: one step of rewinding an `inspect` object that serves no traffic. */
export type OpsRestoreRequest = OpsRestorePrepare | OpsRestoreArm | OpsRestoreVerify

export interface OpsRestorePrepareAck {
	readonly step: 'prepare'
	readonly current: string
	readonly target: string
}

/** May be lost to the reset; `verify` reconciles. */
export interface OpsRestoreArmAck {
	readonly step: 'arm'
	readonly undo: string
}

/** A sentinel still present means the restore did not happen. */
export interface OpsRestoreVerifyAck {
	readonly step: 'verify'
	readonly sentinel: 'present' | 'absent'
	readonly bookmark: string
}

export function parseOpsRestoreRequest(body: unknown): OpsRestoreRequest | null {
	const step = prop(body, 'step')
	const object = parseApplicationObjectName(prop(body, 'object'))
	const sentinel = readMatch(prop(body, 'sentinel'), UUID)
	if (object === null || sentinel === null) return null
	if (step === 'verify') return exactKeys(body, ['step', 'object', 'sentinel']) ? { step, object, sentinel } : null
	const generation = readGeneration(prop(body, 'generation'))
	if (generation === null) return null
	if (step === 'prepare') {
		const at = readTimestamp(prop(body, 'at'))
		return exactKeys(body, ['step', 'object', 'generation', 'sentinel', 'at']) && at !== null ? { step, object, generation, sentinel, at } : null
	}
	if (step === 'arm') {
		const target = readMatch(prop(body, 'target'), OPAQUE_TOKEN)
		return exactKeys(body, ['step', 'object', 'generation', 'sentinel', 'target']) && target !== null
			? { step, object, generation, sentinel, target }
			: null
	}
	return null
}

export function parseOpsRestorePrepareAck(body: unknown): OpsRestorePrepareAck | null {
	if (!exactKeys(body, ['step', 'current', 'target']) || prop(body, 'step') !== 'prepare') return null
	const current = readMatch(prop(body, 'current'), OPAQUE_TOKEN)
	const target = readMatch(prop(body, 'target'), OPAQUE_TOKEN)
	return current === null || target === null ? null : { step: 'prepare', current, target }
}

export function parseOpsRestoreArmAck(body: unknown): OpsRestoreArmAck | null {
	const undo = readMatch(prop(body, 'undo'), OPAQUE_TOKEN)
	return exactKeys(body, ['step', 'undo']) && prop(body, 'step') === 'arm' && undo !== null ? { step: 'arm', undo } : null
}

export function parseOpsRestoreVerifyAck(body: unknown): OpsRestoreVerifyAck | null {
	if (!exactKeys(body, ['step', 'sentinel', 'bookmark']) || prop(body, 'step') !== 'verify') return null
	const sentinel = readEnum(prop(body, 'sentinel'), SENTINEL_STATES)
	const bookmark = readMatch(prop(body, 'bookmark'), OPAQUE_TOKEN)
	return sentinel === null || bookmark === null ? null : { step: 'verify', sentinel, bookmark }
}

/** The most timers one answer lists; the rest are counted in `omitted`. */
export const OPS_TIMERS_CAP = 500
/** A timer's stack keeps at most this many frames, the ones nearest the call that registered the work. */
export const OPS_TIMER_STACK_MAX_FRAMES = 20
/** A timer's stack is at most this many UTF-8 bytes, cut after it is scrubbed. */
export const OPS_TIMER_STACK_MAX_BYTES = 4 * 1024

/** `POST /__fabrika/ops/timers`: reads the tracker, or with `track` switches it on or off first. In memory only. */
export interface OpsTimersRequest {
	readonly object: string
	readonly track: boolean | null
}

/** A pending timer or `waitUntil` promise and the stack that registered it, which may name application code: content. */
export interface OpsTimer {
	readonly kind: 'timeout' | 'interval' | 'waitUntil'
	readonly since: string
	/** `null` exactly for `waitUntil`. */
	readonly delayMs: number | null
	readonly stack: string
}

/** The object's live timers, oldest first (`data.content.read`). */
export interface OpsTimersView {
	readonly tracking: boolean
	readonly timers: readonly OpsTimer[]
	readonly omitted: number
}

export function parseOpsTimersRequest(body: unknown): OpsTimersRequest | null {
	const object = parseApplicationObjectName(prop(body, 'object'))
	const track = prop(body, 'track')
	return exactKeys(body, ['object', 'track']) && object !== null && (track === null || typeof track === 'boolean') ? { object, track } : null
}

export function parseOpsTimersView(body: unknown): OpsTimersView | null {
	if (!exactKeys(body, ['tracking', 'timers', 'omitted'])) return null
	const tracking = prop(body, 'tracking')
	const raw = prop(body, 'timers')
	const timers = Array.isArray(raw) && raw.length <= OPS_TIMERS_CAP ? readList(raw, readTimer) : null
	const omitted = readCount(prop(body, 'omitted'))
	return typeof tracking !== 'boolean' || timers === null || omitted === null ? null : { tracking, timers, omitted }
}

/** The status of a data operation's refusal. It is answered only after authentication. */
export const OPS_DATA_REFUSED_STATUS = 422

/** Why the object refused an export, import or restore step. */
export const OPS_DATA_REFUSALS = [
	'wrong_mode',
	'serving_object',
	'unsupported_schema',
	'not_fresh',
	'no_import',
	'invalid_manifest',
	'fuzzy_dump',
	'part_mismatch',
	'ledger_mismatch',
	'schema_mismatch',
	'verify_mismatch',
	'bookmark_unavailable',
	'row_too_large',
] as const

export type OpsDataRefusalReason = (typeof OPS_DATA_REFUSALS)[number]

/** The body of a data refusal; `table` names the table at fault, an identifier and never a value. */
export interface OpsDataRefusal {
	readonly refused: OpsDataRefusalReason
	readonly table: string | null
}

export function parseOpsDataRefusal(body: unknown): OpsDataRefusal | null {
	const refused = readEnum(prop(body, 'refused'), OPS_DATA_REFUSALS)
	const table = readNullable(prop(body, 'table'), (value) => readMatch(value, TABLE_NAME))
	return exactKeys(body, ['refused', 'table']) && refused !== null && table !== undefined ? { refused, table } : null
}

const VIEW_KEYS = ['release', 'maintenance', 'database', 'migrations', 'scheduler', 'jobs', 'files', 'webhooks', 'bootFailure']
const FILE_STATUSES: readonly OpsFileStatus[] = ['pending', 'quarantined', 'live', 'rejected']
const WEBHOOK_STATES = ['claimed', 'completed'] as const
const JOB_STATUSES = ['succeeded', 'failed'] as const
/** The form `Date.prototype.toISOString` and SQLite's `%Y-%m-%dT%H:%M:%fZ` both write. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
/** `@fabrika/db`'s `isPlainIdentifier`: the only table names the data layer admits. */
const TABLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/
/** The contract build's authored-name rule (`@fabrika/app/contract`), which a file kind follows. */
const CONTRACT_NAME = /^[A-Za-z][A-Za-z0-9_]*$/
/** `@fabrika/db`'s SQLite migration runner: a bundle name, a migration file name and a file's SHA-256 hex. */
const MIGRATION_BUNDLE = /^[a-z][a-z0-9-]*$/
const MIGRATION_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.sql$/
const MIGRATION_CHECKSUM = /^[0-9a-f]{64}$/
const SHA256_HEX = /^[0-9a-f]{64}$/
/** A dump id or a sentinel: a UUID as Control writes one. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** A token R2 or the object hands out and nobody reads into: an upload id, an ETag, a bookmark. Printable ASCII, no space. */
const OPAQUE_TOKEN = /^[!-~]{1,1024}$/
/** The decimal text `cast(c as text)` writes for an integer: no leading zero, no `-0`. */
const INT64_TEXT = /^(?:0|-?[1-9][0-9]{0,18})$/
const INT64_MIN = -(2n ** 63n)
const INT64_MAX = 2n ** 63n - 1n
/**
 * `hex(c)` of a blob, and `hex(CAST(c AS BLOB))` of text. Bun's regex engine answers `false` for `^(?:[0-9A-F]{2})*$`
 * on a string of a few megabytes, so the pairing is a length check.
 */
function isBytesHex(value: string): boolean {
	return value.length % 2 === 0 && /^[0-9A-F]*$/.test(value)
}
const MANIFEST_KEYS = [
	'format',
	'dump',
	'object',
	'consistent',
	'createdAt',
	'bookmark',
	'release',
	'contractDigest',
	'ddl',
	'migrations',
	'tables',
	'parts',
]
const EXPORT_SCOPE_KEYS = ['object', 'generation', 'consistent', 'dump']
const IMPORT_SCOPE_KEYS = ['object', 'generation', 'source']
const SCHEMA_TYPES = ['table', 'index', 'trigger', 'view'] as const
const SENTINEL_STATES = ['present', 'absent'] as const
const TIMER_KINDS = ['timeout', 'interval', 'waitUntil'] as const

/** Every field of the view but the boot failure, whose form differs between the two views. */
function readViewFields(body: unknown): Omit<OpsView, 'bootFailure'> | null {
	if (!exactKeys(body, VIEW_KEYS)) return null
	const release = prop(body, 'release')
	const maintenance = readMaintenance(prop(body, 'maintenance'))
	const database = readDatabase(prop(body, 'database'))
	const migrations = readList(prop(body, 'migrations'), readMigration)
	const scheduler = readScheduler(prop(body, 'scheduler'))
	const jobs = readList(prop(body, 'jobs'), readJob)
	const files = readList(prop(body, 'files'), readFileCount)
	const webhooks = readList(prop(body, 'webhooks'), readWebhookCount)
	if (
		typeof release !== 'string' || !FRAMEWORK_RELEASE_PATTERN.test(release) || maintenance === null || database === null || migrations === null
		|| scheduler === null || jobs === null || files === null || webhooks === null
	) {
		return null
	}
	return { release, maintenance, database, migrations, scheduler, jobs, files, webhooks }
}

function readMaintenance(value: unknown): OpsMaintenance | null {
	if (!exactKeys(value, ['mode', 'generation', 'published'])) return null
	const mode = readMode(prop(value, 'mode'))
	const rawGeneration = prop(value, 'generation')
	const generation = rawGeneration === null ? null : readGeneration(rawGeneration)
	const published = prop(value, 'published')
	if (mode === null || (rawGeneration !== null && generation === null) || typeof published !== 'boolean') return null
	return { mode, generation, published }
}

function readDatabase(value: unknown): OpsDatabase | null {
	if (!exactKeys(value, ['sizeBytes', 'tables'])) return null
	const sizeBytes = readCount(prop(value, 'sizeBytes'))
	const tables = readList(prop(value, 'tables'), readTableCount)
	return sizeBytes === null || tables === null ? null : { sizeBytes, tables }
}

function readTableCount(value: unknown): OpsTableCount | null {
	if (!exactKeys(value, ['name', 'rows'])) return null
	const name = readMatch(prop(value, 'name'), TABLE_NAME)
	const rows = readCount(prop(value, 'rows'))
	return name === null || rows === null || rows > OPS_ROW_COUNT_CAP ? null : { name, rows }
}

function readMigration(value: unknown): OpsMigration | null {
	if (!exactKeys(value, ['bundle', 'name', 'checksum', 'appliedAt'])) return null
	const bundle = readMatch(prop(value, 'bundle'), MIGRATION_BUNDLE)
	const name = readMatch(prop(value, 'name'), MIGRATION_NAME)
	const checksum = readMatch(prop(value, 'checksum'), MIGRATION_CHECKSUM)
	const appliedAt = readTimestamp(prop(value, 'appliedAt'))
	return bundle === null || name === null || checksum === null || appliedAt === null ? null : { bundle, name, checksum, appliedAt }
}

function readScheduler(value: unknown): OpsScheduler | null {
	if (!exactKeys(value, ['alarm'])) return null
	const raw = prop(value, 'alarm')
	const alarm = raw === null ? null : readTimestamp(raw)
	return raw !== null && alarm === null ? null : { alarm }
}

/** A framework job of the application runtime (`fabrika-file-sweep`): reserved by its `-`, which no contract job name holds. */
const FRAMEWORK_JOB_NAME = /^fabrika-[a-z][a-z0-9-]{0,55}$/

function readJob(value: unknown): OpsJob | null {
	if (!exactKeys(value, ['job', 'lastStatus', 'lastStartedAt', 'lastFinishedAt', 'lastDurationMs'])) return null
	const raw = prop(value, 'job')
	const job = readMatch(raw, WORKLOAD_NAME) ?? readMatch(raw, FRAMEWORK_JOB_NAME)
	const lastStatus = readNullable(prop(value, 'lastStatus'), (status) => readEnum(status, JOB_STATUSES))
	const lastStartedAt = readNullable(prop(value, 'lastStartedAt'), readTimestamp)
	const lastFinishedAt = readNullable(prop(value, 'lastFinishedAt'), readTimestamp)
	const lastDurationMs = readNullable(prop(value, 'lastDurationMs'), readCount)
	if (job === null || lastStatus === undefined || lastStartedAt === undefined || lastFinishedAt === undefined || lastDurationMs === undefined) {
		return null
	}
	return { job, lastStatus, lastStartedAt, lastFinishedAt, lastDurationMs }
}

function readFileCount(value: unknown): OpsFileCount | null {
	if (!exactKeys(value, ['kind', 'status', 'count'])) return null
	const kind = readMatch(prop(value, 'kind'), CONTRACT_NAME)
	const status = readEnum(prop(value, 'status'), FILE_STATUSES)
	const count = readCount(prop(value, 'count'))
	return kind === null || status === null || count === null ? null : { kind, status, count }
}

function readWebhookCount(value: unknown): OpsWebhookCount | null {
	if (!exactKeys(value, ['webhook', 'state', 'count'])) return null
	const webhook = readMatch(prop(value, 'webhook'), WORKLOAD_NAME)
	const state = readEnum(prop(value, 'state'), WEBHOOK_STATES)
	const count = readCount(prop(value, 'count'))
	return webhook === null || state === null || count === null ? null : { webhook, state, count }
}

/** `undefined` for a value that is no boot failure; the caller reads `null` as none before calling. */
function readBootFailure(value: unknown): OpsBootFailure | undefined {
	const at = readTimestamp(prop(value, 'at'))
	return exactKeys(value, ['at']) && at !== null ? { at } : undefined
}

function readBootFailureContent(value: unknown): OpsBootFailureContent | undefined {
	if (!exactKeys(value, ['at', 'message', 'stack'])) return undefined
	const at = readTimestamp(prop(value, 'at'))
	const message = prop(value, 'message')
	const stack = prop(value, 'stack')
	if (at === null || typeof message !== 'string' || (stack !== null && typeof stack !== 'string')) return undefined
	return { at, message, stack }
}

/** Whether `value` is a plain object holding exactly `keys`: no key missing, none unknown. */
function exactKeys(value: unknown, keys: readonly string[]): boolean {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
	const own = Object.keys(value)
	return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function readList<T>(value: unknown, read: (item: unknown) => T | null): readonly T[] | null {
	if (!Array.isArray(value)) return null
	const items: T[] = []
	for (const item of value) {
		const parsed = read(item)
		if (parsed === null) return null
		items.push(parsed)
	}
	return items
}

/** `null` stays `null`; anything else is read, and `undefined` marks a value `read` refused. */
function readNullable<T>(value: unknown, read: (value: unknown) => T | null): T | null | undefined {
	if (value === null) return null
	return read(value) ?? undefined
}

function readEnum<T extends string>(value: unknown, members: readonly T[]): T | null {
	return members.find((member) => member === value) ?? null
}

function readMode(value: unknown): OpsMode | null {
	return readEnum(value, OPS_MODES)
}

/** A generation Control allocated: a positive safe integer. */
function readGeneration(value: unknown): number | null {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function readCount(value: unknown): number | null {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** An identifier the platform or the contract names, in its owner's format: free text never fits one. */
function readMatch(value: unknown, pattern: RegExp): string | null {
	return typeof value === 'string' && pattern.test(value) ? value : null
}

/** `Date` rolls an impossible date over (`02-31` to `03-03`), so the instant must print back as the same text. */
function readTimestamp(value: unknown): string | null {
	if (typeof value !== 'string' || !TIMESTAMP.test(value)) return null
	const instant = new Date(value)
	return !Number.isNaN(instant.getTime()) && instant.toISOString() === value ? value : null
}

/** `undefined` for text that is no JSON; every reader refuses it. */
function parseJson(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

// The errors name the rule a value broke and never the value, which is a tenant's data.
function encodeValue(value: OpsDumpValue): string | null {
	if (value === null) return null
	switch (value.type) {
		case 'integer':
			if (!isInt64Text(value.value)) throw new Error('a dump integer must be the decimal text of a 64-bit integer')
			return `i:${value.value}`
		case 'real':
			if (Number.isNaN(value.value)) throw new Error('a dump real must not be NaN')
			return `r:${realText(value.value)}`
		case 'text':
			if (!isBytesHex(value.value)) throw new Error('dump text must be the upper-case hex of its bytes')
			return `t:${value.value}`
		case 'blob':
			if (!isBytesHex(value.value)) throw new Error('a dump blob must be upper-case hex')
			return `b:${value.value}`
	}
}

/** ECMAScript's shortest text that reads back as the same double, with the sign of a negative zero kept. */
function realText(value: number): string {
	return Object.is(value, -0) ? '-0' : String(value)
}

function isInt64Text(text: string): boolean {
	if (!INT64_TEXT.test(text)) return false
	const value = BigInt(text)
	return value >= INT64_MIN && value <= INT64_MAX
}

/** `undefined` for an encoded value outside the rules; `null` is SQL's NULL. */
function readValue(raw: unknown): OpsDumpValue | undefined {
	if (raw === null) return null
	if (typeof raw !== 'string') return undefined
	const text = raw.slice(2)
	switch (raw.slice(0, 2)) {
		case 'i:':
			return isInt64Text(text) ? { type: 'integer', value: text } : undefined
		case 'r:': {
			const value = Number(text)
			return !Number.isNaN(value) && realText(value) === text ? { type: 'real', value } : undefined
		}
		case 't:':
			return isBytesHex(text) ? { type: 'text', value: text } : undefined
		case 'b:':
			return isBytesHex(text) ? { type: 'blob', value: text } : undefined
		default:
			return undefined
	}
}

function readRowValues(raw: unknown): OpsDumpValue[] | null {
	if (!Array.isArray(raw)) return null
	const values: OpsDumpValue[] = []
	for (const item of raw) {
		const value = readValue(item)
		if (value === undefined) return null
		values.push(value)
	}
	return values
}

function readCursor(value: unknown): OpsDumpCursor | null {
	if (!exactKeys(value, ['table', 'after', 'rows', 'hash'])) return null
	const table = readMatch(prop(value, 'table'), TABLE_NAME)
	const after = readNullable(prop(value, 'after'), readRowid)
	const rows = readCount(prop(value, 'rows'))
	const hash = readMatch(prop(value, 'hash'), SHA256_HEX)
	if (table === null || after === undefined || rows === null || hash === null) return null
	// Before a table's first row nothing is folded; past a row, at least that row is.
	if ((after === null) !== (rows === 0) || (rows === 0 && hash !== OPS_EMPTY_TABLE_HASH)) return null
	return { table, after, rows, hash }
}

function readRowid(value: unknown): string | null {
	return typeof value === 'string' && isInt64Text(value) ? value : null
}

/** Tables in load order, each named once. */
function readTables(value: unknown): readonly OpsDumpTable[] | null {
	const tables = readList(value, readDumpTable)
	return tables !== null && distinct(tables.map((table) => table.name)) ? tables : null
}

function readDumpTable(value: unknown): OpsDumpTable | null {
	if (!exactKeys(value, ['name', 'rows', 'hash'])) return null
	const name = readMatch(prop(value, 'name'), TABLE_NAME)
	const rows = readCount(prop(value, 'rows'))
	const hash = readMatch(prop(value, 'hash'), SHA256_HEX)
	if (name === null || rows === null || hash === null || (rows === 0 && hash !== OPS_EMPTY_TABLE_HASH)) return null
	return { name, rows, hash }
}

function readDumpPart(value: unknown): OpsDumpPart | null {
	if (!exactKeys(value, ['part', 'size', 'sha256'])) return null
	return readPartFields(value)
}

function readUploadedPart(value: unknown): OpsUploadedPart | null {
	if (!exactKeys(value, ['part', 'size', 'sha256', 'etag'])) return null
	const fields = readPartFields(value)
	const etag = readMatch(prop(value, 'etag'), OPAQUE_TOKEN)
	return fields === null || etag === null ? null : { ...fields, etag }
}

function readPartFields(value: unknown): OpsDumpPart | null {
	const part = readPartNumber(prop(value, 'part'))
	const size = readCount(prop(value, 'size'))
	const sha256 = readMatch(prop(value, 'sha256'), SHA256_HEX)
	return part === null || size === null || size === 0 || size > OPS_DUMP_PART_SIZE || sha256 === null ? null : { part, size, sha256 }
}

/** Every part of an upload: numbered 1 to n without a gap, each of the fixed size but the last. */
function readWholeParts<T extends OpsDumpPart>(value: unknown, read: (item: unknown) => T | null): readonly T[] | null {
	const parts = readList(value, read)
	if (parts === null || parts.length === 0 || parts.length > OPS_DUMP_MAX_PARTS) return null
	const whole = parts.every((part, index) => part.part === index + 1 && (index === parts.length - 1 || part.size === OPS_DUMP_PART_SIZE))
	return whole ? parts : null
}

function readPartNumber(value: unknown): number | null {
	const part = readGeneration(value)
	return part !== null && part <= OPS_DUMP_MAX_PARTS ? part : null
}

function readSchemaEntry(value: unknown): OpsDumpSchemaEntry | null {
	if (!exactKeys(value, ['type', 'name', 'table', 'sql'])) return null
	const type = readEnum(prop(value, 'type'), SCHEMA_TYPES)
	const name = prop(value, 'name')
	const table = prop(value, 'table')
	const sql = prop(value, 'sql')
	if (type === null || typeof name !== 'string' || name === '' || typeof table !== 'string' || table === '' || typeof sql !== 'string' || sql === '') {
		return null
	}
	// A table's entry names itself; an index or a trigger names any table or view, which the importer compares as text.
	if (type === 'table' && (name !== table || !TABLE_NAME.test(name))) return null
	return { type, name, table, sql }
}

function readExportScope(body: unknown): OpsExportScope | null {
	const object = parseApplicationObjectName(prop(body, 'object'))
	const generation = readNullable(prop(body, 'generation'), readGeneration)
	const consistent = prop(body, 'consistent')
	const dump = readMatch(prop(body, 'dump'), UUID)
	if (object === null || generation === undefined || typeof consistent !== 'boolean' || dump === null) return null
	return consistent === (generation !== null) ? { object, generation, consistent, dump } : null
}

function readSource(value: unknown): OpsDumpSource | null {
	if (!exactKeys(value, ['object', 'dump'])) return null
	const object = parseApplicationObjectName(prop(value, 'object'))
	const dump = readMatch(prop(value, 'dump'), UUID)
	return object === null || dump === null ? null : { object, dump }
}

function boundedStack(stack: string): boolean {
	return new TextEncoder().encode(stack).length <= OPS_TIMER_STACK_MAX_BYTES && stack.split('\n').length <= OPS_TIMER_STACK_MAX_FRAMES
}

function readTimer(value: unknown): OpsTimer | null {
	if (!exactKeys(value, ['kind', 'since', 'delayMs', 'stack'])) return null
	const kind = readEnum(prop(value, 'kind'), TIMER_KINDS)
	const since = readTimestamp(prop(value, 'since'))
	const delayMs = readNullable(prop(value, 'delayMs'), readCount)
	const stack = prop(value, 'stack')
	if (kind === null || since === null || delayMs === undefined || typeof stack !== 'string' || !boundedStack(stack)) return null
	return (kind === 'waitUntil') === (delayMs === null) ? { kind, since, delayMs, stack } : null
}

/** A foreign key with its parent's columns named. */
interface ResolvedForeignKey {
	readonly parent: string
	readonly columns: readonly string[]
	readonly references: readonly string[]
}

interface DescribedTable {
	readonly table: OpsDumpSchemaTable
	readonly keyset: string
	readonly parents: readonly ResolvedForeignKey[]
}

const ROWID_NAMES = ['rowid', '_rowid_', 'oid']

function unsupported(table: string | null): OpsDataRefusal {
	return { refused: 'unsupported_schema', table }
}

/** A rowid table's `INTEGER PRIMARY KEY` is the rowid itself; any other primary key gets an automatic index (`origin` `pk`). */
function rowidName(table: OpsDumpSchemaTable): string | null {
	const key = table.columns.filter((column) => column.primaryKey > 0)
	const [only] = key
	if (key.length === 1 && only !== undefined && asciiLower(only.type) === 'integer' && !table.indexes.some((index) => index.origin === 'pk')) {
		return only.name
	}
	const taken = new Set(table.columns.map((column) => asciiLower(column.name)))
	return ROWID_NAMES.find((name) => !taken.has(name)) ?? null
}

function resolveForeignKeys(table: OpsDumpSchemaTable, tables: ReadonlyMap<string, OpsDumpSchemaTable>): readonly ResolvedForeignKey[] | null {
	const keys: ResolvedForeignKey[] = []
	for (const key of table.foreignKeys) {
		const parent = tables.get(asciiLower(key.parent))
		if (parent === undefined || key.initiallyDeferred || key.columns.length === 0) return null
		const primaryKey = parent.columns.filter((column) => column.primaryKey > 0).sort((left, right) => left.primaryKey - right.primaryKey)
		const references = key.references ?? primaryKey.map((column) => column.name)
		if (references.length !== key.columns.length) return null
		keys.push({ parent: parent.name, columns: key.columns, references })
	}
	return keys
}

/** Each table's cycle, named by its first table: two tables share one exactly when each reaches the other through parents. */
function cycleIds(tables: readonly DescribedTable[]): ReadonlyMap<string, string> {
	const parents = new Map(tables.map(({ table, parents }) => [table.name, parents]))
	const reach = new Map<string, ReadonlySet<string>>()
	for (const { table } of tables) {
		const seen = new Set<string>()
		const pending = [table.name]
		for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
			for (const key of parents.get(name) ?? []) {
				if (!seen.has(key.parent)) {
					seen.add(key.parent)
					pending.push(key.parent)
				}
			}
		}
		reach.set(table.name, seen)
	}
	const ids = new Map<string, string>()
	for (const { table } of tables) {
		const first = tables.find(({ table: other }) => reach.get(table.name)?.has(other.name) === true && reach.get(other.name)?.has(table.name) === true)
		ids.set(table.name, first === undefined || compareNames(first.table.name, table.name) > 0 ? table.name : first.table.name)
	}
	return ids
}

/** Repeatedly the first table by name whose every parent outside its own cycle is placed. */
function loadOrder(tables: readonly DescribedTable[], cycle: ReadonlyMap<string, string>): readonly DescribedTable[] {
	const placed = new Set<string>()
	const order: DescribedTable[] = []
	while (order.length < tables.length) {
		const next = tables.find(({ table, parents }) =>
			!placed.has(table.name) && parents.every((key) => placed.has(key.parent) || cycle.get(key.parent) === cycle.get(table.name))
		)
		// The cycles form a directed acyclic graph, so one always has every outside parent placed.
		if (next === undefined) throw new Error('a foreign-key graph without a table to place')
		placed.add(next.table.name)
		order.push(next)
	}
	return order
}

/** Whether every deferred column of `table` can hold `NULL` from its part until the link pass, with nothing to violate. */
function takesTemporaryNull(table: OpsDumpSchemaTable, deferred: readonly OpsDumpSchemaColumn[], referenced: ReadonlySet<string>): boolean {
	if (table.checked || table.columns.some((column) => column.generated && column.notNull)) return false
	if (table.indexes.some((index) => index.unique && (index.partial || index.columns.includes(null)))) return false
	return deferred.every((column) => !column.notNull && column.primaryKey === 0 && !referenced.has(columnKey(table.name, column.name)))
}

function columnKey(table: string, column: string): string {
	return `${table}\n${asciiLower(column)}`
}

/** SQLite compares identifiers case-insensitively in ASCII only. */
function asciiLower(value: string): string {
	return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
}

/** Code-unit order, which no locale changes. */
function compareNames(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0
}

function quoteIdentifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`
}

function hexBytes(hex: string): Uint8Array {
	if (!isBytesHex(hex)) throw new Error('dump bytes must be upper-case hex')
	const bytes = new Uint8Array(hex.length / 2)
	for (let index = 0; index < bytes.length; index++) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
	return bytes
}

/** Whether a cursor resumes a table the same answer reports finished. */
function continuesFinished(tables: readonly OpsDumpTable[], next: OpsDumpCursor | null): boolean {
	return next !== null && tables.some((table) => table.name === next.table)
}

function utf8Length(text: string): number {
	return new TextEncoder().encode(text).length
}

function distinct(values: readonly string[]): boolean {
	return new Set(values).size === values.length
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
	const names = new Set(left)
	return distinct(left) && distinct(right) && left.length === right.length && right.every((name) => names.has(name))
}
