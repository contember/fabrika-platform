// The authorization vocabulary: two independent dimensions, whose values IAM stores and never interprets, and the
// notes that lie in a project.

import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'example-app',
	dimensions: {
		// The organizations a grant may name, offered to an administrator as checkboxes (ADR-0085): the application's own
		// list, asked as the administrator through `api.organizationValues`, and this declared one when it cannot answer.
		organization: {
			valuesFrom: 'api.organizationValues',
			values: [
				{ value: 'acme', label: 'Acme Corporation' },
				{ value: 'globex', label: 'Globex' },
				{ value: 'initech', label: 'Initech' },
				{ value: 'umbrella', label: 'Umbrella' },
			],
		},
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
