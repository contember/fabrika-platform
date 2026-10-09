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
	// mistake: an OAuth resource token, which only an installation row admits, as a caller of an RPC mount
	machine: c.rpc('/machine', { callers: ['machine', 'oauth'] }, {
		notes: { get: c.query({ input: ById, output: Note, access: { action: 'notes.read', on: 'note', from: 'id' } }) },
	}),
}))
