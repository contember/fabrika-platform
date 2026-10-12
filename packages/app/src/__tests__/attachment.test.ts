// An `attachment()` output: the handler returns rows and the framework answers a CSV file, quoted per RFC 4180, every
// text cell that a spreadsheet would run as a formula escaped first, and nothing sent when the file outgrows its limit.

import { createClient, download, RpcError } from '@fabrika/app/client'
import { attachment, compileContract, ContractError, defineContract, parseContractArtifact } from '@fabrika/app/contract'
import { testKit } from '@fabrika/app/testing'
import type { AttachmentShape } from '@fabrika/auth-core'
import { describe, expect, spyOn, test } from 'bun:test'
import { z } from 'zod/v4'
import { encodeCsv } from '../implement/attachment'
import { ServerFault } from '../implement/faults'
import { implement } from '../implement/implement'

const vocabulary = {
	app: 'intake',
	dimensions: { workspace: {} },
	actions: { 'intake.read': 'Read submissions', 'intake.export': 'Export submissions' },
	roles: {
		reviewer: { grants: ['intake.read', 'intake.export'], member: { scope: 'workspace', assignableBy: ['reviewer'] } },
		guest: { grants: ['intake.read'], member: { scope: 'workspace', assignableBy: ['reviewer'] } },
	},
} as const

const Row = z.strictObject({ name: z.string(), score: z.nullable(z.number()), active: z.boolean() })
const Candidates = attachment({ format: 'csv', filename: 'candidates.csv', row: Row, maxBytes: 200, maxRows: 5 })
const ExportInput = z.strictObject({ workspaceId: z.string(), names: z.array(z.string()) })

const contract = defineContract(vocabulary, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, {
		candidates: c.mutation({ input: ExportInput, output: Candidates, access: { action: 'intake.export', in: 'workspace', from: 'workspaceId' } }),
	}),
}))

const app = implement(contract, {
	database: null,
	deps: () => ({}),
	handlers: () => ({
		api: {
			candidates: ({ input }) => input.names.map((name, index) => ({ name, score: index === 0 ? -1.5 : null, active: index % 2 === 0 })),
		},
	}),
})

const BOM = '﻿'
const NAMES = ['=1+1', 'say "hi"', 'line\nbreak']
const EXPECTED = `${BOM}name,score,active\r\n'=1+1,-1.5,true\r\n"say ""hi""",,false\r\n"line\nbreak",,true\r\n`

function problemsOf(compile: () => unknown): readonly string[] {
	try {
		compile()
	} catch (error) {
		if (error instanceof ContractError) {
			return error.problems
		}
		throw error
	}
	throw new Error('the contract compiled')
}

const shape = (columns: readonly string[], limits: { maxBytes?: number; maxRows?: number } = {}): AttachmentShape => ({
	type: 'attachment',
	format: 'csv',
	filename: 'x.csv',
	maxBytes: limits.maxBytes ?? 1_000_000,
	maxRows: limits.maxRows ?? 100,
	columns: columns.map((name) => ({
		name,
		shape: { type: 'string', format: null, minLength: null, maxLength: null, pattern: null, startsWith: null, endsWith: null, includes: null },
	})),
})

const decoded = (bytes: Uint8Array): string => new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)

/** The one cell of a one-column file of one row, as written to the file. */
const cell = (value: unknown): string => decoded(encodeCsv('t', shape(['v']), [{ v: value }])).slice(`${BOM}v\r\n`.length, -2)

function faultOf(encode: () => unknown): string {
	try {
		encode()
	} catch (error) {
		if (error instanceof ServerFault) {
			return error.reason
		}
		throw error
	}
	throw new Error('the rows encoded')
}

describe('the contract build', () => {
	test('an attachment output is the row the file holds, in its column order, with its limits', () => {
		const artifact = compileContract(contract, {})
		const row = artifact.endpoints.find((endpoint) => endpoint.id === 'api.candidates')
		expect(row?.kind).toBe('mutation')
		expect(row?.output).toEqual({
			type: 'attachment',
			format: 'csv',
			filename: 'candidates.csv',
			maxBytes: 200,
			maxRows: 5,
			columns: [
				{
					name: 'name',
					shape: { type: 'string', format: null, minLength: null, maxLength: null, pattern: null, startsWith: null, endsWith: null, includes: null },
				},
				{
					name: 'score',
					shape: {
						type: 'nullable',
						inner: { type: 'number', int: false, min: null, exclusiveMin: false, max: null, exclusiveMax: false, multipleOf: null },
					},
				},
				{ name: 'active', shape: { type: 'boolean' } },
			],
		})
		expect(parseContractArtifact(JSON.parse(JSON.stringify(artifact)))).toEqual(artifact)
	})

	test('maxRows defaults to 10 000', () => {
		const unbounded = defineContract(vocabulary, (c) => ({
			api: c.rpc('/api', { callers: ['human'] }, {
				all: c.query({
					output: attachment({ format: 'csv', filename: 'all.csv', row: Row, maxBytes: 1024 }),
					access: { action: 'intake.read', over: 'workspace' },
				}),
			}),
		}))
		const output = compileContract(unbounded, {}).endpoints.find((endpoint) => endpoint.id === 'api.all')?.output
		expect(output?.type === 'attachment' ? output.maxRows : null).toBe(10_000)
	})

	test('refuses a format, a file name, a limit or a column outside what an attachment may be', () => {
		const Nested = z.strictObject({ name: z.string(), tags: z.array(z.string()) })
		const refused = defineContract(vocabulary, (c) => ({
			api: c.rpc('/api', { callers: ['human'] }, {
				nested: c.query({
					output: attachment({ format: 'csv', filename: '../etc/passwd.csv', row: Nested, maxBytes: 0, maxRows: 100_001 }),
					access: { action: 'intake.read', over: 'workspace' },
				}),
			}),
		}))
		expect(problemsOf(() => compileContract(refused, {}))).toEqual([
			"procedure 'api.nested' attachment: filename '../etc/passwd.csv' is not a file name (allowed: ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\\.csv$)",
			"procedure 'api.nested' attachment: maxBytes 0 is not a whole number from 1 to 16777216",
			"procedure 'api.nested' attachment: maxRows 100001 is not a whole number from 1 to 100000",
			"procedure 'api.nested' attachment: column 'tags' is not a cell (allowed: a string, number, boolean, enum or literal, optional or nullable)",
		])
	})

	test('an attachment is a whole output: never an input, never inside another schema, never on an export', () => {
		const nested = defineContract(vocabulary, (c) => ({
			api: c.rpc('/api', { callers: ['human'] }, {
				page: c.query({
					output: z.strictObject({ file: Candidates }),
					access: { action: 'intake.read', over: 'workspace' },
				}),
			}),
			exports: {
				reports: c.export({
					version: 1,
					consumers: ['crm'],
					audience: 'any consumer user',
					procedures: { candidates: c.query({ output: Candidates, access: { action: 'intake.read', over: 'workspace' } }) },
				}),
			},
		}))
		expect(problemsOf(() => compileContract(nested, {}))).toEqual([
			"mount 'api' procedure 'page' output.file: an attachment() is a procedure's whole output, never part of a schema or an input (allowed: output: attachment({ … }))",
		])
		const exported = defineContract(vocabulary, (c) => ({
			exports: {
				reports: c.export({
					version: 1,
					consumers: ['crm'],
					audience: 'any consumer user',
					procedures: { candidates: c.query({ output: Candidates, access: { action: 'intake.read', over: 'workspace' } }) },
				}),
			},
		}))
		expect(problemsOf(() => compileContract(exported, {}))).toContain(
			"procedure 'reports.v1.candidates': an export answers its consumers JSON; an attachment() is for an RPC or a link procedure",
		)
	})
})

describe('the CSV encoding', () => {
	test.each([
		['=1+1', "'=1+1"],
		['+1', "'+1"],
		['-1', "'-1"],
		['@SUM(A1:A9)', "'@SUM(A1:A9)"],
		['=HYPERLINK("https://evil.test","x")', `"'=HYPERLINK(""https://evil.test"",""x"")"`],
		['\t=1', "'\t=1"],
		['\t', "'\t"],
		['\r=1', `"'\r=1"`],
		['\n-1', `"'\n-1"`],
		[' =1', "' =1"],
		['   @x', "'   @x"],
		[' +1', "' +1"],
		[' \t-1', "' \t-1"],
		['＝1+1', "'＝1+1"],
		['＠x', "'＠x"],
		['a=1', 'a=1'],
		['1-2', '1-2'],
		[' x', ' x'],
		['', ''],
		['a,b', '"a,b"'],
		['"=1"', '"""=1"""'],
		['=1,2', `"'=1,2"`],
	])('the text cell %j is written as %j', (value, written) => {
		expect(cell(value)).toBe(written)
	})

	test('a number keeps its sign, a boolean is true or false, and null is an empty field', () => {
		expect([-1.5, 0, 1e21, true, false, null, undefined].map(cell)).toEqual(['-1.5', '0', '1e+21', 'true', 'false', '', ''])
	})

	test('the file is a byte order mark, a header line of the column names and one CRLF line per row; a column name is escaped too', () => {
		const bytes = encodeCsv('t', shape(['=name', 'note']), [{ '=name': 'Ann', note: 'ok' }])
		expect(decoded(bytes)).toBe(`${BOM}'=name,note\r\nAnn,ok\r\n`)
		expect([...bytes.slice(0, 3)]).toEqual([0xEF, 0xBB, 0xBF])
	})

	test('maxBytes counts UTF-8 bytes: a file exactly at its limit encodes, one byte less fails', () => {
		const rows = [{ v: 'č😀\uD800' }]
		const exact = new TextEncoder().encode(`${BOM}v\r\nč😀�\r\n`).byteLength
		expect(exact).toBe(3 + 3 + 2 + 4 + 3 + 2)
		expect(encodeCsv('t', shape(['v'], { maxBytes: exact }), rows).byteLength).toBe(exact)
		expect(faultOf(() => encodeCsv('t', shape(['v'], { maxBytes: exact - 1 }), rows))).toBe('attachment_size')
	})

	test('the encoding stops at the first line over the limit, whatever follows', () => {
		const rows = Array.from({ length: 100 }, () => ({ v: 'x'.repeat(1_000) }))
		expect(faultOf(() => encodeCsv('t', shape(['v'], { maxBytes: 5_000 }), rows))).toBe('attachment_size')
	})

	test('a row count over maxRows and a cell over the cell limit fail before the file is joined', () => {
		expect(faultOf(() => encodeCsv('t', shape(['v'], { maxRows: 2 }), [{ v: 'a' }, { v: 'b' }, { v: 'c' }]))).toBe('attachment_rows')
		expect(encodeCsv('t', shape(['v']), [{ v: 'x'.repeat(32_767) }]).byteLength).toBe(3 + 3 + 32_767 + 2)
		expect(faultOf(() => encodeCsv('t', shape(['v']), [{ v: 'x'.repeat(32_768) }]))).toBe('attachment_cell')
	})

	test('an output that is not a list of scalar rows is a contract fault, never a file', () => {
		expect(faultOf(() => encodeCsv('t', shape(['v']), { v: 'a' }))).toBe('contract_inconsistent')
		expect(faultOf(() => encodeCsv('t', shape(['v']), ['a']))).toBe('contract_inconsistent')
		expect(faultOf(() => encodeCsv('t', shape(['v']), [{ v: { nested: true } }]))).toBe('contract_inconsistent')
	})
})

describe('the dispatcher answers the file', () => {
	const reviewer = (kit: ReturnType<typeof testKit>) => kit.testCaller([{ role: 'reviewer', scope: { type: 'workspace', value: 'w1' } }])

	test('the CSV bytes and headers, with a formula, a quote and a newline in its cells', async () => {
		const kit = testKit(app)
		const response = await kit.browser(reviewer(kit))('/api/candidates', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ workspaceId: 'w1', names: NAMES }),
		})
		expect(response.status).toBe(200)
		expect(response.headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
		expect(response.headers.get('Content-Disposition')).toBe("attachment; filename*=UTF-8''candidates.csv")
		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
		expect(response.headers.get('Cache-Control')).toBe('no-store')
		const bytes = new Uint8Array(await response.arrayBuffer())
		expect(response.headers.get('Content-Length')).toBe(String(bytes.byteLength))
		expect(decoded(bytes)).toBe(EXPECTED)
	})

	test('over maxBytes the invocation fails: a 500 envelope, no CSV, and a log line of fixed codes', async () => {
		const kit = testKit(app)
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			const response = await kit.browser(reviewer(kit))('/api/candidates', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ workspaceId: 'w1', names: ['x'.repeat(150), 'secret-row-value'.repeat(4)] }),
			})
			expect(response.status).toBe(500)
			expect(response.headers.get('Content-Type')).toStartWith('application/json')
			expect(response.headers.get('Content-Disposition')).toBeNull()
			const text = await response.text()
			expect(JSON.parse(text)).toEqual({ error: { type: 'internal', message: 'Internal error' } })
			const lines = log.mock.calls.map((line) => String(line[0]))
			expect(lines).toEqual([
				'fabrika: api.candidates: framework_fault: attachment_size: the encoded attachment is larger than it declares (maxBytes); no body was sent',
			])
			expect(lines.join('\n')).not.toContain('secret-row-value')
		} finally {
			log.mockRestore()
		}
	})

	test('more rows than maxRows fail the invocation too', async () => {
		const kit = testKit(app)
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			const response = await kit.browser(reviewer(kit))('/api/candidates', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ workspaceId: 'w1', names: ['a', 'b', 'c', 'd', 'e', 'f'] }),
			})
			expect(response.status).toBe(500)
			expect(log.mock.calls.map((line) => String(line[0]))).toEqual([
				'fabrika: api.candidates: framework_fault: attachment_rows: the handler returned more rows than its attachment declares (maxRows)',
			])
		} finally {
			log.mockRestore()
		}
	})
})

describe('the client downloads the file', () => {
	test('download(api.<procedure>, input) answers the file under its declared name', async () => {
		const kit = testKit(app)
		const caller = kit.testCaller([{ role: 'reviewer', scope: { type: 'workspace', value: 'w1' } }])
		const api = createClient(contract, 'api', { fetch: kit.browser(caller) })
		expect(api.candidates).toEqual({ id: 'api.candidates', filename: 'candidates.csv' })
		const file = await download(api.candidates, { workspaceId: 'w1', names: NAMES })
		expect(file.name).toBe('candidates.csv')
		expect(file.type).toStartWith('text/csv')
		expect(decoded(new Uint8Array(await file.arrayBuffer()))).toBe(EXPECTED)
	})

	test('a refused download is an RpcError with the envelope of the refusal', async () => {
		const kit = testKit(app)
		const guest = kit.testCaller([{ role: 'guest', scope: { type: 'workspace', value: 'w1' } }])
		const api = createClient(contract, 'api', { fetch: kit.browser(guest) })
		const refusal = await download(api.candidates, { workspaceId: 'w1', names: NAMES }).catch((error: unknown) => error)
		expect(refusal).toBeInstanceOf(RpcError)
		expect(refusal instanceof RpcError ? refusal.httpStatus : null).toBe(403)
	})

	test('download takes only a client attachment procedure', async () => {
		await expect(download({ id: 'api.forged', filename: 'x.csv' })).rejects.toThrow("'api.forged' is not an attachment procedure of a client")
	})
})
