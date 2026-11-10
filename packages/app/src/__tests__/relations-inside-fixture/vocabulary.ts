import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'orgs',
	dimensions: { org: {}, project: { in: 'org' } },
	actions: {
		'projects.read': 'Read projects',
		'projects.write': 'Rename projects',
		'members.assign': 'Add a member to a project',
	},
	relations: { member: { dimension: 'project' } },
	roles: {
		owner: { grants: ['projects.read', 'members.assign'], member: { scope: 'org', assignableBy: ['owner'] } },
		// Held in an organization, it reaches a project of that organization only where a member row names its holder.
		lead: { grants: [], member: { scope: 'org', assignableBy: ['owner'] }, via: { member: ['projects.read', 'projects.write'] } },
	},
})
