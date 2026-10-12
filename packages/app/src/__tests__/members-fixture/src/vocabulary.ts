// A CRM whose org declares the member directory, with a deal two levels below it (org → company → deal), for the
// member lookup of an endpoint below its directory (WU22). It is named `notes` because IAM's membership test fixture
// (`packages/iam/src/__tests__/helpers/membership.ts`) reconciles that application.

import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'notes',
	dimensions: {
		org: { members: { manage: 'members.manage', list: 'crm.read' }, directory: 'labels' },
		company: { in: 'org' },
		deal: { in: 'company' },
	},
	actions: {
		'crm.read': 'Read companies and deals',
		'deals.write': 'Create and edit deals',
		'deals.assign': 'Hand a deal over to another member',
		'members.manage': 'Manage the members of an org',
	},
	roles: {
		viewer: { grants: ['crm.read'], member: { scope: 'org', assignableBy: ['manager'] } },
		manager: {
			grants: ['crm.read', 'deals.write', 'deals.assign', 'members.manage'],
			member: { scope: 'org', assignableBy: ['manager'] },
		},
	},
})
