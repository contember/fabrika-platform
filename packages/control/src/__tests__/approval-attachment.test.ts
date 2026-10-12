// An attachment output in the conservative access diff (ADR-0050 §3): a new file endpoint names its file; a larger
// limit, a new column and a switch between JSON and a file widen; a smaller limit, a lost column and a rename do not.

import { readContractSource } from '@fabrika/check/contract'
import { describe, expect, test } from 'bun:test'
import { classifyAccess } from '../approval/diff'
import type { AccessSnapshot } from '../approval/snapshot'
import { BASE, edited } from './helpers/contracts'

const IMPORTS = "import { defineContract } from '@fabrika/app/contract'"
const WITH_ATTACHMENT = "import { attachment, defineContract } from '@fabrika/app/contract'"
const GET = "get: c.query({ input: z.strictObject({ id: z.uuid() }), output: Note, access: { action: 'notes.read', on: 'note', from: 'id' } }),"

function snapshot(contract: string): AccessSnapshot {
	return { version: 1, contract: readContractSource(new Map([['fabrika.contract.ts', contract]]), {}), migrations: [], checker: '0.0.0' }
}

/** `BASE` with `api.notes` answering a file of `row` under `filename`, at most `maxBytes`. */
const withExport = (row: string, maxBytes: number, filename = 'notes.csv'): string =>
	edited(
		GET,
		`${GET}\n\t\tnotes: c.query({ output: attachment({ format: 'csv', filename: '${filename}', row: ${row}, maxBytes: ${maxBytes} }), access: { action: 'notes.read', over: 'workspace' } }),`,
		edited(IMPORTS, WITH_ATTACHMENT),
	)

const ROW = 'z.strictObject({ id: z.uuid(), title: z.string() })'

function lines(
	from: string,
	to: string,
): { readonly outcome: string; readonly changes: readonly { readonly widens: boolean; readonly line: string }[] } {
	return classifyAccess(snapshot(from), snapshot(to))
}

describe('an attachment output in the approval diff', () => {
	test('a new attachment endpoint widens, and its line names the file it answers', () => {
		expect(lines(BASE, withExport(ROW, 1_000))).toEqual({
			outcome: 'widening',
			changes: [{
				widens: true,
				line: 'New endpoint `api.notes` (POST /api/notes) for human callers with `notes.read` (over `workspace`), answering the CSV file `notes.csv`',
			}],
		})
	})

	test('a larger file and a new column widen; a smaller file, a lost column and a new name do not', () => {
		const base = withExport(ROW, 1_000)
		expect(lines(base, withExport('z.strictObject({ id: z.uuid(), title: z.string(), body: z.string() })', 2_000)).changes).toEqual([
			{ widens: true, line: 'Endpoint `api.notes` file size limit changes from 1000 to 2000' },
			{ widens: true, line: 'Endpoint `api.notes` output gains field `body`' },
		])
		expect(lines(base, withExport('z.strictObject({ id: z.uuid() })', 500, 'all-notes.csv'))).toEqual({
			outcome: 'removal',
			changes: [
				{ widens: false, line: 'Endpoint `api.notes` file name changes from `notes.csv` to `all-notes.csv`' },
				{ widens: false, line: 'Endpoint `api.notes` file size limit changes from 1000 to 500' },
				{ widens: false, line: 'Endpoint `api.notes` output loses field `title`' },
			],
		})
	})

	test('a JSON output that becomes a file widens', () => {
		const json = edited(
			GET,
			`${GET}\n\t\tnotes: c.query({ output: z.array(${ROW}), access: { action: 'notes.read', over: 'workspace' } }),`,
			edited(IMPORTS, WITH_ATTACHMENT),
		)
		expect(lines(json, withExport(ROW, 1_000)).changes).toEqual([
			{ widens: true, line: 'Endpoint `api.notes` output changes from JSON to the CSV file `notes.csv`' },
		])
	})
})
