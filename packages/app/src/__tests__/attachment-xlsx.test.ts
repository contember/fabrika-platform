// An `attachment({ format: 'xlsx' })` output: the file the dispatcher answers is opened by an independent reader
// (Python's own `zipfile` and `xml.etree`, which checks every entry's CRC-32), and each cell has its type and value; a
// text is an inline string, never a formula; a file over its limit sends no body. Skips the reader's half without
// `python3` on PATH.

import { attachment, compileContract, ContractError, defineContract, parseContractArtifact } from '@fabrika/app/contract'
import { testKit } from '@fabrika/app/testing'
import type { AttachmentShape } from '@fabrika/auth-core'
import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { ServerFault } from '../implement/faults'
import { implement } from '../implement/implement'
import { encodeXlsx } from '../implement/xlsx'

const python = Bun.which('python3')
if (python === null) {
	console.warn('attachment-xlsx.test.ts skipped its independent reader: put python3 on PATH to run it')
}

/** Reads an XLSX as a spreadsheet reads it: its entries (CRC-checked), each cell's type by `t` and its style's format. */
const READER = `
import datetime, json, re, sys, zipfile
import xml.etree.ElementTree as ET
NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
book = zipfile.ZipFile(sys.argv[1])
corrupt = book.testzip()
formats = [int(xf.get('numFmtId')) for xf in ET.fromstring(book.read('xl/styles.xml')).find('m:cellXfs', NS)]
sheet = ET.fromstring(book.read('xl/worksheets/sheet1.xml'))
decode = lambda text: re.sub(r'_x([0-9A-Fa-f]{4})_', lambda match: chr(int(match.group(1), 16)), text)
epoch = datetime.datetime(1899, 12, 30)
rows = []
for row in sheet.find('m:sheetData', NS):
    cells = []
    for cell in row:
        kind = cell.get('t', 'n')
        if kind == 'inlineStr':
            cells.append([cell.get('r'), 'text', decode(''.join(cell.find('m:is', NS).itertext()))])
        elif kind == 'b':
            cells.append([cell.get('r'), 'boolean', cell.find('m:v', NS).text == '1'])
        else:
            value = float(cell.find('m:v', NS).text)
            format = formats[int(cell.get('s', '0'))]
            if format == 14:
                cells.append([cell.get('r'), 'date', (epoch + datetime.timedelta(days=value)).date().isoformat()])
            elif format == 22:
                cells.append([cell.get('r'), 'datetime', (epoch + datetime.timedelta(days=value)).isoformat()])
            else:
                cells.append([cell.get('r'), 'number', value])
    rows.append(cells)
types = ET.fromstring(book.read('[Content_Types].xml'))
sheetType = [o.get('ContentType') for o in types if o.get('PartName') == '/xl/worksheets/sheet1.xml']
print(json.dumps({'corrupt': corrupt, 'entries': book.namelist(), 'sheetType': sheetType, 'formulas': len(sheet.findall('.//m:f', NS)), 'rows': rows}))
`

const ReadBook = z.strictObject({
	corrupt: z.null(),
	entries: z.array(z.string()),
	sheetType: z.array(z.string()),
	formulas: z.number(),
	rows: z.array(
		z.array(z.tuple([z.string(), z.enum(['text', 'boolean', 'date', 'datetime', 'number']), z.union([z.string(), z.number(), z.boolean()])])),
	),
})

function read(bytes: Uint8Array): z.output<typeof ReadBook> {
	const directory = mkdtempSync(join(tmpdir(), 'fabrika-xlsx-'))
	try {
		const path = join(directory, 'book.xlsx')
		writeFileSync(path, bytes)
		const run = Bun.spawnSync([python ?? 'python3', '-I', '-c', READER, path], { stdout: 'pipe', stderr: 'pipe' })
		if (run.exitCode !== 0) throw new Error(`the reader failed: ${run.stderr.toString()}`)
		return ReadBook.parse(JSON.parse(run.stdout.toString()))
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

const vocabulary = {
	app: 'intake',
	dimensions: { workspace: {} },
	actions: { 'intake.read': 'Read submissions', 'intake.export': 'Export submissions' },
	roles: { reviewer: { grants: ['intake.read', 'intake.export'], member: { scope: 'workspace', assignableBy: ['reviewer'] } } },
} as const

const Row = z.strictObject({
	name: z.string(),
	score: z.nullable(z.number()),
	active: z.boolean(),
	joined: z.iso.date(),
	seen: z.nullable(z.iso.datetime()),
	code: z.string(),
})
const Book = attachment({ format: 'xlsx', filename: 'candidates.xlsx', row: Row, maxBytes: 8192, maxRows: 5 })
const Small = attachment({ format: 'xlsx', filename: 'small.xlsx', row: Row, maxBytes: 4000 })

const contract = defineContract(vocabulary, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, {
		candidates: c.query({ output: Book, access: { action: 'intake.export', over: 'workspace' } }),
		small: c.query({ output: Small, access: { action: 'intake.export', over: 'workspace' } }),
	}),
}))

type CandidateRow = z.input<typeof Row>

const ROWS: CandidateRow[] = [
	{ name: '=1+1', score: -1.5, active: true, joined: '2026-10-12', seen: '2026-10-12T06:30:00Z', code: '007' },
	{ name: 'a < b & "c"', score: null, active: false, joined: '1900-01-15', seen: null, code: 'bell\u0007 _x0041_ end ' },
]

const app = implement(contract, {
	database: null,
	deps: () => ({}),
	handlers: () => ({ api: { candidates: () => ROWS, small: () => [...ROWS, ...ROWS, ...ROWS, ...ROWS, ...ROWS] } }),
})

const reviewer = (kit: ReturnType<typeof testKit>) => kit.testCaller([{ role: 'reviewer', scope: { type: 'workspace', value: 'w1' } }])

const post = (kit: ReturnType<typeof testKit>, path: string) =>
	kit.browser(reviewer(kit))(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })

function faultOf(encode: () => unknown): string {
	try {
		encode()
	} catch (error) {
		if (error instanceof ServerFault) return error.reason
		throw error
	}
	throw new Error('the rows encoded')
}

describe('the contract build', () => {
	test("format 'xlsx' is the attachment's, with an .xlsx file name, and parses back from the artifact", () => {
		const artifact = compileContract(contract, {})
		const output = artifact.endpoints.find((row) => row.id === 'api.candidates')?.output
		expect(output).toMatchObject({ type: 'attachment', format: 'xlsx', filename: 'candidates.xlsx', maxBytes: 8192, maxRows: 5 })
		expect(parseContractArtifact(JSON.parse(JSON.stringify(artifact)))).toEqual(artifact)
	})

	test('refuses a format the framework does not write, and a file name of another format', () => {
		const refused = defineContract(vocabulary, (c) => ({
			api: c.rpc('/api', { callers: ['human'] }, {
				csvName: c.query({
					output: attachment({ format: 'xlsx', filename: 'candidates.csv', row: Row, maxBytes: 1024 }),
					access: { action: 'intake.read', over: 'workspace' },
				}),
			}),
		}))
		let problems: readonly string[] = []
		try {
			compileContract(refused, {})
		} catch (error) {
			if (error instanceof ContractError) problems = error.problems
		}
		expect(problems).toEqual([
			"procedure 'api.csvName' attachment: filename 'candidates.csv' is not a file name (allowed: ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\\.xlsx$)",
		])
	})
})

describe.skipIf(python === null)('the file an independent reader opens', () => {
	test('one sheet: the header row, then a typed cell per value; a date column is a date, any other text an inline string', async () => {
		const kit = testKit(app)
		const response = await post(kit, '/api/candidates')
		expect(response.status).toBe(200)
		expect(response.headers.get('Content-Type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
		expect(response.headers.get('Content-Disposition')).toBe("attachment; filename*=UTF-8''candidates.xlsx")
		const bytes = new Uint8Array(await response.arrayBuffer())
		expect(response.headers.get('Content-Length')).toBe(String(bytes.byteLength))
		const book = read(bytes)
		expect(book.entries).toEqual([
			'[Content_Types].xml',
			'_rels/.rels',
			'xl/workbook.xml',
			'xl/_rels/workbook.xml.rels',
			'xl/styles.xml',
			'xl/worksheets/sheet1.xml',
		])
		expect(book.sheetType).toEqual(['application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'])
		expect(book.formulas).toBe(0)
		expect(book.rows).toEqual([
			[['A1', 'text', 'name'], ['B1', 'text', 'score'], ['C1', 'text', 'active'], ['D1', 'text', 'joined'], ['E1', 'text', 'seen'], [
				'F1',
				'text',
				'code',
			]],
			[
				['A2', 'text', '=1+1'],
				['B2', 'number', -1.5],
				['C2', 'boolean', true],
				['D2', 'date', '2026-10-12'],
				['E2', 'datetime', '2026-10-12T06:30:00'],
				['F2', 'text', '007'],
			],
			[
				['A3', 'text', 'a < b & "c"'],
				['C3', 'boolean', false],
				['D3', 'text', '1900-01-15'],
				['F3', 'text', 'bell\u0007 _x0041_ end '],
			],
		])
	})
})

describe('the bounds of the XLSX', () => {
	const shape = (limits: { maxBytes?: number; maxRows?: number } = {}): AttachmentShape => ({
		type: 'attachment',
		format: 'xlsx',
		filename: 'x.xlsx',
		maxBytes: limits.maxBytes ?? 1_000_000,
		maxRows: limits.maxRows ?? 100,
		columns: [{
			name: 'v',
			shape: { type: 'string', format: null, minLength: null, maxLength: null, pattern: null, startsWith: null, endsWith: null, includes: null },
		}],
	})
	const asIs = (row: unknown): unknown => row

	test('maxBytes is the whole file: one exactly at its limit encodes, one byte less fails', () => {
		const rows = [{ v: 'č😀' }]
		const exact = encodeXlsx('t', shape(), rows, asIs).byteLength
		expect(encodeXlsx('t', shape({ maxBytes: exact }), rows, asIs).byteLength).toBe(exact)
		expect(faultOf(() => encodeXlsx('t', shape({ maxBytes: exact - 1 }), rows, asIs))).toBe('attachment_size')
	})

	test('a long result stops at the first row over the limit, and a row count or a cell over its limit fails first', () => {
		let reads = 0
		const rows = Array.from({ length: 100 }, () => ({ v: 'x'.repeat(1_000) }))
		const counted = (row: unknown): unknown => {
			reads++
			return row
		}
		expect(faultOf(() => encodeXlsx('t', shape({ maxBytes: 5_000 }), rows, counted))).toBe('attachment_size')
		expect(reads).toBeLessThan(5)
		expect(faultOf(() => encodeXlsx('t', shape({ maxRows: 2 }), [{ v: 'a' }, { v: 'b' }, { v: 'c' }], asIs))).toBe('attachment_rows')
		expect(faultOf(() => encodeXlsx('t', shape(), [{ v: 'x'.repeat(32_768) }], asIs))).toBe('attachment_cell')
	})

	test('over maxBytes the invocation fails: a 500 envelope and no file', async () => {
		const kit = testKit(app)
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			const response = await post(kit, '/api/small')
			expect(response.status).toBe(500)
			expect(response.headers.get('Content-Type')).toStartWith('application/json')
			expect(response.headers.get('Content-Disposition')).toBeNull()
			expect(log.mock.calls.map((line) => String(line[0]))).toEqual([
				'fabrika: api.small: framework_fault: attachment_size: the encoded attachment is larger than it declares (maxBytes); no body was sent',
			])
		} finally {
			log.mockRestore()
		}
	})
})
