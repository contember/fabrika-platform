import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'desk',
	dimensions: { branch: {} },
	actions: {
		'cash.read': 'Read the open cash desks',
		'cash.audit': 'Audit the closed cash desks',
		'cash.manage': 'Manage the cash desks and record their entries',
		'reports.run': 'Run the reports',
	},
	roles: {
		teller: { grants: ['cash.read'] },
		auditor: { grants: ['cash.audit'] },
		manager: { grants: ['cash.read', 'cash.manage'] },
	},
})
