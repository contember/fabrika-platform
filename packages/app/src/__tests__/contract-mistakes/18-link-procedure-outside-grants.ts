import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'

const ById = z.strictObject({ id: z.uuid() })
const Note = z.strictObject({ id: z.uuid(), title: z.string() })

export const contract = defineContract({
	app: 'notes',
	dimensions: {
		workspace: { creator: 'owner', members: { manage: 'notes.admin', list: 'notes.read' } },
		note: { in: 'workspace' },
	},
	actions: {
		'notes.read': 'Read notes',
		'notes.write': 'Create and edit notes',
		'notes.delete': 'Delete notes',
		'notes.share': 'Create share links for a note',
		'notes.admin': 'Manage the workspace and its members',
		'workspaces.create': 'Start a workspace',
	},
	roles: {
		editor: { grants: ['notes.read', 'notes.write', 'notes.share'], member: { scope: 'workspace', assignableBy: ['owner'] } },
		owner: {
			grants: ['notes.read', 'notes.write', 'notes.delete', 'notes.share', 'notes.admin'],
			member: { scope: 'workspace', assignableBy: ['owner'] },
		},
	},
}, (c) => ({
	shared: c.link('/s', {
		spa: 'dist/share',
		dimension: 'note',
		grants: ['notes.read'],
		issuedBy: 'notes.share',
		maxDays: 30,
		procedures: (l) => ({
			// mistake: a link procedure that needs an action the link does not grant
			remove: l.mutation({ input: ById, output: Note, access: { action: 'notes.delete' } }),
		}),
	}),
}))
