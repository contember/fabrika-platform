// The framework's side of `fabrika_files` (`@fabrika/db/migrations`): every stored file, a value a table's file column
// references by id. `@fabrika/app` stages a file's row before its object, on a connection of its own; the data layer
// claims it at its first reference, in the handler's transaction, and reads its metadata beside every row; the sweep
// deletes a file no column references in three steps. Each operation is a fixed statement on the database's clock,
// reached only through `@fabrika/db/framework`. A statement that names an application table builds it from the
// table policies' validated identifiers, never from a caller's value.

import { freeze } from './builtins'
import { type FixedParameter, runFixedStatement, type Session, sessionOf } from './database'
import { DatabaseError, QueryRefusedError } from './errors'
import { isPlainIdentifier } from './identifier'
import { fencedTransaction } from './job-leases'
import { FILE_DELETIONS_TABLE, FILES_TABLE } from './migrations'
import type { DataLayerRuntime } from './store'

const F = FILES_TABLE
const D = FILE_DELETIONS_TABLE

/** A stored file's states: written, waiting for its first reference, for its scan, served, or refused by the scan. */
export const STORED_FILE_STATUSES = ['pending', 'quarantined', 'live', 'rejected'] as const

export type StoredFileStatus = (typeof STORED_FILE_STATUSES)[number]

/** What a file reference carries: the file's metadata, never its bytes or its object. */
export interface StoredFileMeta {
	readonly id: string
	readonly kind: string
	readonly name: string | null
	readonly type: string
	readonly size: number
	readonly status: StoredFileStatus
}

/** A file about to be written: its row comes first, then the object under `objectKey`. */
export interface StagedFile {
	readonly id: string
	readonly kind: string
	readonly objectKey: string
	readonly contentType: string
	readonly name: string | null
	/** The request (or job attempt) that writes it: only it may claim the file while it is pending. */
	readonly request: string
}

/** A stored file as a byte consumer reads it: only a live one is served, by its scanned version when its kind scans. */
export interface ServedFile extends StoredFileMeta {
	readonly objectKey: string
	readonly objectVersion: string | null
}

/** What the scan pass needs of a quarantined file. */
export interface QuarantinedStoredFile {
	readonly id: string
	readonly objectKey: string
	readonly size: number
	readonly sha256: string
	readonly contentType: string
	readonly scanAttempts: number
	readonly dueSince: Date
}

/** A file column the sweep looks a file up in: an application table's column, both validated identifiers. */
export interface FileColumnRef {
	readonly table: string
	readonly column: string
}

/** What a reference write learns of a file it locked. */
export interface LockedFile {
	readonly kind: string
	readonly status: StoredFileStatus
	readonly request: string | null
	readonly scope: string | null
	/** Whether it is still within the pending grace, counted from its creation. */
	readonly fresh: boolean
}

export interface StoredFiles {
	/** Commits the `pending` row of a file whose object is written next, on a connection of its own: the cleanup intent. */
	stage(file: StagedFile): Promise<void>
	/** Records the written object's size and digest on its pending row, on a connection of its own. */
	written(id: string, written: { readonly size: number; readonly sha256: string }): Promise<void>
	/**
	 * Deletes a pending row this request wrote and nobody claimed, and records its object for deletion, in one
	 * statement: the object key, or `null` when the file was claimed (or is gone).
	 */
	abandon(id: string, request: string): Promise<string | null>
	/** A file as a byte consumer reads it, in `using` or on its own; `null` when the sweep deleted it. */
	find(id: string, using?: Session): Promise<ServedFile | null>
	/** Quarantines a live file of a scanning kind again when it has no scanned version, so the scan decides once more. */
	requarantine(id: string, version: string | null): Promise<void>
	/** Each file's metadata, by id, in `using`: what the data layer answers in a file column. */
	metadata(using: Session, ids: readonly string[]): Promise<ReadonlyMap<string, StoredFileMeta>>
	// The scan pass, each verdict fenced by the scan job's lease.
	quarantined(kinds: readonly string[], limit: number, now: Date): Promise<readonly QuarantinedStoredFile[]>
	promote(id: string, sha256: string, version: string): Promise<boolean>
	deferScan(id: string, attempts: number, after: Date): Promise<boolean>
	reject(id: string): Promise<boolean>
	// The sweep.
	/** Objects whose rows a sweep deleted and whose own deletion it did not finish. */
	unfinishedDeletions(limit: number): Promise<readonly string[]>
	forgetDeletion(objectKey: string): Promise<void>
	/** Clears the legacy marker of every migrated file that one of `columns` references: it is an ordinary file now. */
	adoptReferenced(columns: readonly FileColumnRef[]): Promise<number>
	/** At most `limit` files past the grace that no column of `columns` references (pending ones included), oldest first. */
	unreferenced(columns: readonly FileColumnRef[], limit: number, graceMs: number): Promise<readonly string[]>
	/**
	 * Deletes the row of an unreferenced file and records its object for deletion, in one transaction; `null` when it
	 * survived: a reference exists (the foreign key refuses the delete), or it is legacy or within the grace.
	 */
	remove(id: string, graceMs: number): Promise<string | null>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** Postgres' code of a foreign key violation: the delete of a file some column still references. */
const FOREIGN_KEY_VIOLATION = '23503'

const SERVED_COLUMNS = `id::text as id, kind, name, content_type, size, status, object_key, object_version`

const SQL_STAGE = `insert into ${F} (id, kind, status, object_key, content_type, name, request, created_at)
values ($1::uuid, $2, 'pending', $3, $4, $5, $6, now())`

const SQL_WRITTEN = `update ${F} set size = $2::bigint, sha256 = $3 where id = $1::uuid and status = 'pending' returning id`

const SQL_ABANDON = `with gone as (delete from ${F} where id = $1::uuid and status = 'pending' and request = $2 returning object_key)
insert into ${D} (object_key, recorded_at) select object_key, now() from gone on conflict (object_key) do nothing returning object_key`

const SQL_FIND = `select ${SERVED_COLUMNS} from ${F} where id = $1::uuid`

const SQL_REQUARANTINE = `update ${F} set status = 'quarantined', object_version = null, scan_attempts = 0, scan_after = now()
where id = $1::uuid and status = 'live' and object_version is not distinct from $2`

const SQL_METADATA = `select id::text as id, kind, name, content_type, size, status from ${F}
where id = any(string_to_array($1, ',')::uuid[])`

const SQL_QUARANTINED = `select id::text as id, object_key, size, sha256, content_type, scan_attempts, coalesce(scan_after, created_at) as due_since
from ${F} where status = 'quarantined' and kind = any(string_to_array($1, ',')) and (scan_after is null or scan_after < $2::timestamptz)
order by scan_after nulls first, created_at limit $3::int`

const SQL_PROMOTE = `update ${F} set status = 'live', object_version = $3 where id = $1::uuid and status = 'quarantined' and sha256 = $2 returning id`

const SQL_DEFER = `update ${F} set scan_attempts = $2::int, scan_after = $3::timestamptz
where id = $1::uuid and status = 'quarantined' and scan_attempts = $2::int - 1 returning id`

const SQL_REJECT = `update ${F} set status = 'rejected' where id = $1::uuid and status = 'quarantined' returning id`

const SQL_UNFINISHED = `select object_key from ${D} order by recorded_at limit $1::int`

const SQL_FORGET = `delete from ${D} where object_key = $1`

const SQL_REMOVE = `with gone as (
	delete from ${F} where id = $1::uuid and legacy is null and created_at < now() - $2::bigint * interval '1 millisecond' returning object_key
)
insert into ${D} (object_key, recorded_at) select object_key, now() from gone returning object_key`

/** The lock a reference write takes: a file being deleted cannot gain a reference, and a referenced one is not deleted. */
const SQL_LOCK = `select kind, status, request, scope, created_at > now() - $2::bigint * interval '1 millisecond' as fresh
from ${F} where id = $1::uuid for share`

const SQL_CLAIM = `update ${F} set status = $2 where id = $1::uuid and status = 'pending' returning id`

/** The first dimensional reference stamps the scope; one from another top-level scope matches nothing. */
const SQL_STAMP = `update ${F} set scope = $2 where id = $1::uuid and (scope is null or scope = $2) returning id`

/** `exists (select 1 from <table> where <column> = f.id)`, one per column, over the policies' validated identifiers. */
function referencedBy(columns: readonly FileColumnRef[]): string {
	if (columns.length === 0) {
		return 'false'
	}
	return columns.map(({ table, column }) => {
		if (!isPlainIdentifier(table) || !isPlainIdentifier(column)) {
			throw new QueryRefusedError('invalid_name', 'a file column is named by plain identifiers')
		}
		return `exists (select 1 from ${table} r where r.${column} = f.id)`
	}).join(' or ')
}

function uuid(value: string): string {
	if (!UUID.test(value)) {
		throw new QueryRefusedError('invalid_argument', 'a stored file is named by its UUID')
	}
	return value
}

function positive(value: number, what: string): number {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new QueryRefusedError('invalid_argument', `${what} must be a whole number of at least 1`)
	}
	return value
}

function record(row: unknown): Readonly<Record<string, unknown>> {
	if (typeof row !== 'object' || row === null) {
		throw new QueryRefusedError('unexpected_row', `${F} answered a row that is not an object`)
	}
	return Object.fromEntries(Object.entries(row))
}

function text(row: Readonly<Record<string, unknown>>, column: string): string {
	const value = row[column]
	if (typeof value !== 'string') {
		throw new QueryRefusedError('unexpected_row', `${F}.${column} came back as ${typeof value}`)
	}
	return value
}

function nullableText(row: Readonly<Record<string, unknown>>, column: string): string | null {
	const value = row[column]
	return typeof value === 'string' ? value : null
}

/** BIGINT and INTEGER come back as strings or numbers; a pending row has no size yet, which reads as 0. */
function count(row: Readonly<Record<string, unknown>>, column: string): number {
	const value = row[column] === null ? 0 : Number(row[column])
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new QueryRefusedError('unexpected_row', `${F}.${column} is not a non-negative integer`)
	}
	return value
}

function status(row: Readonly<Record<string, unknown>>): StoredFileStatus {
	const value = row['status']
	const found = STORED_FILE_STATUSES.find((candidate) => candidate === value)
	if (found === undefined) {
		throw new QueryRefusedError('unexpected_row', `${F}.status is not a file state`)
	}
	return found
}

function date(row: Readonly<Record<string, unknown>>, column: string): Date {
	const value = row[column]
	if (!(value instanceof Date)) {
		throw new QueryRefusedError('unexpected_row', `${F}.${column} came back as ${typeof value}`)
	}
	return value
}

function metaOf(row: Readonly<Record<string, unknown>>): StoredFileMeta {
	return freeze({
		id: text(row, 'id'),
		kind: text(row, 'kind'),
		name: nullableText(row, 'name'),
		type: text(row, 'content_type'),
		size: count(row, 'size'),
		status: status(row),
	})
}

/** Locks file `id` `for share` in `session`, the transaction that writes a reference to it; `null` when it is gone. */
export async function lockStoredFile(session: Session, id: string, graceMs: number): Promise<LockedFile | null> {
	const [found] = await runFixedStatement(session, SQL_LOCK, [uuid(id), positive(graceMs, 'a pending grace')])
	if (found === undefined) {
		return null
	}
	const row = record(found)
	return freeze({
		kind: text(row, 'kind'),
		status: status(row),
		request: nullableText(row, 'request'),
		scope: nullableText(row, 'scope'),
		fresh: row['fresh'] === true,
	})
}

/** Ends the pending state of a file the reference write locked: `quarantined` for a scanning kind, else `live`. */
export async function claimStoredFile(session: Session, id: string, ended: 'quarantined' | 'live'): Promise<void> {
	const rows = await runFixedStatement(session, SQL_CLAIM, [uuid(id), ended])
	if (rows.length !== 1) {
		throw new QueryRefusedError('unexpected_row', 'a pending file changed under its lock')
	}
}

/** Sets the scope of a file's first dimensional reference; `false` when it already holds another. */
export async function stampStoredFile(session: Session, id: string, scope: string): Promise<boolean> {
	return (await runFixedStatement(session, SQL_STAMP, [uuid(id), scope])).length === 1
}

/** Each file's metadata, by id, in `using`: one statement for every file column of a read. */
export async function storedFilesMetadata(using: Session, ids: readonly string[]): Promise<ReadonlyMap<string, StoredFileMeta>> {
	const unique = [...new Set(ids)]
	if (unique.length === 0) {
		return new Map()
	}
	const rows = await runFixedStatement(using, SQL_METADATA, [unique.map(uuid).join(',')])
	return new Map(rows.map((found) => {
		const meta = metaOf(record(found))
		return [meta.id, meta] as const
	}))
}

export function storedFiles(runtime: () => DataLayerRuntime): StoredFiles {
	const session = () => sessionOf(runtime())
	async function fenced(statement: string, parameters: readonly FixedParameter[]): Promise<boolean> {
		const current = runtime()
		const fence = current.capabilities.fence()
		if (fence === null) {
			throw new QueryRefusedError('file_scan', "a scan verdict is written only inside the scan job's lease")
		}
		const rows = await fencedTransaction(sessionOf(current), fence, (transaction) => runFixedStatement(transaction, statement, parameters))
		return rows.length > 0
	}
	return freeze({
		async stage(file: StagedFile): Promise<void> {
			await runFixedStatement(session(), SQL_STAGE, [uuid(file.id), file.kind, file.objectKey, file.contentType, file.name, file.request])
		},

		async written(id: string, written: { readonly size: number; readonly sha256: string }): Promise<void> {
			if (!/^[0-9a-f]{64}$/.test(written.sha256) || !Number.isSafeInteger(written.size) || written.size < 0) {
				throw new QueryRefusedError('invalid_argument', 'a written file records its size and the hex SHA-256 of its bytes')
			}
			const rows = await runFixedStatement(session(), SQL_WRITTEN, [uuid(id), String(written.size), written.sha256])
			if (rows.length !== 1) {
				throw new QueryRefusedError('unexpected_row', 'a staged file is no longer pending')
			}
		},

		async abandon(id: string, request: string): Promise<string | null> {
			const [found] = await runFixedStatement(session(), SQL_ABANDON, [uuid(id), request])
			return found === undefined ? null : text(record(found), 'object_key')
		},

		async find(id: string, using?: Session): Promise<ServedFile | null> {
			if (!UUID.test(id)) {
				return null
			}
			const [found] = await runFixedStatement(using ?? session(), SQL_FIND, [id])
			if (found === undefined) {
				return null
			}
			const row = record(found)
			return freeze({ ...metaOf(row), objectKey: text(row, 'object_key'), objectVersion: nullableText(row, 'object_version') })
		},

		async requarantine(id: string, version: string | null): Promise<void> {
			await runFixedStatement(session(), SQL_REQUARANTINE, [uuid(id), version])
		},

		metadata: storedFilesMetadata,

		async quarantined(kinds: readonly string[], limit: number, now: Date): Promise<readonly QuarantinedStoredFile[]> {
			if (kinds.length === 0) {
				return []
			}
			const rows = await runFixedStatement(session(), SQL_QUARANTINED, [kinds.join(','), now.toISOString(), positive(limit, 'a scan batch')])
			return rows.map((found) => {
				const row = record(found)
				return freeze({
					id: text(row, 'id'),
					objectKey: text(row, 'object_key'),
					size: count(row, 'size'),
					sha256: text(row, 'sha256'),
					contentType: text(row, 'content_type'),
					scanAttempts: count(row, 'scan_attempts'),
					dueSince: date(row, 'due_since'),
				})
			})
		},

		promote: (id: string, sha256: string, version: string) => fenced(SQL_PROMOTE, [uuid(id), sha256, version]),

		deferScan: (id: string, attempts: number, after: Date) => fenced(SQL_DEFER, [uuid(id), positive(attempts, 'a scan attempt'), after.toISOString()]),

		reject: (id: string) => fenced(SQL_REJECT, [uuid(id)]),

		async unfinishedDeletions(limit: number): Promise<readonly string[]> {
			const rows = await runFixedStatement(session(), SQL_UNFINISHED, [positive(limit, 'a sweep batch')])
			return rows.map((found) => text(record(found), 'object_key'))
		},

		async forgetDeletion(objectKey: string): Promise<void> {
			await runFixedStatement(session(), SQL_FORGET, [objectKey])
		},

		async adoptReferenced(columns: readonly FileColumnRef[]): Promise<number> {
			if (columns.length === 0) {
				return 0
			}
			const statement = `update ${F} f set legacy = null where f.legacy is not null and (${referencedBy(columns)}) returning id`
			return (await runFixedStatement(session(), statement, [])).length
		},

		async unreferenced(columns: readonly FileColumnRef[], limit: number, graceMs: number): Promise<readonly string[]> {
			const statement = `select f.id::text as id from ${F} f
where f.legacy is null and f.created_at < now() - $1::bigint * interval '1 millisecond' and not (${referencedBy(columns)})
order by f.created_at limit $2::int`
			const rows = await runFixedStatement(session(), statement, [positive(graceMs, 'a pending grace'), positive(limit, 'a sweep batch')])
			return rows.map((found) => text(record(found), 'id'))
		},

		async remove(id: string, graceMs: number): Promise<string | null> {
			try {
				const [found] = await runFixedStatement(session(), SQL_REMOVE, [uuid(id), positive(graceMs, 'a pending grace')])
				return found === undefined ? null : text(record(found), 'object_key')
			} catch (error) {
				if (error instanceof DatabaseError && error.sqlState === FOREIGN_KEY_VIOLATION) {
					return null
				}
				throw error
			}
		},
	})
}
