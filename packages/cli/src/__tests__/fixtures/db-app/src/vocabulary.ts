import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'isolation',
	dimensions: {
		organization: { creator: 'founder' },
		workspace: { in: 'organization', members: { manage: 'workspaces.admin', list: 'workspaces.read' } },
		note: { in: 'workspace' },
	},
	actions: {
		'organizations.read': 'Read organizations',
		'organizations.admin': 'Rename organizations',
		'organizations.create': 'Start an organization',
		'workspaces.read': 'Read workspaces',
		'workspaces.write': 'Create and rename workspaces',
		'workspaces.admin': 'Invite the members of a workspace',
		'notes.read': 'Read notes',
		'notes.write': 'Create and edit notes',
		'notes.delete': 'Delete notes',
		'notes.admin': 'Read internal notes',
		'notes.share': 'Share a note by link',
	},
	roles: {
		member: { grants: ['organizations.read', 'workspaces.read', 'notes.read', 'notes.write'] },
		founder: { grants: ['organizations.read', 'organizations.admin'], member: { scope: 'organization', assignableBy: ['founder'] } },
		editor: { grants: ['workspaces.read', 'notes.read', 'notes.write'], member: { scope: 'workspace', assignableBy: ['lead'] } },
		lead: { grants: ['workspaces.read', 'workspaces.admin', 'notes.read', 'notes.write'], member: { scope: 'workspace', assignableBy: ['lead'] } },
	},
})
