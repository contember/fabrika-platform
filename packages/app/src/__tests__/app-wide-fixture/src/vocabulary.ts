import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'registry',
	dimensions: { candidate: {} },
	actions: {
		'candidates.read': 'Read candidate records',
		'candidates.review': 'Record the reason of a decision on a candidate',
		'reasons.manage': 'Edit the decision reasons',
		'positions.read': 'Read the open positions',
		'positions.manage': 'Edit the open positions',
		'audit.read': 'Read the export log',
	},
	roles: {
		hr: { grants: ['candidates.read', 'candidates.review', 'positions.read'] },
		registrar: { grants: ['positions.read', 'positions.manage', 'audit.read', 'candidates.review', 'reasons.manage'] },
	},
})
