import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'

const ById = z.strictObject({ id: z.uuid() })

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
	api: c.rpc('/api', { callers: ['human'] }, {
		notes: {
			get: c.query({
				input: ById,
				// mistake: an output object that passes undeclared fields through
				output: z.strictObject({ id: z.uuid(), title: z.string() }).passthrough(),
				access: { action: 'notes.read', on: 'note', from: 'id' },
			}),
		},
	}),
}))
