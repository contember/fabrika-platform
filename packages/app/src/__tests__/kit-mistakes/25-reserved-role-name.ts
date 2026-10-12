import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'crm',
	dimensions: { org: { creator: 'owner', members: { manage: 'members.manage', list: 'crm.read' } } },
	actions: { 'crm.read': 'Read the organization', 'members.manage': 'Manage its members', 'orgs.create': 'Start an organization' },
	roles: {
		starter: { grants: ['orgs.create'] },
		// mistake: IAM defines admin itself for every application
		admin: { grants: ['crm.read', 'members.manage'], member: { scope: 'org', assignableBy: ['owner'] } },
		owner: { grants: ['crm.read', 'members.manage'], member: { scope: 'org', assignableBy: ['owner'] } },
	},
})
