// The file an `attachment()` output answers: the rows the handler returned, encoded as CSV (RFC 4180) in UTF-8. The
// whole file is encoded and measured before a byte is sent, so a file over its limit fails the invocation, which
// then rolls back, instead of sending a partial body. The limits are met while the rows are read, never after.

import type { AttachmentShape } from '@fabrika/auth-core'
import { z } from 'zod/v4'
import { attachmentOf } from '../contract/attachment'
import { ATTACHMENT_LIMITS, CSV_CONTENT_TYPE } from '../contract/defaults'
import type { Schema } from '../contract/define'
import { contentDisposition } from '../files/treatment'
import { ServerFault } from './faults'
import { project, ProjectionRefusedError } from './project'

/** A byte order mark: without it a spreadsheet reads the file in the machine's legacy code page. */
const BYTE_ORDER_MARK = '\uFEFF'
const LINE_END = '\r\n'

/**
 * A text a spreadsheet would run as a formula (or as a DDE command): one that starts with `=`, `+`, `-`, `@`, a tab,
 * a carriage return or a line feed, also after leading whitespace, and their full-width forms.
 */
const FORMULA_START = /^\s*[=+\-@\t\r\n\uFF1D\uFF0B\uFF0D\uFF20]/

/** RFC 4180: a field with a quote, a comma or a line break is quoted, and each quote inside doubled. */
const NEEDS_QUOTES = /[",\r\n]/

/**
 * The response an attachment answers. `rows` is what the handler returned: each row is projected and validated with
 * the row schema of `output` only when its turn to be encoded comes.
 */
export function attachmentResponse(endpoint: string, shape: AttachmentShape, output: Schema, rows: unknown): Response {
	const mark = attachmentOf(output)
	if (mark === null) {
		throw new ServerFault('contract_inconsistent', `'${endpoint}' answers an attachment, and its output schema is no attachment()`)
	}
	const body = encodeCsv(endpoint, shape, rows, (row) => validRow(endpoint, mark.row, row))
	return new Response(body, {
		status: 200,
		headers: {
			'Content-Type': CSV_CONTENT_TYPE,
			'Content-Length': String(body.byteLength),
			'Content-Disposition': contentDisposition('text/csv', shape.filename),
		},
	})
}

function validRow(endpoint: string, schema: Schema, row: unknown): unknown {
	let projected: unknown
	try {
		projected = project(schema, row)
	} catch (error) {
		if (error instanceof ProjectionRefusedError) {
			throw new ServerFault('output_refused', `'${endpoint}' returned a row no branch of its row schema accepts`)
		}
		throw error
	}
	const parsed = z.safeParse(schema, projected)
	if (!parsed.success) {
		throw new ServerFault('output_refused', `'${endpoint}' returned a row its row schema refuses`)
	}
	return parsed.data
}

/**
 * The header line of the column names, then one line per row, each row read through `rowOf` only when its turn
 * comes. The row count is checked before any row is read. Each field is encoded on its own, with its separator, and
 * counted against `maxBytes` before the next one is read, so neither a long result nor a wide row is built past the
 * limit; only then is the whole file joined.
 */
export function encodeCsv(endpoint: string, shape: AttachmentShape, rows: unknown, rowOf: (row: unknown) => unknown): Uint8Array<ArrayBuffer> {
	if (!Array.isArray(rows)) {
		throw new ServerFault('output_refused', `'${endpoint}' is an attachment, and its handler returned no list of rows`)
	}
	const count = rows.length
	if (count > shape.maxRows) {
		throw new ServerFault('attachment_rows', `'${endpoint}' returned ${count} rows, and its attachment holds at most ${shape.maxRows}`)
	}
	const encoder = new TextEncoder()
	const chunks: Uint8Array[] = []
	let size = 0
	const append = (text: string): void => {
		const bytes = encoder.encode(text)
		size += bytes.byteLength
		if (size > shape.maxBytes) {
			throw new ServerFault('attachment_size', `'${endpoint}' encodes to more than its ${shape.maxBytes} bytes`)
		}
		chunks.push(bytes)
	}
	const names = shape.columns.map((column) => column.name)
	const appendLine = (cellAt: (name: string) => unknown): void => {
		for (const [index, name] of names.entries()) {
			append(field(endpoint, cellAt(name)) + (index === names.length - 1 ? LINE_END : ','))
		}
	}
	append(BYTE_ORDER_MARK)
	appendLine((name) => name)
	for (let index = 0; index < count; index++) {
		const row = rowOf(rows[index])
		appendLine((name) => cellOf(endpoint, row, name))
	}
	const file = new Uint8Array(size)
	let offset = 0
	for (const bytes of chunks) {
		file.set(bytes, offset)
		offset += bytes.byteLength
	}
	return file
}

function cellOf(endpoint: string, row: unknown, name: string): unknown {
	if (typeof row !== 'object' || row === null || Array.isArray(row)) {
		throw new ServerFault('contract_inconsistent', `'${endpoint}' is an attachment, and a row of its output is not an object`)
	}
	return Reflect.get(row, name)
}

/**
 * One field. Text is escaped before it is quoted, so the quote cannot hide the formula from the escape. A number is a
 * finite JavaScript number, whose text is a numeric literal: its `-` is a sign, never a formula, so it stays a number.
 */
function field(endpoint: string, value: unknown): string {
	if (value === null || value === undefined) {
		return ''
	}
	if (typeof value === 'number' && Number.isFinite(value)) {
		return String(value)
	}
	if (typeof value === 'boolean') {
		return value ? 'true' : 'false'
	}
	if (typeof value !== 'string') {
		throw new ServerFault('contract_inconsistent', `'${endpoint}' is an attachment, and a cell of its output is not a scalar`)
	}
	if (value.length > ATTACHMENT_LIMITS.maxCellLength) {
		throw new ServerFault('attachment_cell', `'${endpoint}' returned a cell of ${value.length} characters`)
	}
	const text = FORMULA_START.test(value) ? `'${value}` : value
	return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
