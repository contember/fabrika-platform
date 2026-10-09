// A contract with a file collection on the notes table: every file inherits its note's access, note → workspace.

import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'

export const Note = z.strictObject({ id: z.uuid(), title: z.string() })

export const MAX_BYTES = 262144
export const MAX_PER_NOTE = 3

export const contract = defineContract({
	app: 'notes',
	dimensions: {
		workspace: {},
		note: { in: 'workspace' },
	},
	actions: {
		'notes.read': 'Read notes',
		'notes.write': 'Create and edit notes',
		'notes.delete': 'Delete notes',
	},
	roles: {
		editor: { grants: ['notes.read', 'notes.write', 'notes.delete'] },
	},
}, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, {
		notes: {
			get: c.query({ input: z.strictObject({ id: z.uuid() }), output: Note, access: { action: 'notes.read', on: 'note', from: 'id' } }),
		},
	}),
	files: {
		attachments: c.files({
			owner: 'notes',
			read: 'notes.read',
			write: 'notes.write',
			delete: 'notes.delete',
			maxBytes: MAX_BYTES,
			types: ['image/png', 'image/svg+xml', 'application/pdf', 'text/plain'],
			maxPerOwner: MAX_PER_NOTE,
		}),
	},
	health: c.health('/healthz'),
}))
