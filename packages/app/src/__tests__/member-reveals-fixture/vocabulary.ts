import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'steps',
	dimensions: { project: {}, task: { in: 'project' }, step: { in: 'task' } },
	actions: {
		'projects.read': 'Read projects',
		'projects.rename': 'Rename projects',
		'steps.read': 'Read steps',
	},
	roles: {},
})
