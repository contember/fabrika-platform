// A link-holder file collection (WU15) in the conservative access diff: a collection that becomes reachable through
// share links widens, with a line for each upload and download route the link mount's holders gain.

import { compileContract, defineContract } from '@fabrika/app/contract'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { tables } from '../../../app/src/__tests__/fixtures/scoped-files/src/db/tables'
import { vocabulary } from '../../../app/src/__tests__/fixtures/scoped-files/src/vocabulary'
import { classifyAccess } from '../approval/diff'
import type { AccessSnapshot } from '../approval/snapshot'

const Title = z.strictObject({ title: z.string() })

function snapshot(link: boolean): AccessSnapshot {
	const contract = defineContract(vocabulary, (c) => ({
		shared: c.link('/s', {
			spa: 'dist/share',
			dimension: 'note',
			grants: ['notes.read', 'notes.write'],
			issuedBy: 'notes.write',
			maxDays: 7,
			procedures: (l) => ({ note: l.query({ output: Title, access: { action: 'notes.read' } }) }),
		}),
		files: {
			attachments: c.files({
				owner: 'notes',
				read: 'notes.read',
				write: 'notes.write',
				delete: 'notes.delete',
				maxBytes: 4096,
				types: ['application/pdf'],
				link,
			}),
		},
	}))
	return { version: 1, contract: compileContract(contract, tables), migrations: [], checker: '0.0.0' }
}

describe('a link-holder file collection in the approval diff', () => {
	test('a collection that becomes reachable through share links widens, route by route', () => {
		const classification = classifyAccess(snapshot(false), snapshot(true))
		expect(classification.outcome).toBe('widening')
		expect(classification.changes.map((change) => change.line)).toEqual([
			'New endpoint `shared.files.attachments.download` (GET /s/api/files.attachments/:fileId) for link callers with `notes.read` (on `note`)',
			'New endpoint `shared.files.attachments.upload` (POST /s/api/files.attachments.upload) for link callers with `notes.write` (on `note`)',
			'File collection `attachments` becomes reachable through share links',
		])
	})
})
