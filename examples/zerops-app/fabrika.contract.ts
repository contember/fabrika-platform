// Who may call what, over the vocabulary of src/vocabulary.ts. The proxy enforces this file's endpoint table, the data
// layer the policies of src/db/tables.ts, and src/app.ts implements each endpoint.

import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { vocabulary } from './src/vocabulary'

export const Note = z.strictObject({ id: z.uuid(), title: z.string(), trashed: z.boolean(), version: z.int() })
export const NoteList = z.strictObject({ items: z.array(Note) })
export const ById = z.strictObject({ id: z.uuid() })
export const Trash = z.strictObject({ id: z.uuid(), expectVersion: z.int().positive() })
export const NewNote = z.strictObject({ workspaceId: z.string().min(1).max(100), title: z.string().min(1).max(200) })
export const Done = z.strictObject({ id: z.uuid() })

export const MAX_ATTACHMENT_BYTES = 1048576
export const MAX_ATTACHMENTS_PER_NOTE = 10

export const contract = defineContract(vocabulary, (c) => ({
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
