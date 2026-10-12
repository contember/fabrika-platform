import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'crm',
	dimensions: {
		org: { members: { manage: 'members.manage', list: 'crm.read' }, directory: 'labels' },
		company: { in: 'org' },
		contact: { in: 'company' },
		deal: { in: 'company' },
		task: { in: 'deal' },
	},
	actions: {
		'crm.read': 'Read companies, contacts, deals, tasks, activities, attachments and the members of an org',
		'crm.write': 'Create and edit companies and contacts',
		'crm.delete': 'Delete companies, contacts, deals and attachments',
		'deals.write': 'Create deals, edit them, move them through the pipeline and attach files',
		'deals.assign': 'Choose the owner of a deal',
		'tasks.write': 'Create tasks and mark them done',
		'activities.write': 'Log activities on contacts and deals',
		'members.manage': 'Invite and remove the members of an org',
	},
	roles: {
		manager: {
			grants: ['crm.read', 'crm.write', 'crm.delete', 'deals.write', 'deals.assign', 'tasks.write', 'activities.write', 'members.manage'],
			member: { scope: 'org', assignableBy: ['manager'] },
		},
		sales: { grants: ['crm.read', 'deals.write', 'tasks.write', 'activities.write'], member: { scope: 'org', assignableBy: ['manager'] } },
		viewer: { grants: ['crm.read'], member: { scope: 'org', assignableBy: ['manager'] } },
	},
})
