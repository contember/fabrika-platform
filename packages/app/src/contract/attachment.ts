// `attachment()`: a procedure output that answers a file. The handler returns rows of the row schema, and the
// framework encodes them, so the quoting, the formula escaping and the size bound are right once. The value is the
// zod schema of what the handler returns (the rows' array), marked with what it declares beside it.

import { z } from 'zod/v4'
import { type AttachmentDeclaration, unknownOptions } from './declaration'
import type { InputSchema, NotLoose, Schema } from './define'

const ATTACHMENT = Symbol('fabrika.attachment')

/** What `attachment()` adds to the rows' array schema: its declaration and its row schema. */
export interface AttachmentMark {
	readonly declaration: AttachmentDeclaration
	readonly row: InputSchema
}

/** The marks `attachmentOutput` made: a property another module set on a schema is no attachment. */
const marks = new WeakSet<object>()

/** An attachment output of rows `R`: the handler returns `z.input<R>[]`, and the caller receives a file. */
export type Attachment<R extends InputSchema> = z.ZodArray<R> & AttachmentBrand

/** What tells an attachment output from a JSON one in the types. */
export interface AttachmentBrand {
	readonly [ATTACHMENT]: AttachmentMark
}

export interface AttachmentOptions<R> {
	/** `'csv'`: RFC 4180, UTF-8 with a byte order mark, a header line of the row's field names. */
	readonly format: 'csv'
	/** The file name the browser saves: `[A-Za-z0-9._-]`, ending in `.csv`. */
	readonly filename: string
	/** The row schema: a strict object of scalar fields, in the file's column order. */
	readonly row: R
	/** The encoded file's limit; an encoding over it fails the invocation and sends no body. */
	readonly maxBytes: number
	/** At most this many rows; 10 000 when left out. */
	readonly maxRows?: number
}

/**
 * The output of a procedure that answers a file of `row`s. Like every builder it validates nothing: `compileContract`
 * and the checker refuse a format, a name, a limit or a column outside what an attachment may be.
 */
export function attachment<R extends InputSchema>(options: AttachmentOptions<R & NotLoose<R>>): Attachment<R> {
	return attachmentOutput(options.row, {
		format: options.format,
		filename: options.filename,
		maxBytes: options.maxBytes,
		...(options.maxRows === undefined ? {} : { maxRows: options.maxRows }),
		unknownOptions: unknownOptions(options, 'attachment'),
	})
}

/** The rows' array schema marked with `declaration`; the static reader builds the evaluated value with it. */
export function attachmentOutput<R extends InputSchema>(row: R, declaration: AttachmentDeclaration): Attachment<R> {
	const mark: AttachmentMark = Object.freeze({ declaration: Object.freeze({ ...declaration }), row })
	marks.add(mark)
	return Object.assign(z.array(row), { [ATTACHMENT]: mark })
}

/** The mark of an `attachment()` output, or `null` for any other schema. */
export function attachmentOf(schema: Schema): AttachmentMark | null {
	const mark: unknown = Reflect.get(schema, ATTACHMENT)
	return isMark(mark) ? mark : null
}

function isMark(value: unknown): value is AttachmentMark {
	return typeof value === 'object' && value !== null && marks.has(value)
}
