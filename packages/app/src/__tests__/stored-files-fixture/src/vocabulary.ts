import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'stored-files',
	dimensions: { org: {}, deal: { in: 'org' } },
	actions: {
		'crm.read': 'Read deals and their attachments',
		'deals.write': 'Attach files to deals',
		'catalog.read': 'Read the catalog anyone sees',
		'catalog.write': 'Edit the catalog',
		'intake.register': 'Record an anonymous submission',
		'intake.drain': 'Drain the submissions',
		'reports.render': 'Render reports',
	},
	roles: {
		staff: { grants: ['catalog.write', 'intake.drain'] },
	},
})
