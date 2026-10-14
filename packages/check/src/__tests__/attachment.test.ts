// The static reader reads an `attachment({ … })` output, in the contract or in a schema module, into the artifact the
// evaluated contract compiles to, and refuses every other use of the builder.

import { attachment, compileContract, defineContract } from '@fabrika/app/contract'
import { canonicalArtifactJson } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { ContractSourceError, readContract, readContractSource } from '../contract'

const SCHEMAS = `import { attachment } from '@fabrika/app/contract'
import { z } from 'zod/v4'

export const Row = z.strictObject({ name: z.string(), score: z.nullable(z.int()) })
export const Candidates = attachment({ format: 'csv', filename: 'candidates.csv', row: Row, maxBytes: 100_000 })
`

const contractSource = (output: string): string =>
	`import { attachment, defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { Candidates, Row } from './src/schemas'

export const contract = defineContract({
	app: 'intake',
	dimensions: { workspace: {} },
	actions: { 'intake.read': 'Read submissions' },
	roles: { reviewer: { grants: ['intake.read'], member: { scope: 'workspace', assignableBy: ['reviewer'] } } },
}, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, {
		candidates: c.query({ output: Candidates, access: { action: 'intake.read', over: 'workspace' } }),
		inline: c.query({ output: ${output}, access: { action: 'intake.read', over: 'workspace' } }),
	}),
}))
`

const Row = z.strictObject({ name: z.string(), score: z.nullable(z.int()) })
const evaluated = defineContract({
	app: 'intake',
	dimensions: { workspace: {} },
	actions: { 'intake.read': 'Read submissions' },
	roles: { reviewer: { grants: ['intake.read'], member: { scope: 'workspace', assignableBy: ['reviewer'] } } },
}, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, {
		candidates: c.query({
			output: attachment({ format: 'csv', filename: 'candidates.csv', row: Row, maxBytes: 100_000 }),
			access: { action: 'intake.read', over: 'workspace' },
		}),
		inline: c.query({
			output: attachment({ format: 'csv', filename: 'inline.csv', row: Row, maxBytes: 2_000, maxRows: 50 }),
			access: { action: 'intake.read', over: 'workspace' },
		}),
	}),
}))

const files = (output: string): ReadonlyMap<string, string> => new Map([['fabrika.contract.ts', contractSource(output)], ['src/schemas.ts', SCHEMAS]])

function refusal(output: string): string[] {
	try {
		readContract(files(output))
	} catch (error) {
		if (error instanceof ContractSourceError) {
			return error.findings.map((finding) => `${finding.file}:${finding.line} ${finding.rule} ${finding.message}`)
		}
		throw error
	}
	return []
}

describe('an attachment output in the static reader', () => {
	test('reads a const of a schema module and an inline call into the artifact and the canonical bytes of the evaluated contract', () => {
		const read = readContractSource(files("attachment({ format: 'csv', filename: 'inline.csv', row: Row, maxBytes: 2_000, maxRows: 50 })"), {})
		expect(read).toEqual(compileContract(evaluated, {}))
		expect(canonicalArtifactJson(read)).toBe(canonicalArtifactJson(compileContract(evaluated, {})))
		expect(read.endpoints.find((row) => row.id === 'api.inline')?.output?.type).toBe('attachment')
	})

	test('a format the framework does not write is refused in the runtime words, and an XLSX takes an .xlsx name', () => {
		expect(() => readContractSource(files("attachment({ format: 'ods', filename: 'x.csv', row: Row, maxBytes: 10 })"), {})).toThrow(
			"procedure 'api.inline' attachment: format 'ods' is not a file format the framework encodes (allowed: 'csv', 'xlsx')",
		)
		expect(() => readContractSource(files("attachment({ format: 'xlsx', filename: 'x.csv', row: Row, maxBytes: 10 })"), {})).toThrow(
			"procedure 'api.inline' attachment: filename 'x.csv' is not a file name (allowed: ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\\.xlsx$)",
		)
		const read = readContractSource(files("attachment({ format: 'xlsx', filename: 'x.xlsx', row: Row, maxBytes: 10_000 })"), {})
		expect(read.endpoints.find((row) => row.id === 'api.inline')?.output).toMatchObject({ type: 'attachment', format: 'xlsx', filename: 'x.xlsx' })
	})

	test('an option the builder does not take is refused in the runtime words', () => {
		expect(() => readContractSource(files("attachment({ format: 'csv', filename: 'x.csv', row: Row, maxBytes: 10, sheet: 'A' })"), {})).toThrow(
			"procedure 'api.inline' attachment: 'sheet' is not an option of attachment() (allowed: format, filename, row, maxBytes, maxRows)",
		)
	})

	test.each([
		[
			'a row that is no object',
			"attachment({ format: 'csv', filename: 'x.csv', row: z.string(), maxBytes: 10 })",
			'contract the row is not an object schema',
		],
		['a limit that is no number', "attachment({ format: 'csv', filename: 'x.csv', row: Row, maxBytes: '10' })", 'contract maxBytes is a string'],
		['a method on an attachment', 'Candidates.optional()', "contract 'Candidates' is not a schema, so it takes no .optional()"],
		['an attachment inside a schema', 'z.array(Candidates)', 'contract z.array() takes a schema'],
	])('refuses %s', (_name, output, message) => {
		expect(refusal(output).map((finding) => finding.replace(/^fabrika\.contract\.ts:\d+ /, ''))).toContainEqual(expect.stringContaining(message))
	})
})
