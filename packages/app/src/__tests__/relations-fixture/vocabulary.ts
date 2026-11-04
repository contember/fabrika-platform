import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'projects',
	dimensions: { project: {} },
	actions: {
		'projects.read': 'Read projects',
		'projects.write': 'Rename projects',
		'members.assign': 'Add a member to a project',
	},
	relations: { member: { dimension: 'project' } },
	roles: {
		assistant: { grants: [], via: { member: ['projects.read', 'projects.write'] } },
		lead: { grants: ['members.assign'] },
	},
})
