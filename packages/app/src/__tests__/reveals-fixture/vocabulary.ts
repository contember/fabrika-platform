import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'tasks',
	dimensions: { project: {}, task: { in: 'project' } },
	actions: {
		'projects.read': 'Read projects',
		'projects.write': 'Rename projects',
		'tasks.read': 'Read tasks',
		'tasks.assign': 'Assign a task',
	},
	relations: { assignee: { dimension: 'task' } },
	roles: {
		worker: { grants: [], via: { assignee: ['tasks.read', 'projects.read', 'projects.write'] } },
		lead: { grants: ['tasks.assign'] },
	},
})
