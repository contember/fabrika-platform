import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'board',
	dimensions: { workspace: {}, note: { in: 'workspace' } },
	actions: {
		'notices.post': 'Post a notice',
		'notices.audit': 'Read the internal notes of notices',
		'notes.read': 'Read notes',
		'reports.run': 'Run the reports',
		'intake.submit': 'Submit a notice anonymously',
	},
	roles: {},
})
