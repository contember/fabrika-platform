// The contract the hook tests call: a paged list, a get, two mutations, one in another group, and an SPA mount.

import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'

export const Note = z.strictObject({ id: z.string(), title: z.string(), version: z.int() })
export const NotePage = z.strictObject({ items: z.array(Note), next: z.nullable(z.string()) })
const ListNotes = z.strictObject({ workspaceId: z.string(), after: z.string().optional() })
const NewNote = z.strictObject({ workspaceId: z.string(), title: z.string().min(1).max(20) })
const Rename = z.strictObject({ id: z.string(), title: z.string().min(1), expectVersion: z.int().positive() })
const Counts = z.strictObject({ notes: z.int() })

export const contract = defineContract({
	app: 'notes',
	dimensions: { workspace: {}, note: { in: 'workspace' } },
	actions: { 'notes.read': 'Read notes', 'notes.write': 'Write notes' },
	roles: {
		editor: { grants: ['notes.read', 'notes.write'], member: { scope: 'workspace', assignableBy: ['editor'] } },
		reader: { grants: ['notes.read'], member: { scope: 'workspace', assignableBy: ['editor'] } },
	},
}, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, {
		notes: {
			list: c.query({ input: ListNotes, output: NotePage, access: { action: 'notes.read', in: 'workspace', from: 'workspaceId' } }),
			get: c.query({ input: z.strictObject({ id: z.string() }), output: Note, access: { action: 'notes.read', on: 'note', from: 'id' } }),
			create: c.mutation({ input: NewNote, output: Note, access: { action: 'notes.write', in: 'workspace', from: 'workspaceId' } }),
			rename: c.mutation({ input: Rename, output: Note, access: { action: 'notes.write', on: 'note', from: 'id' } }),
		},
		stats: { counts: c.query({ output: Counts, access: { action: 'notes.read', over: 'workspace' } }) },
	}),
	site: c.spa('/', { dir: 'dist/site', access: { member: true } }),
}))
