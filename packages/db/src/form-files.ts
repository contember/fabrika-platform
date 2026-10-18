// The framework's side of `fabrika_form_files` (`@fabrika/db/migrations`): the files a form received with a submission,
// before anything owns them. A row is written `pending` before its object, so it is the intent to clean that object up;
// the submission's inbox append makes it `held` in the inbox row's own transaction (`holdFormFiles`), and the job that
// drains the inbox claims it in the transaction that writes its owner, where `@fabrika/app` moves it into the
// collection's own table. Nothing serves a row of this table. Each operation is one fixed statement on the database's
// clock, reached only through `frameworkTablesOf`.

import { type FixedParameter, runFixedStatement, type Session, sessionOf } from './database'
import { QueryRefusedError } from './errors'
import { FORM_FILES_TABLE } from './migrations'
import type { DataLayerRuntime } from './store'

const F = FORM_FILES_TABLE

/** A file a form is about to write: its row comes first, then the object under `objectKey`. */
export interface StagedFormFile {
	readonly id: string
	readonly form: string
	readonly collection: string
	readonly objectKey: string
	readonly contentType: string
	readonly originalName: string | null
}

/** What writing a staged file's object recorded: its size and the SHA-256 of its bytes. */
export interface WrittenFormFile {
	readonly id: string
	readonly size: number
	readonly sha256: string
}

/** The files a submission holds once its inbox row commits, and how long they wait for their owner. */
export interface HeldFormFiles {
	readonly files: readonly WrittenFormFile[]
	readonly holdMs: number
}

/** A held file a claim took out of the table: what the collection's own row records of it. */
export interface ClaimedFormFile {
	readonly id: string
	readonly objectKey: string
	readonly size: number
	readonly sha256: string
	readonly contentType: string
	readonly originalName: string | null
	readonly createdAt: Date
}

export interface RemovableFormFile {
	readonly id: string
	readonly objectKey: string
}

export interface FormFiles {
	/** Inserts the `pending` row of a file whose object is written next: the intent to clean that object up. */
	stage(file: StagedFormFile): Promise<void>
	/** Deletes a `pending` row once its object is gone; a held row stays. */
	abandon(id: string): Promise<void>
	/**
	 * Takes the held file `id` of `collection` out of the table, in `using` (the transaction that writes its owner), and
	 * answers it; `null` when there is none: never received, of another collection, already claimed, or its hold ended.
	 */
	claim(collection: string, id: string, using: Session): Promise<ClaimedFormFile | null>
	/** At most `limit` rows whose objects may go: held past their hold, or pending for longer than `pendingGraceMs`. */
	removable(limit: number, pendingGraceMs: number): Promise<readonly RemovableFormFile[]>
	/** Deletes a removable row once its object is gone; a row that is held or recently pending is never deleted. */
	purge(id: string, pendingGraceMs: number): Promise<void>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Removable: held for an hour past its hold, or pending for longer than the grace in parameter `$<grace>`. The hour
 * keeps the sweep off a file a job's transaction, which started before the hold ended, may still claim.
 */
const removable = (grace: number): string =>
	`(status = 'pending' and created_at < now() - $${grace}::bigint * interval '1 millisecond')
	or (status = 'held' and held_until <= now() - interval '1 hour')`

const SQL_STAGE = `insert into ${F} (id, form, collection, status, object_key, content_type, original_name, created_at)
values ($1::uuid, $2, $3, 'pending', $4, $5, $6, now()) returning id`

const SQL_ABANDON = `delete from ${F} where id = $1::uuid and status = 'pending' returning id`

/** Every file of a submission at once: ids, sizes and digests as comma-separated lists, in the same order. */
const SQL_HOLD = `update ${F} as f set status = 'held', size = v.size, sha256 = v.sha256,
	held_until = now() + $4::bigint * interval '1 millisecond'
from unnest(string_to_array($1, ',')::uuid[], string_to_array($2, ',')::bigint[], string_to_array($3, ',')) as v (id, size, sha256)
where f.id = v.id and f.status = 'pending' returning f.id`

// The clock of the statement, not of the transaction: a job's transaction may have started before the hold ended.
const SQL_CLAIM = `delete from ${F} where id = $1::uuid and collection = $2 and status = 'held' and held_until > clock_timestamp()
returning id::text as id, object_key, size, sha256, content_type, original_name, created_at`

const SQL_REMOVABLE = `select id::text as id, object_key from ${F} where ${removable(1)} order by created_at limit $2::int`

const SQL_PURGE = `delete from ${F} where id = $1::uuid and (${removable(2)}) returning id`

function positive(value: number, what: string): number {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new QueryRefusedError('invalid_argument', `${what} must be a whole number of at least 1`)
	}
	return value
}

function nonNegative(value: number, what: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new QueryRefusedError('invalid_argument', `${what} must be a whole number`)
	}
	return value
}

function sha256(value: string): string {
	if (!/^[0-9a-f]{64}$/.test(value)) {
		throw new QueryRefusedError('invalid_argument', 'a form file is recorded with the hex SHA-256 of its bytes')
	}
	return value
}

function uuid(value: string): string {
	if (!UUID.test(value)) {
		throw new QueryRefusedError('invalid_argument', 'a form file is named by its UUID')
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

/** BIGINT comes back as a string. */
function size(row: Readonly<Record<string, unknown>>): number {
	const value = Number(row['size'])
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new QueryRefusedError('unexpected_row', `${F}.size is not a non-negative integer`)
	}
	return value
}

/**
 * Makes every file of a submission `held`, in `session`: the transaction that appends its inbox row, so a row that does
 * not commit leaves its files pending for the form to clean up. A file that is no longer pending fails the transaction.
 */
export async function holdFormFiles(session: Session, held: HeldFormFiles): Promise<void> {
	if (held.files.length === 0) {
		return
	}
	const parameters: FixedParameter[] = [
		held.files.map((file) => uuid(file.id)).join(','),
		held.files.map((file) => nonNegative(file.size, 'a form file size')).join(','),
		held.files.map((file) => sha256(file.sha256)).join(','),
		positive(held.holdMs, 'a form file hold'),
	]
	const rows = await runFixedStatement(session, SQL_HOLD, parameters)
	if (rows.length !== held.files.length) {
		throw new QueryRefusedError('unexpected_row', 'a form file is no longer pending; the submission writes nothing')
	}
}

export function formFiles(runtime: () => DataLayerRuntime): FormFiles {
	const session = () => sessionOf(runtime())
	return Object.freeze({
		async stage(file: StagedFormFile): Promise<void> {
			await runFixedStatement(session(), SQL_STAGE, [
				uuid(file.id),
				file.form,
				file.collection,
				file.objectKey,
				file.contentType,
				file.originalName,
			])
		},

		async abandon(id: string): Promise<void> {
			await runFixedStatement(session(), SQL_ABANDON, [uuid(id)])
		},

		async claim(collection: string, id: string, using: Session): Promise<ClaimedFormFile | null> {
			if (!UUID.test(id)) {
				return null
			}
			const [found] = await runFixedStatement(using, SQL_CLAIM, [id, collection])
			if (found === undefined) {
				return null
			}
			const row = record(found)
			const createdAt = row['created_at']
			if (!(createdAt instanceof Date)) {
				throw new QueryRefusedError('unexpected_row', `${F}.created_at came back as ${typeof createdAt}`)
			}
			const name = row['original_name']
			return Object.freeze({
				id: text(row, 'id'),
				objectKey: text(row, 'object_key'),
				size: size(row),
				sha256: text(row, 'sha256'),
				contentType: text(row, 'content_type'),
				originalName: typeof name === 'string' ? name : null,
				createdAt,
			})
		},

		async removable(limit: number, pendingGraceMs: number): Promise<readonly RemovableFormFile[]> {
			const rows = await runFixedStatement(session(), SQL_REMOVABLE, [positive(pendingGraceMs, 'a pending grace'), positive(limit, 'a batch')])
			return rows.map((found) => {
				const row = record(found)
				return Object.freeze({ id: text(row, 'id'), objectKey: text(row, 'object_key') })
			})
		},

		async purge(id: string, pendingGraceMs: number): Promise<void> {
			await runFixedStatement(session(), SQL_PURGE, [uuid(id), positive(pendingGraceMs, 'a pending grace')])
		},
	})
}
