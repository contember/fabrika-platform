import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'notes',
	dimensions: {
		workspace: { creator: 'owner', members: { manage: 'notes.admin', list: 'notes.read' } },
		note: { in: 'workspace' },
	},
	actions: {
		'notes.read': 'Read notes',
		'notes.write': 'Create and edit notes',
		'notes.share': 'Create share links for a note',
		'notes.admin': 'Manage the workspace and its members',
		'workspaces.create': 'Start a workspace',
		'contacts.read': 'Read contact messages',
	},
	roles: {
		starter: { grants: ['workspaces.create'] },
		support: { grants: ['contacts.read'] },
		editor: { grants: ['notes.read', 'notes.write', 'notes.share'], member: { scope: 'workspace', assignableBy: ['owner'] } },
		owner: { grants: ['notes.read', 'notes.write', 'notes.share', 'notes.admin'], member: { scope: 'workspace', assignableBy: ['owner'] } },
	},
})
