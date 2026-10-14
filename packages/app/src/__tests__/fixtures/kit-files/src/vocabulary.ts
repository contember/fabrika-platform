import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
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
})
