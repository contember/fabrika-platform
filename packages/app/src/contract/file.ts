// `file('<kind>')`: a stored file of a declared kind, as a procedure's input field or its whole output. In an input it
// is a top-level field, optional, or a bounded array of them: the client sends it as a multipart part of its own, and
// the handler receives a file reference to the file the framework staged. As an output it is the file the procedure
// answers: the handler returns a reference it read, and the framework streams the file. The value is a zod schema of a
// file reference, marked with its kind.

import { z } from 'zod/v4'
import type { Schema } from './define'

const FILE = Symbol('fabrika.file')

/** A stored file's states: written, waiting for a scan, served, or refused by the scan. */
export type FileStatus = 'pending' | 'quarantined' | 'live' | 'rejected'

/**
 * What a handler holds of a stored file: its metadata, never its bytes. A file column read through `ctx.db`, an input
 * file and `ctx.files.put` answer one; only one this request holds is written into a column, served or opened.
 */
export interface FileRef {
	readonly id: string
	readonly name: string | null
	readonly type: string
	readonly size: number
	readonly status: FileStatus
}

/** What `file()` adds to its schema: the kind of file it holds. */
export interface FileMark {
	readonly kind: string
}

/** A file field or output of kind `K`. */
export type FileSchema<K extends string = string> = z.ZodType<FileRef, FileRef> & FileBrand<K>

/** What tells a file schema from a JSON one in the types. */
export interface FileBrand<K extends string> {
	readonly [FILE]: FileMark & { readonly '~kind'?: K }
}

/** The marks `file` made: a property another module set on a schema is no file. */
const marks = new WeakSet<object>()

/** A value a file field admits on its way in: a reference the framework made, or (in a browser) the `Blob` it sends. */
function isFileValue(value: unknown): boolean {
	if (typeof Blob !== 'undefined' && value instanceof Blob) {
		return true
	}
	return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'id') === 'string'
}

/**
 * A file of kind `kind` (`c.files({ … })` of the contract): an input field (top level, `z.optional`, or `z.array(…).max(n)`)
 * or a procedure's output. `compileContract` and the checker refuse it anywhere else.
 */
export function file<const K extends string>(kind: K): FileSchema<K> {
	const mark: FileMark = Object.freeze({ kind })
	marks.add(mark)
	const schema: z.ZodType<FileRef, FileRef> = z.custom<FileRef>(isFileValue, { message: `a file of kind '${kind}'` })
	return Object.assign(schema, { [FILE]: mark })
}

/** The mark of a `file()` schema, or `null` for any other schema. */
export function fileOf(schema: Schema | z.core.$ZodType): FileMark | null {
	const mark: unknown = Reflect.get(schema, FILE)
	return isMark(mark) ? mark : null
}

function isMark(value: unknown): value is FileMark {
	return typeof value === 'object' && value !== null && marks.has(value)
}
