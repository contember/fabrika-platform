// The contract `implement` and `boot` are tested against: every access form A3 serves, a machine mount, a health
// check and the SPA.

import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'

export const ById = z.strictObject({ id: z.uuid() })
export const Note = z.strictObject({ id: z.uuid(), title: z.string() })
export const NoteList = z.strictObject({ items: z.array(Note) })
export const NewNote = z.strictObject({ workspaceId: z.string(), title: z.string().min(1) })
export const Deleted = z.strictObject({ deleted: z.string() })
export const Me = z.strictObject({ id: z.string(), label: z.string() })
export const Import = z.strictObject({ workspaceId: z.string(), titles: z.array(z.string()) })
export const Imported = z.strictObject({ imported: z.int().nonnegative() })

export const contract = defineContract({
	app: 'notes',
	dimensions: {
		workspace: { members: { manage: 'notes.admin', list: 'notes.read' } },
		note: { in: 'workspace' },
	},
	actions: {
		'notes.read': 'Read notes',
		'notes.write': 'Create and edit notes',
		'notes.delete': 'Delete notes',
		'notes.admin': 'Manage the workspace and its members',
	},
	roles: {
		editor: { grants: ['notes.read', 'notes.write'], member: { scope: 'workspace', assignableBy: ['owner'] } },
		owner: {
			grants: ['notes.read', 'notes.write', 'notes.delete', 'notes.admin'],
			member: { scope: 'workspace', assignableBy: ['owner'] },
		},
	},
}, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, {
		me: c.query({ output: Me, access: { member: true } }),
		notes: {
			list: c.query({ output: NoteList, access: { action: 'notes.read', over: 'workspace' } }),
			get: c.query({ input: ById, output: Note, access: { action: 'notes.read', on: 'note', from: 'id' } }),
			create: c.mutation({ input: NewNote, output: Note, access: { action: 'notes.write', in: 'workspace', from: 'workspaceId' } }),
			remove: c.mutation({ input: ById, output: Deleted, access: { action: 'notes.delete', on: 'note', from: 'id' } }),
		},
	}),
	machine: c.rpc('/machine', { callers: ['machine'] }, {
		importNotes: c.mutation({ input: Import, output: Imported, access: { action: 'notes.write', in: 'workspace', from: 'workspaceId' } }),
	}),
	health: c.health('/healthz'),
	spa: c.spa('/', { dir: 'dist/app', access: { member: true } }),
}))
