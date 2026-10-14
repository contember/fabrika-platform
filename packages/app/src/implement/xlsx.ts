// The XLSX an `attachment({ format: 'xlsx' })` answers: one sheet, the header row of the row's field names, then one
// row per returned row with a typed cell each. The framework writes it itself, without a dependency: a ZIP of stored
// (uncompressed) entries holding the six SpreadsheetML parts a reader needs, and every text as an inline string,
// which no reader evaluates as a formula. Like the CSV, the file is measured while it is built and sent only whole.

import type { AttachmentShape, SchemaShape } from '@fabrika/auth-core'
import { ATTACHMENT_LIMITS } from '../contract/defaults'
import { ServerFault } from './faults'

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

const SHEET_PART = 'xl/worksheets/sheet1.xml'

/** The parts beside the sheet, in the order they are stored. */
const FIXED_PARTS: readonly (readonly [string, string])[] = [
	[
		'[Content_Types].xml',
		`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
		+ `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
		+ `<Default Extension="xml" ContentType="application/xml"/>`
		+ `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
		+ `<Override PartName="/${SHEET_PART}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
		+ `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`
		+ `</Types>`,
	],
	[
		'_rels/.rels',
		`<Relationships xmlns="${RELATIONSHIPS}"><Relationship Id="rId1" Type="${OFFICE}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
	],
	[
		'xl/workbook.xml',
		`<workbook xmlns="${MAIN}" xmlns:r="${OFFICE}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
	],
	[
		'xl/_rels/workbook.xml.rels',
		`<Relationships xmlns="${RELATIONSHIPS}">`
		+ `<Relationship Id="rId1" Type="${OFFICE}/worksheet" Target="worksheets/sheet1.xml"/>`
		+ `<Relationship Id="rId2" Type="${OFFICE}/styles" Target="styles.xml"/>`
		+ `</Relationships>`,
	],
	[
		'xl/styles.xml',
		`<styleSheet xmlns="${MAIN}">`
		+ `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>`
		+ `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>`
		+ `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>`
		+ `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
		+ `<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`
		+ `<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`
		+ `<xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>`
		+ `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>`
		+ `</styleSheet>`,
	],
]

/** The cell style of a date and of a date-time: the built-in formats 14 and 22 of `styles.xml`. */
const DATE_STYLE = 1
const DATETIME_STYLE = 2
const MS_PER_DAY = 86_400_000
/** Day 0 of the 1900 date system as a reader counts it from 1900-03-01 on, past its phantom 1900-02-29. */
const EPOCH_MS = Date.UTC(1899, 11, 30)
const FIRST_SERIAL_DATE_MS = Date.UTC(1900, 2, 1)

/** How a column's values are written: a string column whose schema says it is a date is a date cell. */
type TextKind = 'text' | 'date' | 'datetime'

function textKind(shape: SchemaShape): TextKind {
	switch (shape.type) {
		case 'optional':
		case 'nullable':
			return textKind(shape.inner)
		case 'string':
			return shape.format === 'date' ? 'date' : shape.format === 'datetime' ? 'datetime' : 'text'
		default:
			return 'text'
	}
}

/** Control characters but tab and line breaks, which XML 1.0 cannot carry, and a literal `_xHHHH_`, which a reader would decode. */
const UNSAFE = /(?![\t\n\r])\p{Cc}|[\uFFFE\uFFFF]|_(?=x[0-9A-Fa-f]{4}_)/gu

function escaped(text: string): string {
	return text
		.replace(UNSAFE, (char) => `_x${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`)
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
}

/** `A`, …, `Z`, `AA`, …: the column of a cell reference. */
function columnName(index: number): string {
	let name = ''
	for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) {
		name = String.fromCharCode(65 + ((rest - 1) % 26)) + name
	}
	return name
}

/** The serial day of a reader's 1900 date system, or `null` for a value it cannot show as one. */
function serial(value: string, kind: 'date' | 'datetime'): number | null {
	const time = kind === 'date' ? Date.parse(`${value}T00:00:00Z`) : Date.parse(value)
	if (!Number.isFinite(time) || time < FIRST_SERIAL_DATE_MS) {
		return null
	}
	return (time - EPOCH_MS) / MS_PER_DAY
}

function cell(endpoint: string, reference: string, value: unknown, kind: TextKind): string {
	if (value === null || value === undefined) {
		return ''
	}
	if (typeof value === 'number' && Number.isFinite(value)) {
		return `<c r="${reference}"><v>${value}</v></c>`
	}
	if (typeof value === 'boolean') {
		return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`
	}
	if (typeof value !== 'string') {
		throw new ServerFault('contract_inconsistent', `'${endpoint}' is an attachment, and a cell of its output is not a scalar`)
	}
	if (value.length > ATTACHMENT_LIMITS.maxCellLength) {
		throw new ServerFault('attachment_cell', `'${endpoint}' returned a cell of ${value.length} characters`)
	}
	const day = kind === 'text' ? null : serial(value, kind)
	if (day !== null) {
		return `<c r="${reference}" s="${kind === 'date' ? DATE_STYLE : DATETIME_STYLE}"><v>${day}</v></c>`
	}
	return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escaped(value)}</t></is></c>`
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
	let crc = index
	for (let bit = 0; bit < 8; bit++) {
		crc = crc & 1 ? 0xEDB88320 ^ (crc >>> 1) : crc >>> 1
	}
	return crc >>> 0
})

function crc32(chunks: readonly Uint8Array[]): number {
	let crc = 0xFFFFFFFF
	for (const chunk of chunks) {
		for (const byte of chunk) {
			crc = (CRC_TABLE[(crc ^ byte) & 0xFF] ?? 0) ^ (crc >>> 8)
		}
	}
	return (crc ^ 0xFFFFFFFF) >>> 0
}

interface Entry {
	readonly name: Uint8Array
	readonly chunks: readonly Uint8Array[]
	readonly size: number
}

const LOCAL_HEADER = 30
const CENTRAL_HEADER = 46
const END_RECORD = 22
/** 1980-01-01 00:00, the earliest DOS date: every entry has the same, so one set of rows is one file. */
const DOS_DATE = (1 << 5) | 1

/** Writes little-endian fields of a ZIP record from `offset` on. */
class Fields {
	readonly #view: DataView
	offset: number

	constructor(view: DataView, offset: number) {
		this.#view = view
		this.offset = offset
	}

	u16(...values: readonly number[]): this {
		for (const value of values) {
			this.#view.setUint16(this.offset, value, true)
			this.offset += 2
		}
		return this
	}

	u32(...values: readonly number[]): this {
		for (const value of values) {
			this.#view.setUint32(this.offset, value, true)
			this.offset += 4
		}
		return this
	}
}

/**
 * A ZIP of stored entries (APPNOTE 6.3: method 0, no data descriptor), `size` bytes long: the caller counted
 * `LOCAL_HEADER`, `CENTRAL_HEADER` and the name twice per entry, the data and `END_RECORD`.
 */
function zip(entries: readonly Entry[], size: number): Uint8Array<ArrayBuffer> {
	const file = new Uint8Array(size)
	const view = new DataView(file.buffer)
	const located = entries.map((entry) => ({ entry, crc: crc32(entry.chunks), offset: 0 }))
	let offset = 0
	for (const record of located) {
		const { entry, crc } = record
		record.offset = offset
		// signature, version needed, flags, method, time, date, CRC-32, sizes, name and extra field lengths
		offset = new Fields(view, offset).u32(0x04034B50).u16(20, 0, 0, 0, DOS_DATE).u32(crc, entry.size, entry.size).u16(entry.name.byteLength, 0)
			.offset
		file.set(entry.name, offset)
		offset += entry.name.byteLength
		for (const chunk of entry.chunks) {
			file.set(chunk, offset)
			offset += chunk.byteLength
		}
	}
	const directory = offset
	for (const { entry, crc, offset: local } of located) {
		// signature, versions made by and needed, flags, method, time, date, CRC-32, sizes, name, extra and comment
		// lengths, disk, internal and external attributes, the local header's offset
		offset = new Fields(view, offset).u32(0x02014B50).u16(20, 20, 0, 0, 0, DOS_DATE).u32(crc, entry.size, entry.size)
			.u16(entry.name.byteLength, 0, 0, 0, 0).u32(0, local).offset
		file.set(entry.name, offset)
		offset += entry.name.byteLength
	}
	// signature, this disk, the directory's disk, its entries on this disk and in all, its size and offset, comment length
	new Fields(view, offset).u32(0x06054B50).u16(0, 0, entries.length, entries.length).u32(offset - directory, directory).u16(0)
	return file
}

/**
 * The XLSX of `rows`, each read through `rowOf` only when its turn comes, after the row count was checked. Each cell
 * is counted against `maxBytes`, with every other part and header of the file, before the next one is read.
 */
export function encodeXlsx(endpoint: string, shape: AttachmentShape, rows: unknown, rowOf: (row: unknown) => unknown): Uint8Array<ArrayBuffer> {
	if (!Array.isArray(rows)) {
		throw new ServerFault('output_refused', `'${endpoint}' is an attachment, and its handler returned no list of rows`)
	}
	const count = rows.length
	if (count > shape.maxRows) {
		throw new ServerFault('attachment_rows', `'${endpoint}' returned ${count} rows, and its attachment holds at most ${shape.maxRows}`)
	}
	const encoder = new TextEncoder()
	const fixed: Entry[] = FIXED_PARTS.map(([name, xml]) => {
		const bytes = encoder.encode(XML_DECLARATION + xml)
		return { name: encoder.encode(name), chunks: [bytes], size: bytes.byteLength }
	})
	const sheetName = encoder.encode(SHEET_PART)
	const headers = [...fixed.map((entry) => entry.name), sheetName].reduce((sum, name) => sum + LOCAL_HEADER + CENTRAL_HEADER + 2 * name.byteLength, 0)
	let size = headers + END_RECORD + fixed.reduce((sum, entry) => sum + entry.size, 0)
	const sheet: Uint8Array[] = []
	let sheetSize = 0
	const append = (text: string): void => {
		const bytes = encoder.encode(text)
		size += bytes.byteLength
		sheetSize += bytes.byteLength
		if (size > shape.maxBytes) {
			throw new ServerFault('attachment_size', `'${endpoint}' encodes to more than its ${shape.maxBytes} bytes`)
		}
		sheet.push(bytes)
	}
	const columns = shape.columns.map((column, index) => ({ name: column.name, letter: columnName(index), kind: textKind(column.shape) }))
	append(`${XML_DECLARATION}<worksheet xmlns="${MAIN}"><sheetData>`)
	append(`<row r="1">${columns.map((column) => cell(endpoint, `${column.letter}1`, column.name, 'text')).join('')}</row>`)
	for (let index = 0; index < count; index++) {
		const row = rowOf(rows[index])
		if (typeof row !== 'object' || row === null || Array.isArray(row)) {
			throw new ServerFault('contract_inconsistent', `'${endpoint}' is an attachment, and a row of its output is not an object`)
		}
		const line = index + 2
		append(`<row r="${line}">`)
		for (const column of columns) {
			append(cell(endpoint, `${column.letter}${line}`, Reflect.get(row, column.name), column.kind))
		}
		append('</row>')
	}
	append('</sheetData></worksheet>')
	return zip([...fixed, { name: sheetName, chunks: sheet, size: sheetSize }], size)
}
