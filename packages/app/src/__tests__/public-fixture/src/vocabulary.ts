import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'intake',
	dimensions: {},
	actions: {
		'intake.register': 'Record an anonymous submission',
		'intake.read': 'Read the submissions',
		'catalog.read': 'Read the catalog anyone sees',
		'catalog.write': 'Edit the catalog',
	},
	roles: {
		staff: { grants: ['intake.read', 'catalog.write'] },
	},
})
