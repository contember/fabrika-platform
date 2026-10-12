// Named 'notes' because the harness serves the audience notes@prod.
import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'notes',
	dimensions: {},
	actions: {
		'signups.process': 'Welcome the visitors who signed up',
	},
	roles: {
		staff: { grants: ['signups.process'] },
	},
})
