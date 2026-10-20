// A link-holder file collection (WU15) in the conservative access diff: a collection that becomes reachable through
// share links widens, with a line for each upload, list and download route the link mount's holders gain; naming the
// mounts a collection serves narrows it from every link mount of its owner. Only a 0.5 application declares one.

import type { TablePolicyArtifact } from '@fabrika/auth-core-0.5'
import { describe, expect, test } from 'bun:test'
import { classifyAccess } from '../approval/diff'
import type { AccessSnapshot } from '../approval/snapshot'
import { BASE, edited, snapshot05 } from './helpers/contracts'

const NOTES: TablePolicyArtifact = {
	scope: { mode: 'dimension', dimension: 'note', key: 'id', container: { dimension: 'workspace', column: 'workspace_id' } },
	actions: { read: 'notes.read', insert: 'notes.write', update: 'notes.write', delete: 'notes.delete' },
	insert: ['title'],
	update: ['title'],
	version: null,
	createdBy: null,
	columns: {},
}

function snapshot(link: string): AccessSnapshot {
	const contract = edited(
		'\thealth: c.health',
		`\tshared: c.link('/s', {
		spa: 'dist/share',
		dimension: 'note',
		grants: ['notes.read', 'notes.write'],
		issuedBy: 'notes.write',
		maxDays: 7,
		procedures: (l) => ({ note: l.query({ output: z.strictObject({ title: z.string() }), access: { action: 'notes.read' } }) }),
	}),
	files: {
		attachments: c.files({
			owner: 'notes',
			read: 'notes.read',
			write: 'notes.write',
			delete: 'notes.delete',
			maxBytes: 4096,
			types: ['application/pdf'],
			link: ${link},
		}),
	},
	health: c.health`,
		BASE,
	)
	return snapshot05(contract, { notes: NOTES })
}

describe('a link-holder file collection in the approval diff', () => {
	test('a collection that becomes reachable through share links widens, route by route', () => {
		const classification = classifyAccess(snapshot('false'), snapshot('true'))
		expect(classification.outcome).toBe('widening')
		expect(classification.changes.map((change) => change.line)).toEqual([
			'New endpoint `shared.files.attachments.download` (GET /s/api/files.attachments/:fileId) for link callers with `notes.read` (on `note`)',
			'New endpoint `shared.files.attachments.list` (POST /s/api/files.attachments.list) for link callers with `notes.read` (on `note`)',
			'New endpoint `shared.files.attachments.upload` (POST /s/api/files.attachments.upload) for link callers with `notes.write` (on `note`)',
			'File collection `attachments` becomes reachable through share links',
		])
	})

	test('naming the mounts it serves is shown, and so is going back to every link mount', () => {
		expect(classifyAccess(snapshot('true'), snapshot("['shared']")).changes).toEqual([
			{ effect: 'narrows', line: 'File collection `attachments` is reachable only through the share links of mount `shared`' },
		])
		expect(classifyAccess(snapshot("['shared']"), snapshot('true')).changes).toEqual([
			{ effect: 'widens', line: 'File collection `attachments` becomes reachable through the share links of every link mount bound to its owner' },
		])
		expect(classifyAccess(snapshot("['shared']"), snapshot("['shared']")).outcome).toBe('none')
	})
})
