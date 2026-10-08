// A contract over nested containment: a note lies in a workspace, a workspace in an organization. A grant on a
// container reaches every value inside it, through the locators the framework generates from src/db/tables.ts.

import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'

export const Note = z.strictObject({ id: z.uuid(), title: z.string() })
export const NoteList = z.strictObject({ items: z.array(Note) })
export const ById = z.strictObject({ id: z.uuid() })
export const NewNote = z.strictObject({ workspaceId: z.string(), title: z.string().min(1) })
export const Located = z.strictObject({ id: z.string(), workspace: z.string(), organization: z.string() })

export const contract = defineContract({
	app: 'notes',
	dimensions: {
		organization: {},
		workspace: { in: 'organization' },
		note: { in: 'workspace' },
	},
	actions: {
		'notes.read': 'Read notes',
		'notes.write': 'Create and edit notes',
	},
	roles: {
		editor: { grants: ['notes.read', 'notes.write'] },
	},
}, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, {
		notes: {
			list: c.query({ output: NoteList, access: { action: 'notes.read', over: 'workspace' } }),
			where: c.query({ input: ById, output: Located, access: { action: 'notes.read', on: 'note', from: 'id' } }),
			create: c.mutation({ input: NewNote, output: Located, access: { action: 'notes.write', in: 'workspace', from: 'workspaceId' } }),
		},
	}),
	health: c.health('/healthz'),
}))
