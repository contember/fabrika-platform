// A project lies in an org and a task in a project: the tables take their containment from here.

import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'tasks',
	dimensions: {
		org: { creator: 'owner' },
		project: { in: 'org' },
		task: { in: 'project' },
	},
	actions: {
		'tasks.read': 'Read projects and tasks',
		'tasks.write': 'Edit projects and tasks',
		'tasks.assign': 'Assign tasks',
	},
	roles: {
		owner: { grants: ['tasks.read', 'tasks.write', 'tasks.assign'], member: { scope: 'org', assignableBy: ['owner'] } },
	},
})
