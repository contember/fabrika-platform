import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'signup',
	locale: 'en',
	dimensions: {},
	actions: { 'signups.join': 'Record a sign-up', 'signups.process': 'Process the sign-ups' },
	roles: { staff: { grants: ['signups.process'] } },
})
