import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'signup',
	dimensions: { candidate: {} },
	actions: {
		'candidates.read': 'Read a candidate record and its photo',
		'candidates.attach': 'Attach files to a candidate record',
		'candidates.process': 'Register candidates',
		'candidates.review': 'Remove a candidate photo',
	},
	roles: {
		hr: { grants: ['candidates.read'] },
	},
})
