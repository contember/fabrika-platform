import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'intake',
	dimensions: { candidate: {} },
	actions: {
		'candidates.read': 'Read a candidate record',
		'candidates.verify': "Confirm a candidate's e-mail address",
		'candidates.invite': "Issue a candidate's portal link",
		'candidates.process': 'Register and invite candidates',
	},
	roles: {
		hr: { grants: ['candidates.read'] },
	},
})
