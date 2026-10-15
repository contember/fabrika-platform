// Named 'notes' because the harness serves the audience notes@prod.
import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'notes',
	dimensions: {},
	actions: {
		'outbox.read': 'Read and deliver the queued messages',
		'outbox.write': 'Queue a message',
	},
	roles: {
		staff: { grants: ['outbox.read', 'outbox.write'] },
	},
})
