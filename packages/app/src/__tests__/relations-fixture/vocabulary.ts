import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'projects',
	dimensions: { project: {} },
	actions: {
		'projects.read': 'Read projects',
		'projects.write': 'Rename projects',
		'members.assign': 'Add a member to a project',
		'staff.assign': 'Staff a project with a person of the directory',
	},
	relations: { member: { dimension: 'project' }, staff: { dimension: 'project' } },
	roles: {
		assistant: { grants: [], via: { member: ['projects.read', 'projects.write'] } },
		staffer: { grants: [], via: { staff: ['projects.read'] } },
		lead: { grants: ['members.assign', 'staff.assign'] },
	},
})
