// The file an `attachment()` output answers: the rows the handler returned, encoded as CSV (RFC 4180) in UTF-8. The
// whole file is encoded and measured before a byte is sent, so a file over its limit fails the invocation, which
// then rolls back, instead of sending a partial body.

import type { AttachmentShape } from '@fabrika/auth-core'
import { ATTACHMENT_LIMITS, CSV_CONTENT_TYPE } from '../contract/defaults'
import { contentDisposition } from '../files/treatment'
import { ServerFault } from './faults'

/** A byte order mark: without it a spreadsheet reads the file in the machine's legacy code page. */
const BYTE_ORDER_MARK = '﻿'
const LINE_END = '\r\n'

/**
 * A text a spreadsheet would run as a formula (or as a DDE command): one that starts with `=`, `+`, `-`, `@`, a tab,
 * a carriage return or a line feed, also after leading whitespace, and their full-width forms.
 */
const FORMULA_START = /^\s*[=+\-@\t\r\n＝＋－＠]/

/** RFC 4180: a field with a quote, a comma or a line break is quoted, and each quote inside doubled. */
const NEEDS_QUOTES = /[",\r\n]/

/** The response an attachment answers; `rows` passed the output schema. */
export function attachmentResponse(endpoint: string, shape: AttachmentShape, rows: unknown): Response {
	const body = encodeCsv(endpoint, shape, rows)
	return new Response(body, {
		status: 200,
		headers: {
			'Content-Type': CSV_CONTENT_TYPE,
			'Content-Length': String(body.byteLength),
			'Content-Disposition': contentDisposition('text/csv', shape.filename),
		},
	})
}

/**
 * The header line of the column names, then one line per row. Each line's UTF-8 bytes are counted as it is encoded,
 * and the encoding stops at the first line over `maxBytes`; only then is the whole file joined.
 */
export function encodeCsv(endpoint: string, shape: AttachmentShape, rows: unknown): Uint8Array<ArrayBuffer> {
	if (!Array.isArray(rows)) {
		throw new ServerFault('contract_inconsistent', `'${endpoint}' is an attachment, and its handler's output is not a list of rows`)
	}
	if (rows.length > shape.maxRows) {
		throw new ServerFault('attachment_rows', `'${endpoint}' returned ${rows.length} rows, and its attachment holds at most ${shape.maxRows}`)
	}
	const encoder = new TextEncoder()
	const lines: Uint8Array[] = []
	let size = 0
	const append = (line: string): void => {
		const bytes = encoder.encode(line)
		size += bytes.byteLength
		if (size > shape.maxBytes) {
			throw new ServerFault('attachment_size', `'${endpoint}' encodes to more than its ${shape.maxBytes} bytes`)
		}
		lines.push(bytes)
	}
	const names = shape.columns.map((column) => column.name)
	append(BYTE_ORDER_MARK + line(endpoint, names))
	for (const row of rows) {
		append(line(endpoint, names.map((name) => cellOf(endpoint, row, name))))
	}
	const file = new Uint8Array(size)
	let offset = 0
	for (const bytes of lines) {
		file.set(bytes, offset)
		offset += bytes.byteLength
	}
	return file
}

function line(endpoint: string, cells: readonly unknown[]): string {
	return cells.map((cell) => field(endpoint, cell)).join(',') + LINE_END
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
