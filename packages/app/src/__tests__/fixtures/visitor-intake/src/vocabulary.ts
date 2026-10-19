import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'intake',
	dimensions: { candidate: {} },
	actions: {
		'candidates.register': 'Record an anonymous registration or resend request',
		'candidates.read': 'Read a candidate record',
		'candidates.verify': "Confirm a candidate's e-mail address",
		'candidates.attach': 'Attach files to a candidate record',
		'candidates.invite': "Issue a candidate's portal link",
		'candidates.process': 'Register and invite candidates',
	},
	roles: {
		hr: { grants: ['candidates.read'] },
	},
})
