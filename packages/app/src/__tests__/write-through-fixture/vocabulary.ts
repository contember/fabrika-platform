import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'teams',
	dimensions: { team: {}, project: {}, task: { in: 'project' } },
	actions: {
		'teams.read': 'Read teams',
		'projects.read': 'Read projects',
		'projects.rename': 'Rename projects',
		'tasks.read': 'Read tasks',
		'tasks.insert': 'Create tasks',
		'tasks.write': 'Write tasks',
	},
	relations: { teamMember: { dimension: 'team' } },
	roles: {
		member: { grants: [], via: { teamMember: ['tasks.read', 'tasks.write', 'projects.rename'] } },
	},
})
