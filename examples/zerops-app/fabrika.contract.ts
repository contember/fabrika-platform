// Who may call what. The proxy enforces this file's endpoint table, the data layer the policies of src/db/tables.ts,
// and src/app.ts implements each endpoint. A note lies in a workspace, the scope value IAM grants roles in.

import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'

export const Note = z.strictObject({ id: z.uuid(), title: z.string(), trashed: z.boolean(), version: z.int() })
export const NoteList = z.strictObject({ items: z.array(Note) })
export const ById = z.strictObject({ id: z.uuid() })
export const Trash = z.strictObject({ id: z.uuid(), expectVersion: z.int().positive() })
export const NewNote = z.strictObject({ workspaceId: z.string().min(1).max(100), title: z.string().min(1).max(200) })
export const Done = z.strictObject({ id: z.uuid() })

export const MAX_ATTACHMENT_BYTES = 1048576
export const MAX_ATTACHMENTS_PER_NOTE = 10

export const contract = defineContract({
	app: 'notes',
	dimensions: {
		workspace: {},
		note: { in: 'workspace' },
	},
	actions: {
		'notes.read': 'Read notes and their attachments',
		'notes.write': 'Create notes, move them to the trash and attach files',
		'notes.delete': 'Delete notes and attachments',
	},
	roles: {
		reader: { grants: ['notes.read'] },
		author: { grants: ['notes.read', 'notes.write'] },
		editor: { grants: ['notes.read', 'notes.write', 'notes.delete'] },
	},
}, (c) => ({
	api: c.rpc('/api', { callers: ['human', 'machine'] }, {
		notes: {
			list: c.query({ output: NoteList, access: { action: 'notes.read', over: 'workspace' } }),
			get: c.query({ input: ById, output: Note, access: { action: 'notes.read', on: 'note', from: 'id' } }),
			create: c.mutation({ input: NewNote, output: Done, access: { action: 'notes.write', in: 'workspace', from: 'workspaceId' } }),
			trash: c.mutation({ input: Trash, output: Done, access: { action: 'notes.write', on: 'note', from: 'id' } }),
			remove: c.mutation({ input: ById, output: Done, access: { action: 'notes.delete', on: 'note', from: 'id' } }),
		},
	}),
	files: {
		attachments: c.files({
			owner: 'notes',
			read: 'notes.read',
			write: 'notes.write',
			delete: 'notes.delete',
			maxBytes: MAX_ATTACHMENT_BYTES,
			types: ['image/png', 'image/jpeg', 'application/pdf', 'text/plain'],
			maxPerOwner: MAX_ATTACHMENTS_PER_NOTE,
		}),
	},
	jobs: {
		purge: c.cron('0 3 * * *', { actions: ['notes.read', 'notes.delete'], scope: 'app', timeout: '5m', retries: 2 }),
	},
	health: c.health('/healthz'),
}))
