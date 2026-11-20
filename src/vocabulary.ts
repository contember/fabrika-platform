// The authorization vocabulary: two independent dimensions, whose values IAM stores and never interprets.

import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'example-app',
	dimensions: {
		organization: {},
		project: {},
	},
	actions: {
		'example.read': 'Read example data',
		'example.view': 'View the example surface',
		'example.settings.update': 'Update example settings',
	},
	roles: {
		viewer: { grants: ['example.read', 'example.view'] },
		editor: { grants: ['example.read', 'example.view', 'example.settings.update'] },
	},
})
