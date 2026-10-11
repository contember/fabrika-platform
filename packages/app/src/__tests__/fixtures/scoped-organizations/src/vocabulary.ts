import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
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
})
