// A table's file columns in the data layer. A read answers a file reference in each one, with the file's metadata
// loaded in one statement per read; a write takes only a reference its site holds and may read, of the column's kind,
// and claims, locks and stamps the file in the write's own transaction. The file's row is `fabrika_files`
// (`stored-files.ts`); the column is a foreign key to it, so a file some row references is never deleted.

import { defineValue, ownDescriptor, ownKeys } from './builtins'
import { runFixedStatement, type Session } from './database'
import type { Primitive } from './description'
import { NotFoundError, QueryRefusedError } from './errors'
import { fileHoldingOf, fileReference, holdsFile } from './file-references'
import { isPlainIdentifier } from './identifier'
import type { TableModel } from './policy'
import { claimStoredFile, lockStoredFile, stampStoredFile, storedFilesMetadata } from './stored-files'

/** Where a site's file references belong, and what claiming a pending one needs. */
export interface FileBinding {
	/** The work a reference of this site belongs to: one request, or one job attempt. */
	readonly holder: object
	/** The id a pending file must carry to be claimed here: the request (or attempt) that staged it. */
	readonly request: string
	/** How long a pending file may wait for its first reference. */
	readonly graceMs: number
	/** Whether files of `kind` wait for a clean scan: a claimed one is `quarantined` until then. */
	scans(kind: string): boolean
}

/** Whether a reference read with `action` lets its holder serve, open and copy the file: the table's or the column's read action. */
function readsFile(model: TableModel, column: string, action: string): boolean {
	const own = Object.hasOwn(model.columnReads, column) ? model.columnReads[column] : undefined
	return own === undefined ? model.actions.read.includes(action) : own === action
}

/**
 * Puts a file reference in each file column of `rows`, read with `action` in `session`: one statement loads every
 * file's metadata. Without a binding (a store's own runner) the columns keep their ids.
 */
export async function answerFiles<R>(model: TableModel, binding: FileBinding | undefined, session: Session, rows: R[], action: string): Promise<R[]> {
	const columns = ownKeys(model.files)
	if (binding === undefined || columns.length === 0 || rows.length === 0) {
		return rows
	}
	const ids: string[] = []
	for (const row of rows) {
		for (const column of columns) {
			const value: unknown = typeof row === 'object' && row !== null ? ownDescriptor(row, column)?.value : undefined
			if (typeof value === 'string') {
				ids.push(value)
			}
		}
	}
	const metadata = await storedFilesMetadata(session, ids)
	for (const row of rows) {
		if (typeof row !== 'object' || row === null) {
			continue
		}
		for (const column of columns) {
			const value: unknown = ownDescriptor(row, column)?.value
			if (typeof value !== 'string') {
				continue
			}
			const meta = metadata.get(value)
			if (meta === undefined) {
				throw new QueryRefusedError('unexpected_row', `${model.name}.${column} references a file that is not stored`)
			}
			defineValue(row, column, fileReference(meta, binding.holder, readsFile(model, column, action)))
		}
	}
	return rows
}

/**
 * A write's value for a file column: `null`, or the id of a file reference of the column's kind. A string id, a copied
 * object or a reference of another kind is refused; whether the site holds it is checked where the write runs.
 */
export function fileValue(model: TableModel, column: string, value: unknown): string | null {
	if (value === null) {
		return null
	}
	const kind = model.files[column]
	const holding = fileHoldingOf(value)
	if (holding === undefined) {
		throw new QueryRefusedError(
			'file_value',
			`${model.name}.${column} takes a file reference (an input file, a ctx.files.put, or a file column read here) or null, never an id`,
		)
	}
	if (holding.kind !== kind) {
		throw new QueryRefusedError('file_value', `${model.name}.${column} holds files of kind '${kind}', and the reference is of another kind`)
	}
	return holding.id
}

/**
 * The top-level scope a row of `model` lies in, from the values it is written with: `<dimension>:<value>`, or `null` for
 * an application table, which sets no scope.
 */
export function rowScope(model: TableModel, values: ReadonlyMap<string, Primitive | null>): string | null | undefined {
	const scope = model.scope
	if (scope.mode !== 'dimension' && scope.mode !== 'child') {
		return null
	}
	const top = model.chain[model.chain.length - 1]
	const [dimension, column] = top === undefined
		? scope.mode === 'dimension' ? [scope.dimension, scope.key] : [undefined, undefined]
		: [top.dimension, top.column]
	if (dimension === undefined || column === undefined) {
		return null
	}
	const value = values.get(column)
	return value === undefined || value === null ? undefined : `${dimension}:${String(value)}`
}

/** The top-level scope of the row whose key is `key`, read in `session`: what an update's file references are stamped with. */
export async function storedRowScope(model: TableModel, session: Session, key: string, keyValue: string): Promise<string | null> {
	const scope = model.scope
	if (scope.mode !== 'dimension' && scope.mode !== 'child') {
		return null
	}
	const top = model.chain[model.chain.length - 1]
	const dimension = top === undefined ? (scope.mode === 'dimension' ? scope.dimension : undefined) : top.dimension
	const column = top === undefined ? (scope.mode === 'dimension' ? scope.key : undefined) : top.column
	if (dimension === undefined || column === undefined) {
		return null
	}
	if (!isPlainIdentifier(model.name) || !isPlainIdentifier(column) || !isPlainIdentifier(key)) {
		throw new QueryRefusedError('invalid_name', "a file column's table is named by plain identifiers")
	}
	const [found] = await runFixedStatement(session, `select ${column}::text as scope from ${model.name} where ${key}::text = $1`, [keyValue])
	const value: unknown = typeof found === 'object' && found !== null ? ownDescriptor(found, 'scope')?.value : undefined
	if (typeof value !== 'string') {
		throw new NotFoundError(`${model.name} not found`)
	}
	return `${dimension}:${value}`
}

/**
 * The file references of a write, in `session` (its transaction), after its statement: each file is locked `for share`
 * while its state is checked, a pending one this request staged within the grace is claimed, and the first reference
 * from a dimensional table stamps its scope; a reference from another top-level scope is refused.
 */
export async function referenceFiles(
	model: TableModel,
	binding: FileBinding | undefined,
	session: Session,
	values: ReadonlyMap<string, Primitive | null>,
	scope: () => Promise<string | null>,
): Promise<void> {
	const written = ownKeys(model.files).flatMap((column) => {
		const id = values.get(column)
		return typeof id === 'string' ? [{ column, id }] : []
	})
	if (written.length === 0) {
		return
	}
	if (binding === undefined) {
		throw new QueryRefusedError('file_value', `${model.name}: a file column is written only by a handler, through ctx.db`)
	}
	const stamp = await scope()
	for (const { column, id } of written) {
		const kind = model.files[column] ?? ''
		if (!holdsFile(binding.holder, id)) {
			throw new QueryRefusedError('file_value', `${model.name}.${column}: this site holds no reference to that file it may read`)
		}
		const locked = await lockStoredFile(session, id, binding.graceMs)
		if (locked === null) {
			throw new NotFoundError('the file is no longer stored')
		}
		if (locked.kind !== kind) {
			throw new QueryRefusedError('file_value', `${model.name}.${column} holds files of kind '${kind}', and the file is of another kind`)
		}
		if (locked.status === 'pending') {
			if (locked.request !== binding.request || !locked.fresh) {
				throw new QueryRefusedError(
					'file_value',
					`${model.name}.${column}: a pending file is claimed only by the request that wrote it, within the grace`,
				)
			}
			await claimStoredFile(session, id, binding.scans(kind) ? 'quarantined' : 'live')
		}
		if (stamp !== null && !(await stampStoredFile(session, id, stamp))) {
			throw new QueryRefusedError('file_scope', `${model.name}.${column}: the file belongs to another top-level scope than this row`)
		}
	}
}
