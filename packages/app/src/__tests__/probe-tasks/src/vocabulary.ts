// The task tracker two fresh-agent probes built, in the staged form: an org holds projects, a project holds tasks. It
// is named `notes` because the test harness (`fixtures/implement/harness.ts`) signs for that application.

import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'notes',
	dimensions: {
		org: { creator: 'owner' },
		project: { in: 'org' },
		task: { in: 'project' },
	},
	actions: {
		'tasks.read': 'Read projects and tasks',
		'tasks.write': 'Create and edit projects and tasks',
		'tasks.assign': 'Assign tasks to people',
	},
	roles: {
		owner: { grants: ['tasks.read', 'tasks.write', 'tasks.assign'], member: { scope: 'org', assignableBy: ['owner'] } },
		member: { grants: ['tasks.read', 'tasks.write'], member: { scope: 'org', assignableBy: ['owner'] } },
	},
})
