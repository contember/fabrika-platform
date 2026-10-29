// One step of loading a consistent backup into a fresh object (ADR-0070 §6): the ops operation `import`, served before
// the application boots. Control drives the steps and holds their state; the object keeps only its import marker and
// the steps' receipts in KV storage, which every step that writes updates in the same `transactionSync` as its rows.
// Every step runs in the maintenance barrier's turn, so no transition interleaves with it.

import {
	decodeOpsDumpLine,
	describeOpsDumpSchema,
	encodeOpsDumpRow,
	foldOpsTableHash,
	OPS_DATA_REFUSED_STATUS,
	OPS_DUMP_KEY,
	OPS_DUMP_MANIFEST_MAX_BYTES,
	OPS_DUMP_PAGE_ROWS,
	OPS_DUMP_PART_MAX_RAW_BYTES,
	OPS_DUMP_PART_MAX_ROWS,
	OPS_DUMP_PART_SIZE,
	OPS_EMPTY_TABLE_HASH,
	OPS_STALE_STATUS,
	type OpsDataRefusal,
	type OpsDataRefusalReason,
	type OpsDumpBinding,
	type OpsDumpCursor,
	type OpsDumpLine,
	type OpsDumpManifest,
	opsDumpRowidSql,
	type OpsDumpSchema,
	type OpsDumpSchemaEntry,
	type OpsDumpSource,
	type OpsDumpTable,
	type OpsDumpTablePlan,
	type OpsDumpValue,
	opsDumpValueBinding,
	type OpsImportBeginAck,
	type OpsImportCompleteAck,
	type OpsImportDiscardAck,
	type OpsImportLinkAck,
	type OpsImportPartAck,
	type OpsImportRequest,
	type OpsImportVerifyAck,
	type OpsStaleRefusal,
	parseOpsImportCompleteAck,
	parseOpsImportLinkAck,
	parseOpsImportPartAck,
	parseOpsImportVerifyAck,
	planOpsDump,
	readOpsDumpManifest,
	readOpsDumpPage,
	sha256Hex,
} from '@fabrika/auth-core'
import type { SqliteStorage, SqliteValue } from '@fabrika/db/sqlite'
import { migrateSqlite, type SqliteMigrationBundle } from '@fabrika/db/sqlite-migrate'
import { jsonResponse } from '../errors.js'
import { method } from './bindings.js'
import type { MaintenanceBarrier, TurnStep } from './maintenance.js'
import type { OpsTarget } from './ops.js'

/**
 * One step of loading a dump into a fresh object (ADR-0070); `serving` is the object of ordinary traffic. A runtime
 * whose storage has no synchronous KV or `deleteAll` does not serve the operation.
 */
export async function serveImport(target: OpsTarget, barrier: MaintenanceBarrier, step: OpsImportRequest, serving: string): Promise<Response> {
	const { storage } = target
	const { kv, deleteAll } = storage
	if (kv === undefined || deleteAll === undefined) {
		return jsonResponse({ refused: 'not_implemented' }, 501)
	}
	const importing: ImportStorage = {
		sql: storage.sql,
		transaction: (closure) => storage.transaction(closure),
		transactionSync: (closure) => storage.transactionSync(closure),
		kv,
		deleteAll: () => deleteAll.call(storage),
	}
	return await importStep({ storage: importing, bucket: target.bucket, migrations: target.migrations, serving }, barrier, step)
}

/** workerd's synchronous KV storage of a SQLite-backed object: it lives in the same database, so it commits with a transaction. */
export interface ImportKv {
	get(key: string): unknown
	put(key: string, value: unknown): void
	delete(key: string): boolean
}

/** What the importer needs of the object's storage; a SQLite-backed `DurableObjectStorage` fits it. */
export interface ImportStorage extends SqliteStorage {
	readonly kv: ImportKv
	/** Wipes the object's database, its KV storage and its alarm. */
	deleteAll(): Promise<void>
}

/** The object an import step loads into. */
export interface ImportTarget {
	readonly storage: ImportStorage
	/** The environment's bucket (the `FABRIKA_FILES` R2 binding), where the backup lies. */
	readonly bucket: unknown
	/** The release's migration bundles in the order the object applies them: the framework's, then the application's. */
	readonly migrations: readonly SqliteMigrationBundle[]
	/** The object of ordinary traffic (`FABRIKA_APPLICATION_OBJECT`), which `discard` never wipes. */
	readonly serving: string
}

/** The KV key of the import marker. Invariant: an object that holds it never boots and never leaves `inspect`. */
export const IMPORT_MARKER_KEY = 'fabrika:import'

/** Whether the object holds an import marker, so it must neither boot nor leave `inspect`. */
export function importInProgress(storage: { readonly kv: ImportKv }): boolean {
	return storage.kv.get(IMPORT_MARKER_KEY) !== undefined
}

/** The KV key under which part `part` records its acknowledgement once loaded, so a retry loads nothing twice. */
function loadedPartKey(part: number): string {
	return `${IMPORT_MARKER_KEY}:part:${part}`
}

/** The KV key under which part `part`'s link pass records its acknowledgement. */
function linkedPartKey(part: number): string {
	return `${IMPORT_MARKER_KEY}:link:${part}`
}

/**
 * The KV key of the receipt `complete` leaves for `source`, so a retried `complete` answers the same. It blocks nothing
 * and stays for the object's life: `begin` takes only a fresh object, so an object completes one import.
 */
function completedKey(source: OpsDumpSource): string {
	return `${IMPORT_MARKER_KEY}:complete:${source.object}/${source.dump}`
}

/**
 * The marker: the backup the object is loading, whether `begin` cleared the target, how many parts are loaded, and the
 * verification of what is loaded now: `null` for none, else the cursor its next step must carry (`null` once every
 * table matched the manifest) and the last step's cursor with its answer, which a retry of that step gets again. A
 * part or a link pass that writes resets it.
 */
interface ImportMarker {
	readonly source: OpsDumpSource
	readonly begun: boolean
	readonly loaded: number
	readonly verified: Verification | null
}

interface Verification {
	readonly next: string | null
	/** `null` after a step that started the verification, which a retry starts again. */
	readonly replay: { readonly cursor: string; readonly ack: OpsImportVerifyAck } | null
}

/**
 * One step of loading the consistent backup `step.source` into the fresh object `target` (ADR-0070 §6), in the
 * barrier's turn: ADR-0069's stale refusal unless `step.generation` is the published one, then `serving_object` on the
 * object of ordinary traffic, then `wrong_mode` unless `inspect`. The turn is held across the step's R2 reads, so the
 * generation and mode it was admitted under still hold when it commits.
 */
export async function importStep(target: ImportTarget, barrier: MaintenanceBarrier, step: OpsImportRequest): Promise<Response> {
	const result = await barrier.step(step.generation, async (mode): Promise<TurnStep<Response>> => {
		if (step.object === target.serving) {
			return answered(refused('serving_object'))
		}
		if (mode !== 'inspect') {
			return answered(refused('wrong_mode'))
		}
		if (step.step !== 'verify') {
			await barrier.restrictedWrite()
		}
		return answered(await admittedStep(target, step))
	})
	if (result.kind === 'ran') {
		return result.value
	}
	const refusal: OpsStaleRefusal = { refused: 'stale_generation', published: result.published }
	return jsonResponse(refusal, OPS_STALE_STATUS)
}

async function admittedStep(target: ImportTarget, step: OpsImportRequest): Promise<Response> {
	const { kv } = target.storage
	if (step.step === 'discard') {
		return await discard(target)
	}
	if (step.step === 'begin') {
		return await begin(target, step.source)
	}
	if (importing(kv, step.source) === null) {
		const completed = step.step === 'complete' ? readCompleted(kv, step.source) : null
		return completed === null ? refused('no_import') : jsonResponse(completed, 200)
	}
	const manifest = await readManifest(target.bucket, step.source)
	if (manifest === null) {
		return refused('invalid_manifest')
	}
	if (step.step === 'complete') {
		return complete(target.storage, step.source, manifest)
	}
	const plan = currentPlan(target.storage, manifest)
	if ('refused' in plan) {
		return jsonResponse(plan, OPS_DATA_REFUSED_STATUS)
	}
	switch (step.step) {
		case 'part':
			return await loadPart(target, step.source, manifest, plan, step.part)
		case 'link':
			return await linkPart(target, step.source, manifest, plan, step.part)
		case 'verify':
			return verify(target.storage, step.source, manifest, plan, step.cursor)
	}
}

function answered(response: Response): TurnStep<Response> {
	return { value: response, holdUntil: null }
}

/** The marker, when it names `source` and records `begin` done; `null` otherwise. */
function importing(kv: ImportKv, source: OpsDumpSource): ImportMarker | null {
	const marker = readMarker(kv)
	return marker?.begun === true && sameSource(marker.source, source) ? marker : null
}

/**
 * Verifies the manifest, checks the target is fresh, writes the marker, migrates the target to exactly the manifest's
 * ledger, checks the schema and its plan, then clears the target in one transaction that records `begin` done. A retry
 * under the same backup resumes after what the marker records.
 */
async function begin(target: ImportTarget, source: OpsDumpSource): Promise<Response> {
	const { storage } = target
	const manifest = await readManifest(target.bucket, source)
	if (manifest === null) {
		return refused('invalid_manifest')
	}
	if (!manifest.consistent) {
		return refused('fuzzy_dump')
	}
	const marker = readMarker(storage.kv)
	if (marker !== null && !sameSource(marker.source, source)) {
		return refused('not_fresh')
	}
	if (marker?.begun === true) {
		return beginAck(manifest)
	}
	if (marker === null && holdsTables(storage)) {
		return refused('not_fresh')
	}
	const bundles = ledgerBundles(target.migrations, manifest)
	if (bundles === null) {
		return refused('ledger_mismatch')
	}
	if (marker === null) {
		writeMarker(storage.kv, { source, begun: false, loaded: 0, verified: null })
	}
	// A database the framework never migrated has no ledger, and gets none.
	if (manifest.migrations.length > 0) {
		await migrateSqlite(
			{ exec: (query, ...bindings) => storage.sql.exec(query, ...bindings), transactionSync: (fn) => storage.transactionSync(fn) },
			bundles,
		)
	}
	if (!sameDdl(readDdl(storage), manifest.ddl)) {
		return refused('schema_mismatch')
	}
	const plan = currentPlan(storage, manifest)
	if ('refused' in plan) {
		return jsonResponse(plan, OPS_DATA_REFUSED_STATUS)
	}
	storage.transactionSync(() => {
		for (const entry of readDdl(storage)) {
			if (entry.type === 'trigger') {
				storage.sql.exec(`DROP TRIGGER ${quote(entry.name)}`)
			}
		}
		// Every deferred column takes a temporary NULL (the schema rule), so no row of its cycle references another one after this.
		for (const table of plan) {
			if (table.deferred.length > 0) {
				storage.sql.exec(`UPDATE ${quote(table.name)} SET ${table.deferred.map((column) => `${quote(column)} = NULL`).join(', ')}`)
			}
		}
		for (const table of [...plan].reverse()) {
			storage.sql.exec(`DELETE FROM ${quote(table.name)}`)
		}
		writeMarker(storage.kv, { source, begun: true, loaded: 0, verified: null })
	})
	return beginAck(manifest)
}

function beginAck(manifest: OpsDumpManifest): Response {
	const ack: OpsImportBeginAck = { step: 'begin', parts: manifest.parts.length }
	return jsonResponse(ack, 200)
}

/**
 * Inserts part `part`'s rows with their rowids, every value through the wire's binding and every deferred column as
 * NULL, in one transaction that reads the marker and the part's receipt again, records the part and resets the
 * verification.
 */
async function loadPart(target: ImportTarget, source: OpsDumpSource, manifest: OpsDumpManifest, plan: readonly OpsDumpTablePlan[], part: number) {
	const { storage } = target
	const recorded = readLoadedPart(storage.kv, part)
	if (recorded !== null) {
		return jsonResponse(recorded, 200)
	}
	const lines = await readPart(target.bucket, source, manifest, plan, part)
	if (!Array.isArray(lines)) {
		return jsonResponse(lines, OPS_DATA_REFUSED_STATUS)
	}
	const tables = new Map(plan.map((table) => [table.name, table]))
	const ack = storage.transactionSync((): OpsImportPartAck | OpsDataRefusal => {
		const marker = importing(storage.kv, source)
		if (marker === null) {
			return { refused: 'no_import', table: null }
		}
		const again = readLoadedPart(storage.kv, part)
		if (again !== null) {
			return again
		}
		let deferred = 0
		for (const { table: name, row } of lines) {
			const table = planned(tables, name)
			if (insertRow(storage, table, row)) {
				deferred++
			}
		}
		const loaded: OpsImportPartAck = { step: 'part', part, rows: lines.length, deferred }
		storage.kv.put(loadedPartKey(part), JSON.stringify(loaded))
		writeMarker(storage.kv, { ...marker, loaded: marker.loaded + 1, verified: null })
		return loaded
	})
	return jsonResponse(ack, 'refused' in ack ? OPS_DATA_REFUSED_STATUS : 200)
}

/** Writes one row; answers whether it has a deferred key for the link pass to set. */
function insertRow(storage: SqliteStorage, table: OpsDumpTablePlan, row: readonly OpsDumpValue[]): boolean {
	const [rowid, ...values] = row
	// Inline, so a row of a table at workerd's column limit binds no more parameters than its columns.
	const key = opsDumpRowidSql(rowid ?? null)
	const columns: string[] = [table.keyset]
	const keys: string[] = [key]
	const bindings: OpsDumpBinding[] = []
	let waits = false
	for (const [index, column] of table.columns.entries()) {
		const value = values[index] ?? null
		// An INTEGER PRIMARY KEY column is the rowid itself, written once.
		if (column === table.keyset) {
			continue
		}
		const deferred = table.deferred.includes(column)
		waits ||= deferred && value !== null
		const binding = opsDumpValueBinding(deferred ? null : value)
		columns.push(column)
		keys.push(binding.sql)
		bindings.push(binding)
	}
	if (table.name === SQLITE_SEQUENCE) {
		// Loading an AUTOINCREMENT table writes its own counter row; the source's row replaces it, whichever table loads first.
		const name = opsDumpValueBinding(values[0] ?? null)
		storage.sql.exec(`DELETE FROM ${SQLITE_SEQUENCE} WHERE rowid = ${key} OR name = ${name.sql}`, ...params([name]))
	}
	storage.sql.exec(
		`INSERT INTO ${quote(table.name)} (${columns.map(quote).join(', ')}) VALUES (${keys.join(', ')})`,
		...params(bindings),
	)
	return waits
}

/**
 * Sets the deferred keys of part `part`'s rows by their rowids, once every part is loaded, in one transaction that
 * reads the marker and the pass's receipt again, records the pass and resets the verification.
 */
async function linkPart(target: ImportTarget, source: OpsDumpSource, manifest: OpsDumpManifest, plan: readonly OpsDumpTablePlan[], part: number) {
	const { storage } = target
	const recorded = readLinkedPart(storage.kv, part)
	if (recorded !== null) {
		return jsonResponse(recorded, 200)
	}
	if (importing(storage.kv, source)?.loaded !== manifest.parts.length) {
		return refused('part_mismatch')
	}
	const lines = await readPart(target.bucket, source, manifest, plan, part)
	if (!Array.isArray(lines)) {
		return jsonResponse(lines, OPS_DATA_REFUSED_STATUS)
	}
	const tables = new Map(plan.map((table) => [table.name, table]))
	const ack = storage.transactionSync((): OpsImportLinkAck | OpsDataRefusal => {
		const marker = importing(storage.kv, source)
		if (marker === null) {
			return { refused: 'no_import', table: null }
		}
		if (marker.loaded !== manifest.parts.length) {
			return { refused: 'part_mismatch', table: null }
		}
		const again = readLinkedPart(storage.kv, part)
		if (again !== null) {
			return again
		}
		let linked = 0
		for (const { table: name, row } of lines) {
			const table = planned(tables, name)
			const [rowid, ...values] = row
			const deferred = table.columns.flatMap((column, index) => table.deferred.includes(column) ? [{ column, value: values[index] ?? null }] : [])
			if (deferred.every(({ value }) => value === null)) {
				continue
			}
			const sets = deferred.map(({ column, value }) => ({ column, binding: opsDumpValueBinding(value) }))
			storage.sql.exec(
				`UPDATE ${quote(table.name)} SET ${sets.map(({ column, binding }) => `${quote(column)} = ${binding.sql}`).join(', ')} WHERE ${
					quote(table.keyset)
				} = ${opsDumpRowidSql(rowid ?? null)}`,
				...params(sets.map(({ binding }) => binding)),
			)
			linked++
		}
		const done: OpsImportLinkAck = { step: 'link', part, rows: linked }
		storage.kv.put(linkedPartKey(part), JSON.stringify(done))
		writeMarker(storage.kv, { ...marker, verified: null })
		return done
	})
	return jsonResponse(ack, 'refused' in ack ? OPS_DATA_REFUSED_STATUS : 200)
}

/**
 * Reads the loaded tables back from `cursor` with the producer's projection and fold, at most a part's row bound per
 * step, and compares each finished table with the manifest. A verification starts at `null`; any other cursor must be
 * the one the marker records this verification handed out last, or the one its last step was sent, whose answer it
 * repeats. It writes no row: only its progress, into the marker, which a mismatch clears.
 */
function verify(
	storage: ImportStorage,
	source: OpsDumpSource,
	manifest: OpsDumpManifest,
	plan: readonly OpsDumpTablePlan[],
	cursor: OpsDumpCursor | null,
): Response {
	const marker = importing(storage.kv, source)
	if (marker === null) {
		return refused('no_import')
	}
	const mismatch = (table: string | null): Response => {
		writeMarker(storage.kv, { ...marker, verified: null })
		return refused('verify_mismatch', table)
	}
	if (cursor !== null) {
		const key = cursorKey(cursor)
		const replay = marker.verified?.replay ?? null
		// Its answer was lost: what is loaded has not changed since, or the verification would be reset.
		if (replay?.cursor === key) {
			return jsonResponse(replay.ack, 200)
		}
		if ((marker.verified?.next ?? null) !== key) {
			return mismatch(cursor.table)
		}
	}
	const tables = new Map(plan.map((table) => [table.name, table]))
	const order = manifest.tables
	let index = cursor === null ? 0 : order.findIndex((table) => table.name === cursor.table)
	if (index < 0) {
		return mismatch(cursor?.table ?? null)
	}
	const startOf = (table: OpsDumpTable | undefined): OpsDumpCursor | null =>
		table === undefined ? null : { table: table.name, after: null, rows: 0, hash: OPS_EMPTY_TABLE_HASH }
	let current = cursor ?? startOf(order[0])
	const finished: OpsDumpTable[] = []
	let budget = OPS_DUMP_PART_MAX_ROWS
	while (current !== null && budget > 0) {
		const expected = order[index]
		if (expected === undefined) {
			throw new Error('a verify cursor past the last table of the manifest')
		}
		const page = readPage(storage, planned(tables, expected.name), current.after)
		const last = page.at(-1)?.[0]
		current = {
			table: expected.name,
			after: last?.type === 'integer' ? last.value : current.after,
			rows: current.rows + page.length,
			hash: foldOpsTableHash(current.hash, page.map((row) => encodeOpsDumpRow(row))),
		}
		budget -= page.length
		if (current.rows > expected.rows) {
			return mismatch(expected.name)
		}
		if (page.length < OPS_DUMP_PAGE_ROWS) {
			if (current.rows !== expected.rows || current.hash !== expected.hash) {
				return mismatch(expected.name)
			}
			finished.push(expected)
			index++
			current = startOf(order[index])
		}
	}
	const ack: OpsImportVerifyAck = { step: 'verify', tables: finished, next: current }
	const next = current === null ? null : cursorKey(current)
	writeMarker(storage.kv, { ...marker, verified: { next, replay: cursor === null ? null : { cursor: cursorKey(cursor), ack } } })
	return jsonResponse(ack, 200)
}

/** A cursor as the marker records it: its fields in a fixed order, whatever order a request named them in. */
function cursorKey(cursor: OpsDumpCursor): string {
	return JSON.stringify([cursor.table, cursor.after, cursor.rows, cursor.hash])
}

/** One keyset page of `table` after the rowid `after`: each row its rowid, then its columns, as the producer reads them. */
function readPage(storage: SqliteStorage, table: OpsDumpTablePlan, after: string | null): (readonly OpsDumpValue[])[] {
	const condition = after === null ? '' : `WHERE ${quote(table.keyset)} > CAST(? AS INTEGER)`
	const query = (sql: string) => after === null ? storage.sql.exec(sql).toArray() : storage.sql.exec(sql, after).toArray()
	return readOpsDumpPage(query, table, condition, OPS_DUMP_PAGE_ROWS).map((row) => row.values)
}

/**
 * Once every part is loaded, every link pass a part needs ran, and a verification of what is loaded now matched every
 * table: recreates the triggers from the manifest's DDL, compares the whole schema again, clears the marker and the
 * steps' receipts, and leaves the completion's receipt.
 */
function complete(storage: ImportStorage, source: OpsDumpSource, manifest: OpsDumpManifest): Response {
	const answer = storage.transactionSync((): OpsImportCompleteAck | OpsDataRefusal => {
		const marker = importing(storage.kv, source)
		if (marker === null) {
			return { refused: 'no_import', table: null }
		}
		const loaded = manifest.parts.map((part) => readLoadedPart(storage.kv, part.part))
		const unlinked = loaded.some((ack) => ack === null || (ack.deferred > 0 && readLinkedPart(storage.kv, ack.part) === null))
		if (marker.loaded !== manifest.parts.length || unlinked) {
			return { refused: 'part_mismatch', table: null }
		}
		if (marker.verified === null || marker.verified.next !== null) {
			return { refused: 'verify_mismatch', table: null }
		}
		const present = new Set(readDdl(storage).filter((entry) => entry.type === 'trigger').map((entry) => entry.name))
		for (const entry of manifest.ddl) {
			if (entry.type !== 'trigger' || present.has(entry.name)) {
				continue
			}
			if (!TRIGGER_DDL.test(entry.sql)) {
				return { refused: 'schema_mismatch', table: null }
			}
			storage.sql.exec(entry.sql)
		}
		if (!sameDdl(readDdl(storage), manifest.ddl)) {
			return { refused: 'schema_mismatch', table: null }
		}
		for (const part of manifest.parts) {
			storage.kv.delete(loadedPartKey(part.part))
			storage.kv.delete(linkedPartKey(part.part))
		}
		storage.kv.delete(IMPORT_MARKER_KEY)
		const ack: OpsImportCompleteAck = { step: 'complete', source: { object: source.object, dump: source.dump } }
		storage.kv.put(completedKey(source), JSON.stringify(ack))
		return ack
	})
	return jsonResponse(answer, 'refused' in answer ? OPS_DATA_REFUSED_STATUS : 200)
}

/** Wipes an `inspect` object that holds an import marker; the caller refused the object of ordinary traffic. */
async function discard(target: ImportTarget): Promise<Response> {
	if (readMarker(target.storage.kv) === null) {
		return refused('no_import')
	}
	await target.storage.deleteAll()
	const ack: OpsImportDiscardAck = { step: 'discard' }
	return jsonResponse(ack, 200)
}

/** The plan of the target's schema, which must list the manifest's tables in the manifest's order. */
function currentPlan(storage: SqliteStorage, manifest: OpsDumpManifest): readonly OpsDumpTablePlan[] | OpsDataRefusal {
	const plan = planOpsDump(describeDumpSchema(storage))
	if ('refused' in plan) {
		return plan
	}
	const names = plan.tables.map((table) => table.name)
	const expected = manifest.tables.map((table) => table.name)
	if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
		return { refused: 'schema_mismatch', table: null }
	}
	return plan.tables
}

function planned(tables: ReadonlyMap<string, OpsDumpTablePlan>, name: string): OpsDumpTablePlan {
	const table = tables.get(name)
	if (table === undefined) {
		throw new Error('a dump line names a table the plan does not hold')
	}
	return table
}

/**
 * Part `part`'s lines: its byte range read and checked against the manifest's size and SHA-256, decompressed up to the
 * raw bound, at most the row bound, each line in the wire's encoding and fitting its table's plan.
 */
async function readPart(
	bucket: unknown,
	source: OpsDumpSource,
	manifest: OpsDumpManifest,
	plan: readonly OpsDumpTablePlan[],
	part: number,
): Promise<OpsDumpLine[] | OpsDataRefusal> {
	const mismatch: OpsDataRefusal = { refused: 'part_mismatch', table: null }
	const described = manifest.parts[part - 1]
	if (described === undefined) {
		return mismatch
	}
	// Every part but the last is exactly the fixed size, so part n starts at (n - 1) parts.
	const body = await r2Get(bucket, OPS_DUMP_KEY({ ...source, consistent: true }, 'data'), {
		range: { offset: (part - 1) * OPS_DUMP_PART_SIZE, length: described.size },
	})
	const bytes = body === null ? null : await bodyBytes(body)
	if (bytes === null || bytes.length !== described.size || (await sha256OfBytes(bytes)) !== described.sha256) {
		return mismatch
	}
	const text = await gunzipWithin(bytes, OPS_DUMP_PART_MAX_RAW_BYTES)
	const raw = text?.split('\n')
	// Each line ends with its newline, so the text ends with one.
	if (raw === undefined || raw.pop() !== '' || raw.length > OPS_DUMP_PART_MAX_ROWS) {
		return mismatch
	}
	const tables = new Map(plan.map((table) => [table.name, table]))
	const lines: OpsDumpLine[] = []
	for (const encoded of raw) {
		const line = decodeOpsDumpLine(encoded)
		const table = line === null ? undefined : tables.get(line.table)
		if (line === null || table === undefined) {
			return mismatch
		}
		if (line.row.length !== table.columns.length + 1 || line.row[0]?.type !== 'integer') {
			return { refused: 'part_mismatch', table: table.name }
		}
		lines.push(line)
	}
	return lines
}

/** `bytes` as one gzip member, or `null` when it does not decompress, decompresses past `bound`, or is not UTF-8. */
async function gunzipWithin(bytes: Uint8Array, bound: number): Promise<string | null> {
	const reader = new Blob([bytes.slice()]).stream().pipeThrough(new DecompressionStream('gzip')).getReader()
	const chunks: Uint8Array[] = []
	let total = 0
	try {
		for (let read = await reader.read(); !read.done; read = await reader.read()) {
			total += read.value.byteLength
			if (total > bound) {
				await reader.cancel()
				return null
			}
			chunks.push(read.value)
		}
	} catch {
		return null
	}
	const raw = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		raw.set(chunk, offset)
		offset += chunk.byteLength
	}
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(raw)
	} catch {
		return null
	}
}

async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes.slice())
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** The manifest at the backup's key, or `null` when it is missing, too large, does not parse or names another dump. */
async function readManifest(bucket: unknown, source: OpsDumpSource): Promise<OpsDumpManifest | null> {
	const body = await r2Get(bucket, OPS_DUMP_KEY({ ...source, consistent: true }, 'manifest'))
	if (body === null) {
		return null
	}
	const size: unknown = typeof body === 'object' ? Reflect.get(body, 'size') : undefined
	if (typeof size === 'number' && size > OPS_DUMP_MANIFEST_MAX_BYTES) {
		return null
	}
	const text = method(body, 'text')
	if (text === null) {
		throw new Error('R2 answered the manifest without its body')
	}
	const content: unknown = await text()
	const manifest = typeof content === 'string' ? readOpsDumpManifest(content) : null
	return manifest !== null && manifest.object === source.object && manifest.dump === source.dump ? manifest : null
}

/** R2's `get` on the bucket, by method lookup at the binding's edge; `null` for a missing object. */
async function r2Get(bucket: unknown, key: string, options?: { readonly range: { readonly offset: number; readonly length: number } }) {
	const get = method(bucket, 'get')
	if (get === null) {
		throw new Error("the FABRIKA_FILES binding has no get; a backup lies in the environment's bucket")
	}
	const body: unknown = await (options === undefined ? get(key) : get(key, options))
	return body ?? null
}

async function bodyBytes(body: unknown): Promise<Uint8Array> {
	const arrayBuffer = method(body, 'arrayBuffer')
	if (arrayBuffer === null) {
		throw new Error('R2 answered a dump part without its body')
	}
	const bytes: unknown = await arrayBuffer()
	if (!(bytes instanceof ArrayBuffer)) {
		throw new Error('R2 answered a dump part body that is not bytes')
	}
	return new Uint8Array(bytes)
}

/**
 * Each bundle of the release cut to the manifest's ledger, which each must begin with exactly (by name and checksum);
 * `null` for any difference, a bundle or a file the release lacks included.
 */
function ledgerBundles(release: readonly SqliteMigrationBundle[], manifest: OpsDumpManifest): readonly SqliteMigrationBundle[] | null {
	const names = new Set(release.map((bundle) => bundle.bundle))
	if (manifest.migrations.some((migration) => !names.has(migration.bundle))) {
		return null
	}
	const bundles: SqliteMigrationBundle[] = []
	for (const bundle of release) {
		const recorded = manifest.migrations.filter((migration) => migration.bundle === bundle.bundle).sort((left, right) =>
			compareNames(left.name, right.name)
		)
		const files = [...bundle.migrations].sort((left, right) => compareNames(left.name, right.name))
		const prefix = files.slice(0, recorded.length)
		const same = prefix.length === recorded.length
			&& prefix.every((file, index) => file.name === recorded[index]?.name && sha256Hex(file.sql) === recorded[index]?.checksum)
		if (!same) {
			return null
		}
		bundles.push({ bundle: bundle.bundle, migrations: prefix })
	}
	return bundles
}

const SQLITE_SEQUENCE = 'sqlite_sequence'

/** `CREATE TRIGGER` as `sqlite_schema` stores it, the only DDL `complete` runs from the manifest. */
const TRIGGER_DDL = /^CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\s/i

/** Whether a dump holds `name`: no SQLite internal table but `sqlite_sequence`, and none of Cloudflare's `_cf_` ones. */
function dumped(name: string): boolean {
	return !name.startsWith('_cf_') && (!name.startsWith('sqlite_') || name === SQLITE_SEQUENCE)
}

/** Whether the object holds any table but Cloudflare's own. */
function holdsTables(storage: SqliteStorage): boolean {
	return storage.sql.exec(`SELECT name FROM sqlite_schema WHERE type = 'table'`).toArray().some((row) => !text(row['name']).startsWith('_cf_'))
}

/** Every `sqlite_schema` entry with SQL a dump's DDL lists, in no particular order. */
function readDdl(storage: SqliteStorage): OpsDumpSchemaEntry[] {
	return storage.sql.exec('SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL').toArray().flatMap((row) => {
		const name = text(row['name'])
		const table = text(row['tbl_name'])
		const type = row['type']
		if (!dumped(name) || !dumped(table) || (type !== 'table' && type !== 'index' && type !== 'trigger' && type !== 'view')) {
			return []
		}
		return [{ type, name, table, sql: text(row['sql']) }]
	})
}

function sameDdl(left: readonly OpsDumpSchemaEntry[], right: readonly OpsDumpSchemaEntry[]): boolean {
	const canonical = (entries: readonly OpsDumpSchemaEntry[]) =>
		entries.map((entry) => JSON.stringify([entry.type, entry.name, entry.table, entry.sql])).sort(compareNames).join('\n')
	return left.length === right.length && canonical(left) === canonical(right)
}

/** The schema `planOpsDump` reads, of every table a dump holds (`describeOpsDumpSchema`). */
export function describeDumpSchema(storage: SqliteStorage): OpsDumpSchema {
	return describeOpsDumpSchema((query, ...bindings) => storage.sql.exec(query, ...bindings).toArray())
}

/** The import marker, parsed strictly; `null` when the object holds none. A marker that does not parse is a corrupt object. */
function readMarker(kv: ImportKv): ImportMarker | null {
	const raw = kv.get(IMPORT_MARKER_KEY)
	if (raw === undefined) {
		return null
	}
	const value: unknown = typeof raw === 'string' ? parseJson(raw) : undefined
	const source: unknown = isRecord(value) ? value['source'] : undefined
	const verified = isRecord(value) ? readVerification(value['verified']) : undefined
	if (
		!isRecord(value) || !isRecord(source) || Object.keys(value).length !== 4 || Object.keys(source).length !== 2
		|| typeof source['object'] !== 'string' || typeof source['dump'] !== 'string' || typeof value['begun'] !== 'boolean'
		|| typeof value['loaded'] !== 'number' || !Number.isSafeInteger(value['loaded']) || value['loaded'] < 0 || verified === undefined
	) {
		throw new Error('the import marker in KV storage does not parse')
	}
	return { source: { object: source['object'], dump: source['dump'] }, begun: value['begun'], loaded: value['loaded'], verified }
}

/** The marker's verification; `undefined` when it does not parse. */
function readVerification(value: unknown): Verification | null | undefined {
	if (value === null) {
		return null
	}
	if (!isRecord(value) || Object.keys(value).length !== 2) {
		return undefined
	}
	const next = value['next']
	const replay = value['replay']
	if (next !== null && typeof next !== 'string') {
		return undefined
	}
	if (replay === null) {
		return { next, replay: null }
	}
	const cursor = isRecord(replay) ? replay['cursor'] : undefined
	const ack = isRecord(replay) && Object.keys(replay).length === 2 ? parseOpsImportVerifyAck(replay['ack']) : null
	return typeof cursor === 'string' && ack !== null ? { next, replay: { cursor, ack } } : undefined
}

function writeMarker(kv: ImportKv, marker: ImportMarker): void {
	kv.put(IMPORT_MARKER_KEY, JSON.stringify(marker))
}

function readLoadedPart(kv: ImportKv, part: number): OpsImportPartAck | null {
	const raw = kv.get(loadedPartKey(part))
	if (raw === undefined) {
		return null
	}
	const ack = typeof raw === 'string' ? parseOpsImportPartAck(parseJson(raw)) : null
	if (ack === null || ack.part !== part) {
		throw new Error('a loaded part recorded in KV storage does not parse')
	}
	return ack
}

function readLinkedPart(kv: ImportKv, part: number): OpsImportLinkAck | null {
	const raw = kv.get(linkedPartKey(part))
	if (raw === undefined) {
		return null
	}
	const ack = typeof raw === 'string' ? parseOpsImportLinkAck(parseJson(raw)) : null
	if (ack === null || ack.part !== part) {
		throw new Error('a link pass recorded in KV storage does not parse')
	}
	return ack
}

/** The acknowledgement `complete` answered for `source`, `null` when it never completed. */
function readCompleted(kv: ImportKv, source: OpsDumpSource): OpsImportCompleteAck | null {
	const raw = kv.get(completedKey(source))
	if (raw === undefined) {
		return null
	}
	const ack = typeof raw === 'string' ? parseOpsImportCompleteAck(parseJson(raw)) : null
	if (ack === null || !sameSource(ack.source, source)) {
		throw new Error('a completed import recorded in KV storage does not parse')
	}
	return ack
}

function sameSource(left: OpsDumpSource, right: OpsDumpSource): boolean {
	return left.object === right.object && left.dump === right.dump
}

function refused(reason: OpsDataRefusalReason, table: string | null = null): Response {
	const refusal: OpsDataRefusal = { refused: reason, table }
	return jsonResponse(refusal, OPS_DATA_REFUSED_STATUS)
}

/** The parameters of `bindings`; `sql.exec` binds bytes as an `ArrayBuffer`. */
function params(bindings: readonly OpsDumpBinding[]): SqliteValue[] {
	return bindings.map(({ param }) => param instanceof Uint8Array ? param.slice().buffer : param)
}

function quote(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`
}

/** Code-unit order, which no locale changes; the migration runner orders files the same way. */
function compareNames(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// SQLite's own answers: a value of another type is a broken runtime, never input to refuse.
function text(value: SqliteValue | undefined): string {
	if (typeof value !== 'string') {
		throw new Error('SQLite answered a schema name or SQL that is not text')
	}
	return value
}
