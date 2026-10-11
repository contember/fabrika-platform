// The kit fixture: a small CRM in the staged form, shared by the kit's type tests and its mistakes.

import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'crm',
	dimensions: {
		org: { creator: 'owner', members: { manage: 'members.manage', list: 'crm.read' } },
		company: { in: 'org' },
		deal: { in: 'company' },
	},
	actions: {
		'crm.read': 'Read companies and deals',
		'crm.write': 'Edit companies',
		'deals.write': 'Edit deals',
		'deals.share': 'Share a deal',
		'crm.delete': 'Delete companies and deals',
		'members.manage': 'Manage the organization and its members',
		'orgs.create': 'Start an organization',
	},
	roles: {
		starter: { grants: ['orgs.create'] },
		viewer: { grants: ['crm.read'], member: { scope: 'org', assignableBy: ['owner'] } },
		owner: {
			grants: ['crm.read', 'crm.write', 'deals.write', 'deals.share', 'crm.delete', 'members.manage'],
			member: { scope: 'org', assignableBy: ['owner'] },
		},
	},
})
