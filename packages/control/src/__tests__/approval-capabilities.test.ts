// Several capabilities in the conservative access diff and the published surface: a new endpoint names each action
// with its form and name, and a change of one capability is a changed requirement.

import type { ContractArtifact, EndpointRow } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { classifyAccess } from '../approval/diff'
import type { AccessSnapshot } from '../approval/snapshot'
import { snapshotSurface } from '../approval/surface'

const handover = (records: 'over' | 'in'): EndpointRow => ({
	id: 'api.requests.handover',
	source: { kind: 'mount', name: 'api' },
	kind: 'mutation',
	method: 'POST',
	path: '/api/requests.handover',
	callers: ['human'],
	requirement: {
		kind: 'capabilities',
		capabilities: {
			request: { action: 'notes.write', access: { form: 'on', dimension: 'note', from: 'noteId' } },
			records: {
				action: 'notes.read',
				access: records === 'over' ? { form: 'over', dimension: 'workspace' } : { form: 'in', dimension: 'workspace', from: 'workspaceId' },
			},
		},
	},
	admission: { contentTypes: ['application/json'], maxBytes: null },
	input: null,
	output: { type: 'null' },
})

function snapshot(rows: readonly EndpointRow[]): AccessSnapshot {
	const contract: ContractArtifact = { ...notesArtifact, endpoints: [...notesArtifact.endpoints, ...rows] }
	return { version: 1, contract, migrations: [], checker: '0.0.0' }
}

const PHRASE = 'with each of `notes.write` (on `note`, as `request`) and `notes.read` (over `workspace`, as `records`)'

describe('several capabilities in the approval', () => {
	test('a new endpoint names every capability, its form and its name', () => {
		const { changes } = classifyAccess(snapshot([]), snapshot([handover('over')]))
		expect(changes.map((change) => change.line)).toContain(
			`New endpoint \`api.requests.handover\` (POST /api/requests.handover) for human callers ${PHRASE}`,
		)
		expect(snapshotSurface(snapshot([handover('over')])).find((row) => row.id === 'api.requests.handover')?.requirement).toBe(PHRASE)
	})

	test('a capability that changes its form changes the requirement', () => {
		const { outcome, changes } = classifyAccess(snapshot([handover('over')]), snapshot([handover('in')]))
		expect(outcome).toBe('widening')
		expect(changes.some((change) => change.line.startsWith('Endpoint `api.requests.handover` requirement'))).toBe(true)
	})
})
