import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'isolation',
	dimensions: {
		organization: {},
		workspace: { in: 'organization' },
		note: { in: 'workspace' },
	},
	actions: {
		'organizations.read': 'Read organizations',
		'organizations.admin': 'Rename organizations',
		'workspaces.read': 'Read workspaces',
		'workspaces.write': 'Create and rename workspaces',
		'notes.read': 'Read notes',
		'notes.write': 'Create and edit notes',
		'notes.delete': 'Delete notes',
		'notes.admin': 'Read internal notes',
	},
	roles: {
		member: { grants: ['organizations.read', 'workspaces.read', 'notes.read', 'notes.write'] },
	},
})
