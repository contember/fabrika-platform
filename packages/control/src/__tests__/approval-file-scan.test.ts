// A file collection's malware scan in the access diff (ADR-0050 §3): turning it off widens, turning it on removes, and a
// collection's generated list query is a new endpoint like any other.

import type { TablePolicyArtifact } from '@fabrika/auth-core'
import { readContractSource } from '@fabrika/check/contract'
import { describe, expect, test } from 'bun:test'
import { classifyAccess } from '../approval/diff'
import type { AccessSnapshot } from '../approval/snapshot'
import { BASE, edited } from './helpers/contracts'

const NOTES_TABLE: TablePolicyArtifact = {
	scope: { mode: 'dimension', dimension: 'note', key: 'id', container: { dimension: 'workspace', column: 'workspace_id' } },
	actions: { read: 'notes.read', insert: 'notes.write', update: 'notes.write', delete: 'notes.delete' },
	insert: ['title'],
	update: ['title'],
	version: null,
	createdBy: null,
	columns: {},
}

const withFiles = (options: string): string =>
	edited(
		'\thealth: c.health',
		`\tfiles: { attachments: c.files({ owner: 'notes', read: 'notes.read', write: 'notes.write', delete: 'notes.delete', maxBytes: 1024, types: ['application/pdf']${options} }) },\n\thealth: c.health`,
	)

const snapshot = (contract: string): AccessSnapshot => ({
	version: 1,
	contract: readContractSource(new Map([['fabrika.contract.ts', contract]]), { notes: NOTES_TABLE }),
	migrations: [],
	checker: '0.0.0',
})

describe('classifyAccess of a file collection that scans', () => {
	test('turning the scan off widens, with its own line; turning it on only removes', () => {
		const scanning = snapshot(withFiles(', scan: true'))
		const plain = snapshot(withFiles(''))
		expect(classifyAccess(scanning, plain)).toEqual({
			outcome: 'widening',
			changes: [{ effect: 'widens', line: 'File collection `attachments` stops scanning uploads for malware' }],
		})
		expect(classifyAccess(plain, scanning)).toEqual({
			outcome: 'removal',
			changes: [{ effect: 'narrows', line: 'File collection `attachments` scans every upload for malware before serving it' }],
		})
		expect(classifyAccess(plain, snapshot(withFiles(', scan: false')))).toEqual({ outcome: 'unchanged', changes: [] })
	})

	test("a new collection's list query is a new endpoint for the collection's read action on its owner", () => {
		const lines = classifyAccess(snapshot(BASE), snapshot(withFiles(', scan: true'))).changes.map((change) => change.line)
		expect(lines).toContain(
			'New endpoint `files.attachments.list` (POST /api/files.attachments.list) for human callers with `notes.read` (on `note`)',
		)
	})
})
