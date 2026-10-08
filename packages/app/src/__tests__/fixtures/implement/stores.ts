// A stand-in for `@fabrika/db`'s stores: it takes capabilities only, asks the framework's authority whether each one
// belongs to the running request, and checks the kind, dimension and action itself, as the data layer does.

import type { ContractDatabase } from '@fabrika/app/implement'
import type { CapabilityAuthority, CapabilityGrant, Ref, Within } from '@fabrika/db/capability'

export interface NoteRow {
	readonly id: string
	readonly workspaceId: string
	readonly title: string
	readonly internalScore: number
}

export const NOTE_TABLE = {
	scope: { mode: 'dimension', dimension: 'note', key: 'id', container: { dimension: 'workspace', column: 'workspace_id' } },
	actions: { read: 'notes.read', insert: 'notes.write', update: 'notes.write', delete: 'notes.delete' },
	insert: ['title'],
	update: ['title'],
	version: null,
	createdBy: null,
	columns: {},
} as const

/** The rows by id, and a locator over them: a note lies in its workspace; no table owns workspaces. */
export function noteDatabase(rows: Map<string, NoteRow>): ContractDatabase {
	return {
		tables: { notes: NOTE_TABLE },
		locate: (dimension, id) => {
			const row = dimension === 'note' ? rows.get(id) : undefined
			return Promise.resolve(row === undefined ? null : new Map([['workspace', row.workspaceId]]))
		},
	}
}

function grantOf(capabilities: CapabilityAuthority, capability: unknown, kind: 'ref' | 'within', dimension: string, action: string): CapabilityGrant {
	const grant = capabilities.resolve(capability)
	if (grant.kind !== kind || grant.dimension !== dimension || grant.action !== action) {
		throw new Error(`needs a ${kind} of ${dimension} for ${action}`)
	}
	return grant
}

export function notesStore(capabilities: CapabilityAuthority, rows: Map<string, NoteRow>) {
	return {
		list: (within: Within<'workspace', 'notes.read'>): NoteRow[] => {
			const grant = grantOf(capabilities, within, 'within', 'workspace', 'notes.read')
			const values = grant.kind === 'within' ? grant.values : []
			return [...rows.values()].filter((row) => values === 'all' || values.includes(row.workspaceId))
		},
		get: (note: Ref<'note', 'notes.read'>): NoteRow => {
			const grant = grantOf(capabilities, note, 'ref', 'note', 'notes.read')
			const row = grant.kind === 'ref' ? rows.get(grant.id) : undefined
			if (row === undefined) {
				throw new Error('missing row')
			}
			return row
		},
		insert: (workspace: Ref<'workspace', 'notes.write'>, title: string): NoteRow => {
			const grant = grantOf(capabilities, workspace, 'ref', 'workspace', 'notes.write')
			const row = { id: crypto.randomUUID(), workspaceId: grant.kind === 'ref' ? grant.id : '', title, internalScore: 0 }
			rows.set(row.id, row)
			return row
		},
		remove: (note: Ref<'note', 'notes.delete'>): void => {
			const grant = grantOf(capabilities, note, 'ref', 'note', 'notes.delete')
			if (grant.kind === 'ref') {
				rows.delete(grant.id)
			}
		},
	}
}

export type NotesStore = ReturnType<typeof notesStore>
