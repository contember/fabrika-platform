// Named 'notes' because the harness serves the audience notes@prod.
import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'notes',
	dimensions: {},
	actions: {
		'applications.read': 'Read registrations',
		'messages.read': 'Read contact messages',
	},
	roles: {
		hr: { grants: ['applications.read', 'messages.read'] },
	},
})
