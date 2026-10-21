// Named 'notes' because the harness serves the audience notes@prod.
import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'notes',
	dimensions: {},
	actions: {
		'applications.submit': 'Record an anonymous registration',
		'applications.read': 'Read registrations',
		'messages.send': 'Record an anonymous contact message',
		'messages.read': 'Read contact messages',
	},
	roles: {
		hr: { grants: ['applications.read', 'messages.read'] },
	},
})
