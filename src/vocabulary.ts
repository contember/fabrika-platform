// The authorization vocabulary: two independent dimensions, whose values IAM stores and never interprets, and the
// notes that lie in a project.

import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'example-app',
	dimensions: {
		organization: {},
		project: {},
		note: { in: 'project' },
	},
	actions: {
		'example.read': 'Read example data',
		'example.view': 'View the example surface',
		'example.write': 'Write notes and attach files to them',
		'example.settings.update': 'Update example settings',
	},
	roles: {
		viewer: { grants: ['example.read', 'example.view'] },
		editor: { grants: ['example.read', 'example.view', 'example.write', 'example.settings.update'] },
	},
})
