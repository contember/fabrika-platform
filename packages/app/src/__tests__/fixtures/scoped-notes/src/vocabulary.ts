import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
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
})
