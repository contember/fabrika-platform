import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'boards',
	dimensions: { org: { partition: true }, project: { in: 'org' }, task: { in: 'project' } },
	actions: {
		'tasks.read': 'Read tasks',
		'members.assign': 'Add a member to a project',
	},
	relations: { member: { dimension: 'project' } },
	roles: {
		owner: { grants: ['tasks.read', 'members.assign'], member: { scope: 'org', assignableBy: ['owner'] } },
		// Held in an organization: its member rows' tasks, and every public task of that organization.
		colleague: { grants: [], member: { scope: 'org', assignableBy: ['owner'] }, via: { member: ['tasks.read'] } },
		// Held in a project (`~relin` inside the partition) or everywhere (`~rel`): its member rows' tasks only.
		lead: { grants: [], via: { member: ['tasks.read'] } },
		staff: { grants: ['members.assign'] },
		// An external principal holds no relation, so no partition node: its plain grant at a project reaches that project.
		guest: { grants: ['tasks.read'], member: { scope: 'project', assignableBy: ['staff'] }, external: true },
	},
})
