import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'registry',
	dimensions: { candidate: {} },
	actions: {
		'candidates.read': 'Read candidate records',
		'positions.read': 'Read the open positions',
		'positions.manage': 'Edit the open positions',
		'audit.read': 'Read the export log',
	},
	roles: {
		hr: { grants: ['candidates.read', 'positions.read'] },
		registrar: { grants: ['positions.read', 'positions.manage', 'audit.read'] },
	},
})
